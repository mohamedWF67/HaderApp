# =====================================================================
# Deploy the Workshop & Registration Service to LOCAL Floci (never real AWS).
# For teammates on Windows: one command, run from the ROOT of the HaderApp repo:
#
#   powershell -ExecutionPolicy Bypass -File services\registration\infra\deploy-registration.ps1
#
# Needs: Docker Desktop (running), AWS CLI, Node.js. No AWS account or profile needed.
# Before the first run: put services\registration\.env in place (copy .env.example and fill it in).
#
# What it does (safe to run again; it updates what already exists):
#   1. checks the tools            5. IAM role: the functions may only write their own logs
#   2. starts Floci if needed      6. two Lambda functions: the API + the scheduled checks
#   3. checks it is Floci          7. API Gateway HTTP API: only this service's routes + throttling
#   4. builds lambda.zip           8. EventBridge Scheduler: run the checks every minute
#                                  9. CloudWatch alarms (+ SNS topic) for server errors and attacks
# It only touches hader-registration-* / hader-http-api / hader-scheduler-* resources.
# =====================================================================
$ErrorActionPreference = 'Stop'
$service = Split-Path -Parent $PSScriptRoot      # ...\services\registration
Push-Location $service

$endpoint    = 'http://localhost:4566'
$region      = 'us-east-1'
$account     = '000000000000'
$fn          = 'hader-registration-api'
$checksFn    = 'hader-registration-checks'
$role        = 'hader-registration-role'
$schedRole   = 'hader-scheduler-role'
$schedule    = 'hader-registration-checks-every-minute'
$apiName     = 'hader-http-api'
$flociImage  = 'floci/floci:latest'
$tempFiles   = @()

# Fake keys + the forced localhost address mean this script can never change real AWS.
$env:AWS_ACCESS_KEY_ID = 'test'
$env:AWS_SECRET_ACCESS_KEY = 'test'
$env:AWS_DEFAULT_REGION = $region
$env:AWS_REGION = $region
$env:AWS_EC2_METADATA_DISABLED = 'true'
$env:AWS_PAGER = ''
Remove-Item Env:AWS_PROFILE -ErrorAction SilentlyContinue

function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }

# Run an AWS CLI command against Floci; stop with a clear message if it fails.
function Invoke-Floci([string[]]$CliArgs) {
  $out = & aws @CliArgs '--endpoint-url' $endpoint '--no-cli-pager' '--output' 'json'
  if ($LASTEXITCODE -ne 0) { throw "AWS CLI command failed: aws $($CliArgs -join ' ')" }
  $text = ($out | Out-String).Trim()
  if (!$text) { return $null }
  return ($text | ConvertFrom-Json)
}

# Same, but a failure is allowed (for example "already exists"). Returns $true if it worked.
function Try-Floci([string[]]$CliArgs) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & aws @CliArgs '--endpoint-url' $endpoint '--no-cli-pager' '--output' 'json' 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
  } finally { $ErrorActionPreference = $previous }
}

