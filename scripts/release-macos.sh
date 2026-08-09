#!/usr/bin/env bash
# Build and verify both macOS architectures sequentially. Nothing is published
# unless the caller explicitly opts in after both artifacts pass every check.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PRODUCT_VERSION="$(node -p "require('./product.json').orbitVersion")"
VERSION="${1:-$PRODUCT_VERSION}"
VERSION="${VERSION#v}"
TAG="v${VERSION}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "Invalid release version: $VERSION (expected x.y.z)" >&2
	exit 1
fi
if [[ "$VERSION" != "$PRODUCT_VERSION" ]]; then
	echo "Requested version $VERSION does not match product.json orbitVersion $PRODUCT_VERSION." >&2
	exit 1
fi

ARTIFACTS=()

verify_app() {
	local app="$1" expected_arch="$2" embedded_version executable
	app="$(cd "$app" && pwd)"
	embedded_version="$(node -p "require('$app/Contents/Resources/app/product.json').orbitVersion")"
	if [[ "$embedded_version" != "$VERSION" ]]; then
		echo "Embedded version mismatch in $app: $embedded_version" >&2
		exit 1
	fi

	executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
	file "$app/Contents/MacOS/$executable" | grep -q "$expected_arch" || {
		echo "Unexpected executable architecture in $app" >&2
		exit 1
	}

	if find -L "$app/Contents/Frameworks" -type l -print -quit | grep -q .; then
		echo "Broken framework symlink found in $app" >&2
		exit 1
	fi
	codesign --verify --deep --strict --verbose=2 "$app"
	(
		cd "$app/Contents/Resources/app"
		ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/$executable" -e "require('@vscode/deviceid')"
	)
}

verify_dmg() {
	local dmg="$1" expected_arch="$2" mount_point mounted_app
	hdiutil verify "$dmg"
	mount_point="$(mktemp -d)"
	if ! hdiutil attach -nobrowse -readonly -mountpoint "$mount_point" "$dmg" >/dev/null; then
		rmdir "$mount_point"
		exit 1
	fi
	mounted_app="$mount_point/Orbit.app"
	if [[ ! -d "$mounted_app" || -L "$mounted_app" ]]; then
		hdiutil detach "$mount_point" -quiet || true
		rmdir "$mount_point" || true
		echo "DMG does not contain a top-level Orbit.app" >&2
		exit 1
	fi
	verify_app "$mounted_app" "$expected_arch"
	hdiutil detach "$mount_point" -quiet
	rmdir "$mount_point"
}

build_arch() {
	local arch="$1" file_arch="$2" app_dir="../Orbit-darwin-$1" app dmg
	echo "Building Orbit $VERSION for macOS $arch"
	./scripts/build-macos-lowmem.sh "$arch"
	app="$(find "$app_dir" -maxdepth 1 -type d -name '*.app' -print -quit)"
	if [[ -z "$app" ]]; then
		echo "No app bundle produced in $app_dir" >&2
		exit 1
	fi
	verify_app "$app" "$file_arch"
	dmg="Orbit-$VERSION-darwin-$arch.dmg"
	./scripts/make-dmg.sh "$app" "$dmg"
	verify_dmg "$dmg" "$file_arch"
	shasum -a 256 "$dmg"
	ARTIFACTS+=("$dmg")
}

# Intentionally sequential: each architecture is fully built and verified
# before the second build starts.
build_arch arm64 arm64
build_arch x64 x86_64

if [[ "${WRITE_UPDATE_MANIFEST:-0}" == 1 ]]; then
	if [[ -z "${ORBIT_UPDATE_SIGNING_KEY:-}" ]]; then
		echo "ORBIT_UPDATE_SIGNING_KEY is required to write the production manifest." >&2
		exit 1
	fi
	node scripts/update-latest-json.js \
		--version "$VERSION" \
		--tag "$TAG" \
		--commit "$(git rev-parse HEAD)" \
		--asset "darwin-arm64=${ARTIFACTS[0]}" \
		--asset "darwin-x64=${ARTIFACTS[1]}"
fi

if [[ "${CREATE_DRAFT_RELEASE:-0}" == 1 ]]; then
	command -v gh >/dev/null 2>&1 || { echo "gh CLI is required to create a draft release." >&2; exit 1; }
	if gh release view "$TAG" >/dev/null 2>&1; then
		gh release upload "$TAG" "${ARTIFACTS[@]}" --clobber
	else
		gh release create "$TAG" "${ARTIFACTS[@]}" --draft --title "Orbit $VERSION" --notes "Orbit $VERSION macOS release candidate"
	fi
fi

echo "Verified macOS artifacts: ${ARTIFACTS[*]}"
echo "The update manifest and GitHub release were not changed unless explicitly requested."
