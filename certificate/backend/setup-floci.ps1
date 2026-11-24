<#
  setup-floci.ps1  -  (re)creates everything the Certificate Service needs on Floci:
    1. IAM role + least-privilege policy
    2. CloudWatch log groups (14-day retention)
    3. Lambda function (zips the code, uploads it, sets env.json)
    4. REST API "workshop-api" with the 5 certificate routes (+ OPTIONS), deployed to "prod"
    5. Stage throttling + access logs
    6. CloudWatch metric filters + alarms

  Safe to run again: it reuses what already exists and only adds what's missing.
  Run from the certificate-backend folder:   .\setup-floci.ps1
  Needs: Floci running, AWS CLI, npm, env.json filled in, infra\trust-policy.json, infra\policy.json
#>
param(
  [string]$Endpoint     = "http://localhost:4566",
  [string]$Region       = "us-east-1",
  [string]$FunctionName = "certificate-service",
  [string]$RoleName     = "certificate-service-role",
  [string]$ApiName      = "workshop-api",
  [string]$Stage        = "prod"
)

$ErrorActionPreference = "Continue"
Push-Location $PSScriptRoot
$env:AWS_ACCESS_KEY_ID = "test"; $env:AWS_SECRET_ACCESS_KEY = "test"; $env:AWS_DEFAULT_REGION = $Region
$Account  = "000000000000"
$FnArn    = "arn:aws:lambda:${Region}:${Account}:function:$FunctionName"
$RoleArn  = "arn:aws:iam::${Account}:role/$RoleName"
$LambdaLG = "/aws/lambda/$FunctionName"
$ApiLG    = "/aws/apigateway/$ApiName"

function Floci { & aws --endpoint-url $Endpoint --region $Region @args }
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "   $text" -ForegroundColor Green }
function Fail($text) { Write-Host "   $text" -ForegroundColor Red; Pop-Location; exit 1 }

# ---------------------------------------------------------------- 0. checks
Step "Checking Floci and files"
Floci sts get-caller-identity --query Account --output text | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "Cannot reach Floci at $Endpoint - is it running?" }
foreach ($f in "env.json", "infra\trust-policy.json", "infra\policy.json", "index.js", "auth.js", "db.js", "services.js", "pdf.js", "package.json") {
  if (-not (Test-Path $f)) { Fail "Missing file: $f" }
}
Ok "Floci is up, files found"

# ---------------------------------------------------------------- 1. IAM
Step "IAM role $RoleName"
Floci iam get-role --role-name $RoleName 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Floci iam create-role --role-name $RoleName --assume-role-policy-document file://infra/trust-policy.json | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "create-role failed" }
  Ok "role created"
} else { Ok "role already exists" }
Floci iam put-role-policy --role-name $RoleName --policy-name certificate-policy --policy-document file://infra/policy.json | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "put-role-policy failed" }
Ok "least-privilege policy attached (own log group only)"

# ---------------------------------------------------------------- 2. log groups
Step "CloudWatch log groups"
foreach ($lg in $LambdaLG, $ApiLG) {
  Floci logs create-log-group --log-group-name $lg 2>$null | Out-Null
  Floci logs put-retention-policy --log-group-name $lg --retention-in-days 14 | Out-Null
  Ok "$lg (14-day retention)"
}

# ---------------------------------------------------------------- 3. Lambda
Step "Lambda $FunctionName"
if (-not (Test-Path "node_modules\jose")) {
  Write-Host "   installing npm packages..." -ForegroundColor DarkGray
  & npm install --omit=dev --no-audit --no-fund | Out-Null
  if (-not (Test-Path "node_modules\jose")) { Fail "npm install failed" }
}
Remove-Item function.zip -ErrorAction SilentlyContinue
& tar -a -c -f function.zip index.js auth.js db.js services.js pdf.js package.json node_modules
if (-not (Test-Path function.zip)) { Fail "could not create function.zip" }
Ok ("function.zip built ({0:N1} MB)" -f ((Get-Item function.zip).Length / 1MB))

