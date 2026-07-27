#!/usr/bin/env bash
set -euo pipefail

REPO="${ORBIT_UPDATE_REPO:-ashish200729/orbiteditor}"
MANIFEST_URL="${ORBIT_UPDATE_MANIFEST_URL:-https://raw.githubusercontent.com/$REPO/main/update/latest.json}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

for required_command in curl python3 sha256sum; do
	if ! command -v "$required_command" >/dev/null 2>&1; then
		echo "Orbit's Linux installer requires $required_command." >&2
		exit 1
	fi
done

case "$(uname -m)" in
	x86_64|amd64) ARCH=x64 ;;
	aarch64|arm64) ARCH=arm64 ;;
	*) echo "Orbit does not publish Linux builds for $(uname -m)." >&2; exit 1 ;;
esac

if [[ -n "${ORBIT_INSTALL_FORMAT:-}" ]]; then
	FORMAT="$ORBIT_INSTALL_FORMAT"
else
	DISTRO_FAMILY=
	if [[ -r /etc/os-release ]]; then
		# os-release is a shell-compatible file defined by the freedesktop.org specification.
		# shellcheck disable=SC1091
		. /etc/os-release
		DISTRO_FAMILY=" ${ID:-} ${ID_LIKE:-} "
	fi
	case "$DISTRO_FAMILY" in
		*" debian "*|*" ubuntu "*) FORMAT=deb ;;
		*" fedora "*|*" rhel "*|*" centos "*|*" suse "*|*" opensuse "*) FORMAT=rpm ;;
		*)
			if command -v apt-get >/dev/null 2>&1; then
				FORMAT=deb
			elif command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
				FORMAT=rpm
			else
				FORMAT=appimage
			fi
			;;
	esac
fi
case "$FORMAT" in deb|rpm|appimage) ;; *) echo "ORBIT_INSTALL_FORMAT must be deb, rpm, or appimage." >&2; exit 1 ;; esac

KEY="linux-$ARCH-$FORMAT"
MANIFEST="$TMP_DIR/latest.json"
curl --fail --location --silent --show-error "$MANIFEST_URL" --output "$MANIFEST"
readarray -t ASSET < <(python3 - "$MANIFEST" "$KEY" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as handle:
    manifest = json.load(handle)
asset = manifest.get('assets', {}).get(sys.argv[2], {})
print(asset.get('url', ''))
print(asset.get('sha256', ''))
PY
)
URL="${ASSET[0]:-}"
EXPECTED_SHA256="${ASSET[1]:-}"
if [[ -z "$URL" || -z "$EXPECTED_SHA256" ]]; then
	echo "No verified Orbit update asset is published for $KEY." >&2
	echo "See https://github.com/$REPO/releases/latest" >&2
	exit 1
fi

PACKAGE="$TMP_DIR/$(basename "${URL%%\?*}")"
echo "Downloading Orbit for $KEY..."
curl --fail --location --progress-bar "$URL" --output "$PACKAGE"
ACTUAL_SHA256="$(sha256sum "$PACKAGE" | cut -d ' ' -f 1)"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
	echo "Checksum mismatch for $PACKAGE" >&2
	exit 1
fi

echo "Checksum OK."
case "$FORMAT" in
	deb)
		if command -v apt-get >/dev/null 2>&1; then
			sudo apt-get install -y "$PACKAGE"
		else
			sudo dpkg -i "$PACKAGE"
		fi
		;;
	rpm)
		if command -v dnf >/dev/null 2>&1; then
			sudo dnf install -y "$PACKAGE"
		elif command -v zypper >/dev/null 2>&1; then
			sudo zypper --non-interactive install "$PACKAGE"
		elif command -v yum >/dev/null 2>&1; then
			sudo yum install -y "$PACKAGE"
		else
			sudo rpm -U --replacepkgs "$PACKAGE"
		fi
		;;
	appimage)
		INSTALL_DIR="${ORBIT_INSTALL_DIR:-$HOME/.local/opt/orbit}"
		BIN_DIR="$HOME/.local/bin"
		APPIMAGE="$INSTALL_DIR/Orbit.AppImage"
		ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
		ICON="$ICON_DIR/orbit.png"
		mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$HOME/.config" "$HOME/.local/share/applications" "$ICON_DIR"
		install -m 0755 "$PACKAGE" "$APPIMAGE.new"
		mv -f "$APPIMAGE.new" "$APPIMAGE"
		ln -sfn "$APPIMAGE" "$BIN_DIR/orbit"
		if (cd "$TMP_DIR" && "$APPIMAGE" --appimage-extract orbit.png >/dev/null 2>&1) && [[ -f "$TMP_DIR/squashfs-root/orbit.png" ]]; then
			install -m 0644 "$TMP_DIR/squashfs-root/orbit.png" "$ICON"
		else
			ICON=orbit
		fi
		cat > "$HOME/.local/share/applications/orbit.desktop" <<EOF
[Desktop Entry]
Name=Orbit
Comment=Open-source AI-powered code editor
GenericName=Text Editor
Exec="$APPIMAGE" %F
Icon=$ICON
Type=Application
StartupNotify=false
StartupWMClass=Orbit
Categories=TextEditor;Development;IDE;
MimeType=application/x-orbit-workspace;
Actions=new-empty-window;

[Desktop Action new-empty-window]
Name=New Empty Window
Exec="$APPIMAGE" --new-window %F
Icon=$ICON
EOF
		cat > "$HOME/.local/share/applications/orbit-url-handler.desktop" <<EOF
[Desktop Entry]
Name=Orbit - URL Handler
Exec="$APPIMAGE" --open-url %U
Icon=$ICON
Type=Application
NoDisplay=true
MimeType=x-scheme-handler/orbit;
EOF
		command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" || true
		command -v xdg-mime >/dev/null 2>&1 && xdg-mime default orbit-url-handler.desktop x-scheme-handler/orbit || true
		echo "Installed Orbit to $APPIMAGE"
		case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Add $BIN_DIR to PATH to use the orbit command." ;; esac
		;;
esac
