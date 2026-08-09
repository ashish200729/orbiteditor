#!/usr/bin/env bash
# Code-sign a built Orbit.app bundle.
#
# Without MACOS_CODESIGN_IDENTITY set: ad-hoc signs the bundle (free, no Apple
# Developer account needed). This is enough to stop macOS Gatekeeper's fatal
# "<App> is damaged and can't be opened" dialog on Apple Silicon, but the app
# will still show the milder "Apple could not verify this app is free from
# malware" prompt on first launch until it is signed with a real Developer ID
# and notarized by Apple.
#
# With MACOS_CODESIGN_IDENTITY set (a "Developer ID Application: ..." identity
# string from `security find-identity -v -p codesigning`): signs with hardened
# runtime + timestamp + entitlements, ready for notarization.
#
# Usage: ./scripts/codesign-macos.sh /path/to/Orbit.app
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:?Usage: codesign-macos.sh /path/to/Orbit.app}"
APP_ENTITLEMENTS="${ROOT}/build/azure-pipelines/darwin/app-entitlements.plist"
GPU_ENTITLEMENTS="${ROOT}/build/azure-pipelines/darwin/helper-gpu-entitlements.plist"
RENDERER_ENTITLEMENTS="${ROOT}/build/azure-pipelines/darwin/helper-renderer-entitlements.plist"
PLUGIN_ENTITLEMENTS="${ROOT}/build/azure-pipelines/darwin/helper-plugin-entitlements.plist"

if [[ ! -d "$APP" ]]; then
	echo "codesign-macos.sh: no such app bundle: $APP" >&2
	exit 1
fi

IDENTITY="${MACOS_CODESIGN_IDENTITY:--}"
DEVELOPER_SIGNING=0
if [[ "$IDENTITY" != - ]]; then
	DEVELOPER_SIGNING=1
	echo "Signing ${APP} with identity: ${IDENTITY}"
else
	echo "WARNING: No MACOS_CODESIGN_IDENTITY set — ad-hoc signing only." >&2
	echo "WARNING: App will show 'unidentified developer' on first launch until a real Developer ID + notarization is configured." >&2
fi

# Sign the Electron bundle INNER -> OUTER. Apple advises against using --deep
# for signing complex bundles: every nested code object needs its own deliberate
# signature and entitlements before the outer app is sealed.
sign_item() {
	local item="$1"
	local entitlements="${2:-}"
	local args=(--force --sign "$IDENTITY")
	if [[ "$DEVELOPER_SIGNING" == 1 ]]; then
		args+=(--options runtime --timestamp)
	fi
	if [[ -n "$entitlements" ]]; then
		args+=(--entitlements "$entitlements")
	fi
	codesign "${args[@]}" "$item"
}

# 1. Loose Mach-O: dynamic libs and native node addons, anywhere in the bundle.
while IFS= read -r -d '' f; do
	sign_item "$f"
done < <(find "$APP/Contents" -type f \( -name '*.dylib' -o -name '*.node' \) -print0)

	# 2. Nested helper .app bundles (Orbit Helper (GPU/Renderer/Plugin), crashpad, etc.):
	#    sign their inner executable(s) first, then the helper bundle itself.
while IFS= read -r -d '' helper; do
	if [[ -d "$helper/Contents/MacOS" ]]; then
		while IFS= read -r -d '' bin; do
			sign_item "$bin"
		done < <(find "$helper/Contents/MacOS" -type f -perm -u+x -print0)
	fi
	helper_entitlements="$RENDERER_ENTITLEMENTS"
	case "$(basename "$helper")" in
		*GPU*) helper_entitlements="$GPU_ENTITLEMENTS" ;;
		*Plugin*) helper_entitlements="$PLUGIN_ENTITLEMENTS" ;;
	esac
	sign_item "$helper" "$helper_entitlements"
done < <(find "$APP/Contents/Frameworks" -maxdepth 1 -type d -name '*.app' -print0 2>/dev/null)

	# 3. Frameworks. Some frameworks (notably Electron Framework.framework)
	#    embed extra executables outside the standard Versions/*/<name> layout,
	#    e.g. Versions/A/Helpers/chrome_crashpad_handler. Upstream Electron
	#    ships that pre-signed on some architectures but not others (e.g. it's
	#    already signed on arm64 builds but ships raw/unsigned on x64), so
	#    relying on an inherited signature is not portable — sign every
	#    executable found inside the framework before sealing the framework
	#    bundle itself, deepest first.
	while IFS= read -r -d '' fw; do
		# Sort deepest-path-first: codesign refuses to seal a Mach-O whose
		# sibling "Helpers" subdirectory (e.g. chrome_crashpad_handler) is
		# still unsigned, so the framework's own main binary — which sits
		# shallower than Helpers/ — must be signed *after* it, not before.
		# `find`'s scan order doesn't guarantee that, so sort on it explicitly.
		while IFS= read -r bin; do
			sign_item "$bin"
		done < <(find "$fw" -type f -perm -u+x -print | awk -F/ '{print NF"\t"$0}' | sort -rn | cut -f2-)
		sign_item "$fw"
	done < <(find "$APP/Contents/Frameworks" -maxdepth 1 -type d -name '*.framework' -print0 2>/dev/null)

	# 4. Outer app last, with the same entitlements used for real signing.
	sign_item "$APP" "$APP_ENTITLEMENTS"

echo "Verifying signature..."
codesign --verify --deep --strict --verbose=2 "$APP"

# Informational only: ad-hoc signatures are ALWAYS "rejected" by Gatekeeper's
# assessment (they have no verifiable publisher). That's expected and does not
# mean the seal is broken — the --verify above is the check that matters.
if [[ "$DEVELOPER_SIGNING" == 1 ]]; then
	echo "Gatekeeper assessment:"
	spctl -a -vv -t execute "$APP"
else
	echo "Gatekeeper assessment (ad-hoc is expected to be 'rejected'):"
	spctl -a -vv -t execute "$APP" || true
fi

echo "Codesign OK: ${APP}"