Floci lambda get-function --function-name $FunctionName 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Floci lambda create-function --function-name $FunctionName --runtime nodejs20.x --handler index.handler `
    --role $RoleArn --zip-file fileb://function.zip --timeout 10 --memory-size 256 `
    --environment file://env.json | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "create-function failed" }
  Ok "function created"
} else {
  Floci lambda update-function-code --function-name $FunctionName --zip-file fileb://function.zip | Out-Null
  Start-Sleep -Seconds 3
  Floci lambda update-function-configuration --function-name $FunctionName --role $RoleArn `
    --environment file://env.json --timeout 10 --memory-size 256 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "update-function failed" }
  Ok "function code + settings updated"
}

# Cap how far the function can scale during a flood: limits cost and Supabase connections (threat 6)
Floci lambda put-function-concurrency --function-name $FunctionName --reserved-concurrent-executions 20 | Out-Null
if ($LASTEXITCODE -eq 0) { Ok "reserved concurrency: 20 (flood cap)" } else { Write-Host "   concurrency cap not set" -ForegroundColor DarkYellow }

# ---------------------------------------------------------------- 4. REST API
Step "REST API $ApiName"
$Api = Floci apigateway get-rest-apis --query "items[?name=='$ApiName'].id | [0]" --output text
if (-not $Api -or $Api -eq "None") {
  $Api = Floci apigateway create-rest-api --name $ApiName --endpoint-configuration types=REGIONAL --query id --output text
  if ($LASTEXITCODE -ne 0) { Fail "create-rest-api failed" }
  Ok "API created: $Api"
} else { Ok "API already exists: $Api" }

function Get-ResId([string]$path) {
  $id = Floci apigateway get-resources --rest-api-id $Api --limit 500 --query "items[?path=='$path'].id | [0]" --output text
  if ($id -and $id -ne "None") { return $id }
  return $null
}
function Ensure-Res([string]$parentPath, [string]$part) {
  $path = if ($parentPath -eq "/") { "/$part" } else { "$parentPath/$part" }
  $id = Get-ResId $path
  if (-not $id) {
    $parent = Get-ResId $parentPath
    $id = Floci apigateway create-resource --rest-api-id $Api --parent-id $parent --path-part $part --query id --output text
    Ok "resource $path"
  }
  return $id
}
$Uri = "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/$FnArn/invocations"
function Ensure-Method([string]$resId, [string]$path, [string]$method) {
  Floci apigateway get-method --rest-api-id $Api --resource-id $resId --http-method $method 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Floci apigateway put-method --rest-api-id $Api --resource-id $resId --http-method $method --authorization-type NONE | Out-Null
  }
  Floci apigateway put-integration --rest-api-id $Api --resource-id $resId --http-method $method `
    --type AWS_PROXY --integration-http-method POST --uri $Uri | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "integration failed for $method $path" }
}

$certs  = Ensure-Res "/" "certificates"
$me     = Ensure-Res "/certificates" "me"
$id     = Ensure-Res "/certificates" "{id}"
[void](Ensure-Res "/certificates" "eligibility")
$elig   = Ensure-Res "/certificates/eligibility" "{workshopId}"
[void](Ensure-Res "/certificates" "verify")
$verify = Ensure-Res "/certificates/verify" "{code}"

$routes = @(
  @($certs,  "/certificates",                          "POST"),
  @($me,     "/certificates/me",                       "GET"),
  @($id,     "/certificates/{id}",                     "GET"),
  @($elig,   "/certificates/eligibility/{workshopId}", "GET"),
  @($verify, "/certificates/verify/{code}",            "GET")
)
foreach ($r in $routes) {
  Ensure-Method $r[0] $r[1] $r[2]
  Ensure-Method $r[0] $r[1] "OPTIONS"     # CORS preflight, answered by the Lambda
  Ok "$($r[2]) $($r[1])  (+ OPTIONS)"
}

Floci lambda add-permission --function-name $FunctionName --statement-id "apigw-$Api" `
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com `
  --source-arn "arn:aws:execute-api:${Region}:${Account}:$Api/*/*/certificates*" 2>$null | Out-Null
Ok "API Gateway allowed to invoke the Lambda"

Floci apigateway create-deployment --rest-api-id $Api --stage-name $Stage | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "create-deployment failed" }
Ok "deployed to stage '$Stage'"

