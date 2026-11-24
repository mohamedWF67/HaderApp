# Deploy Hader Attendance to LOCAL Floci (never real AWS).
# Requirements: Docker Desktop (running), AWS CLI v2, Node.js and npm.
# Run from the project root in PowerShell: .\infra\deploy-attendance.ps1
# Manages only hader-attendance-* resources so teammates are not affected.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

$endpoint = 'http://localhost:4566'
$region = 'us-east-1'
$account = '000000000000'
$functionName = 'hader-attendance-api'
$roleName = 'hader-attendance-role'
$apiName = 'hader-attendance-http-api'
$logGroup = "/aws/lambda/$functionName"
$tempEnv = $null

# Dummy credentials + forced localhost endpoint prevent changes to real AWS.
$env:AWS_ACCESS_KEY_ID = 'test'
$env:AWS_SECRET_ACCESS_KEY = 'test'
$env:AWS_DEFAULT_REGION = $region
$env:AWS_REGION = $region
$env:AWS_EC2_METADATA_DISABLED = 'true'
$env:AWS_PAGER = ''

function Invoke-Floci {
  param([string[]]$CliArgs)
  $output = & aws @CliArgs '--endpoint-url' $endpoint '--no-cli-pager' '--output' 'json'
  if ($LASTEXITCODE -ne 0) {
    throw "Floci AWS CLI command failed: $($CliArgs[0]) $($CliArgs[1])"
  }
  if (!$output) { return $null }
  $text = ($output | Out-String).Trim()
  if (!$text) { return $null }
  return ($text | ConvertFrom-Json)
}

