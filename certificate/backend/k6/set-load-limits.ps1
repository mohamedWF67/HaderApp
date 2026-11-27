<#
  Raise or restore the Certificate Service limits for a k6 load test.
  All k6 users come from one IP (yours), so with the normal limits k6 would only measure
  the limiters. We do not remove them; we raise them for the run and put them back after.

  Three limits are changed:
    1. Certificate rate limiter (Lambda env vars): verify 10, generate 10, other 60 per minute per IP
    2. Certificate API Gateway stage throttling:   50 req/s (burst 100) overall, verify 5 req/s (burst 10)
    3. Registration rate limiter (hader-registration-api): 100 per minute per IP (for e2e-load-test.js)

    .\k6\set-load-limits.ps1 -Raise            # all three raised
    .\k6\set-load-limits.ps1 -Raise -NoEmail   # also stop certificate emails (for e2e-load-test.js)
    .\k6\set-load-limits.ps1 -Restore          # everything back to normal, emails back on

  Run from certificate\backend. Needs Floci running and the service already deployed.
#>
param(
  [switch]$Raise,
  [switch]$Restore,
  [switch]$NoEmail,                  # with -Raise: remove BREVO_API_KEY so generated certificates send no email
  [string]$RegistrationFunction = "hader-registration-api",
  [string]$FunctionName = "certificate-service",
  [string]$ApiName      = "workshop-api",
  [string]$Stage        = "prod",
  [string]$Limit        = "100000",  # app limiter, requests per minute
  [string]$GatewayRate  = "10000"    # gateway throttling while raised, requests per second
)

$ErrorActionPreference = "Stop"
$backend = Split-Path $PSScriptRoot -Parent
Push-Location $backend
if (-not $env:AWS_ACCESS_KEY_ID) { $env:AWS_ACCESS_KEY_ID = "test"; $env:AWS_SECRET_ACCESS_KEY = "test" }

function Floci { aws --endpoint-url http://localhost:4566 --region us-east-1 @args }

function Wait-Update([string]$fn = $FunctionName) {
  for ($i = 0; $i -lt 60; $i++) {
    $s = Floci lambda get-function-configuration --function-name $fn --query "LastUpdateStatus" --output text 2>$null
    if ($s -eq "Successful") { return }
    if ($s -eq "Failed") { throw "Lambda update failed" }
    Start-Sleep -Seconds 2
  }
  throw "Lambda update did not finish in 2 minutes"
}

function Set-GatewayThrottling([string]$rate, [string]$burst, [string]$verifyRate, [string]$verifyBurst) {
  $api = Floci apigateway get-rest-apis --query "items[?name=='$ApiName'].id | [0]" --output text
  if (-not $api -or $api -eq "None") { throw "REST API '$ApiName' not found" }
  $patch = @'
[
  { "op": "replace", "path": "/*/*/throttling/rateLimit",  "value": "RATE" },
  { "op": "replace", "path": "/*/*/throttling/burstLimit", "value": "BURST" },
  { "op": "replace", "path": "/~1certificates~1verify~1{code}/GET/throttling/rateLimit",  "value": "VRATE" },
  { "op": "replace", "path": "/~1certificates~1verify~1{code}/GET/throttling/burstLimit", "value": "VBURST" }
]
'@
  $patch = $patch.Replace("VRATE", $verifyRate).Replace("VBURST", $verifyBurst).Replace("RATE", $rate).Replace("BURST", $burst)
  $file = "stage-throttle.json"
  Set-Content -Encoding ascii $file $patch
  try {
    Floci apigateway update-stage --rest-api-id $api --stage-name $Stage --patch-operations "file://$file" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "update-stage failed" }
  } finally {
    Remove-Item $file -ErrorAction SilentlyContinue
  }
  $now = Floci apigateway get-stage --rest-api-id $api --stage-name $Stage --query "methodSettings" --output json | ConvertFrom-Json
  foreach ($p in $now.PSObject.Properties) {
    Write-Host ("   gateway {0}: {1} req/s, burst {2}" -f $p.Name, $p.Value.throttlingRateLimit, $p.Value.throttlingBurstLimit)
  }
}

