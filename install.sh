#!/usr/bin/env bash
set -euo pipefail

REPO="${ORBIT_UPDATE_REPO:-ashish200729/orbiteditor}"
REF="${ORBIT_INSTALL_REF:-main}"
RAW_BASE="${ORBIT_INSTALL_BASE_URL:-https://raw.githubusercontent.com/$REPO/$REF/scripts}"
MANIFEST_URL="${ORBIT_UPDATE_MANIFEST_URL:-${MANIFEST_URL:-https://raw.githubusercontent.com/$REPO/$REF/update/latest.json}}"

case "$(uname -s)" in
	Linux)
		SCRIPT=install-linux.sh
		;;
	Darwin)
		SCRIPT=install-macos.sh
		;;
	*)
		echo "Orbit's installer supports Linux and macOS. Detected: $(uname -s)" >&2
		exit 1
		;;
esac

TMP_SCRIPT="$(mktemp)"
trap 'rm -f "$TMP_SCRIPT"' EXIT
curl --fail --location --silent --show-error "$RAW_BASE/$SCRIPT" --output "$TMP_SCRIPT"
ORBIT_UPDATE_REPO="$REPO" ORBIT_UPDATE_MANIFEST_URL="$MANIFEST_URL" MANIFEST_URL="$MANIFEST_URL" bash "$TMP_SCRIPT"
