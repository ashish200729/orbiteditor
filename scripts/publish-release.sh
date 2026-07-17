#!/usr/bin/env bash
# Build (optional), publish a macOS release to GitHub, and update the auto-update manifest.
#
# Typical workflow:
#   1. Bump product.json → orbitVersion
#   2. ./scripts/publish-release.sh 0.2.0 arm64
#      (this pushes update/latest.json to origin main itself — that's what clients read)
#
# Usage:
#   ./scripts/publish-release.sh [version] [arch]
#   SKIP_BUILD=1 ./scripts/publish-release.sh 0.1.0 arm64   # upload existing DMG only
#   DMG_PATH=./Orbit-0.1.0-darwin-arm64.dmg SKIP_BUILD=1 ./scripts/publish-release.sh 0.1.0 arm64
#   SKIP_MANIFEST_PUSH=1 ./scripts/publish-release.sh      # don't commit/push manifest
#
# Note: SKIP_BUILD reuses an existing DMG — the version inside the .app must match [version].
#       To release 0.1.1 you must rebuild (omit SKIP_BUILD), not just rename the 0.1.0 DMG.
#
# Requires ORBIT_UPDATE_SIGNING_KEY (PEM Ed25519 private key) in the
# environment — scripts/update-latest-json.js refuses to write an unsigned
# manifest, and the app refuses to auto-install from one.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
ARCH="${2:-arm64}"

if [[ -z "$VERSION" ]]; then
	VERSION="$(node -p "require('./product.json').orbitVersion")"
fi

TAG="v${VERSION#v}"
PLATFORM_KEY="darwin-${ARCH}"
DMG_NAME="Orbit-${VERSION}-darwin-${ARCH}.dmg"
DMG_PATH="${DMG_PATH:-${ROOT}/${DMG_NAME}}"

echo "Orbit publish: version=${VERSION} tag=${TAG} platform=${PLATFORM_KEY}"

if [[ -z "${ORBIT_UPDATE_SIGNING_KEY:-}" && "${ALLOW_UNSIGNED_MANIFEST:-}" != "1" ]]; then
	echo "ERROR: ORBIT_UPDATE_SIGNING_KEY is not set."
	echo "Refusing to publish before the manifest can be signed — otherwise the GitHub"
	echo "release would ship while update/latest.json stays unsigned or stale."
	echo "Set ORBIT_UPDATE_SIGNING_KEY, or ALLOW_UNSIGNED_MANIFEST=1 for local testing only."
	exit 1
fi

# Keep product.json in sync when an explicit version is passed
if [[ -n "${1:-}" ]]; then
	node <<NODE
const fs = require('fs');
const productPath = 'product.json';
const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
product.orbitVersion = '${VERSION}';
fs.writeFileSync(productPath, JSON.stringify(product, null, '\t') + '\n');
console.log('Updated product.json orbitVersion → ${VERSION}');
NODE
fi

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
	./scripts/build-macos-lowmem.sh "$ARCH"

	./scripts/make-dmg.sh "../Orbit-darwin-${ARCH}" "$DMG_NAME"
else
	echo "SKIP_BUILD=1 — using existing DMG at ${DMG_PATH}"
fi

if [[ ! -f "$DMG_PATH" ]]; then
	echo "DMG not found: $DMG_PATH"
	echo ""
	echo "Available DMGs in repo root:"
	ls -1 "$ROOT"/Orbit-*-darwin-*.dmg 2>/dev/null || echo "  (none)"
	echo ""
	echo "If you have a DMG for a different version, either:"
	echo "  • Publish that version:  SKIP_BUILD=1 ./scripts/publish-release.sh 0.1.0 ${ARCH}"
	echo "  • Point at the file:       DMG_PATH=./Orbit-0.1.0-darwin-arm64.dmg SKIP_BUILD=1 ./scripts/publish-release.sh 0.1.0 ${ARCH}"
	echo "  • Rebuild for a new version (required if the .app inside must report the new version):"
	echo "      ./scripts/publish-release.sh ${VERSION} ${ARCH}"
	exit 1
fi

# Normalize DMG_NAME for manifest URLs when DMG_PATH is overridden
DMG_NAME="$(basename "$DMG_PATH")"

