#!/usr/bin/env bash
# Deploys the Workshop & Registration Service to Floci (local AWS), following Lab 7:
#   IAM role -> Lambda functions -> API Gateway (HTTP API) -> EventBridge Scheduler
#   -> CloudWatch alarms (+ SNS topic for alerts).
# Two functions share one code package:
#   hader-registration-api     the API (handler lambda.handler), behind API Gateway
#   hader-registration-checks  scheduled checks (handler scheduler.handler), run every
#                              minute by EventBridge Scheduler, with NO public route
# The website itself is hosted on Vercel (see the HaderApp repo).
# Run it from the ROOT of the HaderApp repo in Git Bash:
#   bash services/registration/infra/deploy-registration.sh
# Safe to run again: it updates what already exists instead of creating it twice.
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
ACCOUNT="${ACCOUNT:-000000000000}"
REGION="us-east-1"
FN="hader-registration-api"
CHECKS_FN="hader-registration-checks"
SCHED_ROLE="hader-scheduler-role"
SCHEDULE="hader-registration-checks-every-minute"
ROLE="hader-registration-role"
POLICY="hader-registration-logs"
API_NAME="hader-http-api"
SERVICE="services/registration"

step() { echo; echo "== $1"; }
none() { [ -z "$1" ] || [ "$1" = "None" ]; }

[ -f "$SERVICE/.env" ] || { echo "Run this from the root of the HaderApp repo ($SERVICE/.env not found)."; exit 1; }

step "1/7 Check that we are talking to Floci"
acct=$(aws sts get-caller-identity --query Account --output text)
if [ "$acct" != "$ACCOUNT" ]; then
  echo "Account is $acct, expected $ACCOUNT. Run: export AWS_PROFILE=floci"; exit 1
fi
echo "OK, account $acct"

step "2/7 IAM role: the function may only write its own logs (least privilege)"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document file://$SERVICE/infra/iam/lambda-trust-policy.json \
    --query Role.Arn --output text
else
  echo "Role $ROLE already exists"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name "$POLICY" \
  --policy-document file://$SERVICE/infra/iam/registration-logs-policy.json
echo "Policy $POLICY attached"

step "3/7 Build lambda.zip and create or update the two Lambda functions"
(cd "$SERVICE" && npm install --silent && npm run zip)
ENV_JSON=$(cd "$SERVICE" && node scripts/lambda-env.js)

# deploy_fn NAME HANDLER: create the function, or update its code and settings.
deploy_fn() {
  if aws lambda get-function --function-name "$1" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$1" \
      --zip-file "fileb://$SERVICE/lambda.zip" --query LastModified --output text
    aws lambda wait function-updated-v2 --function-name "$1"
    aws lambda update-function-configuration --function-name "$1" --handler "$2" \
      --environment "$ENV_JSON" --timeout 15 --query LastModified --output text
    aws lambda wait function-updated-v2 --function-name "$1"
  else
    aws lambda create-function --function-name "$1" \
      --runtime nodejs24.x --handler "$2" \
      --role "arn:aws:iam::$ACCOUNT:role/$ROLE" \
      --zip-file "fileb://$SERVICE/lambda.zip" --timeout 15 --memory-size 256 \
      --environment "$ENV_JSON" --query FunctionArn --output text
    aws lambda wait function-active-v2 --function-name "$1"
  fi
  echo "Function $1 is ready"
}
deploy_fn "$FN" lambda.handler
deploy_fn "$CHECKS_FN" scheduler.handler
rm -f "$SERVICE/lambda.zip"

step "4/7 API Gateway: one HTTP API, only the routes this service needs"
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='$API_NAME'].ApiId | [0]" --output text)
if none "$API_ID"; then
  API_ID=$(aws apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP --query ApiId --output text)
fi
FN_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FN"
INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
  --query "Items[?IntegrationUri=='$FN_ARN'].IntegrationId | [0]" --output text)
if none "$INTEGRATION_ID"; then
  INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" \
    --integration-type AWS_PROXY --payload-format-version 2.0 \
    --integration-uri "$FN_ARN" --query IntegrationId --output text)
fi

ROUTES=(
  "GET /health"
  "GET /me"
  "GET /workshops"
  "POST /workshops"
  "PUT /workshops/{id}"
  "DELETE /workshops/{id}"
  "POST /workshops/{id}/registrations"
  "GET /workshops/{id}/registrations"
  "DELETE /workshops/{id}/registrations/{registrationId}"
  "GET /registrations/me"
  "DELETE /registrations/{id}"
  "POST /workshops/{id}/waitlist"
  "GET /waitlist/me"
  "DELETE /waitlist/{id}"
  "OPTIONS /me"
  "OPTIONS /workshops"
  "OPTIONS /workshops/{id}"
  "OPTIONS /workshops/{id}/registrations"
  "OPTIONS /workshops/{id}/registrations/{registrationId}"
  "OPTIONS /registrations/me"
  "OPTIONS /registrations/{id}"
  "OPTIONS /workshops/{id}/waitlist"
  "OPTIONS /waitlist/me"
  "OPTIONS /waitlist/{id}"
  "GET /notifications/me"
  "POST /notifications/read"
  "OPTIONS /notifications/me"
  "OPTIONS /notifications/read"
)
EXISTING=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[].RouteKey" --output text | tr '\t' '\n')
for ROUTE in "${ROUTES[@]}"; do
  if printf '%s\n' "$EXISTING" | grep -qxF "$ROUTE"; then
    echo "  route exists: $ROUTE"
  else
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$ROUTE" \
      --target "integrations/$INTEGRATION_ID" --query RouteKey --output text | sed 's/^/  route added: /'
  fi
