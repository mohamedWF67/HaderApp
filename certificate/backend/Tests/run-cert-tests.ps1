<#
  run-cert-tests.ps1  -  automatic tests for the Certificate Service (Group 40)

  Logs in to the four test accounts, calls the certificate-service Lambda on Floci with each
  case, compares the status code with what is expected, and writes a report you can use in
  the project write-up.

  Usage (from the certificate-backend folder):
      .\run-cert-tests.ps1
      .\run-cert-tests.ps1 -PublishableKey "sb_publishable_..."

  If PowerShell says scripts are disabled, first run:
      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

  Passwords are typed when asked (hidden) and are never saved. Tokens only live in memory;
  the temporary event.json / out.json files are deleted at the end.
#>
param(
  [string]$PublishableKey = $env:SUPABASE_PUBLISHABLE_KEY,
  [string]$SupabaseUrl    = "https://lydhdtlxodhyqjhvcfdu.supabase.co",
  [string]$Endpoint       = "http://localhost:4566",
  [string]$Region         = "us-east-1",
  [string]$FunctionName   = "certificate-service",
  [string]$OwnerEmail     = "aziz@hader.test",           # attendee who owns the test certificate
  [string]$OtherEmail     = "test2@hader.test",          # attendee who does NOT own it
  [string]$OrganizerEmail = "testorganizer@hader.test",  # organizer
  [string]$NoRoleEmail    = "noroles@hader.test"         # logged in, but has no profile (so no role)
)

$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
$env:AWS_ACCESS_KEY_ID = "test"; $env:AWS_SECRET_ACCESS_KEY = "test"; $env:AWS_DEFAULT_REGION = $Region
$EventFile = "event.json"
$OutFile   = "out.json"
$stamp     = Get-Date -Format "yyyy-MM-dd_HH-mm"
$results   = New-Object System.Collections.ArrayList

# ---------------------------------------------------------------- helpers
function From-B64Url([string]$s) {
  $s = $s.Replace('-', '+').Replace('_', '/')
  switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } }
  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))
}
function To-B64Url([string]$text) {
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# Calls the Lambda directly with an API Gateway-style event (same as Test-Cert)
function Invoke-Cert([string]$Method, [string]$Path, [string]$Token, [string]$Body) {
  $ev = @{ version = "2.0"; rawPath = $Path; rawQueryString = ""; requestContext = @{ http = @{ method = $Method; sourceIp = "127.0.0.1" } }; headers = @{} }
  if ($Token) { $ev.headers.authorization = "Bearer $Token" }
  if ($Body)  { $ev.body = $Body; $ev.headers."content-type" = "application/json" }
  $ev | ConvertTo-Json -Depth 5 -Compress | Set-Content -Encoding ascii $EventFile
  if (Test-Path $OutFile) { Remove-Item $OutFile }
  # (no 2>&1 here: in Windows PowerShell 5.1 that turns any AWS CLI warning into a fatal error)
  $cli = & aws --endpoint-url $Endpoint --region $Region lambda invoke --function-name $FunctionName `
           --cli-binary-format raw-in-base64-out --payload "fileb://$EventFile" $OutFile
  if ($LASTEXITCODE -ne 0) { throw "aws CLI failed (exit code $LASTEXITCODE) - see the error printed above" }
  if ("$cli" -match '"FunctionError"') { throw "Lambda crashed: $(Get-Content $OutFile -Raw)" }
  Get-Content $OutFile -Raw | ConvertFrom-Json
}

function Get-Token([string]$Email) {
  $secure = Read-Host "  Password for $Email (hidden, Enter to skip)" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if (-not $plain) { Write-Host "    skipped" -ForegroundColor DarkYellow; return $null }
    $body = @{ email = $Email; password = $plain } | ConvertTo-Json
    $r = Invoke-RestMethod -Method Post -Uri "$SupabaseUrl/auth/v1/token?grant_type=password" `
           -Headers @{ apikey = $PublishableKey } -ContentType "application/json" -Body $body
    $claims = (From-B64Url $r.access_token.Split('.')[1]) | ConvertFrom-Json
    Write-Host "    logged in (role comes from the profiles table)" -ForegroundColor DarkGray
    return $r.access_token
  } catch {
    Write-Host "    login FAILED: $($_.Exception.Message)" -ForegroundColor Red
    return $null
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $plain = $null
  }
}

