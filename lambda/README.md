# Cron jobs on Lambda, not GitHub Actions

## Status (2026-08-13)

- **`sync-lead-assignments.yml` (daily) — migrated, live.** Its recurring invocation now
  runs on EventBridge Scheduler + `mcaff-cls-sync-lead-assignments` Lambda. GitHub's
  `schedule:` trigger is disabled (`workflow_dispatch:` kept as a manual fallback).
- **`assign-leads.yml`'s `assign-rto` job (every 5 minutes) — migrated, live.** Talked to
  Vikash first. Runs on EventBridge Scheduler + `mcaff-cls-assign-leads` Lambda, rebuilt
  and tested against the actual current code (not the stale clone the first attempt used
  - see the 2026-08-13 incident note below). Two real bugs were found and fixed during
  testing before cutover: the package was missing the `pymysql` dependency
  `mysql_lib.query()` needs, and the `mcaff_cls_app` MySQL user lacked `SELECT` on
  `mcaff_prod` (needed for the GoKwik order-ID lookup) - granted via `GRANT SELECT ON
  mcaff_prod.* TO 'mcaff_cls_app'@'%'`. The GitHub side isn't fully off: `assign-rto`'s
  job has `if: github.event_name != 'schedule'` so the *schedule* trigger skips it (Lambda
  owns that now) while `workflow_dispatch` still works as a manual fallback.
- **`assign-leads.yml`'s `assign-ndr` job — built, NOT migrated yet.** The
  `mcaff-cls-assign-ndr-leads` Lambda exists and its read/decision logic is confirmed
  working against real data, but the actual write path (an assignment landing in the
  sheet + `ndr_lead_assignments`) hasn't been observed yet - every test run so far found
  no agent with spare quota. Its EventBridge schedule stays `DISABLED` and `assign-ndr`'s
  GitHub job is untouched (still running there on schedule, same as before) until that's
  verified.

Both `assign-rto` and `assign-ndr` share one workflow file and one `on: schedule:`
trigger, so cutting over RTO alone needed a job-level `if:`, not just commenting out the
schedule block (that would have also stopped NDR).

## Why these jobs specifically

Both `assign-leads.yml` and `sync-lead-assignments.yml`'s recurring *invocations* don't
need GitHub Actions at all - only actual code changes do. `assign-leads` was the original
trigger for this whole migration: its 5-minute cron on `ubuntu-latest` was running
~8,640 times/month, well over 4x the entire free 2,000-minute Actions quota, before it
moved to a self-hosted runner on 2026-08-12 (which sidesteps the minutes quota but still
depends on that runner staying online). `sync-lead-assignments` was a smaller (~30
min/month) but real ongoing cost with no reason to keep it on Actions either.

`refresh.yml`/`export-resolved-tickets.yml`/`sync-delivery-tickets.yml`/
`refresh-productkyc.yml` are **not** part of this migration because they `git commit`+
`push` results back to `main` as part of their run - Actions gives that for free (already
checked out, already git-authenticated) but Lambda would have to reimplement it (bundle
the `git` binary, store a push-capable PAT, hand-roll the rebase-retry loop `refresh.yml`
already has). Combined those four cost ~400 Actions min/month - not worth that rework.

## What's here

- `assign_leads/handler.py`, `assign_ndr_leads/handler.py`,
  `sync_lead_assignments/handler.py` - thin Lambda entrypoints. Each imports the real
  `scripts/*.py` unmodified - no forked/duplicated logic anywhere.
- `build.sh` - assembles each deployment zip (code + manylinux-wheel deps) from the
  repo's actual `scripts/`. **Always run this from an up-to-date checkout** - `git fetch`
  / `git log -- <path>` the specific files first if there's any doubt; building from a
  stale clone is exactly what went wrong the first time `assign-leads`'s migration was
  attempted (see incident note below).
- `deploy_infra.sh` - **one-time** bootstrap: IAM role, all three Lambda functions,
  EventBridge Scheduler schedules. Not meant to be re-run after initial setup.
- `../.github/workflows/deploy-cron-lambdas.yml` - ongoing: redeploys code whenever
  someone pushes a change to the relevant files. Currently only wired for
  `sync-lead-assignments`'s files - `assign_leads.py`/`assign_ndr_leads.py`'s paths still
  need adding once NDR is cut over too, so a future push to either doesn't silently leave
  the Lambda on stale code.

## Before migrating assign-ndr (when that's decided)

1. Get a real write to actually happen and confirm it: an assignment landing in the NDR
   sheet's Agent Name column, and a matching row in Postgres `ndr_lead_assignments`. Every
   test so far found 0 spare quota across all online agents - not a bug, just never
   observed doing its one real job yet.
2. Rebuild from a **freshly fetched** `main` regardless of how recently `assign-rto` was
   verified - `assign_ndr_leads.py` is a separate file that can change independently.
3. Only then flip its EventBridge schedule on and add the job-level `if:` to
   `assign-ndr` in `assign-leads.yml`, same pattern as `assign-rto` above.

## Incident note (2026-08-13)

A first attempt at migrating `assign-leads` was built from a local clone 339 commits
stale. It nearly shipped a patch for a Postgres bug that someone (Vikash) had already
fixed properly upstream, and would have raced his self-hosted runner on the same
schedule undetected. Caught before merging. Every migration since has started with an
explicit `git fetch` + `git log -- <path>` check against `origin/main`, not assumptions
carried over from earlier in the session.

## Rollback

If either live Lambda misbehaves:
- **`sync-lead-assignments`**: re-enable the `schedule:` block in
  `sync-lead-assignments.yml`.
- **`assign-rto`**: remove the `if: github.event_name != 'schedule'` line from
  `assign-leads.yml`'s `assign-rto` job (or just disable
  `assign-leads-every-5-min`'s EventBridge schedule to stop the Lambda side first, then
  decide).

Nothing is deleted in either case, only triggers toggled.
