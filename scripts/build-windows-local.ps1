# Build Orbit Windows installers (x64 and/or arm64).
#
# Usage:
#   .\scripts\build-windows-local.ps1              # both arches from product.json orbitVersion
#   .\scripts\build-windows-local.ps1 -Arch x64    # x64 only
#   .\scripts\build-windows-local.ps1 -Arch arm64  # arm64 only
#   .\scripts\build-windows-local.ps1 -SkipCompile # repackage existing out-vscode-min only
#   .\scripts\build-windows-local.ps1 -UpdateManifest  # refresh + sign update/latest.json after build
param(
	[ValidateSet('x64', 'arm64', 'both')]
	[string]$Arch = 'both',
	[switch]$SkipCompile,
	[switch]$UpdateManifest
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$product = Get-Content product.json | ConvertFrom-Json
$package = Get-Content package.json | ConvertFrom-Json
$version = $product.orbitVersion

if ($package.version -ne $version) {
	node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8').replace(/^\uFEFF/,'')); p.version='$version'; fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');"
	if ($LASTEXITCODE -ne 0) { throw 'Failed to sync package.json version' }
	Write-Host "Synced package.json version -> $version"
}

$env:NODE_OPTIONS = '--max-old-space-size=8192'

function Invoke-Gulp {
	param([string[]]$Tasks)
	foreach ($task in $Tasks) {
		Write-Host "`n>>> gulp $task"
		npm run gulp -- $task
		if ($LASTEXITCODE -ne 0) { throw "gulp $task failed with exit code $LASTEXITCODE" }
	}
}

if (-not $SkipCompile) {
	Invoke-Gulp @(
		'compile-build-with-mangling',
		'compile-non-native-extensions-build',
		'compile-extension-media-build'
	)
	Write-Host "`n>>> npm run buildreact (dev bundles for compile-client)"
	npm run buildreact
	if ($LASTEXITCODE -ne 0) { throw 'buildreact failed' }
	Write-Host "`n>>> npm run compile-client"
	npm run compile-client
	if ($LASTEXITCODE -ne 0) { throw 'compile-client failed' }
	Write-Host "`n>>> npm run buildreact:prod"
	npm run buildreact:prod
	if ($LASTEXITCODE -ne 0) { throw 'buildreact:prod failed' }
	$agentBundle = Join-Path $Root 'src\vs\workbench\contrib\orbit\browser\react\out\agent-window-tsx\index.js'
	if (-not (Test-Path $agentBundle)) {
		throw "Missing Agents React bundle: $agentBundle (buildreact:prod did not produce agent-window-tsx)"
	}
	Invoke-Gulp @('minify-vscode')
}

$architectures = if ($Arch -eq 'both') { @('x64', 'arm64') } else { @($Arch) }

foreach ($a in $architectures) {
	Write-Host "`n=== Packaging win32-$a ==="
	Invoke-Gulp @(
		"vscode-win32-$a-min-ci",
		"vscode-win32-$a-inno-updater",
		"vscode-win32-$a-system-setup"
	)

	$src = Join-Path $Root ".build\win32-$a\system-setup\VSCodeSetup.exe"
	$dest = Join-Path $Root "Orbit-$version-win32-$a-setup.exe"
	if (-not (Test-Path $src)) {
		throw "Installer not found: $src"
	}
	Copy-Item $src $dest -Force
	Write-Host "Created $dest ($([math]::Round((Get-Item $dest).Length / 1MB, 1)) MB)"
}

$pemPath = Join-Path $Root 'orbit-update-private.pem'
if ($UpdateManifest -or (Test-Path $pemPath)) {
	. (Join-Path $Root 'scripts\orbit-update-signing.ps1')
	Set-OrbitUpdateSigningKeyFromFile -Root $Root | Out-Null
	$tag = "v$version"
	$manifestArgs = @('--version', $version, '--tag', $tag, '--merge')
	foreach ($a in $architectures) {
		$exe = Join-Path $Root "Orbit-$version-win32-$a-setup.exe"
		if (Test-Path $exe) {
			$manifestArgs += @('--asset', "win32-$a=$exe")
		}
	}
	if ($manifestArgs.Count -gt 5) {
		Write-Host "`n>>> Updating and signing update/latest.json (Windows key)"
		node scripts/update-latest-json.js @manifestArgs
		if ($LASTEXITCODE -ne 0) { throw 'update-latest-json.js failed' }
	} elseif (Test-Path $pemPath) {
		Write-Host "`n>>> Signing update/latest.json (Windows key)"
		node scripts/update-latest-json.js --sign-existing
		if ($LASTEXITCODE -ne 0) { throw 'update-latest-json.js --sign-existing failed' }
	}
}

Write-Host "`nDone. Installers:"
Get-ChildItem (Join-Path $Root "Orbit-$version-win32-*-setup.exe") | Format-Table Name, @{N='SizeMB';E={[math]::Round($_.Length/1MB,1)}}, LastWriteTime
