# Building Orbit for macOS

Guide for building a distributable `.app` and `.dmg` on macOS (Apple Silicon and Intel).

## Prerequisites

- macOS with **Xcode** (Command Line Tools or full Xcode)
- **Node.js 20.18.2** — run `nvm use` in the repo root (see `.nvmrc`)
- **GNU libtool** — macOS ships BSD libtool by default; install GNU if you see `libtool: error: unrecognised option: '-static'`
- **create-dmg** — `brew install create-dmg`
- Repo path must **not contain spaces**

```bash
git clone https://github.com/ashish200729/orbiteditor
cd orbiteditor
nvm use
npm install
```

## Publish to GitHub + enable auto-update (recommended)

One command builds, creates a DMG, uploads to GitHub Releases, and updates `update/latest.json` with SHA-256 hashes:

```bash
# Bump product.json → orbitVersion (or pass version explicitly)
./scripts/publish-release.sh 0.2.0 arm64
```

This also pushes the updated `update/latest.json` to `origin main` itself — that's the file every client reads, so there's no separate manual push step to forget. Pass `SKIP_MANIFEST_PUSH=1` to commit the manifest locally without pushing (e.g. to review the diff first).

Users on older builds get an in-app notification within seconds to a few hours. They click **Install update** — Orbit verifies the downloaded DMG actually mounts and the install location is writable, then copies itself to `/Applications` and relaunches. If that verification fails (corrupt download, no write permission), Orbit now shows an error notification and stays running instead of quitting into a broken state.

Requirements: `brew install create-dmg gh` (GitHub CLI authenticated).

## Quick build (script)

Builds Apple Silicon (`arm64`) by default. Add `--dmg` to create a disk image. Use `--low-mem` on 16 GB machines.

```bash
./scripts/build-macos-local.sh arm64 --dmg --low-mem   # Apple Silicon
./scripts/build-macos-local.sh x64 --dmg --low-mem     # Intel Mac
```

**Output:**

| Artifact | Location |
|----------|----------|
| `.app` bundle | `../Orbit-darwin-arm64/` (one folder above the repo) |
| `.dmg` | `Orbit-<version>-darwin-arm64.dmg` in the repo root |

Version comes from `product.json` → `orbitVersion`.

## Low-memory build (16 GB RAM)

The default `vscode-darwin-*-min` gulp task runs **symbol mangling**, which can spike past 16 GB and get killed with `Killed: 9`. Use this split pipeline instead — same result, much lower peak RAM:

```bash
cd orbiteditor
nvm use

# 1. React UI (required before any production build)
npm run buildreact

# 2. Compile without mangling
NODE_OPTIONS="--max-old-space-size=6144" npm run gulp -- compile-build-without-mangling

# 3. Extensions
rm -rf .build/extensions
NODE_OPTIONS="--max-old-space-size=6144" npm run gulp -- compile-non-native-extensions-build
NODE_OPTIONS="--max-old-space-size=6144" npm run gulp -- compile-extension-media-build

# 4. Bundle + minify
NODE_OPTIONS="--max-old-space-size=6144" npm run gulp -- minify-vscode

# 5. Package .app
NODE_OPTIONS="--max-old-space-size=6144" npm run gulp -- vscode-darwin-arm64-min-ci
```

Replace `arm64` with `x64` for Intel. Sign the app, then create the DMG:

```bash
./scripts/codesign-macos.sh "../Orbit-darwin-arm64/Orbit.app"

VERSION=$(node -p "require('./product.json').orbitVersion")
create-dmg \
  --volname "Orbit" \
  --window-pos 200 120 \
  --window-size 800 400 \
  --icon-size 100 \
  --app-drop-link 600 185 \
  "Orbit-${VERSION}-darwin-arm64.dmg" \
  "../Orbit-darwin-arm64"
```

**Tips before building:**

- Quit heavy apps (Chrome, Docker, other Electron apps)
- Check memory: `memory_pressure`
- If still killed, lower heap: `NODE_OPTIONS="--max-old-space-size=4096"`

## Full release (build + DMG + GitHub)

```bash
./scripts/release-local.sh                  # darwin-arm64 from product.json version
./scripts/release-local.sh 0.2.0 darwin-arm64
SKIP_GH_RELEASE=1 ./scripts/release-local.sh   # build only, skip gh upload
```

Requires `gh` CLI for automatic GitHub release upload. After publishing, commit the updated manifest:

```bash
git add update/latest.json product.json
git commit -m "Release v0.2.0"
git push origin main
git push origin v0.2.0
```

## CI build (GitHub Actions)

Push a version tag to trigger the full multi-platform release:

```bash
# Bump product.json orbitVersion first, then:
git tag v0.2.0
git push origin v0.2.0
```

Workflow: `.github/workflows/build-release.yml` — builds macOS (arm64 + x64), Linux, Windows, and uploads to GitHub Releases.

Manual macOS-only CI: `.github/workflows/build-macos.yml` (workflow_dispatch).

## Developer mode (not for distribution)

