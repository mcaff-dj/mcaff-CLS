#!/usr/bin/env bash
# ONE-TIME bootstrap: creates the IAM role, the two active Lambda functions
# (assign-leads, assign-ndr-leads), and their EventBridge Scheduler schedules. The
# sync-lead-assignments sections below are RETIRED (2026-08-17, see comments at each) and
# commented out - kept only as a historical record of what this script once also deployed.
# Run this once from an environment already authenticated to the
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

# All scratch files (trust policies, env JSON) go under lambda/dist instead of /tmp: on
# Windows Git Bash, /tmp is a path only bash's own builtins agree on - a native exe like
# aws.exe or python.exe resolves it as C:\tmp (current-drive root), a completely different
# location from whatever bash itself wrote to, so file:///tmp/... paramfile loads 404 in
# production (hit repeatedly on 2026-08-22). lambda/dist is a plain relative path every
# tool here (bash, aws.exe, python.exe) resolves identically off the shared CWD.
DIST="$(dirname "${BASH_SOURCE[0]}")/dist"
mkdir -p "$DIST"

# ---- 1. IAM role (basic execution only - no Secrets Manager calls at runtime; secrets
#          are injected as plain Lambda env vars at deploy time instead, see below) ----
cat > "$DIST/trust-policy.json" <<'EOF'
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
    --assume-role-policy-document file://"$DIST/trust-policy.json"
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "Created $ROLE_NAME - waiting 10s for IAM propagation..."
  sleep 10
else
  echo "$ROLE_NAME already exists, reusing."
fi
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

# aws lambda update-function-configuration's --environment shorthand syntax
# (Variables={KEY=value,...}) cannot parse a value that itself contains raw JSON -
# GOOGLE_SA_KEY_JSON's braces/quotes/commas break its parser with "Expected: '=',
# received: '\"'" (hit in production 2026-08-22). Writing a real JSON file and passing
# --environment file://... sidesteps the shorthand parser entirely. Args are KEY=VARNAME
# pairs: KEY is the Lambda env var name, VARNAME is the local shell var holding its value.
write_env_json() {
  local out="$1"; shift
  python3 - "$out" "$@" <<'PYEOF'
import json, os, sys
out = sys.argv[1]
env = {}
for pair in sys.argv[2:]:
    k, v = pair.split("=", 1)
    env[k] = os.environ[v]
with open(out, "w") as f:
    json.dump({"Variables": env}, f)
PYEOF
}

# ---- 2. Build both zips (see build.sh) ----
"$(dirname "${BASH_SOURCE[0]}")/build.sh"

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
    --zip-file "fileb://$DIST/assign_leads.zip" >/dev/null
else
  aws lambda update-function-code --function-name "$FN_ASSIGN" \
    --zip-file "fileb://$DIST/assign_leads.zip" --region "$AWS_REGION" >/dev/null
fi
aws lambda wait function-updated --function-name "$FN_ASSIGN" --region "$AWS_REGION"
# >/dev/null: the response echoes back every Environment.Variables value in plaintext -
# see the workflow's own comment on this same issue, caught in production 2026-08-14.
write_env_json "$DIST/env-assign-leads.json" \
  GOOGLE_SA_KEY_JSON=GOOGLE_SA_KEY POSTGRES_URL=POSTGRES_URL MYSQL_HOST=MYSQL_HOST \
  MYSQL_USER=MYSQL_USER MYSQL_PASSWORD=MYSQL_PASSWORD MYSQL_DATABASE=MYSQL_DATABASE MYSQL_PORT=MYSQL_PORT \
  GOKWIK_HYPHEN_APPID=GOKWIK_HYPHEN_APPID GOKWIK_HYPHEN_APPSECRET=GOKWIK_HYPHEN_APPSECRET \
  GOKWIK_FIEN_APPID=GOKWIK_FIEN_APPID GOKWIK_FIEN_APPSECRET=GOKWIK_FIEN_APPSECRET \
  GOKWIK_MCAFFEINE_APPID=GOKWIK_MCAFFEINE_APPID GOKWIK_MCAFFEINE_APPSECRET=GOKWIK_MCAFFEINE_APPSECRET