# ---------------------------------------------------------------- 5. stage settings
Step "Stage throttling + access logs"
$fmt = '{\"requestId\":\"$context.requestId\",\"ip\":\"$context.identity.sourceIp\",\"method\":\"$context.httpMethod\",\"path\":\"$context.resourcePath\",\"status\":\"$context.status\"}'
@"
[
  { "op": "replace", "path": "/*/*/throttling/rateLimit",  "value": "50" },
  { "op": "replace", "path": "/*/*/throttling/burstLimit", "value": "100" },
  { "op": "replace", "path": "/~1certificates~1verify~1{code}/GET/throttling/rateLimit",  "value": "5" },
  { "op": "replace", "path": "/~1certificates~1verify~1{code}/GET/throttling/burstLimit", "value": "10" },
  { "op": "replace", "path": "/accessLogSettings/destinationArn", "value": "arn:aws:logs:${Region}:${Account}:log-group:$ApiLG" },
  { "op": "replace", "path": "/accessLogSettings/format", "value": "$fmt" }
]
"@ | Set-Content -Encoding ascii stage-patch.json
Floci apigateway update-stage --rest-api-id $Api --stage-name $Stage --patch-operations file://stage-patch.json | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "   stage settings failed (API still works)" -ForegroundColor DarkYellow }
else { Ok "50 req/s overall, 5 req/s on verify; access logs -> $ApiLG" }

# ---------------------------------------------------------------- 6. metric filters + alarms
Step "CloudWatch metric filters + alarms"
$filters = @(
  @("CertificateAccessDenied", '{ $.event = "certificate_access_denied" }', 5,  "5+ attempts to open other users' certificates in 5 min (threat 3)"),
  @("CertificateRoleDenied",   '{ $.event = "role_denied" }',               10, "10+ wrong-role requests in 5 min (threat 2)"),
  @("CertificateVerifyFailed", '{ $.event = "certificate_verify_failed" }', 20, "20+ failed verifications in 5 min - code guessing? (threat 4)"),
  @("CertificateAuthFailed",   '{ $.event = "auth_failed" }',               20, "20+ invalid logins in 5 min (threat 2)")
)
foreach ($f in $filters) {
  Floci logs put-metric-filter --log-group-name $LambdaLG --filter-name $f[0] --filter-pattern $f[1] `
    --metric-transformations "metricName=$($f[0]),metricNamespace=Certificates,metricValue=1" | Out-Null
  Floci cloudwatch put-metric-alarm --alarm-name "cert-$($f[0])" --namespace Certificates --metric-name $f[0] `
    --statistic Sum --period 300 --evaluation-periods 1 --threshold $f[2] `
    --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching `
    --alarm-description $f[3] | Out-Null
  if ($LASTEXITCODE -eq 0) { Ok "$($f[0]) -> alarm at $($f[2]) in 5 min" } else { Write-Host "   $($f[0]) failed" -ForegroundColor DarkYellow }
}

# Alarms on the Lambda's own metrics: crashes and hitting the concurrency cap (threat 6)
foreach ($m in @(@("Errors", 1, "certificate Lambda errors (crashes / 500s)"), @("Throttles", 1, "certificate Lambda hit its concurrency cap - possible flood (threat 6)"))) {
  Floci cloudwatch put-metric-alarm --alarm-name "cert-Lambda$($m[0])" --namespace AWS/Lambda --metric-name $m[0] `
    --dimensions "Name=FunctionName,Value=$FunctionName" --statistic Sum --period 300 --evaluation-periods 1 `
    --threshold $m[1] --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching `
    --alarm-description $m[2] | Out-Null
  if ($LASTEXITCODE -eq 0) { Ok "Lambda $($m[0]) -> alarm at $($m[1]) in 5 min" } else { Write-Host "   Lambda $($m[0]) alarm failed" -ForegroundColor DarkYellow }
}

# ---------------------------------------------------------------- done
$Url = "$Endpoint/execute-api/$Api/$Stage"
Remove-Item stage-patch.json -ErrorAction SilentlyContinue
Step "Done"
Write-Host "   API id : $Api"
Write-Host "   URL    : $Url" -ForegroundColor Green
Write-Host "   Test   : curl.exe -i `"$Url/certificates/verify/AAAAAAAAAAAAAAAAAAAA`"   (expect 404)"
Set-Content -Encoding ascii api-url.txt $Url
Write-Host "   (URL also saved to api-url.txt)`n"
Pop-Location
