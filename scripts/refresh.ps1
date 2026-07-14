# Orchestrator: regenerates every brand's report at the repo root.
# Run locally or from GitHub Actions. Requires a credential source (see lib.ps1):
#   CI  -> $env:GOOGLE_SA_KEY_JSON (GitHub secret)
#   local -> $env:GOOGLE_SA_KEY_FILE or the default dev key path.
param([switch]$Quick)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$Here\brands.ps1"
for ($i = 0; $i -lt $Brands.Count; $i++) {
    Write-Host "=== Generating $($Brands[$i].Brand) ==="
    & "$Here\Generate-Report.ps1" -BrandIndex $i -Quick:$Quick
}
Write-Host "All reports regenerated."