aws lambda update-function-configuration --function-name "$FN_ASSIGN" --region "$AWS_REGION" \
  --environment file://"$DIST/env-assign-leads.json" \
  >/dev/null
rm -f "$DIST/env-assign-leads.json"
# Reserved concurrency = 1: same purpose as the workflow's `concurrency: group: assign-leads`
# - stops a slow run overlapping the next 5-minute tick.
aws lambda put-function-concurrency --function-name "$FN_ASSIGN" \
  --reserved-concurrent-executions 1 --region "$AWS_REGION"

# ---- 5. assign-ndr-leads Lambda (independent of assign_leads.py's lead_priority.py/GoKwik
#          needs - see its own module docstring - but it DOES need MYSQL_* now:
#          fetch_online_ndr_agents reads agent_presence from MySQL, same as assign_leads) ----
FN_NDR=mcaff-cls-assign-ndr-leads
if ! aws lambda get-function --function-name "$FN_NDR" >/dev/null 2>&1; then
  aws lambda create-function --function-name "$FN_NDR" \
    --runtime python3.12 --handler handler.handler --role "$ROLE_ARN" \
    --timeout 120 --memory-size 256 --region "$AWS_REGION" \
    --zip-file "fileb://$DIST/assign_ndr_leads.zip" >/dev/null
else
  aws lambda update-function-code --function-name "$FN_NDR" \
    --zip-file "fileb://$DIST/assign_ndr_leads.zip" --region "$AWS_REGION" >/dev/null
fi
aws lambda wait function-updated --function-name "$FN_NDR" --region "$AWS_REGION"
write_env_json "$DIST/env-assign-ndr-leads.json" \
  GOOGLE_SA_KEY_JSON=GOOGLE_SA_KEY POSTGRES_URL=POSTGRES_URL MYSQL_HOST=MYSQL_HOST \
  MYSQL_USER=MYSQL_USER MYSQL_PASSWORD=MYSQL_PASSWORD MYSQL_DATABASE=MYSQL_DATABASE MYSQL_PORT=MYSQL_PORT
aws lambda update-function-configuration --function-name "$FN_NDR" --region "$AWS_REGION" \
  --environment file://"$DIST/env-assign-ndr-leads.json" \
  >/dev/null
rm -f "$DIST/env-assign-ndr-leads.json"

# ---- 5b. csv-upload-worker Lambda - the RTO CSV upload feature's background worker. Its own
#          function (not folded into assign-leads) specifically so its timeout/memory can be
#          set generously AT CREATION here, sidestepping the fact that the GitHub Actions
#          deploy role lacks lambda:UpdateFunctionConfiguration (confirmed blocked 2026-08-20 -
#          see git log for that incident) and so cannot resize an EXISTING function. No
#          EventBridge schedule: this is invoked on-demand by api/rto/upload-start.js via a
#          fire-and-forget Lambda invoke, never on a timer. ----
FN_CSV_WORKER=mcaff-cls-csv-upload-worker
if ! aws lambda get-function --function-name "$FN_CSV_WORKER" >/dev/null 2>&1; then
  aws lambda create-function --function-name "$FN_CSV_WORKER" \
    --runtime python3.12 --handler handler.handler --role "$ROLE_ARN" \
    --timeout 900 --memory-size 1536 --region "$AWS_REGION" \
    --zip-file "fileb://$DIST/csv_upload_worker.zip" >/dev/null
else
  aws lambda update-function-code --function-name "$FN_CSV_WORKER" \
    --zip-file "fileb://$DIST/csv_upload_worker.zip" --region "$AWS_REGION" >/dev/null
