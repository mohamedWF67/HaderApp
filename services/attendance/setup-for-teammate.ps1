# Hader Attendance | One-command local setup for teammates
# Run in PowerShell from any folder:
#   & ".\services\attendance\setup-for-teammate.ps1"
# Requires the private .env to be placed beside this script.
[CmdletBinding()]
param([switch]$SkipTests)

$ErrorActionPreference = 'Stop'
$serviceDir = $PSScriptRoot
$composeFile = Join-Path $serviceDir 'infra/docker-compose.floci.yml'
$deployFile = Join-Path $serviceDir 'infra/deploy-attendance.ps1'
$envFile = Join-Path $serviceDir '.env'

function Step([string]$message) {
    Write-Host ""
    Write-Host "[Hader Attendance] $message" -ForegroundColor Cyan
}
function Require-Command([string]$name, [string]$hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "$name is not installed or not on PATH. $hint"
    }
}
function Run-Checked([scriptblock]$command, [string]$failure) {
    & $command
    if ($LASTEXITCODE -ne 0) { throw $failure }
}

try {
    Step 'Checking prerequisites'
    Require-Command 'node' 'Install Node.js 22 or later.'
    Require-Command 'npm' 'Install Node.js (includes npm).'
    Require-Command 'docker' 'Install and start Docker Desktop.'
    Require-Command 'aws' 'Install AWS CLI v2.'
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
        throw "Missing private .env at $envFile. Copy the file Mohamed sent you here. Never commit it."
    }
    Run-Checked { docker info --format '{{.ServerVersion}}' | Out-Null } 'Docker Desktop is not running. Start it and retry.'

    Push-Location $serviceDir
    try {
        Step 'Installing Attendance dependencies'
        if (Test-Path 'package-lock.json') {
            Run-Checked { npm ci } 'npm ci failed.'
        } else {
            Run-Checked { npm install } 'npm install failed.'
        }

        if (-not $SkipTests) {
            Step 'Running Attendance tests'
            Run-Checked { npm test } 'Attendance tests failed. Deployment stopped.'
        }

        Step 'Starting local Floci'
        Run-Checked { docker compose -f $composeFile up -d } 'Could not start Floci containers.'

        Step 'Deploying Attendance Lambda and API Gateway to local Floci'
        # The deployment script reads .env securely and prints the API Gateway URL.
        # Do not echo or share the DATABASE_URL.
        & $deployFile
        if (-not $?) { throw 'Attendance deployment failed.' }

        Step 'Setup completed'
        Write-Host 'Copy the API URL printed above (the one ending in :4566).' -ForegroundColor Green
        Write-Host 'In the Certificate backend .env, set ATTENDANCE_API_URL to that full URL.'
        Write-Host 'Note: This API is LOCAL to this laptop. It is not a public Vercel backend.'
    } finally {
        Pop-Location
    }
} catch {
    Write-Host ""
    Write-Host "[Hader Attendance] Setup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
