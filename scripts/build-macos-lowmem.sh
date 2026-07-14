#!/usr/bin/env bash
# Low-memory macOS production build (skips symbol mangling).
# Usage: ./scripts/build-macos-lowmem.sh [arm64|x64]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ARCH="${1:-arm64}"
HEAP="${NODE_HEAP_MB:-6144}"
export NODE_OPTIONS="--max-old-space-size=${HEAP}"

echo "Orbit macOS low-memory build: darwin-${ARCH} (heap=${HEAP}MB)"

npm run buildreact:prod

npm run gulp -- compile-build-without-mangling
rm -rf .build/extensions
npm run gulp -- compile-non-native-extensions-build
npm run gulp -- compile-extension-media-build
npm run gulp -- minify-vscode

# @vscode/deviceid is CommonJS and must remain on uuid 11 under Electron's
# Node 20 runtime. npm can leave a nested .bin link that reflects deviceid's
# newer declared uuid range even when the compatible override is hoisted.
# The unused CLI link is not part of Orbit; remove it only when it is dangling
# so the package copier does not reject an otherwise valid dependency tree.
DEVICEID_UUID_BIN="node_modules/@vscode/deviceid/node_modules/.bin/uuid"
if [[ -L "$DEVICEID_UUID_BIN" && ! -e "$DEVICEID_UUID_BIN" ]]; then
	unlink "$DEVICEID_UUID_BIN"
fi

npm run gulp -- "vscode-darwin-${ARCH}-min-ci"

APP_DIR="../Orbit-darwin-${ARCH}"
if [[ ! -d "$APP_DIR" ]]; then
	echo "Expected app bundle at $APP_DIR"
	exit 1
fi

echo "Built: ${APP_DIR}/Orbit.app"

"$ROOT/scripts/codesign-macos.sh" "${APP_DIR}/Orbit.app"