fi
aws lambda wait function-updated --function-name "$FN_CSV_WORKER" --region "$AWS_REGION"
write_env_json "$DIST/env-csv-upload-worker.json" \
  GOOGLE_SA_KEY_JSON=GOOGLE_SA_KEY POSTGRES_URL=POSTGRES_URL MYSQL_HOST=MYSQL_HOST \
  MYSQL_USER=MYSQL_USER MYSQL_PASSWORD=MYSQL_PASSWORD MYSQL_DATABASE=MYSQL_DATABASE MYSQL_PORT=MYSQL_PORT \
  GOKWIK_HYPHEN_APPID=GOKWIK_HYPHEN_APPID GOKWIK_HYPHEN_APPSECRET=GOKWIK_HYPHEN_APPSECRET \
  GOKWIK_FIEN_APPID=GOKWIK_FIEN_APPID GOKWIK_FIEN_APPSECRET=GOKWIK_FIEN_APPSECRET \
  GOKWIK_MCAFFEINE_APPID=GOKWIK_MCAFFEINE_APPID GOKWIK_MCAFFEINE_APPSECRET=GOKWIK_MCAFFEINE_APPSECRET
aws lambda update-function-configuration --function-name "$FN_CSV_WORKER" --region "$AWS_REGION" \
  --environment file://"$DIST/env-csv-upload-worker.json" \
  >/dev/null
rm -f "$DIST/env-csv-upload-worker.json"
# Reserved concurrency = 1: one upload job processed at a time, avoiding two jobs racing on
# the same AWB-dedup read. A second job's own /start call still succeeds immediately (it only
# creates the Postgres row and fires the invoke) - Lambda's own async-invoke retry policy
# queues the actual worker run until the first job's invocation finishes, no custom queueing
# needed on our side (see the design spec's concurrency note).
aws lambda put-function-concurrency --function-name "$FN_CSV_WORKER" \
  --reserved-concurrent-executions 1 --region "$AWS_REGION"
# Belt-and-suspenders against a duplicate append: an async Lambda invoke retries automatically
# by default on failure/timeout, which would re-run process_job (including its final sheet
# append) a second time. The worker's own live AWB re-check right before appending is the real
# correctness backstop for that; this just avoids the retry - and its wasted GoKwik/MySQL work -
# happening at all.
aws lambda put-function-event-invoke-config --function-name "$FN_CSV_WORKER" \
  --maximum-retry-attempts 0 --region "$AWS_REGION"

# ---- 5c. order-punch-worker Lambda - Order Punch feature's background worker (own function,
#          same "own timeout at creation" reasoning as csv-upload-worker above). Own IAM role
#          (not the shared $ROLE_NAME above) since it needs two permissions - reading the
#          Unicommerce secret, invoking itself to continue a job that outran one invoke's time
#          budget - that assign-leads/assign-ndr-leads/csv-upload-worker have no business also
#          holding just because they'd share a role. No EventBridge schedule: invoked on-demand
#          by api/order-punch/start.js, and by itself for continuation. ----
ORDER_PUNCH_ROLE_NAME="mcaff-cls-order-punch-worker-role"
if ! aws iam get-role --role-name "$ORDER_PUNCH_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ORDER_PUNCH_ROLE_NAME" \
    --assume-role-policy-document file://"$DIST/trust-policy.json"
  aws iam attach-role-policy --role-name "$ORDER_PUNCH_ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "Created $ORDER_PUNCH_ROLE_NAME - waiting 10s for IAM propagation..."
  sleep 10
else
  echo "$ORDER_PUNCH_ROLE_NAME already exists, reusing."
fi
ORDER_PUNCH_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ORDER_PUNCH_ROLE_NAME}"