# Registration's limit: the original value is saved in k6\.registration-limit so -Restore can put it back.
function Set-RegistrationLimit([switch]$Up) {
  $saved = Join-Path $PSScriptRoot ".registration-limit"
  try {
    $json = (Floci lambda get-function-configuration --function-name $RegistrationFunction --query "Environment" --output json 2>$null) | Out-String
  } catch { $json = "" }
  if (-not $json.Trim() -or $json.Trim() -eq "null") { Write-Host "   $RegistrationFunction not found, skipped"; return }
  $cfg = $json | ConvertFrom-Json
  $current = $cfg.Variables.RATE_LIMIT_PER_MINUTE
  if ($Up) {
    if (-not (Test-Path $saved)) { Set-Content $saved ($(if ($current) { $current } else { "none" })) }
    $cfg.Variables | Add-Member -NotePropertyName RATE_LIMIT_PER_MINUTE -NotePropertyValue $Limit -Force
  } else {
    $original = if (Test-Path $saved) { (Get-Content $saved -Raw).Trim() } else { "none" }
    if ($original -eq "none") { $cfg.Variables.PSObject.Properties.Remove("RATE_LIMIT_PER_MINUTE") }
    else { $cfg.Variables | Add-Member -NotePropertyName RATE_LIMIT_PER_MINUTE -NotePropertyValue $original -Force }
  }
  $tmp = "env.registration-loadtest.json"   # holds secrets: deleted straight after the update
  [IO.File]::WriteAllText((Join-Path $backend $tmp), ($cfg | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
  try {
    Floci lambda update-function-configuration --function-name $RegistrationFunction `
      --environment "file://$tmp" --cli-read-timeout 300 | Out-Null
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
  Wait-Update $RegistrationFunction
  if ($Up) { Write-Host "Registration rate limit raised to $Limit per minute" -ForegroundColor Yellow }
  else {
    Remove-Item $saved -ErrorAction SilentlyContinue
    Write-Host "Registration rate limit restored ($(if ($original -eq 'none') { 'default 100' } else { $original }) per minute)" -ForegroundColor Green
  }
}

try {
  if ($Raise -eq $Restore) { throw "Use exactly one of -Raise or -Restore" }

  if ($Restore) {
    Floci lambda update-function-configuration --function-name $FunctionName `
      --environment file://env.json --cli-read-timeout 300 | Out-Null
    Wait-Update
    Write-Host "App rate limits restored (verify 10, generate 10, other 60 per minute), emails on" -ForegroundColor Green
    Set-GatewayThrottling "50" "100" "5" "10"
    Write-Host "Gateway throttling restored (50 req/s overall, 5 req/s on verify)" -ForegroundColor Green
    Set-RegistrationLimit
    return
  }

  # 1. App limiter: env.json + raised RATE_LIMIT_* values
  $cfg = Get-Content env.json -Raw | ConvertFrom-Json
  foreach ($name in "RATE_LIMIT_VERIFY", "RATE_LIMIT_GENERATE", "RATE_LIMIT_OTHER") {
    $cfg.Variables | Add-Member -NotePropertyName $name -NotePropertyValue $Limit -Force
  }
  if ($NoEmail) { $cfg.Variables.PSObject.Properties.Remove("BREVO_API_KEY") }
  $tmp = "env.loadtest.json"   # holds secrets: deleted straight after the update
  [IO.File]::WriteAllText((Join-Path $backend $tmp), ($cfg | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
  try {
    Floci lambda update-function-configuration --function-name $FunctionName `
      --environment "file://$tmp" --cli-read-timeout 300 | Out-Null
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
  Wait-Update
  Write-Host "App rate limits raised to $Limit per minute" -ForegroundColor Yellow
  if ($NoEmail) { Write-Host "Certificate emails OFF (BREVO_API_KEY removed until -Restore)" -ForegroundColor Yellow }

  # 2. API Gateway throttling
  $burst = [string]([int]$GatewayRate * 2)
  Set-GatewayThrottling $GatewayRate $burst $GatewayRate $burst
  Write-Host "Gateway throttling raised to $GatewayRate req/s" -ForegroundColor Yellow

  # 3. Registration limiter
  Set-RegistrationLimit -Up
  Write-Host "Remember: .\k6\set-load-limits.ps1 -Restore" -ForegroundColor Yellow
}
finally {
  Pop-Location
}
