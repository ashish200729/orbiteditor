#!/usr/bin/env bash
# Install Orbit on macOS from the signed update manifest or a local DMG.
#
# Usage:
#   ./scripts/install-macos.sh                  # fetch latest release per update/latest.json
#   LOCAL_DMG=./Orbit-0.1.0-darwin-arm64.dmg ./scripts/install-macos.sh   # test with a local DMG, no download
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ARCH="$(uname -m)"
case "$ARCH" in
	arm64) PLATFORM_KEY="darwin-arm64" ;;
	x86_64) PLATFORM_KEY="darwin-x64" ;;
	*) echo "install-macos.sh: unsupported arch: $ARCH" >&2; exit 1 ;;
esac

MANIFEST_URL="${MANIFEST_URL:-https://raw.githubusercontent.com/ashish200729/orbiteditor/main/update/latest.json}"
WORKDIR="$(mktemp -d)"
MOUNT_POINT=""
cleanup() {
	if [[ -n "$MOUNT_POINT" ]]; then
		hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
	fi
	rm -rf "$WORKDIR"
}
trap cleanup EXIT

if [[ -n "${LOCAL_DMG:-}" ]]; then
	echo "Using local DMG (no network fetch, no quarantine involved): ${LOCAL_DMG}"
	DMG_PATH="$LOCAL_DMG"
	if [[ ! -f "$DMG_PATH" ]]; then
		echo "install-macos.sh: no such file: $DMG_PATH" >&2
		exit 1
	fi
else
	echo "Fetching manifest: ${MANIFEST_URL}"
	curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$MANIFEST_URL" -o "${WORKDIR}/latest.json"
	node "$ROOT/scripts/verify-update-manifest.js" "${WORKDIR}/latest.json" "$PLATFORM_KEY"

	URL="$(node -p "require('${WORKDIR}/latest.json').assets['${PLATFORM_KEY}'].url")"
	SHA256_EXPECTED="$(node -p "require('${WORKDIR}/latest.json').assets['${PLATFORM_KEY}'].sha256")"
	VERSION="$(node -p "require('${WORKDIR}/latest.json').version")"

	if [[ -z "$URL" || "$URL" == "undefined" ]]; then
		echo "install-macos.sh: no asset for ${PLATFORM_KEY} in manifest" >&2
		exit 1
	fi

	DMG_PATH="${WORKDIR}/orbit.dmg"
	echo "Downloading Orbit ${VERSION} (${PLATFORM_KEY}) via curl..."
	curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$URL" -o "$DMG_PATH"

	echo "Verifying checksum..."
	SHA256_ACTUAL="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
	if [[ "$SHA256_ACTUAL" != "$SHA256_EXPECTED" ]]; then
		echo "install-macos.sh: checksum mismatch — expected ${SHA256_EXPECTED}, got ${SHA256_ACTUAL}" >&2
		exit 1
	fi
	echo "Checksum OK."
fi

echo "Mounting DMG..."
MOUNT_POINT="${WORKDIR}/mnt"
mkdir -p "$MOUNT_POINT"
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -readonly -quiet

APP_SRC="${MOUNT_POINT}/Orbit.app"
if [[ ! -d "$APP_SRC" || -L "$APP_SRC" ]]; then
	hdiutil detach "$MOUNT_POINT" -quiet || true
	echo "install-macos.sh: Orbit.app not found inside DMG" >&2
	exit 1
fi

echo "Verifying app signature..."
codesign --verify --deep --strict --verbose=2 "$APP_SRC"

TARGET="/Applications/Orbit.app"
INSTALL_DIR="$(mktemp -d /Applications/.Orbit.app.install.XXXXXX)"
STAGE="$INSTALL_DIR/Orbit.app"
BACKUP="$INSTALL_DIR/previous.app"

echo "Copying verified app to staging..."
ditto "$APP_SRC" "$STAGE"
codesign --verify --deep --strict --verbose=2 "$STAGE"

hdiutil detach "$MOUNT_POINT" -quiet
MOUNT_POINT=""

echo "Installing to /Applications..."
if [[ -e "$TARGET" ]]; then
	mv -- "$TARGET" "$BACKUP"
fi
if ! mv -- "$STAGE" "$TARGET"; then
	echo "install-macos.sh: install failed; restoring the previous app" >&2
	if [[ -d "$BACKUP" ]]; then
		mv -- "$BACKUP" "$TARGET"
	fi
	rm -rf -- "$INSTALL_DIR"
	exit 1
fi
rm -rf -- "$BACKUP" "$INSTALL_DIR"

echo "Done. Launch: open /Applications/Orbit.app"