# The Unicommerce credential is never created by this script (see the design spec's own note
# on why) - it must already exist before this section can grant read access to it.
#
# Missing means THIS worker is skipped, not that the script stops. It used to exit 1 here,
# which also skipped everything below - the API-role invoke grant in 5d, and the EventBridge
# schedules for assign-leads/assign-ndr-leads that have nothing to do with Unicommerce. A run
# on 2026-08-21 stopped exactly here, leaving csv-upload-worker created and every later
# section unapplied, with the half-done state visible nowhere.
ORDER_PUNCH_SKIPPED=""
if ! aws secretsmanager describe-secret --secret-id mcaff-cls/unicommerce --region "$AWS_REGION" >/dev/null 2>&1; then
  ORDER_PUNCH_SKIPPED=yes
  echo "" >&2
  echo "WARNING: secret 'mcaff-cls/unicommerce' does not exist, so $ORDER_PUNCH_ROLE_NAME's" >&2
  echo "         policy and mcaff-cls-order-punch-worker are being SKIPPED. Order Punch will" >&2
  echo "         not work until you create it and re-run this script:" >&2
  echo "  aws secretsmanager create-secret --name mcaff-cls/unicommerce --region $AWS_REGION \\" >&2
  echo "    --secret-string '{\"username\":\"...\",\"password\":\"...\"}'" >&2
  echo "" >&2
fi

if [ -z "$ORDER_PUNCH_SKIPPED" ]; then
UC_SECRET_ARN="$(aws secretsmanager describe-secret --secret-id mcaff-cls/unicommerce --region "$AWS_REGION" --query ARN --output text)"

FN_ORDER_PUNCH_WORKER=mcaff-cls-order-punch-worker
ORDER_PUNCH_WORKER_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${FN_ORDER_PUNCH_WORKER}"
cat > "$DIST/order-punch-worker-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": "${UC_SECRET_ARN}"},
    {"Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": "${ORDER_PUNCH_WORKER_ARN}"}
  ]
}
EOF
aws iam put-role-policy --role-name "$ORDER_PUNCH_ROLE_NAME" \
  --policy-name order-punch-worker-access --policy-document file://"$DIST/order-punch-worker-policy.json"

if ! aws lambda get-function --function-name "$FN_ORDER_PUNCH_WORKER" >/dev/null 2>&1; then
  aws lambda create-function --function-name "$FN_ORDER_PUNCH_WORKER" \
    --runtime python3.12 --handler handler.handler --role "$ORDER_PUNCH_ROLE_ARN" \
    --timeout 900 --memory-size 256 --region "$AWS_REGION" \
    --zip-file "fileb://$DIST/order_punch_worker.zip" >/dev/null
else
  aws lambda update-function-code --function-name "$FN_ORDER_PUNCH_WORKER" \
    --zip-file "fileb://$DIST/order_punch_worker.zip" --region "$AWS_REGION" >/dev/null
fi
aws lambda wait function-updated --function-name "$FN_ORDER_PUNCH_WORKER" --region "$AWS_REGION"
# MYSQL_* because the order_punch_* tables live in MySQL (process_order_punch_job.py opens
# its own pymysql connection). This used to set POSTGRES_URL alone, which the worker never
# reads - every job died at 'could not connect to MySQL' and sat at 'queued' (2026-08-22).
#
# The Unicommerce credential deliberately does NOT join them as a plain env var (see the
# design spec's "why deviate" note): it is read from Secrets Manager at runtime via the
# IAM policy granted above.
write_env_json "$DIST/env-order-punch-worker.json" \
  MYSQL_HOST=MYSQL_HOST MYSQL_USER=MYSQL_USER MYSQL_PASSWORD=MYSQL_PASSWORD \
  MYSQL_DATABASE=MYSQL_DATABASE MYSQL_PORT=MYSQL_PORT
aws lambda update-function-configuration --function-name "$FN_ORDER_PUNCH_WORKER" --region "$AWS_REGION" \
  --environment file://"$DIST/env-order-punch-worker.json" \
  >/dev/null
rm -f "$DIST/env-order-punch-worker.json"
# Reserved concurrency 1: serializes this job's own continuations and any other queued job, so
# two workers never race the same display-code's _1/_2 suffix assignment.
aws lambda put-function-concurrency --function-name "$FN_ORDER_PUNCH_WORKER" \
  --reserved-concurrent-executions 1 --region "$AWS_REGION"
# Same duplicate-create-avoidance reasoning as csv-upload-worker's own event-invoke config -
# the real correctness backstop is process_one_row's own duplicate-create recovery logic, this
# just avoids the wasted retry.
aws lambda put-function-event-invoke-config --function-name "$FN_ORDER_PUNCH_WORKER" \
  --maximum-retry-attempts 0 --region "$AWS_REGION"
