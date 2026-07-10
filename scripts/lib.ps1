# Shared auth + fetch helpers for the report refresh pipeline.
# Signs the Google service-account JWT with .NET (no OpenSSL dependency), so it
# runs unchanged on a GitHub Actions windows runner or locally.
#
# Credential source (first that is set wins):
#   $env:GOOGLE_SA_KEY_JSON  -> the full service-account JSON as a string (CI secret)
#   $env:GOOGLE_SA_KEY_FILE  -> path to the service-account JSON file (local)
# Falls back to the local dev key path if neither is set.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-SACredential {
    if ($env:GOOGLE_SA_KEY_JSON) { return ($env:GOOGLE_SA_KEY_JSON | ConvertFrom-Json) }
    $path = $env:GOOGLE_SA_KEY_FILE
    if (-not $path) { $path = "C:\Users\VIKASH PATHAK\Desktop\Service account\sheetdata-501810-53e5bf991483.json" }
    if (-not (Test-Path $path)) { throw "Service-account key not found. Set GOOGLE_SA_KEY_JSON or GOOGLE_SA_KEY_FILE." }
    return (Get-Content -Raw -Path $path | ConvertFrom-Json)
}

function ConvertTo-Base64Url([byte[]]$bytes) {
    return [Convert]::ToBase64String($bytes) -replace '\+','-' -replace '/','_' -replace '='
}

$script:AccessToken = $null
$script:TokenExpiry = 0

function Find-OpenSSL {
    $cmd = Get-Command openssl -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @(
        "C:\Program Files\Git\mingw64\bin\openssl.exe",
        "C:\Program Files\Git\usr\bin\openssl.exe",
        "C:\Program Files\OpenSSL-Win64\bin\openssl.exe")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# RSA-SHA256 sign. Uses .NET RSA.ImportFromPem when available (pwsh 7 / .NET Core,
# e.g. GitHub Actions), otherwise falls back to OpenSSL (Windows PowerShell 5.1).
function Invoke-RS256Sign([string]$SigningInput, [string]$PrivateKeyPem) {
    $rsa = [System.Security.Cryptography.RSA]::Create()
    $hasPem = ($rsa | Get-Member -Name 'ImportFromPem' -MemberType Method) -ne $null
    if ($hasPem) {
        try {
            $rsa.ImportFromPem($PrivateKeyPem.ToCharArray())
            return $rsa.SignData(
                [System.Text.Encoding]::ASCII.GetBytes($SigningInput),
                [System.Security.Cryptography.HashAlgorithmName]::SHA256,
                [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
        } finally { $rsa.Dispose() }
    }
    $rsa.Dispose()
    $openssl = Find-OpenSSL
    if (-not $openssl) { throw "No RSA signing method available (need pwsh 7 or OpenSSL)." }
    $keyTmp  = Join-Path $env:TEMP ("sa_" + [guid]::NewGuid().ToString('N') + ".pem")
    $dataTmp = Join-Path $env:TEMP ("jd_" + [guid]::NewGuid().ToString('N') + ".txt")
    $sigTmp  = Join-Path $env:TEMP ("js_" + [guid]::NewGuid().ToString('N') + ".bin")
    try {
        Set-Content -Path $keyTmp -Value $PrivateKeyPem -NoNewline -Encoding ascii
        [System.IO.File]::WriteAllText($dataTmp, $SigningInput, (New-Object System.Text.ASCIIEncoding))
        & $openssl dgst -sha256 -sign $keyTmp -out $sigTmp $dataTmp 2>$null
        if ($LASTEXITCODE -ne 0) { throw "openssl signing failed (exit $LASTEXITCODE)" }
        return [System.IO.File]::ReadAllBytes($sigTmp)
    } finally {
        Remove-Item $keyTmp,$dataTmp,$sigTmp -Force -ErrorAction SilentlyContinue
    }
}

function Get-AccessToken {
    $nowUnix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    if ($script:AccessToken -and $nowUnix -lt ($script:TokenExpiry - 120)) { return $script:AccessToken }

    $cred = Get-SACredential
    $exp = $nowUnix + 3600
    $headerJson = '{"alg":"RS256","typ":"JWT"}'
    $scope = "https://www.googleapis.com/auth/spreadsheets.readonly"
    $claimJson = "{`"iss`":`"$($cred.client_email)`",`"scope`":`"$scope`",`"aud`":`"$($cred.token_uri)`",`"exp`":$exp,`"iat`":$nowUnix}"
    $headerB64 = ConvertTo-Base64Url ([System.Text.Encoding]::UTF8.GetBytes($headerJson))
    $claimB64  = ConvertTo-Base64Url ([System.Text.Encoding]::UTF8.GetBytes($claimJson))
    $signingInput = "$headerB64.$claimB64"
    $sigBytes = Invoke-RS256Sign -SigningInput $signingInput -PrivateKeyPem $cred.private_key
    $jwt = "$signingInput." + (ConvertTo-Base64Url $sigBytes)

    $resp = Invoke-RestMethod -Uri $cred.token_uri -Method Post -Body @{
        grant_type = "urn:ietf:params:oauth:grant-type:jwt-bearer"; assertion = $jwt
    }
    $script:AccessToken = $resp.access_token
    $script:TokenExpiry = $nowUnix + [int]$resp.expires_in
    return $script:AccessToken
}

function Get-SheetValues([string]$SpreadsheetId, [string]$Range, [int]$TimeoutSec = 120) {
    $encoded = [uri]::EscapeDataString($Range)
    $uri = "https://sheets.googleapis.com/v4/spreadsheets/$SpreadsheetId/values/$encoded"
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            $token = Get-AccessToken
            $resp = Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $token" } -TimeoutSec $TimeoutSec
            return $resp.values
        } catch {
            Write-Host "  fetch '$Range' attempt $attempt failed: $($_.Exception.Message)"
            Start-Sleep -Seconds (4 * $attempt)
        }
    }
    throw "Failed to fetch range '$Range' after 5 attempts"
}

# Fetch a large sheet in row chunks (returns array of row arrays, no header).
function Get-SheetRowsChunked([string]$SpreadsheetId, [string]$SheetName, [string]$LastCol, [int]$TotalRows, [int]$ChunkSize = 10000) {
    $all = New-Object System.Collections.Generic.List[object]
    $start = 2
    while ($start -le $TotalRows) {
        $end = [math]::Min($start + $ChunkSize - 1, $TotalRows)
        $rows = Get-SheetValues $SpreadsheetId "$SheetName!A$start`:$LastCol$end"
        if ($rows) { foreach ($r in $rows) { $all.Add($r) } }
        Write-Host "  fetched $SheetName rows $start-$end ($($all.Count) total)"
        $start = $end + 1
    }
    return $all
}
