#!/usr/bin/env bash
# ONE-TIME bootstrap: creates the IAM role, all three Lambda functions, and their
# EventBridge Scheduler schedules. Run this once from an environment already
# authenticated to the
# mcaff-CLS AWS account (AWS CloudShell is the easiest option - it has python3, pip3, zip,
# and your console login already wired up, so nothing to install locally).
#
# After this, ongoing code changes are pushed via the GitHub Actions workflow in
# .github/workflows/deploy-cron-lambdas.yml (aws lambda update-function-code only) -
# this script's create-* calls are not meant to be re-run.
#
# Fill in the 5 secret values below (same ones already in GitHub Secrets / used by
# assign-leads.yml and sync-lead-assignments.yml today) before running, OR pull them
# from wherever you already store them and export as env vars before invoking this script.
set -euo pipefail

AWS_REGION="ap-south-1"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ROLE_NAME="mcaff-cls-cron-lambda-role"

# ---- 1. IAM role (basic execution only - no Secrets Manager calls at runtime; secrets
#          are injected as plain Lambda env vars at deploy time instead, see below) ----
cat > /tmp/trust-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "lambda.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOF

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document file:///tmp/trust-policy.json
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "Created $ROLE_NAME - waiting 10s for IAM propagation..."
  sleep 10
else
  echo "$ROLE_NAME already exists, reusing."
fi
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

# ---- 2. Build both zips (see build.sh) ----
"$(dirname "${BASH_SOURCE[0]}")/build.sh"
DIST="$(dirname "${BASH_SOURCE[0]}")/dist"

# ---- 3. Same secret values already used by assign-leads.yml / sync-lead-assignments.yml.
#          Set these as env vars before running this script - never hardcode them here. ----
: "${POSTGRES_URL:?set POSTGRES_URL}"
: "${MYSQL_HOST:?set MYSQL_HOST}" "${MYSQL_USER:?}" "${MYSQL_PASSWORD:?}" "${MYSQL_DATABASE:?}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
: "${GOOGLE_SA_KEY:?set GOOGLE_SA_KEY (the full service-account JSON, same secret as today)}"
: "${GOKWIK_HYPHEN_APPID:?}" "${GOKWIK_HYPHEN_APPSECRET:?}"
: "${GOKWIK_FIEN_APPID:?}" "${GOKWIK_FIEN_APPSECRET:?}"
: "${GOKWIK_MCAFFEINE_APPID:?}" "${GOKWIK_MCAFFEINE_APPSECRET:?}"

# ---- 4. assign-leads Lambda ----
FN_ASSIGN=mcaff-cls-assign-leads
if ! aws lambda get-function --function-name "$FN_ASSIGN" >/dev/null 2>&1; then
  aws lambda create-function --function-name "$FN_ASSIGN" \
    --runtime python3.12 --handler handler.handler --role "$ROLE_ARN" \
    --timeout 60 --memory-size 256 --region "$AWS_REGION" \
    --zip-file "fileb://$DIST/assign_leads.zip"
else
  aws lambda update-function-code --function-name "$FN_ASSIGN" \
    --zip-file "fileb://$DIST/assign_leads.zip" --region "$AWS_REGION"
fi
aws lambda wait function-updated --function-name "$FN_ASSIGN" --region "$AWS_REGION"
aws lambda update-function-configuration --function-name "$FN_ASSIGN" --region "$AWS_REGION" \
  --environment "Variables={GOOGLE_SA_KEY_JSON=${GOOGLE_SA_KEY},POSTGRES_URL=${POSTGRES_URL},MYSQL_HOST=${MYSQL_HOST},MYSQL_USER=${MYSQL_USER},MYSQL_PASSWORD=${MYSQL_PASSWORD},MYSQL_DATABASE=${MYSQL_DATABASE},MYSQL_PORT=${MYSQL_PORT},GOKWIK_HYPHEN_APPID=${GOKWIK_HYPHEN_APPID},GOKWIK_HYPHEN_APPSECRET=${GOKWIK_HYPHEN_APPSECRET},GOKWIK_FIEN_APPID=${GOKWIK_FIEN_APPID},GOKWIK_FIEN_APPSECRET=${GOKWIK_FIEN_APPSECRET},GOKWIK_MCAFFEINE_APPID=${GOKWIK_MCAFFEINE_APPID},GOKWIK_MCAFFEINE_APPSECRET=${GOKWIK_MCAFFEINE_APPSECRET}}"
# Reserved concurrency = 1: same purpose as the workflow's `concurrency: group: assign-leads`
# - stops a slow run overlapping the next 5-minute tick.
aws lambda put-function-concurrency --function-name "$FN_ASSIGN" \
  --reserved-concurrent-executions 1 --region "$AWS_REGION"

# ---- 5. assign-ndr-leads Lambda (independent of assign_leads.py - see its own module
#          docstring - so it only needs POSTGRES_URL and GOOGLE_SA_KEY, no MYSQL_*/GOKWIK_*) ----
FN_NDR=mcaff-cls-assign-ndr-leads
if ! aws lambda get-function --function-name "$FN_NDR" >/dev/null 2>&1; then
  aws lambda create-function --function-name "$FN_NDR" \
    --runtime python3.12 --handler handler.handler --role "$ROLE_ARN" \
    --timeout 120 --memory-size 256 --region "$AWS_REGION" \
    --zip-file "fileb://$DIST/assign_ndr_leads.zip"
else
  aws lambda update-function-code --function-name "$FN_NDR" \
    --zip-file "fileb://$DIST/assign_ndr_leads.zip" --region "$AWS_REGION"