fi  # end of the order-punch-worker section, skipped when its secret is absent

# ---- 5d. Let the Node API Lambda actually invoke the worker Lambdas above ----
# api/_lib/lambdaTrigger.js fires those invokes from mcaff-cls-api (Order Punch's /start, RTO
# CSV upload's /start, the agent-presence nudge). Without this grant the invoke is refused with
# AccessDeniedException and the job row it just committed never gets picked up - one half of the
# 2026-08-21 Order Punch incident (the other half being a worker function that did not exist
# yet). It lives here, in version control, because it used to be a manual "verify or add this
# yourself" checklist item in each feature's plan doc, and a step like that gets skipped exactly
# once.
#
# The resource is a wildcard over mcaff-cls-*-worker rather than a list of ARNs, so the next
# worker Lambda is covered the day it is created with nothing here to remember to edit.
# put-role-policy is create-or-replace, so re-running this section is a no-op.
API_FN=mcaff-cls-api
if API_ROLE_ARN="$(aws lambda get-function-configuration --function-name "$API_FN" \
      --region "$AWS_REGION" --query Role --output text 2>/dev/null)"; then
  API_ROLE_NAME="${API_ROLE_ARN##*/}"
  cat > "$DIST/api-invoke-workers-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "lambda:InvokeFunction",
    "Resource": "arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:mcaff-cls-*-worker"
  }]
}
EOF
  aws iam put-role-policy --role-name "$API_ROLE_NAME" \
    --policy-name invoke-mcaff-cls-workers \
    --policy-document file://"$DIST/api-invoke-workers-policy.json"
  echo "Granted $API_ROLE_NAME lambda:InvokeFunction on mcaff-cls-*-worker."
else
  # Not fatal - the workers themselves are deployed and correct by this point, and on a fresh
  # account the API Lambda may simply not exist yet. Loud, because every /start that queues
  # background work stays broken until this grant lands.
  echo "WARNING: could not read $API_FN's execution role - skipping the invoke grant." >&2
  echo "         Grant lambda:InvokeFunction on mcaff-cls-*-worker to that role by hand," >&2
  echo "         or re-run this script once $API_FN exists." >&2
fi

# ---- 6. sync-lead-assignments Lambda ----
# RETIRED 2026-08-17 - sync_agent_presence_log_to_mysql.py deleted, this Lambda's zip can
# no longer be built (build.sh has no sync_lead_assignments target). The already-deployed
# Lambda/schedule still exist in AWS and are not deleted by this script or this comment -
# see lambda/README.md's Rollback section. FN_SYNC/SYNC_ARN are left defined (uncommented)
# below since the EventBridge invoke-permission policy further down still names that ARN
# for the still-live (if now unmanaged-by-this-script) Lambda; only the actual build/deploy
# calls that depend on the no-longer-buildable zip are commented out.
FN_SYNC=mcaff-cls-sync-lead-assignments
# if ! aws lambda get-function --function-name "$FN_SYNC" >/dev/null 2>&1; then
#   aws lambda create-function --function-name "$FN_SYNC" \
#     --runtime python3.12 --handler handler.handler --role "$ROLE_ARN" \
#     --timeout 120 --memory-size 256 --region "$AWS_REGION" \
#     --zip-file "fileb://$DIST/sync_lead_assignments.zip" >/dev/null
# else
#   aws lambda update-function-code --function-name "$FN_SYNC" \
#     --zip-file "fileb://$DIST/sync_lead_assignments.zip" --region "$AWS_REGION" >/dev/null
# fi
# aws lambda wait function-updated --function-name "$FN_SYNC" --region "$AWS_REGION"
# aws lambda update-function-configuration --function-name "$FN_SYNC" --region "$AWS_REGION" \
#   --environment "Variables={POSTGRES_URL=${POSTGRES_URL},MYSQL_HOST=${MYSQL_HOST},MYSQL_USER=${MYSQL_USER},MYSQL_PASSWORD=${MYSQL_PASSWORD},MYSQL_DATABASE=${MYSQL_DATABASE},MYSQL_PORT=${MYSQL_PORT}}" \
#   >/dev/null