For day-to-day development, do **not** run a full production build. Use watch mode instead:

```bash
npm run watch          # or Cmd+Shift+B in VS Code
./scripts/code.sh      # launch Orbit dev window
```

First compile takes ~5 minutes. Reload with Cmd+R after code changes.

## Troubleshooting

### `Killed: 9` during compile

Out-of-memory. Use the [low-memory build](#low-memory-build-16-gb-ram) above.

### `Found non-ascii character ⚡ in the minified output`

Emoji inside **regex literals** in React/TS source breaks esbuild minify. Use Unicode escapes instead:

```ts
// Bad
/Build success|⚡|success in \d+ms/i

// Good
/Build success|\u26A1|success in \d+ms/i
```

Then `npm run buildreact` and re-run minify.

### `The SUID sandbox helper binary was found, but is not configured correctly`

```bash
sudo chown root:root .build/electron/chrome-sandbox
sudo chmod 4755 .build/electron/chrome-sandbox
./scripts/code.sh
```

### `libtool: error: unrecognised option: '-static'`

Install GNU libtool (`brew install libtool`) and ensure it is ahead of the system one in `PATH`.

### "Orbit is damaged and can't be opened" / Gatekeeper blocks the app

Every build path (`build-macos-local.sh`, `build-macos-lowmem.sh`, `release-local.sh`, `publish-release.sh`, and both GitHub Actions workflows) runs `scripts/codesign-macos.sh` automatically. Without a real Apple Developer ID (see below), this **ad-hoc signs** the app. The script signs the Electron bundle **inner → outer** (nested `.dylib`/`.node`, then the Helper `.app`s, then frameworks, then the outer app) rather than relying on `codesign --deep`, which is unreliable on Electron bundles and can produce a seal that breaks when the DMG is copied to another Mac — the usual cause of "is damaged" reappearing on someone else's machine. A valid ad-hoc seal is enough to stop the fatal "is damaged" dialog on Apple Silicon, but Gatekeeper will still show "Apple could not verify this app is free of malware" on first launch, since ad-hoc signing has no verifiable publisher identity. This is expected until real signing + notarization is configured.

> **Distribution:** point users to **[orbiteditorai.com](https://orbiteditorai.com)** for downloads. If a browser-downloaded DMG shows a Gatekeeper warning, users can right-click → Open, or use System Settings → Privacy & Security → Open Anyway.

To open a browser-downloaded DMG build anyway:

- Right-click (or Control-click) `Orbit.app` → **Open** → **Open Anyway**, or
- System Settings → Privacy & Security → scroll to the blocked-app notice → **Open Anyway**, or

If you instead see the old **"is damaged and can't be opened. You should move it to the Bin."** message, the DMG was built before signing was wired in — rebuild it.

## Code signing

`scripts/codesign-macos.sh` is called automatically by every build/publish path. It no-ops into ad-hoc signing when no Apple credentials are present, and switches to real Developer ID signing the moment this env var (or a GitHub Actions secret of the same name) is set:

| Variable | Purpose |
|----------|---------|
| `MACOS_CODESIGN_IDENTITY` | A `"Developer ID Application: <Name> (<TeamID>)"` identity string from `security find-identity -v -p codesigning` |

Requires an active [Apple Developer Program](https://developer.apple.com/programs/) membership ($99/yr). Once you have a Developer ID Application certificate installed in your local keychain (or added as a GitHub Actions secret for CI), no script changes are needed:

```bash
MACOS_CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID1234)" \
./scripts/release-macos.sh 0.2.0
```

Entitlements are scoped per Electron process under `build/azure-pipelines/darwin/`.

Note: real Developer ID signing alone still isn't enough to fully clear Gatekeeper — Apple also requires notarization (`xcrun notarytool` + `xcrun stapler`) for a download to open with zero prompts. That's not wired in currently; ad-hoc signing is the fix in place today (see Troubleshooting above for what that means for end users).

The upstream VS Code Azure/ESRP signing pipeline under `build/azure-pipelines/**` and `build/darwin/sign.js` is Microsoft-internal tooling, not used by Orbit's release process — ignore it.

## Architecture reference

| Mac type | Gulp arch | Asset key in `update/latest.json` |
|----------|-----------|-----------------------------------|
| Apple Silicon (M1–M4) | `arm64` | `darwin-arm64` |
| Intel | `x64` | `darwin-x64` |

All Apple Silicon chips share one `arm64` binary — no separate M1/M2/M4 builds needed.

## Auto-update system

| Component | Location |
|-----------|----------|
| Manifest | `update/latest.json` on `main` branch |
| Updater service | `src/vs/workbench/contrib/orbit/electron-main/orbitUpdateMainService.ts` |
| UI notifications | `src/vs/workbench/contrib/orbit/browser/orbitUpdateActions.ts` |
| Manifest tool | `scripts/update-latest-json.js` |

**Flow:** App checks manifest → downloads DMG if newer → shows notification → user clicks Install → macOS copies to `/Applications` and relaunches.

**Manual check:** Command Palette → `Orbit: Check for Updates`