done

if ! aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name '$default' >/dev/null 2>&1; then
  aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy >/dev/null
fi
if aws apigatewayv2 update-stage --api-id "$API_ID" --stage-name '$default' \
     --default-route-settings ThrottlingBurstLimit=20,ThrottlingRateLimit=10 >/dev/null 2>&1; then
  echo "Throttling on: 10 requests per second, bursts of 20 (extra requests get 429)"
else
  echo "Throttling: not supported by this Floci version (it is set on real AWS)"
fi

if aws lambda add-permission --function-name "$FN" --statement-id apigw-invoke \
     --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
     --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*" >/dev/null 2>&1; then
  echo "API Gateway may now call $FN (and nobody else may)"
else
  echo "Permission for API Gateway already exists"
fi
API_URL="http://$API_ID.execute-api.localhost.floci.io:4566"

step "5/7 EventBridge Scheduler: run the checks every minute"
# The scheduler gets its own role that may ONLY invoke the checks function (least privilege).
if ! aws iam get-role --role-name "$SCHED_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$SCHED_ROLE" \
    --assume-role-policy-document file://$SERVICE/infra/iam/scheduler-trust-policy.json \
    --query Role.Arn --output text
else
  echo "Role $SCHED_ROLE already exists"
fi
aws iam put-role-policy --role-name "$SCHED_ROLE" --policy-name hader-scheduler-invoke \
  --policy-document file://$SERVICE/infra/iam/scheduler-invoke-policy.json
TARGET="{\"Arn\":\"arn:aws:lambda:$REGION:$ACCOUNT:function:$CHECKS_FN\",\"RoleArn\":\"arn:aws:iam::$ACCOUNT:role/$SCHED_ROLE\"}"
if aws scheduler get-schedule --name "$SCHEDULE" >/dev/null 2>&1; then
  aws scheduler update-schedule --name "$SCHEDULE" --schedule-expression "rate(1 minute)" \
    --flexible-time-window Mode=OFF --target "$TARGET" >/dev/null
  echo "Schedule $SCHEDULE updated (every minute)"
else
  aws scheduler create-schedule --name "$SCHEDULE" --schedule-expression "rate(1 minute)" \
    --flexible-time-window Mode=OFF --target "$TARGET" >/dev/null
  echo "Schedule $SCHEDULE created (every minute)"
fi
echo "Running the checks once now:"
if aws lambda invoke --function-name "$CHECKS_FN" checks-result.json >/dev/null 2>&1; then
  cat checks-result.json; echo
else
  echo "(could not run it now; the schedule will run it within a minute)"
fi
rm -f checks-result.json

step "6/7 CloudWatch alarms: get warned about server errors and attacks"
# Metric filters turn matching log lines into numbers; alarms watch those numbers and
# switch to ALARM (and notify the SNS topic) when a limit is crossed.
LOG_GROUP="/aws/lambda/$FN"
aws logs create-log-group --log-group-name "$LOG_GROUP" >/dev/null 2>&1 || true
aws logs put-metric-filter --log-group-name "$LOG_GROUP" --filter-name hader-registration-server-errors \
  --filter-pattern server_error \
  --metric-transformations metricName=ServerErrors,metricNamespace=HaderRegistration,metricValue=1,defaultValue=0
aws logs put-metric-filter --log-group-name "$LOG_GROUP" --filter-name hader-registration-access-denied \
  --filter-pattern access_denied \
  --metric-transformations metricName=AccessDenied,metricNamespace=HaderRegistration,metricValue=1,defaultValue=0
TOPIC_ARN=$(aws sns create-topic --name hader-registration-alerts --query TopicArn --output text)
aws cloudwatch put-metric-alarm --alarm-name hader-registration-server-errors \
  --alarm-description "Any 500 error in the Registration API within 5 minutes" \
  --namespace HaderRegistration --metric-name ServerErrors --statistic Sum \
  --period 300 --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching --alarm-actions "$TOPIC_ARN"
aws cloudwatch put-metric-alarm --alarm-name hader-registration-access-denied \
  --alarm-description "20 or more refused requests (401/403) within 5 minutes: possible attack" \
  --namespace HaderRegistration --metric-name AccessDenied --statistic Sum \
  --period 300 --evaluation-periods 1 --threshold 20 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching --alarm-actions "$TOPIC_ARN"
echo "Alarms hader-registration-server-errors and hader-registration-access-denied -> SNS $TOPIC_ARN"

step "7/7 Quick test"
echo "GET $API_URL/health"
curl -s -m 30 "$API_URL/health" || echo "(no answer yet: wait 30 seconds and try again)"
echo
echo
echo "Done."
echo "  API:      $API_URL"
echo "  Logs:     aws logs tail /aws/lambda/$FN --since 15m --format short"
echo "  Checks:   aws logs tail /aws/lambda/$CHECKS_FN --since 15m --format short"
echo "  Alarms:   aws cloudwatch describe-alarms --alarm-name-prefix hader-registration --query 'MetricAlarms[].[AlarmName,StateValue]' --output table"