# ---- 7. EventBridge Scheduler: assign-leads every 5 min, assign-ndr-leads every 5 min.
#          sync-lead-assignments-daily's own create/update-schedule calls are commented out
#          below (RETIRED 2026-08-17, same reasoning as section 6) - its already-created
#          schedule keeps running unmanaged by this script until manually deleted. ----
aws scheduler create-schedule-group --name mcaff-cls-cron 2>/dev/null || true

ASSIGN_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${FN_ASSIGN}"
NDR_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${FN_NDR}"
SYNC_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${FN_SYNC}"

# A dedicated role lets EventBridge Scheduler invoke these three Lambdas specifically
# (SYNC_ARN's schedule is retired - see above - but the already-existing schedule still
# needs permission to invoke its still-existing Lambda, hence keeping it in this policy).
SCHED_ROLE_NAME="mcaff-cls-scheduler-invoke-role"
cat > "$DIST/scheduler-trust.json" <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "scheduler.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOF
cat > "$DIST/scheduler-invoke-policy.json" <<EOF
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
    --assume-role-policy-document file://"$DIST/scheduler-trust.json"
  aws iam put-role-policy --role-name "$SCHED_ROLE_NAME" \
    --policy-name invoke-cron-lambdas --policy-document file://"$DIST/scheduler-invoke-policy.json"
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
  --schedule-expression "rate(5 minutes)" --flexible-time-window '{"Mode": "OFF"}' --state ENABLED \
  --target "{\"Arn\": \"${NDR_ARN}\", \"RoleArn\": \"${SCHED_ROLE_ARN}\"}" \
  --region "$AWS_REGION" 2>/dev/null || \
aws scheduler update-schedule --name assign-ndr-leads-every-5-min --group-name mcaff-cls-cron \
  --schedule-expression "rate(5 minutes)" --flexible-time-window '{"Mode": "OFF"}' --state ENABLED \
  --target "{\"Arn\": \"${NDR_ARN}\", \"RoleArn\": \"${SCHED_ROLE_ARN}\"}" \
  --region "$AWS_REGION"

# RETIRED 2026-08-17 - sync_agent_presence_log_to_mysql.py deleted, this Lambda's zip can
# no longer be built (build.sh has no sync_lead_assignments target). The already-deployed
# Lambda/schedule still exist in AWS and are not deleted by this script or this comment -
# see lambda/README.md's Rollback section.
# aws scheduler create-schedule --name sync-lead-assignments-daily --group-name mcaff-cls-cron \
#   --schedule-expression "cron(30 3 * * ? *)" --flexible-time-window '{"Mode": "OFF"}' \
#   --target "{\"Arn\": \"${SYNC_ARN}\", \"RoleArn\": \"${SCHED_ROLE_ARN}\"}" \
#   --region "$AWS_REGION" 2>/dev/null || \
# aws scheduler update-schedule --name sync-lead-assignments-daily --group-name mcaff-cls-cron \
#   --schedule-expression "cron(30 3 * * ? *)" --flexible-time-window '{"Mode": "OFF"}' \
#   --target "{\"Arn\": \"${SYNC_ARN}\", \"RoleArn\": \"${SCHED_ROLE_ARN}\"}" \
#   --region "$AWS_REGION"

echo ""
echo "Done. Two Lambdas are deployed and their EventBridge schedules are live:"
echo "assign-leads and assign-ndr-leads, both every 5 minutes. (sync-lead-assignments is"
echo "retired - its own Lambda/schedule sections above are commented out, not re-created here.)"
if [ -n "$ORDER_PUNCH_SKIPPED" ]; then
  echo "order-punch-worker was SKIPPED - create the mcaff-cls/unicommerce secret (see the"
  echo "warning above) and re-run this script."
else
  echo "order-punch-worker is also deployed (on-demand invoke only, no schedule)."
fi