function Short-Body($r) {
  if ($r.headers.'Content-Type' -eq 'application/pdf') { return "PDF" }
  $b = [string]$r.body
  if ($b.Length -gt 80) { $b = $b.Substring(0, 77) + "..." }
  return $b
}

# One test case. $Call returns the Lambda response; $Check (optional) returns "" if fine or a reason.
function Test-Case([string]$Id, [string]$Name, [string]$Threat, [int]$Expected, [scriptblock]$Call, [scriptblock]$Check, [bool]$Skip = $false) {
  if ($Skip) {
    $row = [pscustomobject]@{ Id = $Id; Test = $Name; Threat = $Threat; Expected = $Expected; Actual = "-"; Result = "SKIPPED"; Detail = "no token for this account" }
  } else {
    try {
      $r = & $Call
      $actual = [int]$r.statusCode
      $detail = Short-Body $r
      $ok = ($actual -eq $Expected)
      if ($ok -and $Check) { $why = & $Check $r; if ($why) { $ok = $false; $detail = $why } }
      $row = [pscustomobject]@{ Id = $Id; Test = $Name; Threat = $Threat; Expected = $Expected; Actual = $actual; Result = $(if ($ok) { "PASS" } else { "FAIL" }); Detail = $detail }
    } catch {
      $row = [pscustomobject]@{ Id = $Id; Test = $Name; Threat = $Threat; Expected = $Expected; Actual = "ERR"; Result = "FAIL"; Detail = $_.Exception.Message }
    }
  }
  [void]$results.Add($row)
  $color = @{ PASS = "Green"; FAIL = "Red"; SKIPPED = "DarkYellow" }[$row.Result]
  Write-Host ("  [{0,-7}] {1,-5} {2,-52} expected {3}, got {4}" -f $row.Result, $Id, $Name, $Expected, $row.Actual) -ForegroundColor $color
  if ($row.Result -eq "FAIL") { Write-Host "            $($row.Detail)" -ForegroundColor Red }
}

# ---------------------------------------------------------------- setup
Write-Host "`nCertificate Service tests  -  $stamp`n" -ForegroundColor Cyan
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { Write-Host "AWS CLI not found." -ForegroundColor Red; Pop-Location; exit 1 }
& aws --endpoint-url $Endpoint lambda get-function --function-name $FunctionName | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "Cannot reach '$FunctionName' on $Endpoint. Is Floci running?" -ForegroundColor Red; Pop-Location; exit 1 }

if (-not $PublishableKey) { $PublishableKey = Read-Host "Supabase publishable (anon) key" }

Write-Host "Logging in test accounts:" -ForegroundColor Cyan
$owner = Get-Token $OwnerEmail
$other = Get-Token $OtherEmail
$org   = Get-Token $OrganizerEmail
$none  = Get-Token $NoRoleEmail

# Find the owner's certificate (id + verification code) to test against
$certId = $null; $code = $null; $certWorkshop = $null
if ($owner) {
  try {
    $me = Invoke-Cert GET "/certificates/me" $owner
    $first = ((ConvertFrom-Json $me.body).certificates | Select-Object -First 1)
    if ($first) { $certId = $first.certificate_id; $code = $first.verification_code; $certWorkshop = $first.workshop_id
      Write-Host "  Using certificate $certId (code $code)`n" -ForegroundColor DarkGray }
    else { Write-Host "  $OwnerEmail has no certificate - insert the test certificate first.`n" -ForegroundColor DarkYellow }
  } catch { Write-Host "  Could not read $OwnerEmail's certificates: $($_.Exception.Message)`n" -ForegroundColor Red }
}
$fakeUuid = "00000000-0000-4000-8000-000000000000"
$haveCert = [bool]$certId