# Write text to a temporary file OUTSIDE the repo and return it as file://... for the AWS CLI.
# (Passing JSON straight on the command line breaks in Windows PowerShell because of quotes.)
function Temp-File([string]$text) {
  $path = [System.IO.Path]::GetTempFileName()
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
  $script:tempFiles += $path
  return ('file://' + $path.Replace('\', '/'))
}

function Floci-Answers {
  try { Invoke-WebRequest -Uri $endpoint -UseBasicParsing -TimeoutSec 3 | Out-Null; return $true }
  catch { return ($null -ne $_.Exception.Response) }   # any HTTP answer means it is up
}

# Create a Lambda function, or update its code and settings if it exists.
function Deploy-Function([string]$name, [string]$handler, [string]$envArg, $existing) {
  if ($existing -contains $name) {
    Invoke-Floci @('lambda','update-function-code','--function-name',$name,'--zip-file','fileb://lambda.zip') | Out-Null
    Try-Floci @('lambda','wait','function-updated-v2','--function-name',$name) | Out-Null
    Invoke-Floci @('lambda','update-function-configuration','--function-name',$name,'--handler',$handler,
      '--environment',$envArg,'--timeout','15') | Out-Null
    Try-Floci @('lambda','wait','function-updated-v2','--function-name',$name) | Out-Null
  } else {
    Invoke-Floci @('lambda','create-function','--function-name',$name,'--runtime','nodejs24.x',
      '--handler',$handler,'--role',"arn:aws:iam::${account}:role/${role}",
      '--zip-file','fileb://lambda.zip','--timeout','15','--memory-size','256',
      '--environment',$envArg) | Out-Null
    Try-Floci @('lambda','wait','function-active-v2','--function-name',$name) | Out-Null
  }
  Write-Host "Function $name is ready"
}

try {
  Step '1/9 Check the tools'
  if (!(Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop is not installed.' }
  if (!(Get-Command aws -ErrorAction SilentlyContinue))    { throw 'The AWS CLI is not installed: https://aws.amazon.com/cli/' }
  if (!(Get-Command node -ErrorAction SilentlyContinue))   { throw 'Node.js is not installed: https://nodejs.org' }
  if (!(Get-Command npm -ErrorAction SilentlyContinue))    { throw 'npm is not installed (it comes with Node.js).' }
  if (!(Test-Path '.env')) {
    throw "services\registration\.env is missing. Copy .env.example to .env and fill it in (never commit it)."
  }
  Write-Host 'Docker, AWS CLI, Node.js and .env found'

  Step '2/9 Start Floci (local AWS) on localhost:4566'
  if (Floci-Answers) {
    Write-Host 'Floci is already running, using it'
  } else {
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & docker info 2>&1 | Out-Null; $dockerOk = ($LASTEXITCODE -eq 0)
    # Reuse a stopped Floci container if there is one (for example the one from the lab).
    $existingFloci = (& docker ps -a --filter "ancestor=$flociImage" --format '{{.Names}}' 2>$null | Select-Object -First 1)
    $ErrorActionPreference = $previous
    if (!$dockerOk) { throw 'Docker is not running. Open Docker Desktop and wait for "Engine running".' }
    if ($existingFloci) {
      Write-Host "Starting the existing Floci container: $existingFloci"
      & docker start $existingFloci | Out-Null
    } else {
      Write-Host 'Starting a new Floci container: hader-floci'
      & docker run -d --name hader-floci -p 4566:4566 `
        -v /var/run/docker.sock:/var/run/docker.sock -v hader_floci_data:/app/data $flociImage | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { throw 'Could not start Floci in Docker.' }
    Write-Host -NoNewline 'Waiting for Floci'
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
      if (Floci-Answers) { $ready = $true; break }
      Write-Host -NoNewline '.'; Start-Sleep -Seconds 2
    }
    Write-Host ''
    if (!$ready) { throw 'Floci did not start. Check: docker logs hader-floci' }
    Write-Host 'Floci is ready'
  }

  Step '3/9 Check that we are talking to Floci'
  $identity = Invoke-Floci @('sts','get-caller-identity')
  if ($identity.Account -ne $account) { throw "Account is $($identity.Account), expected $account. This script only deploys to Floci." }
  Write-Host "OK, account $account"

  Step '4/9 Build lambda.zip (code + certificate + libraries, never .env)'
  & npm install --silent
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
  & npm run zip --silent
  if ($LASTEXITCODE -ne 0 -or !(Test-Path 'lambda.zip')) { throw 'lambda.zip was not created.' }
  $envJson = (& node scripts/lambda-env.js | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not read DATABASE_URL and SUPABASE_URL from .env.' }
  $envArg = Temp-File $envJson     # secrets go into a temporary file, deleted at the end

  Step '5/9 IAM role: the functions may only write their own logs (least privilege)'
  $roleNames = @((Invoke-Floci @('iam','list-roles')).Roles | ForEach-Object { $_.RoleName })
  if ($roleNames -notcontains $role) {
    Invoke-Floci @('iam','create-role','--role-name',$role,
      '--assume-role-policy-document','file://infra/iam/lambda-trust-policy.json') | Out-Null
    Write-Host "Role $role created"
  } else { Write-Host "Role $role already exists" }
  Invoke-Floci @('iam','put-role-policy','--role-name',$role,'--policy-name','hader-registration-logs',
    '--policy-document','file://infra/iam/registration-logs-policy.json') | Out-Null
  Write-Host 'Policy hader-registration-logs attached'

  Step '6/9 Create or update the two Lambda functions'
  $functions = @((Invoke-Floci @('lambda','list-functions')).Functions | ForEach-Object { $_.FunctionName })
  Deploy-Function $fn 'lambda.handler' $envArg $functions
  Deploy-Function $checksFn 'scheduler.handler' $envArg $functions
  Remove-Item 'lambda.zip' -Force

  Step '7/9 API Gateway: one HTTP API, only the routes this service needs'
  $api = @((Invoke-Floci @('apigatewayv2','get-apis')).Items) | Where-Object { $_.Name -eq $apiName } | Select-Object -First 1
  if (!$api) { $api = Invoke-Floci @('apigatewayv2','create-api','--name',$apiName,'--protocol-type','HTTP') }
  $apiId = $api.ApiId
  $fnArn = "arn:aws:lambda:${region}:${account}:function:${fn}"
  $integration = @((Invoke-Floci @('apigatewayv2','get-integrations','--api-id',$apiId)).Items) |
    Where-Object { $_.IntegrationUri -eq $fnArn } | Select-Object -First 1
  if (!$integration) {
    $integration = Invoke-Floci @('apigatewayv2','create-integration','--api-id',$apiId,'--integration-type','AWS_PROXY',
      '--payload-format-version','2.0','--integration-uri',$fnArn)
  }
  $routes = @(
    'GET /health', 'GET /me',
    'GET /workshops', 'POST /workshops', 'PUT /workshops/{id}', 'DELETE /workshops/{id}',
    'POST /workshops/{id}/registrations', 'GET /workshops/{id}/registrations',
    'DELETE /workshops/{id}/registrations/{registrationId}',
    'GET /registrations/me', 'DELETE /registrations/{id}',
    'POST /workshops/{id}/waitlist', 'GET /waitlist/me', 'DELETE /waitlist/{id}',
    'GET /notifications/me', 'POST /notifications/read',
    'OPTIONS /me', 'OPTIONS /workshops', 'OPTIONS /workshops/{id}', 'OPTIONS /workshops/{id}/registrations',
    'OPTIONS /workshops/{id}/registrations/{registrationId}', 'OPTIONS /registrations/me',
    'OPTIONS /registrations/{id}', 'OPTIONS /workshops/{id}/waitlist', 'OPTIONS /waitlist/me',
    'OPTIONS /waitlist/{id}', 'OPTIONS /notifications/me', 'OPTIONS /notifications/read'
  )
  $existingRoutes = @(@((Invoke-Floci @('apigatewayv2','get-routes','--api-id',$apiId)).Items) | ForEach-Object { $_.RouteKey })
  foreach ($r in $routes) {
    if ($existingRoutes -contains $r) { Write-Host "  route exists: $r" }
    else {
      Invoke-Floci @('apigatewayv2','create-route','--api-id',$apiId,'--route-key',$r,
        '--target',"integrations/$($integration.IntegrationId)") | Out-Null
      Write-Host "  route added: $r" -ForegroundColor Green
    }
  }
  $stages = @(@((Invoke-Floci @('apigatewayv2','get-stages','--api-id',$apiId)).Items) | ForEach-Object { $_.StageName })
  if ($stages -notcontains '$default') {
    Invoke-Floci @('apigatewayv2','create-stage','--api-id',$apiId,'--stage-name','$default','--auto-deploy') | Out-Null
  }
  if (Try-Floci @('apigatewayv2','update-stage','--api-id',$apiId,'--stage-name','$default',
      '--default-route-settings','ThrottlingBurstLimit=20,ThrottlingRateLimit=10')) {
    Write-Host 'Throttling on: 10 requests per second, bursts of 20 (the code also limits 100 per minute: 429)'
  } else { Write-Host 'Throttling: not supported by this Floci version (the code still limits 100 per minute: 429)' }
  if (Try-Floci @('lambda','add-permission','--function-name',$fn,'--statement-id','apigw-invoke',
      '--action','lambda:InvokeFunction','--principal','apigateway.amazonaws.com',
      '--source-arn',"arn:aws:execute-api:${region}:${account}:${apiId}/*")) {
    Write-Host "API Gateway may now call $fn (and nobody else may)"
  } else { Write-Host 'Permission for API Gateway already exists' }

  Step '8/9 EventBridge Scheduler: run the checks every minute'
  $roleNames = @((Invoke-Floci @('iam','list-roles')).Roles | ForEach-Object { $_.RoleName })
  if ($roleNames -notcontains $schedRole) {
    Invoke-Floci @('iam','create-role','--role-name',$schedRole,
      '--assume-role-policy-document','file://infra/iam/scheduler-trust-policy.json') | Out-Null
    Write-Host "Role $schedRole created (may ONLY invoke $checksFn)"
  } else { Write-Host "Role $schedRole already exists" }
  Invoke-Floci @('iam','put-role-policy','--role-name',$schedRole,'--policy-name','hader-scheduler-invoke',
    '--policy-document','file://infra/iam/scheduler-invoke-policy.json') | Out-Null
  $target = Temp-File ("{""Arn"":""arn:aws:lambda:${region}:${account}:function:${checksFn}"",""RoleArn"":""arn:aws:iam::${account}:role/${schedRole}""}")
  $scheduleArgs = @('--name',$schedule,'--schedule-expression','rate(1 minute)','--flexible-time-window','Mode=OFF','--target',$target)
  if (Try-Floci @('scheduler','get-schedule','--name',$schedule)) {
    Invoke-Floci (@('scheduler','update-schedule') + $scheduleArgs) | Out-Null
    Write-Host "Schedule $schedule updated (every minute)"
  } else {
    Invoke-Floci (@('scheduler','create-schedule') + $scheduleArgs) | Out-Null
    Write-Host "Schedule $schedule created (every minute)"
  }
  $resultFile = [System.IO.Path]::GetTempFileName(); $script:tempFiles += $resultFile
  if (Try-Floci @('lambda','invoke','--function-name',$checksFn,$resultFile)) {
    Write-Host "Checks ran once now: $(Get-Content $resultFile -Raw)"
  } else { Write-Host '(could not run the checks now; the schedule will run them within a minute)' }

  Step '9/9 CloudWatch alarms: get warned about server errors and attacks'
  # Metric filters turn matching log lines into numbers; alarms watch those numbers and
  # switch to ALARM (and notify the SNS topic) when a limit is crossed.
  $logGroup = "/aws/lambda/$fn"
  Try-Floci @('logs','create-log-group','--log-group-name',$logGroup) | Out-Null
  Invoke-Floci @('logs','put-metric-filter','--log-group-name',$logGroup,'--filter-name','hader-registration-server-errors',
    '--filter-pattern','server_error',
    '--metric-transformations','metricName=ServerErrors,metricNamespace=HaderRegistration,metricValue=1,defaultValue=0') | Out-Null
  Invoke-Floci @('logs','put-metric-filter','--log-group-name',$logGroup,'--filter-name','hader-registration-access-denied',
    '--filter-pattern','access_denied',
    '--metric-transformations','metricName=AccessDenied,metricNamespace=HaderRegistration,metricValue=1,defaultValue=0') | Out-Null
  $topicArn = (Invoke-Floci @('sns','create-topic','--name','hader-registration-alerts')).TopicArn
  Invoke-Floci @('cloudwatch','put-metric-alarm','--alarm-name','hader-registration-server-errors',
    '--alarm-description','Any 500 error in the Registration API within 5 minutes',
    '--namespace','HaderRegistration','--metric-name','ServerErrors','--statistic','Sum',
    '--period','300','--evaluation-periods','1','--threshold','1','--comparison-operator','GreaterThanOrEqualToThreshold',
    '--treat-missing-data','notBreaching','--alarm-actions',$topicArn) | Out-Null
  Invoke-Floci @('cloudwatch','put-metric-alarm','--alarm-name','hader-registration-access-denied',
    '--alarm-description','20 or more refused requests (401/403) within 5 minutes: possible attack',
    '--namespace','HaderRegistration','--metric-name','AccessDenied','--statistic','Sum',
    '--period','300','--evaluation-periods','1','--threshold','20','--comparison-operator','GreaterThanOrEqualToThreshold',
    '--treat-missing-data','notBreaching','--alarm-actions',$topicArn) | Out-Null
  Write-Host "Alarms hader-registration-server-errors and hader-registration-access-denied -> SNS $topicArn"

  $apiUrl = "http://$apiId.execute-api.localhost.floci.io:4566"
  Write-Host ''
  Write-Host "Quick test: GET $apiUrl/health"
  try { Write-Host ((Invoke-RestMethod -Uri "$apiUrl/health" -TimeoutSec 20) | ConvertTo-Json -Compress) }
  catch { Write-Host '(no answer yet: wait 30 seconds and open the address in a browser)' }

  Write-Host ''
  Write-Host 'Done.' -ForegroundColor Green
  Write-Host "  API:     $apiUrl"
  Write-Host "  Website: put this address in shared\config.js as REGISTRATION_API"
  Write-Host "  Logs:    aws logs tail /aws/lambda/$fn --since 15m --endpoint-url $endpoint"
  Write-Host "  Checks:  aws logs tail /aws/lambda/$checksFn --since 15m --endpoint-url $endpoint"
  Write-Host "  Alarms:  aws cloudwatch describe-alarms --alarm-name-prefix hader-registration --endpoint-url $endpoint --output table"
}
finally {
  foreach ($f in $tempFiles) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }
  if (Test-Path 'lambda.zip') { Remove-Item 'lambda.zip' -Force }
  Pop-Location
}
