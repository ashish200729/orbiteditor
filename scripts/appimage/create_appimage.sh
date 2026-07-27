#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET_ARCH="${1:-x64}"
SOURCE_DIR="${2:-$ROOT/../Orbit-linux-$TARGET_ARCH}"
OUTPUT="${3:-$ROOT/Orbit-$(node -p "require('$ROOT/product.json').orbitVersion")-linux-$TARGET_ARCH.AppImage}"
WORK_DIR="$(mktemp -d)"
APP_DIR="$WORK_DIR/Orbit.AppDir"
TOOL="$WORK_DIR/appimagetool.AppImage"
trap 'rm -rf "$WORK_DIR"' EXIT

case "$TARGET_ARCH" in
	x64) APPIMAGE_ARCH=x86_64 ;;
	arm64) APPIMAGE_ARCH=arm_aarch64 ;;
	*) echo "Unsupported AppImage architecture: $TARGET_ARCH (expected x64 or arm64)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
	x86_64|amd64)
		TOOL_ARCH=x86_64
		DEFAULT_TOOL_SHA256=b90f4a8b18967545fda78a445b27680a1642f1ef9488ced28b65398f2be7add2
		;;
	aarch64|arm64)
		TOOL_ARCH=aarch64
		DEFAULT_TOOL_SHA256=a48972e5ae91c944c5a7c80214e7e0a42dd6aa3ae979d8756203512a74ff574d
		;;
	*) echo "Unsupported build host architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [[ "$(uname -s)" != Linux ]]; then
	echo "AppImages must be assembled on Linux." >&2
	exit 1
fi
if [[ ! -x "$SOURCE_DIR/orbit" || ! -x "$SOURCE_DIR/bin/orbit" ]]; then
	echo "Built Orbit bundle not found at $SOURCE_DIR" >&2
	exit 1
fi

mkdir -p "$APP_DIR/usr/share/orbit" "$APP_DIR/usr/bin" "$APP_DIR/usr/share/applications"
cp -a "$SOURCE_DIR/." "$APP_DIR/usr/share/orbit/"
ln -s ../share/orbit/bin/orbit "$APP_DIR/usr/bin/orbit"
install -m 0644 "$ROOT/resources/linux/code.png" "$APP_DIR/orbit.png"
ln -s orbit.png "$APP_DIR/.DirIcon"

cat > "$APP_DIR/orbit.desktop" <<'EOF'
[Desktop Entry]
Name=Orbit
Comment=Open-source AI-powered code editor
GenericName=Text Editor
Exec=orbit %F
Icon=orbit
Type=Application
StartupNotify=false
StartupWMClass=Orbit
Categories=TextEditor;Development;IDE;
MimeType=application/x-orbit-workspace;
Actions=new-empty-window;
Keywords=orbit;ai;

[Desktop Action new-empty-window]
Name=New Empty Window
Exec=orbit --new-window %F
Icon=orbit
EOF

cat > "$APP_DIR/usr/share/applications/orbit-url-handler.desktop" <<'EOF'
[Desktop Entry]
Name=Orbit - URL Handler
Comment=Open-source AI-powered code editor
GenericName=Text Editor
Exec=orbit --open-url %U
Icon=orbit
Type=Application
NoDisplay=true
StartupNotify=true
Categories=TextEditor;Development;IDE;
MimeType=x-scheme-handler/orbit;
Keywords=orbit;ai;
EOF
cp "$APP_DIR/orbit.desktop" "$APP_DIR/usr/share/applications/orbit.desktop"

cat > "$APP_DIR/AppRun" <<'EOF'
#!/usr/bin/env sh
HERE="$(dirname "$(readlink -f "$0")")"
export APPDIR="$HERE"
export PATH="$HERE/usr/bin:$PATH"

# A FUSE-mounted AppImage cannot provide a root-owned setuid sandbox helper.
# Prefer Chromium's user-namespace sandbox, and fall back only on systems where
# the kernel or AppArmor explicitly blocks unprivileged user namespaces.
SANDBOX_ARG=--disable-setuid-sandbox
if { [ -r /proc/sys/kernel/unprivileged_userns_clone ] && [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = 0 ]; } ||
	{ [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1 ]; }; then
	echo "Orbit: unprivileged user namespaces are unavailable; launching the AppImage without Chromium sandboxing." >&2
	SANDBOX_ARG=--no-sandbox
fi

exec "$HERE/usr/bin/orbit" "$SANDBOX_ARG" "$@"
EOF
chmod 0755 "$APP_DIR/AppRun"
chmod 0755 "$APP_DIR/usr/share/orbit/chrome-sandbox"

APPIMAGETOOL_URL="${APPIMAGETOOL_URL:-https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${TOOL_ARCH}.AppImage}"
echo "Downloading appimagetool from $APPIMAGETOOL_URL"
curl --fail --location --silent --show-error "$APPIMAGETOOL_URL" --output "$TOOL"
EXPECTED_TOOL_SHA256="${APPIMAGETOOL_SHA256:-$DEFAULT_TOOL_SHA256}"
printf '%s  %s\n' "$EXPECTED_TOOL_SHA256" "$TOOL" | sha256sum --check --status
chmod 0755 "$TOOL"
mkdir -p "$(dirname "$OUTPUT")"
(
	cd "$WORK_DIR"
	"$TOOL" --appimage-extract >/dev/null
	export ARCH="$APPIMAGE_ARCH"
	"$WORK_DIR/squashfs-root/AppRun" -n "$APP_DIR" "$OUTPUT"
)
chmod 0755 "$OUTPUT"
echo "Created $OUTPUT"