if [[ "${SKIP_BUILD:-}" == "1" ]]; then
	echo "SKIP_BUILD=1 — verifying DMG's embedded version matches ${VERSION}..."
	MOUNT_POINT="$(mktemp -d)"
	cleanup_mount() {
		hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
		rmdir "$MOUNT_POINT" 2>/dev/null || true
	}
	trap cleanup_mount EXIT
	hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_POINT" "$DMG_PATH" >/dev/null
	# CFBundleShortVersionString tracks the upstream Electron/VS Code bundle version,
	# not Orbit's own release version — check the bundled product.json's orbitVersion
	# instead, which is what the update system and product.json itself agree on.
	APP_PRODUCT_JSON="$(find "$MOUNT_POINT" -maxdepth 1 -name '*.app' -print -quit)/Contents/Resources/app/product.json"
	if [[ ! -f "$APP_PRODUCT_JSON" ]]; then
		echo "Could not find product.json inside ${DMG_PATH} to verify version."
		exit 1
	fi
	EMBEDDED_VERSION="$(node -p "require('${APP_PRODUCT_JSON}').orbitVersion")"
	cleanup_mount
	trap - EXIT
	if [[ "$EMBEDDED_VERSION" != "$VERSION" ]]; then
		echo "Version mismatch: DMG contains v${EMBEDDED_VERSION} but you're publishing v${VERSION}."
		echo "Rebuild instead of reusing this DMG: ./scripts/publish-release.sh ${VERSION} ${ARCH}"
		exit 1
	fi
	echo "Version check OK: DMG embeds v${EMBEDDED_VERSION}"
fi

echo "DMG ready: $DMG_PATH ($(du -h "$DMG_PATH" | awk '{print $1}'))"

if ! command -v gh >/dev/null 2>&1; then
	echo "gh CLI not found. Install GitHub CLI, then re-run or upload manually:"
	echo "  gh release create ${TAG} ${DMG_NAME} --title \"Orbit ${VERSION}\""
	exit 1
fi

ensure_tag_on_remote() {
	if git rev-parse "$TAG" >/dev/null 2>&1; then
		echo "Pushing existing tag ${TAG} to origin..."
		git push origin "$TAG"
	else
		echo "Creating tag ${TAG} at HEAD..."
		git tag -a "$TAG" -m "Orbit ${VERSION}"
		git push origin "$TAG"
	fi
}

if gh release view "$TAG" >/dev/null 2>&1; then
	echo "Uploading to existing release ${TAG}"
	gh release upload "$TAG" "$DMG_PATH" --clobber
else
	ensure_tag_on_remote
	echo "Creating GitHub release ${TAG}"
	gh release create "$TAG" "$DMG_PATH" \
		--title "Orbit ${VERSION}" \
		--notes "Orbit ${VERSION} — see update/latest.json for auto-update manifest."
fi

echo "Verifying ${DMG_NAME} landed on release ${TAG}..."
if ! gh release view "$TAG" --json assets --jq '.assets[].name' | grep -qx "$DMG_NAME"; then
	echo "ERROR: ${DMG_NAME} was not found on release ${TAG} after upload — refusing to update the manifest."
	echo "Check 'gh release view ${TAG}' and re-run once the asset is actually present."
	exit 1
fi

UPDATE_MANIFEST_ARGS=(--version "$VERSION" --tag "$TAG" --merge --asset "${PLATFORM_KEY}=${DMG_NAME}")
if [[ -z "${ORBIT_UPDATE_SIGNING_KEY:-}" && "${ALLOW_UNSIGNED_MANIFEST:-}" == "1" ]]; then
	UPDATE_MANIFEST_ARGS+=(--allow-unsigned)
fi

node scripts/update-latest-json.js "${UPDATE_MANIFEST_ARGS[@]}"

if [[ "${SKIP_MANIFEST_PUSH:-}" == "1" ]]; then
	echo "SKIP_MANIFEST_PUSH=1 — manifest updated locally only (not committed or pushed)."
else
	git add update/latest.json product.json
	if git diff --staged --quiet; then
		echo "No manifest changes to commit."
	else
		git commit -m "chore: update auto-update manifest for ${TAG}"
		echo "Pushing update/latest.json to origin main..."
		git push origin main
	fi
fi

echo ""
echo "Done."
echo "  Release: https://github.com/ashish200729/orbiteditor/releases/tag/${TAG}"
echo "  Manifest: update/latest.json (clients read from main branch)"
echo ""
echo "Users on older builds will see an update notification within ~5s–3h."
echo "They can click Install update to upgrade in place."