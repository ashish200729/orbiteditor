#!/usr/bin/env bash
# Build one Orbit platform, publish its artifacts, and refresh update/latest.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PRODUCT_VERSION="$(node -p "require('./product.json').orbitVersion")"
VERSION="${1:-$PRODUCT_VERSION}"
VERSION="${VERSION#v}"
if [[ "$VERSION" != "$PRODUCT_VERSION" ]]; then
	echo "Requested version $VERSION does not match product.json orbitVersion $PRODUCT_VERSION." >&2
	exit 1
fi
TAG="v$VERSION"
PLATFORM="${2:-darwin-arm64}"
FILES=()
ASSET_ARGS=(--version "$VERSION" --tag "$TAG" --merge)

echo "Orbit local release: version=$VERSION tag=$TAG platform=$PLATFORM"
npm run buildreact:prod

release_darwin() {
	local arch="$1" app_dir="../Orbit-darwin-$1" dmg="Orbit-$VERSION-darwin-$1.dmg"
	if [[ "${ALLOW_LEGACY_SINGLE_ARCH_RELEASE:-0}" != 1 ]]; then
		echo "Single-architecture macOS releases are disabled. Use ./scripts/release-macos.sh." >&2
		exit 1
	fi
	./scripts/build-macos-lowmem.sh "$arch"
	[[ -d "$app_dir" ]] || { echo "Expected app bundle at $app_dir" >&2; exit 1; }
	./scripts/make-dmg.sh "$app_dir" "$dmg"
	FILES+=("$dmg")
	ASSET_ARGS+=(--asset "darwin-$arch=$dmg")
}

release_linux() {
	local arch="$1" deb_arch rpm_arch deb_src rpm_src
	case "$arch" in
		x64) deb_arch=amd64; rpm_arch=x86_64 ;;
		arm64) deb_arch=arm64; rpm_arch=aarch64 ;;
		*) echo "Unsupported Linux architecture: $arch" >&2; exit 1 ;;
	esac

	npm run gulp -- compile-build-without-mangling
	rm -rf .build/extensions
	npm run gulp -- compile-non-native-extensions-build
	npm run gulp -- compile-extension-media-build
	npm run gulp -- minify-vscode
	npm run gulp -- "vscode-linux-$arch-min-ci"
	npm run gulp -- "vscode-linux-$arch-prepare-deb"
	npm run gulp -- "vscode-linux-$arch-build-deb"
	npm run gulp -- "vscode-linux-$arch-prepare-rpm"
	npm run gulp -- "vscode-linux-$arch-build-rpm"

	deb_src="$(printf '%s\n' ".build/linux/deb/$deb_arch/deb/"*.deb | head -n 1)"
	rpm_src="$(printf '%s\n' ".build/linux/rpm/$rpm_arch/"*.rpm | head -n 1)"
	[[ -f "$deb_src" && -f "$rpm_src" ]] || { echo "Linux package build did not produce deb and rpm artifacts" >&2; exit 1; }

	local deb="Orbit-$VERSION-linux-$arch.deb"
	local rpm="Orbit-$VERSION-linux-$arch.rpm"
	local appimage="Orbit-$VERSION-linux-$arch.AppImage"
	cp "$deb_src" "$deb"
	cp "$rpm_src" "$rpm"
	./scripts/appimage/create_appimage.sh "$arch" "../Orbit-linux-$arch" "$ROOT/$appimage"
	FILES+=("$deb" "$rpm" "$appimage")
	ASSET_ARGS+=(
		--asset "linux-$arch-deb=$deb"
		--asset "linux-$arch-rpm=$rpm"
		--asset "linux-$arch-appimage=$appimage"
	)
}

case "$PLATFORM" in
	darwin-arm64) release_darwin arm64 ;;
	darwin-x64) release_darwin x64 ;;
	win32-x64)
		NODE_OPTIONS="--max-old-space-size=8192" npm run gulp -- compile-build-with-mangling
		NODE_OPTIONS="--max-old-space-size=8192" npm run gulp -- compile-non-native-extensions-build
		NODE_OPTIONS="--max-old-space-size=8192" npm run gulp -- compile-extension-media-build
		npm run buildreact:prod
		NODE_OPTIONS="--max-old-space-size=8192" npm run gulp -- minify-vscode
		NODE_OPTIONS="--max-old-space-size=8192" npm run gulp -- vscode-win32-x64-min-ci
		NODE_OPTIONS="--max-old-space-size=8192" npm run gulp -- vscode-win32-x64-inno-updater
		NODE_OPTIONS="--max-old-space-size=8192" npm run gulp -- vscode-win32-x64-system-setup
		file="Orbit-$VERSION-win32-x64-setup.exe"
		mv .build/win32-x64/system-setup/VSCodeSetup.exe "$file"
		FILES+=("$file")
		ASSET_ARGS+=(--asset "win32-x64=$file")
		;;
	linux-x64) release_linux x64 ;;
	linux-arm64) release_linux arm64 ;;
	*)
		echo "Unknown platform: $PLATFORM" >&2
		echo "Supported: darwin-arm64, darwin-x64, win32-x64, linux-x64, linux-arm64" >&2
		exit 1
		;;
esac

if [[ "${SKIP_MANIFEST:-}" != 1 ]]; then
	node scripts/update-latest-json.js "${ASSET_ARGS[@]}"
fi

if [[ "${SKIP_GH_RELEASE:-}" == 1 ]]; then
	echo "SKIP_GH_RELEASE=1 — skipped GitHub release upload."
elif command -v gh >/dev/null 2>&1; then
	if gh release view "$TAG" >/dev/null 2>&1; then
		gh release upload "$TAG" "${FILES[@]}" --clobber
	else
		gh release create "$TAG" "${FILES[@]}" --title "Orbit $VERSION" --notes "Orbit $VERSION"
	fi
else
	echo "gh CLI not found; skipped GitHub release upload."
fi

echo "Built: ${FILES[*]}"
echo "Push update/latest.json to main after verifying the release assets."