# Forged tokens built from a real one (signature no longer matches the content)
$forgedSig = $null; $forgedRole = $null
if ($owner) {
  $p = $owner.Split('.')
  $forgedSig = "$($p[0]).$($p[1]).$($p[2].Substring(0, $p[2].Length - 6))AAAAAA"
}
if ($none) {
  $p = $none.Split('.')
  $claims = (From-B64Url $p[1]) | ConvertFrom-Json
  $claims.app_metadata | Add-Member -Force -NotePropertyName role -NotePropertyValue "attendee"
  $forgedRole = "$($p[0]).$(To-B64Url ($claims | ConvertTo-Json -Depth 10 -Compress)).$($p[2])"
}

# ---------------------------------------------------------------- tests
Write-Host "No login / public:" -ForegroundColor Cyan
Test-Case "1.1" "Verify a made-up code"                    "T4" 404 { Invoke-Cert GET "/certificates/verify/AAAAAAAAAAAAAAAAAAAA" }
Test-Case "1.3" "Verify with SQL injection text"           "T5" 404 { Invoke-Cert GET "/certificates/verify/1' OR 1=1--" }
Test-Case "1.4" "CORS preflight (OPTIONS)"                 "-"  204 { Invoke-Cert OPTIONS "/certificates" }
Test-Case "1.5" "My certificates without a token"          "T2" 401 { Invoke-Cert GET "/certificates/me" }
Test-Case "1.6" "Token with a broken signature"            "T2" 401 { Invoke-Cert GET "/certificates/me" $forgedSig } $null (-not $forgedSig)
Test-Case "1.7" "Token edited to say role=attendee"        "T2" 401 { Invoke-Cert GET "/certificates/me" $forgedRole } $null (-not $forgedRole)

Write-Host "`nOwner ($OwnerEmail, attendee):" -ForegroundColor Cyan
Test-Case "2.1" "My certificates"                          "-"  200 { Invoke-Cert GET "/certificates/me" $owner } `
  { param($r) if (-not (ConvertFrom-Json $r.body).certificates) { "no certificates returned" } } (-not $owner)
Test-Case "2.3" "Download a certificate that doesn't exist" "T3" 404 { Invoke-Cert GET "/certificates/$fakeUuid" $owner } $null (-not $owner)
Test-Case "2.4" "Download with a malformed id"             "T5" 404 { Invoke-Cert GET "/certificates/not-a-real-id" $owner } $null (-not $owner)
Test-Case "2.5" "Generate with no body"                    "T5" 400 { Invoke-Cert POST "/certificates" $owner } $null (-not $owner)

Write-Host "`nOther attendee ($OtherEmail):" -ForegroundColor Cyan
Test-Case "3.1" "My certificates (sees only own)"          "T3" 200 { Invoke-Cert GET "/certificates/me" $other } `
  { param($r) if ($certId -and ((ConvertFrom-Json $r.body).certificates | Where-Object { $_.certificate_id -eq $certId })) { "can see the owner's certificate!" } } (-not $other)
Test-Case "3.2" "Download the owner's certificate"         "T3" 403 { Invoke-Cert GET "/certificates/$certId" $other } $null (-not ($other -and $haveCert))

Write-Host "`nOrganizer ($OrganizerEmail):" -ForegroundColor Cyan
Test-Case "4.1" "My certificates"                          "T2" 403 { Invoke-Cert GET "/certificates/me" $org } $null (-not $org)
Test-Case "4.2" "Download the owner's certificate"         "T2" 403 { Invoke-Cert GET "/certificates/$certId" $org } $null (-not ($org -and $haveCert))
Test-Case "4.3" "Check eligibility"                        "T2" 403 { Invoke-Cert GET "/certificates/eligibility/1" $org } $null (-not $org)

