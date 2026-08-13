# Cron jobs on Lambda, not GitHub Actions

`assign-leads.yml` (every 5 minutes) and `sync-lead-assignments.yml` (daily) moved here
because their recurring *invocation* doesn't need GitHub Actions at all - only actual code
changes do. See the chat thread for the full reasoning (assign-leads alone was ~8,640
Actions runs/month, ~4x the entire free 2,000-minute quota).

`refresh.yml`, `export-resolved-tickets.yml`, `sync-delivery-tickets.yml`, and
`refresh-productkyc.yml` are **not** part of this migration - they `git commit`+`push`
results back to `main` as part of their run, which Actions gives for free (already
checked out, already git-authenticated) but Lambda would have to reimplement (bundle the
`git` binary, store a push-capable PAT, hand-roll the rebase-retry loop `refresh.yml`
already has). Combined they cost ~400 Actions min/month - trivial next to the 2,000 free
minutes once assign-leads is gone, so there's no reason to take on that rework.

## What's here

- `assign_leads/handler.py`, `sync_lead_assignments/handler.py` - thin Lambda entrypoints.
  They import the real `scripts/*.py` unmodified (see each handler's docstring for why the
  directory layout matters) - there is no forked/duplicated copy of the logic.
- `build.sh` - assembles both deployment zips (code + manylinux-wheel deps) from the repo's
  actual `scripts/`. Needs Linux (WSL / CI runner / AWS CloudShell) - see its header comment.
- `deploy_infra.sh` - **one-time** bootstrap: IAM role, both Lambda functions, EventBridge
  Scheduler schedules. Not meant to be re-run after initial setup.
- `../.github/workflows/deploy-cron-lambdas.yml` - ongoing: redeploys code to the *existing*
  Lambdas whenever someone pushes a change to the relevant files. This is the "code push"
  half - Vikash still just pushes to `main`, same as every other change.

## One-time setup (do this once, from AWS CloudShell or anywhere already logged into the AWS console/CLI)

1. **Export the existing secrets as env vars** - same values already in GitHub Secrets today
   (`GOOGLE_SA_KEY`, `POSTGRES_URL`, `MYSQL_HOST/USER/PASSWORD/DATABASE/PORT`, the 6
   `GOKWIK_*` vars). GitHub secrets can't be read back out through the UI, so pull these
   from wherever else you have them recorded (password manager, Secrets Manager if already
   duplicated there, or Vikash).
2. Run:
   ```bash
   cd mcaff-cls-real/lambda
   POSTGRES_URL=... MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=... \
   GOOGLE_SA_KEY='<full JSON, single-quoted>' \
   GOKWIK_HYPHEN_APPID=... GOKWIK_HYPHEN_APPSECRET=... \
   GOKWIK_FIEN_APPID=... GOKWIK_FIEN_APPSECRET=... \
   GOKWIK_MCAFFEINE_APPID=... GOKWIK_MCAFFEINE_APPSECRET=... \
   bash deploy_infra.sh
   ```
3. **Grant the existing deploy role permission to update these two Lambdas** - so
   `deploy-cron-lambdas.yml` (using the same `github-actions-mcaff-cls-deploy` OIDC role as
   `deploy.yml`) can push future code changes. Add this statement to that role's policy:
   ```json
   {
     "Effect": "Allow",
     "Action": ["lambda:UpdateFunctionCode", "lambda:GetFunction"],
     "Resource": [
       "arn:aws:lambda:ap-south-1:157320387454:function:mcaff-cls-assign-leads",
       "arn:aws:lambda:ap-south-1:157320387454:function:mcaff-cls-sync-lead-assignments"
     ]
   }
   ```
4. **Test both Lambdas manually before touching the old crons**:
   ```bash
   aws lambda invoke --function-name mcaff-cls-assign-leads /tmp/out.json && cat /tmp/out.json
   aws lambda invoke --function-name mcaff-cls-sync-lead-assignments /tmp/out2.json && cat /tmp/out2.json
   ```
   Check CloudWatch Logs (`/aws/lambda/mcaff-cls-assign-leads`) for the same log lines the
   Actions run used to print - if leads get assigned / rows sync correctly, it's working.
5. **Only once step 4 is confirmed working**, disable the old workflows so the job doesn't
   run twice: comment out the `schedule:` block (keep `workflow_dispatch:` as a manual
   fallback) in `.github/workflows/assign-leads.yml` and
   `.github/workflows/sync-lead-assignments.yml`, and push that change.

## Rollback

If the Lambda version misbehaves, re-enabling the `schedule:` block in the two old
`.yml` files brings GitHub Actions back immediately - nothing about the old workflows was
deleted, only their trigger commented out.
