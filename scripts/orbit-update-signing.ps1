$script:OrbitUpdatePrivateKeyFile = 'orbit-update-private.pem'
function Get-OrbitRepoRoot {
	param([string]$StartPath = $PSScriptRoot)
	Split-Path -Parent $StartPath
}
function Get-OrbitUpdatePrivateKeyPath {
	param([string]$Root = (Get-OrbitRepoRoot))
	Join-Path $Root $script:OrbitUpdatePrivateKeyFile
}
function Set-OrbitUpdateSigningKeyFromFile {
	param(
		[string]$Root = (Get-OrbitRepoRoot),
		[string]$KeyPath = (Get-OrbitUpdatePrivateKeyPath -Root $Root)
	)
	if (-not (Test-Path $KeyPath)) {
		throw "Windows update signing key not found: $KeyPath"
	}
	$env:ORBIT_UPDATE_SIGNING_KEY = Get-Content -Raw $KeyPath
	return $KeyPath
}