fi
aws lambda wait function-updated --function-name "$FN_NDR" --region "$AWS_REGION"
aws lambda update-function-configuration --function-name "$FN_NDR" --region "$AWS_REGION" \
  --environment "Variables={GOOGLE_SA_KEY_JSON=${GOOGLE_SA_KEY},POSTGRES_URL=${POSTGRES_URL}}"

# ---- 6. sync-lead-assignments Lambda ----
FN_SYNC=mcaff-cls-sync-lead-assignments
if ! aws lambda get-function --function-name "$FN_SYNC" >/dev/null 2>&1; then
  aws lambda create-function --function-name "$FN_SYNC" \
    --runtime python3.12 --handler handler.handler --role "$ROLE_ARN" \
    --timeout 120 --memory-size 256 --region "$AWS_REGION" \
    --zip-file "fileb://$DIST/sync_lead_assignments.zip"
else
  aws lambda update-function-code --function-name "$FN_SYNC" \
    --zip-file "fileb://$DIST/sync_lead_assignments.zip" --region "$AWS_REGION"
fi
aws lambda wait function-updated --function-name "$FN_SYNC" --region "$AWS_REGION"
aws lambda update-function-configuration --function-name "$FN_SYNC" --region "$AWS_REGION" \
  --environment "Variables={POSTGRES_URL=${POSTGRES_URL},MYSQL_HOST=${MYSQL_HOST},MYSQL_USER=${MYSQL_USER},MYSQL_PASSWORD=${MYSQL_PASSWORD},MYSQL_DATABASE=${MYSQL_DATABASE},MYSQL_PORT=${MYSQL_PORT}}"

# ---- 7. EventBridge Scheduler: assign-leads every 5 min, assign-ndr-leads every 5 min
#          (created DISABLED - see README.md's Status, NDR's write path isn't verified
#          yet), sync-lead-assignments daily 9:00am IST (3:30 UTC). ----
aws scheduler create-schedule-group --name mcaff-cls-cron 2>/dev/null || true

ASSIGN_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${FN_ASSIGN}"
NDR_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${FN_NDR}"
SYNC_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${FN_SYNC}"

# A dedicated role lets EventBridge Scheduler invoke these three Lambdas specifically.
SCHED_ROLE_NAME="mcaff-cls-scheduler-invoke-role"
cat > /tmp/scheduler-trust.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "scheduler.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOF
cat > /tmp/scheduler-invoke-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "lambda:InvokeFunction",
    "Resource": ["${ASSIGN_ARN}", "${NDR_ARN}", "${SYNC_ARN}"]
  }]
}
EOF
if ! aws iam get-role --role-name "$SCHED_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$SCHED_ROLE_NAME" \
    --assume-role-policy-document file:///tmp/scheduler-trust.json
  aws iam put-role-policy --role-name "$SCHED_ROLE_NAME" \
    --policy-name invoke-cron-lambdas --policy-document file:///tmp/scheduler-invoke-policy.json
  sleep 10
fi
SCHED_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${SCHED_ROLE_NAME}"

aws scheduler create-schedule --name assign-leads-every-5-min --group-name mcaff-cls-cron \
  --schedule-expression "rate(5 minutes)" --flexible-time-window '{"Mode": "OFF"}' \
  --target "{\"Arn\": \"${ASSIGN_ARN}\", \"RoleArn\": \"${SCHED_ROLE_ARN}\"}" \
  --region "$AWS_REGION" 2>/dev/null || \
aws scheduler update-schedule --name assign-leads-every-5-min --group-name mcaff-cls-cron \
  --schedule-expression "rate(5 minutes)" --flexible-time-window '{"Mode": "OFF"}' \
  --target "{\"Arn\": \"${ASSIGN_ARN}\", \"RoleArn\": \"${SCHED_ROLE_ARN}\"}" \
  --region "$AWS_REGION"

aws scheduler create-schedule --name assign-ndr-leads-every-5-min --group-name mcaff-cls-cron \
  --schedule-expression "rate(5 minutes)" --flexible-time-window '{"Mode": "OFF"}' --state DISABLED \
  --target "{\"Arn\": \"${NDR_ARN}\", \"RoleArn\": \"${SCHED_ROLE_ARN}\"}" \
  --region "$AWS_REGION" 2>/dev/null || \
aws scheduler update-schedule --name assign-ndr-leads-every-5-min --group-name mcaff-cls-cron \
  --schedule-expression "rate(5 minutes)" --flexible-time-window '{"Mode": "OFF"}' --state DISABLED \
  --target "{\"Arn\": \"${NDR_ARN}\", \"RoleArn\": \"${SCHED_ROLE_ARN}\"}" \
  --region "$AWS_REGION"

aws scheduler create-schedule --name sync-lead-assignments-daily --group-name mcaff-cls-cron \
  --schedule-expression "cron(30 3 * * ? *)" --flexible-time-window '{"Mode": "OFF"}' \
  --target "{\"Arn\": \"${SYNC_ARN}\", \"RoleArn\": \"${SCHED_ROLE_ARN}\"}" \
  --region "$AWS_REGION" 2>/dev/null || \
aws scheduler update-schedule --name sync-lead-assignments-daily --group-name mcaff-cls-cron \
  --schedule-expression "cron(30 3 * * ? *)" --flexible-time-window '{"Mode": "OFF"}' \
  --target "{\"Arn\": \"${SYNC_ARN}\", \"RoleArn\": \"${SCHED_ROLE_ARN}\"}" \
  --region "$AWS_REGION"

echo ""
echo "Done. All three Lambdas are deployed. assign-leads and sync-lead-assignments are"
echo "scheduled and live; assign-ndr-leads is created but its schedule is DISABLED until"
echo "its write path is verified (see README.md's Status section)."
