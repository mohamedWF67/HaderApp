$env:AWS_DEFAULT_REGION = "us-east-1"
$env:AWS_ACCESS_KEY_ID = "test"
$env:AWS_SECRET_ACCESS_KEY = "test"
$e = "http://localhost:4566"

function Test-Cert($method, $path, $token) {
  $ev = @{ rawPath = $path; requestContext = @{ http = @{ method = $method } }; headers = @{} }
  if ($token) { $ev.headers.authorization = "Bearer $token" }
  $ev | ConvertTo-Json -Depth 5 | Set-Content -Encoding ascii event.json
  aws --endpoint-url $e lambda invoke --function-name certificate-service `
    --cli-binary-format raw-in-base64-out --payload fileb://event.json out.json | Out-Null
  Get-Content out.json | ConvertFrom-Json
}