try {
  if (!(Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker Desktop is missing. Install/start Docker Desktop first.'
  }
  if (!(Get-Command aws -ErrorAction SilentlyContinue)) {
    throw 'AWS CLI is missing. Install AWS CLI v2 first.'
  }
  if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is missing.'
  }
  if (!(Test-Path '.env')) {
    throw 'Your .env file is missing. Do not put the database password in GitHub.'
  }

  Write-Host '[1/7] Check Floci is running' -ForegroundColor Cyan
  $identity = Invoke-Floci @('sts','get-caller-identity')
  if ($identity.Account -ne $account) {
    throw "Unexpected AWS account: $($identity.Account). This script only supports local Floci."
  }
  Write-Host "Connected to Floci account $account"

  Write-Host '[2/7] Build Lambda package' -ForegroundColor Cyan
  & node scripts/build-lambda.js
  if ($LASTEXITCODE -ne 0) {
    throw 'Packaging failed. Run: npm install serverless-http archiver'
  }
  if (!(Test-Path 'dist/attendance-lambda.zip')) {
    throw 'dist/attendance-lambda.zip was not created.'
  }

  Write-Host '[3/7] Create least-privilege IAM role' -ForegroundColor Cyan
  $roles = Invoke-Floci @('iam','list-roles')
  $role = @($roles.Roles) | Where-Object { $_.RoleName -eq $roleName } | Select-Object -First 1
  if (!$role) {
    $role = (Invoke-Floci @('iam','create-role','--role-name',$roleName,
      '--assume-role-policy-document','file://infra/iam/lambda-trust-policy.json')).Role
  }
  Invoke-Floci @('iam','put-role-policy','--role-name',$roleName,
    '--policy-name','hader-attendance-logs',
    '--policy-document','file://infra/iam/attendance-logs-policy.json') | Out-Null

  Write-Host '[4/7] Create CloudWatch Logs group' -ForegroundColor Cyan
  $groups = Invoke-Floci @('logs','describe-log-groups','--log-group-name-prefix',$logGroup)
  if (!(@($groups.logGroups) | Where-Object { $_.logGroupName -eq $logGroup })) {
    Invoke-Floci @('logs','create-log-group','--log-group-name',$logGroup) | Out-Null
  }

  Write-Host '[5/7] Create or update Lambda' -ForegroundColor Cyan
  # Secrets go into a temporary file outside the repository, then are deleted.
  $tempEnv = [System.IO.Path]::GetTempFileName()
  $envJson = & node scripts/lambda-env.js
  if ($LASTEXITCODE -ne 0) { throw 'Could not read DATABASE_URL from local .env.' }
  [System.IO.File]::WriteAllText($tempEnv, [string]$envJson,
    (New-Object System.Text.UTF8Encoding($false)))
  $environmentArg = 'file://' + $tempEnv.Replace('\', '/')
  $zipArg = 'fileb://dist/attendance-lambda.zip'

  $fnArn = "arn:aws:lambda:${region}:${account}:function:${functionName}"
  $existing = Invoke-Floci @('lambda','list-functions')
  $exists = @($existing.Functions) | Where-Object { $_.FunctionName -eq $functionName } |
    Select-Object -First 1

  if ($exists) {
    Invoke-Floci @('lambda','update-function-code',
      '--function-name',$functionName,'--zip-file',$zipArg) | Out-Null
    Invoke-Floci @('lambda','update-function-configuration',
      '--function-name',$functionName,'--environment',$environmentArg,
      '--timeout','20') | Out-Null
  } else {
    Invoke-Floci @('lambda','create-function',
      '--function-name',$functionName,
      '--runtime','nodejs22.x',
      '--handler','lambda.handler',
      '--role',"arn:aws:iam::${account}:role/${roleName}",
      '--zip-file',$zipArg,'--timeout','20','--memory-size','256',
      '--environment',$environmentArg) | Out-Null
  }

  # Remove sensitive temporary file immediately after Lambda configuration.
  Remove-Item -LiteralPath $tempEnv -Force
  $tempEnv = $null

  Write-Host '[6/7] Configure API Gateway HTTP API' -ForegroundColor Cyan
  $apis = Invoke-Floci @('apigatewayv2','get-apis')
  $api = @($apis.Items) | Where-Object { $_.Name -eq $apiName } | Select-Object -First 1
  if (!$api) {
    $api = Invoke-Floci @('apigatewayv2','create-api','--name',$apiName,'--protocol-type','HTTP')
  }
  $apiId = $api.ApiId

  $integrations = Invoke-Floci @('apigatewayv2','get-integrations','--api-id',$apiId)
  $integration = @($integrations.Items) | Where-Object { $_.IntegrationUri -eq $fnArn } |
    Select-Object -First 1
  if (!$integration) {
    $integration = Invoke-Floci @('apigatewayv2','create-integration',
      '--api-id',$apiId,'--integration-type','AWS_PROXY',
      '--payload-format-version','2.0','--integration-uri',$fnArn)
  }
  $integrationId = $integration.IntegrationId

  $routes = Invoke-Floci @('apigatewayv2','get-routes','--api-id',$apiId)
  $routeKeys = @(@($routes.Items) | ForEach-Object { $_.RouteKey })
  $wanted = @(
    'GET /health',
    'GET /workshops/{workshopId}/sessions',
    'POST /workshops/{workshopId}/sessions',
    'PATCH /workshops/{workshopId}/sessions/{sessionId}/checkin',
    'POST /workshops/{workshopId}/sessions/{sessionId}/attendance',
    'GET /workshops/{workshopId}/attendance/summary',
    'OPTIONS /{proxy+}'
  )
  foreach ($routeKey in $wanted) {
    if ($routeKeys -notcontains $routeKey) {
      Invoke-Floci @('apigatewayv2','create-route','--api-id',$apiId,
        '--route-key',$routeKey,'--target',"integrations/$integrationId") | Out-Null
      Write-Host " Added: $routeKey"
    }
  }

  $stages = Invoke-Floci @('apigatewayv2','get-stages','--api-id',$apiId)
  if (!(@($stages.Items) | Where-Object { $_.StageName -eq '$default' })) {
    Invoke-Floci @('apigatewayv2','create-stage','--api-id',$apiId,
      '--stage-name','$default','--auto-deploy') | Out-Null
  }

  # API Gateway may invoke this Lambda. The idempotent conflict is harmless.
  $permissionArgs = @('lambda','add-permission','--function-name',$functionName,
    '--statement-id','hader-attendance-api-gateway',
    '--action','lambda:InvokeFunction','--principal','apigateway.amazonaws.com',
    '--source-arn',"arn:aws:execute-api:${region}:${account}:${apiId}/*")
  # On the second deployment AWS returns a ResourceConflictException because
  # the permission already exists. PowerShell 5.1 treats native stderr as a
  # terminating error under Stop; temporarily relax handling for this call.
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $permissionOutput = & aws @permissionArgs '--endpoint-url' $endpoint '--no-cli-pager' '--output' 'json' 2>&1
    $permissionExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($permissionExitCode -ne 0) {
    if (($permissionOutput | Out-String) -match 'ResourceConflictException|already exists') {
      Write-Host ' API Gateway invoke permission already exists'
    } else {
      throw 'Could not grant API Gateway permission to invoke Lambda.'
    }
  }

  Write-Host '[7/7] Output deployment details' -ForegroundColor Cyan
  $apiUrl = "http://$apiId.execute-api.localhost.floci.io:4566"
  Write-Host ""
  Write-Host 'Your Attendance API is configured in local Floci.' -ForegroundColor Green
  Write-Host "API: $apiUrl"
  Write-Host "Test in browser: $apiUrl/health"
  Write-Host "CloudWatch logs: aws logs tail $logGroup --since 15m --endpoint-url $endpoint"
  Write-Host ""
  Write-Host 'Take screenshots of IAM, Lambda, API Gateway, CloudWatch for coursework.'
} finally {
  if ($tempEnv -and (Test-Path -LiteralPath $tempEnv)) {
    Remove-Item -LiteralPath $tempEnv -Force
  }
  Pop-Location
}
