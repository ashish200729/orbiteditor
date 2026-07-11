# Build Orbit Windows installers (x64 and/or arm64).
#
# Usage:
#   .\scripts\build-windows-local.ps1              # both arches from product.json orbitVersion
#   .\scripts\build-windows-local.ps1 -Arch x64    # x64 only
#   .\scripts\build-windows-local.ps1 -Arch arm64  # arm64 only
#   .\scripts\build-windows-local.ps1 -SkipCompile # repackage existing out-vscode-min only
param(
	[ValidateSet('x64', 'arm64', 'both')]
	[string]$Arch = 'both',
	[switch]$SkipCompile
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$product = Get-Content product.json | ConvertFrom-Json
$package = Get-Content package.json | ConvertFrom-Json
$version = $product.orbitVersion

if ($package.version -ne $version) {
	$package.version = $version
	$package | ConvertTo-Json -Depth 100 | Set-Content package.json -Encoding utf8
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
	npm run buildreact:prod
	if ($LASTEXITCODE -ne 0) { throw 'buildreact:prod failed' }
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

Write-Host "`nDone. Installers:"
Get-ChildItem (Join-Path $Root "Orbit-$version-win32-*-setup.exe") | Format-Table Name, @{N='SizeMB';E={[math]::Round($_.Length/1MB,1)}}, LastWriteTime