Write-Host "`nNo profile / no role ($NoRoleEmail):" -ForegroundColor Cyan
Test-Case "5.1" "My certificates"                          "T2" 403 { Invoke-Cert GET "/certificates/me" $none } $null (-not $none)
Test-Case "5.2" "Download the owner's certificate"         "T2" 403 { Invoke-Cert GET "/certificates/$certId" $none } $null (-not ($none -and $haveCert))

Write-Host "`nRevoke (organizer only, own workshops only - nothing is actually revoked here):" -ForegroundColor Cyan
$reason = '{"reason":"automated test - must be refused"}'
Test-Case "7.1" "Revoke without a token"                   "T2" 401 { Invoke-Cert PATCH "/certificates/$fakeUuid/revoke" $null $reason }
Test-Case "7.2" "Attendee revokes own certificate"         "T2" 403 { Invoke-Cert PATCH "/certificates/$certId/revoke" $owner $reason } $null (-not ($owner -and $haveCert))
Test-Case "7.3" "No-role user revokes"                     "T2" 403 { Invoke-Cert PATCH "/certificates/$fakeUuid/revoke" $none $reason } $null (-not $none)
Test-Case "7.4" "Organizer revokes with no reason"         "T5" 400 { Invoke-Cert PATCH "/certificates/$fakeUuid/revoke" $org '{}' } $null (-not $org)
Test-Case "7.5" "Organizer revokes with a 500-char reason" "T5" 400 { Invoke-Cert PATCH "/certificates/$fakeUuid/revoke" $org ('{"reason":"' + ('x' * 500) + '"}') } $null (-not $org)
Test-Case "7.6" "Organizer revokes a certificate that doesn't exist" "T3" 404 { Invoke-Cert PATCH "/certificates/$fakeUuid/revoke" $org $reason } $null (-not $org)
Test-Case "7.7" "Attendee lists a workshop's certificates" "T2" 403 { Invoke-Cert GET "/certificates/workshop/1" $owner } $null (-not $owner)

Write-Host "`nRate limit (runs last: it uses up this minute's verify allowance):" -ForegroundColor Cyan
Test-Case "6.1" "12 verifies in a row -> the last is refused" "T4/T6" 429 {
  $last = $null
  for ($i = 0; $i -lt 12; $i++) { $last = Invoke-Cert GET "/certificates/verify/AAAAAAAAAAAAAAAAAAAA" }
  $last
} { param($r) if (-not $r.headers.'Retry-After') { "no Retry-After header" } }

# ---------------------------------------------------------------- report
$pass = @($results | Where-Object Result -eq "PASS").Count
$fail = @($results | Where-Object Result -eq "FAIL").Count
$skip = @($results | Where-Object Result -eq "SKIPPED").Count
$color = $(if ($fail) { "Red" } else { "Green" })
Write-Host "`n$pass passed, $fail failed, $skip skipped (of $($results.Count))`n" -ForegroundColor $color

$csv = "test-results_$stamp.csv"
$md  = "test-results_$stamp.md"
$results | Export-Csv -NoTypeInformation -Encoding UTF8 $csv
$lines = @("# Certificate Service test results", "", "Run: $stamp  |  Function: $FunctionName on $Endpoint", "",
           "**$pass passed, $fail failed, $skip skipped**", "",
           "| # | Test | Threat | Expected | Actual | Result |", "|---|---|---|---|---|---|")
foreach ($r in $results) { $lines += "| $($r.Id) | $($r.Test) | $($r.Threat) | $($r.Expected) | $($r.Actual) | $($r.Result) |" }
$lines += "", "Threats: T2 = role escalation / forged login, T3 = another user's certificate, T4 = fake certificate, T5 = injection / bad input, T6 = flood (rate limit)."
$lines | Set-Content -Encoding UTF8 $md
Write-Host "Report saved: $md and $csv" -ForegroundColor Cyan

# Clean up: temp files contain a token
Remove-Item $EventFile, $OutFile -ErrorAction SilentlyContinue
$owner = $other = $org = $none = $forgedSig = $forgedRole = $null
Pop-Location
exit $fail
