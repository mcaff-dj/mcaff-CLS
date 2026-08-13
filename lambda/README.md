# Cron jobs on Lambda, not GitHub Actions

## Status (2026-08-13)

All three cron jobs from `assign-leads.yml` and `sync-lead-assignments.yml` are migrated
and live:

- **`sync-lead-assignments.yml` (daily)** — EventBridge Scheduler + Lambda. GitHub's
  `schedule:` trigger is disabled, `workflow_dispatch:` kept as a manual fallback. This
  Lambda (`mcaff-cls-sync-lead-assignments`) originally ran two jobs; it now only runs
  the agent-presence-log sync - the lead-assignments half was retired once
  `lead_assignments` moved OFF Postgres onto MySQL `CLS_RTO_calling` directly (see
  `scripts/migrate_cls_rto_calling_schema.py` /
  `migrate_lead_assignments_to_cls_rto_calling.py`), leaving nothing for a daily copy to
  do. The Lambda/schedule name is a leftover from before that; not renamed to avoid
  re-touching live infra for a cosmetic reason.
- **`assign-leads.yml`'s `assign-rto` job (every 5 minutes)** — EventBridge Scheduler +
  Lambda. Talked to Vikash first, since it moved off his self-hosted runner. Two real
  bugs were found and fixed during testing before cutover: the package was missing the
  `pymysql` dependency `mysql_lib.query()` needs, and the `mcaff_cls_app` MySQL user
  lacked `SELECT` on `mcaff_prod` (needed for the GoKwik order-ID lookup) - granted via
  `GRANT SELECT ON mcaff_prod.* TO 'mcaff_cls_app'@'%'`. The app's own instant-assignment
  trigger (an agent coming online with an empty queue - see `api/auth/[action].js`) was
  also found still dispatching this job on GitHub on every empty-queue heartbeat, racing
  the new Lambda schedule; fixed to invoke the Lambda directly instead (see that file's
  `triggerImmediateLambdaAssignment`).
- **`assign-leads.yml`'s `assign-ndr` job (every 5 minutes)** — EventBridge Scheduler +
  Lambda, cut over once real spare agent quota let the write path actually be observed
  (every earlier test found 0 spare quota across all online agents). Its instant-
  assignment trigger moved to Lambda invocation at the same time, avoiding the mistake
  made with `assign-rto` (fixed only after the fact there).

Both `assign-rto` and `assign-ndr` share one workflow file and one `on: schedule:`
trigger in `assign-leads.yml`, so stopping either on GitHub needed a job-level `if:`,
not commenting out the shared schedule block (which would have stopped both).

## Two Postgres bugs found during migration, both since fixed (2026-08-13)

**RTO** - `record_lead_assignments()`'s `ON CONFLICT (order_id)` upsert failed on every
call before 2026-08-12's `reassigned_away_at`/partial-unique-index rework (see git
history) - same code, same failure on GitHub or Lambda. Already fixed upstream (by
Vikash) by the time this migration reached it; mentioned here only because a first
attempt at this migration (built from a 339-commit-stale local clone) nearly re-broke it
with an already-obsolete patch - see the incident note below. Verified after the fact:
zero `order_id`s currently have more than one live row, so nothing further needed here.

**NDR** - `record_new_assignments()` never had the equivalent fix: it only ever `INSERT
... ON CONFLICT (awb_number) WHERE reassigned_away_at IS NULL DO NOTHING`, with no step
to retire an existing live row first. Whenever a lead was reassigned after its first
agent's cycle ended, the sheet correctly showed the new agent while the insert silently
conflicted with the still-live old row and got dropped - Postgres stayed stuck on the
stale agent forever, invisibly. Found via write-path verification during cutover: of 24
leads assigned in one test, only 7 landed in Postgres; a full sheet-vs-Postgres
cross-check found 402 of 2,009 assigned AWBs system-wide affected (264 missing from
Postgres entirely, 138 stuck under a stale agent). Fixed by adding the same
retire-then-insert transaction RTO already had, and backfilled all 402 rows to match the
sheet's current (correct) state - true historical `assigned_at` for the backfilled rows
is unrecoverable, stamped `now()` as an explicit approximation rather than fabricated.
Verified after backfill: zero missing, zero mismatched, zero invariant violations.

## Why these jobs specifically

All three jobs' recurring *invocations* don't need GitHub Actions at all - only actual
code changes do. `assign-leads` was the original trigger for this whole migration: its
5-minute cron on `ubuntu-latest` was running ~8,640 times/month, well over 4x the entire
free 2,000-minute Actions quota, before it moved to a self-hosted runner on 2026-08-12
(which sidesteps the minutes quota but still depends on that runner staying online).
`sync-lead-assignments` was a smaller (~30 min/month) but real ongoing cost with no
reason to keep it on Actions either.

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
  EventBridge Scheduler schedules (all created `ENABLED` - reflects current live state,
  not a fresh from-scratch bootstrap sequence). Not meant to be re-run as-is against an
  already-live setup.
- `../.github/workflows/deploy-cron-lambdas.yml` - ongoing: redeploys code to all three
  Lambdas whenever someone pushes a change to any of their relevant files.

## Incident note (2026-08-13)

A first attempt at migrating `assign-leads` was built from a local clone 339 commits
stale. It nearly shipped a patch for a Postgres bug that someone (Vikash) had already
fixed properly upstream, and would have raced his self-hosted runner on the same
schedule undetected. Caught before merging. Every migration since has started with an
explicit `git fetch` + `git log -- <path>` check against `origin/main`, not assumptions
carried over from earlier in the session - and, separately, every app-level trigger of
each job (not just the cron schedule itself) was checked before declaring a job fully
migrated, after the `assign-rto` instant-assignment trigger was initially missed.

## Rollback

If any live Lambda misbehaves: remove its `if: github.event_name != 'schedule'` line
from `assign-leads.yml` (or re-enable `sync-lead-assignments.yml`'s `schedule:` block),
disable the corresponding EventBridge schedule, and - if it's `assign-rto`/`assign-ndr` -
revert `api/auth/[action].js`'s trigger back to a GitHub `workflow_dispatch` call for
that process. Nothing is deleted in any case, only triggers toggled.
