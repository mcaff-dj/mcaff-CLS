# Cron jobs on Lambda, not GitHub Actions

## Status (2026-08-13)

- **`sync-lead-assignments.yml` (daily) — migrated, live.** Its recurring invocation now
  runs on EventBridge Scheduler + `mcaff-cls-sync-lead-assignments` Lambda. GitHub's
  `schedule:` trigger is disabled (`workflow_dispatch:` kept as a manual fallback).
- **`assign-leads.yml` (every 5 minutes, both the RTO and NDR jobs) — NOT migrated yet,
  deliberately.** It moved to a self-hosted GitHub Actions runner on 2026-08-12, which
  already solves the original GitHub Actions billing problem for this job (self-hosted
  runner time isn't metered against the included Actions minutes the way `ubuntu-latest`
  is). It's also under active development (the Postgres schema for lead assignments was
  reworked around the same time - see `record_lead_assignments`'s `reassigned_away_at`/
  partial-unique-index logic). Migrating this needs the same current-code care taken here,
  plus signing off with whoever owns that runner first - moving it without warning would
  cut over infrastructure someone else is actively building on. See the chat thread from
  2026-08-13 for the full incident (a first attempt at this was built from a stale local
  clone - 339 commits behind - and nearly shipped an already-obsolete bug patch and a
  double-run race; this file's `sync-lead-assignments` migration was redone from a
  freshly-verified-current checkout after that was caught).

## Why this job specifically

`sync-lead-assignments.yml`'s recurring *invocation* doesn't need GitHub Actions at all -
only actual code changes do. Before this move it was a real (if modest, ~30 Actions
min/month) ongoing cost with no offsetting reason to keep it there - unlike
`refresh.yml`/`export-resolved-tickets.yml`/`sync-delivery-tickets.yml`/
`refresh-productkyc.yml`, which are **not** part of this migration because they
`git commit`+`push` results back to `main` as part of their run - Actions gives that for
free (already checked out, already git-authenticated) but Lambda would have to
reimplement it (bundle the `git` binary, store a push-capable PAT, hand-roll the
rebase-retry loop `refresh.yml` already has). Combined those four cost ~400 Actions
min/month - not worth that rework.

## What's here

- `sync_lead_assignments/handler.py` - thin Lambda entrypoint. Imports the real
  `scripts/sync_lead_assignments_to_mysql.py` and `sync_agent_presence_log_to_mysql.py`
  unmodified - no forked/duplicated logic.
- `build.sh` - assembles the deployment zip (code + manylinux-wheel deps) from the repo's
  actual `scripts/`. **Always run this from an up-to-date checkout** - `git fetch` /
  `git log -- <path>` the specific files first if there's any doubt; building from a stale
  clone is exactly what went wrong the first time this migration was attempted. Needs Linux
  (WSL / CI runner / AWS CloudShell) - see its header comment.
- `deploy_infra.sh` - **one-time** bootstrap: IAM role, both Lambda functions (the
  `assign-leads` one exists but is currently `DISABLED` on its schedule - see Status
  above), EventBridge Scheduler schedules. Not meant to be re-run after initial setup.
- `../.github/workflows/deploy-cron-lambdas.yml` - ongoing: redeploys code to the Lambdas
  whenever someone pushes a change to the relevant files. This is the "code push" half -
  Vikash still just pushes to `main`, same as every other change. Currently only wired for
  `sync-lead-assignments`'s files.

## Before migrating assign-leads (when that's decided)

1. Confirm with whoever owns the self-hosted runner (Vikash) before touching anything -
   it's their active infrastructure from the last day, not a stale/idle job.
2. Rebuild from a **freshly fetched** `main` - `git fetch origin main && git log -1
   --format="%H %s" origin/main` and compare against what `build.sh` actually packages,
   file by file if needed. `assign_leads.py` alone gained a second file dependency
   (`scripts/assign_ndr_leads.py`, a whole separate NDR assignment job) since this was
   first attempted - check for others.
3. Test-invoke manually and read the full log output before touching any schedule.
4. Only disable the self-hosted runner's `schedule:` trigger once the Lambda version is
   confirmed correct against current logic - not before.

## Rollback

If the Lambda version misbehaves, re-enabling the `schedule:` block in
`sync-lead-assignments.yml` brings GitHub Actions back immediately - nothing was deleted,
only the trigger commented out.
