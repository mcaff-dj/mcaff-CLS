# NPS-Calling — Product Leads from `nps_product` — Design Spec

**Date:** 2026-09-06
**Status:** Awaiting user review of this spec, pending written-plan handoff
**Follows:** `2026-09-05-nps-calling-round-robin-design.md` (auto-assign triggers, one shared
quota per agent — unchanged by this spec) and `2026-08-28-per-team-dispositions-design.md`
(the `team_id` nullable-scope pattern this spec reuses for `lead_type`).

## Goal

NPS-Calling's detractor pool currently comes only from `nps_delivery` (delivery-experience
survey). Add a second, independent detractor pool sourced from `nps_product` (product-rating
survey — separate respondents, separate `response_id` space, confirmed with user). Both pools
feed the same agent, the same quota, the same ticket list — but a Product lead must show its own
survey fields and offer its own disposition tree, distinct from Delivery's.

## Scope decisions (confirmed with user)

| Decision | Choice |
| --- | --- |
| Pool relationship | `nps_delivery` and `nps_product` are separate response pools — not the same person appearing in both. |
| Lead granularity | One call lead per `response_id`, even though `nps_product` has up to 4 rows per response (one per rated product, `product_slot` 0–3). Dedup to the person, same shape as `nps_delivery` today. |
| Quota | One shared quota per agent, mixed pool — no per-type quota, no per-agent type assignment. Auto-fill and self-refill (existing triggers, unchanged) pull whichever pool has the globally oldest (or newest, per admin setting) eligible lead. |
| Process/tab | Same `'detractor'` process, same page (`/nps-calling`), same admin panel. No new `callingProcesses.json` entry. |
| Disposition tree | Per-`lead_type` tree, same nullable-scope mechanism `team_id` already uses: `lead_type IS NULL` = today's shared/Delivery tree (no data migration — existing rows keep meaning), `lead_type = 'product'` = new tree, admin-configured from scratch (no seed data implied by this spec). |

## Schema

### `CLS_NPS_calling` — one new column, one generated-column change

```
CLS_NPS_calling
  + lead_type ENUM('delivery','product') NOT NULL DEFAULT 'delivery'
  ~ live_response_id VARCHAR(64) GENERATED ALWAYS AS
      (IF(reassigned_away_at IS NULL, CONCAT(lead_type, ':', response_id), NULL)) VIRTUAL
```

`live_response_id` is the table's actual dedup mechanism today (a generated column carrying a
`UNIQUE KEY`, not a raw `PRIMARY KEY(response_id)` — reassigning a lead sets it back to `NULL` so
the same `response_id` can be claimed again later). `nps_delivery` and `nps_product` are
independent UUID spaces with no shared generator, so a same-string collision between the two is
extremely unlikely — but since the fix is one `CONCAT` away and the alternative (an unrelated
Delivery and Product lead silently colliding on the unique key) is a hard-to-diagnose failure,
the generated column is namespaced by `lead_type` rather than relying on that assumption.

Existing rows: `lead_type` backfills to `'delivery'` (the column default), matching every row's
actual origin today.

### `calling_process_dispositions` — one new nullable column

```
calling_process_dispositions
  + lead_type VARCHAR(16) NULL
  ~ KEY calling_process_dispositions_process_key_idx (process_key, lead_type, sort_order)
```

Same convention as `team_id`: `NULL` means shared/fallback, not "unassigned" — every existing row
(every process, including today's `'detractor'` rows) keeps its current meaning, no data
migration needed. Only `'detractor'` is expected to ever use a non-null value; every other
process's rows stay `lead_type IS NULL` forever, same as `team_id` for RTO/Escalation.

## Resolution rules — disposition tree

`getProcessDispositions(processKey, teamId, leadType)` gains a second independent fallback,
applied **after** today's team resolution (unchanged):

```
1. Resolve team scope exactly as today: teamId's own rows if any exist, else team_id IS NULL.
2. Within that resolved team scope, resolve lead_type:
     leadType given AND that (team scope, lead_type) has rows  -> those rows only
     leadType given AND no rows for that lead_type             -> lead_type IS NULL rows (shared)
     no leadType                                                -> lead_type IS NULL rows only
```

In practice `'detractor'` has no active teams today (`NpsCallingClient.js` calls
`useProcessDispositions(PROCESS_KEY, { googleUser, showToast })` with no `teamId`), so step 1
always resolves to the shared team scope — step 2 is the only fallback that matters until/unless
NPS-Calling ever adopts team-splitting too. The two dimensions are kept independent (not merged
into one combined nullable column) so that stays true without extra work.

### Where `leadType` comes from

Never from an agent's client for writes, same trust model as `teamId`:

| Caller | Read (`GET`) | Write (`POST`/`PUT`/`DELETE`) |
| --- | --- | --- |
| Agent (viewing a ticket) | the ticket's own `lead_type`, read from `CLS_NPS_calling` | n/a |
| Admin (Disposition List editor) | `?leadType=` selects which tree to view/edit | `body.leadType` — honored for any admin (no per-role restriction; disposition-tree edits are already full-admin-scoped for a process with active teams, and adding a second free-form dimension doesn't need a stricter rule than that) |

## Claim / assignment logic — `api/_lib/db.js`

### `claimOneProductDetractorLead(email)` — new

Same shape as `getNextDetractorLead` (renamed conceptually to `claimOneDeliveryDetractorLead` for
symmetry, no behavior change): dedups `nps_product` to one row per `response_id`
(`nps_category = 'Detractor'`, 30-day recency on `submitted_date`, same per-agent brand filter),
aggregating the slots with a real (non-`'NA'`) `product_name` into one `product_name_list`-style
comma-joined field — same convention `nps_delivery`/`NpsCallingClient.js`'s
`splitProductNameList` already parses. A response can have more than one real-named slot (up to
4); the per-product rating fields (`results`, `texture`, `fragrance`, `packaging`,
`skin_type_category`, `product_nps`) are taken from the FIRST real-named slot only (lowest
`product_slot`) — the agent sees one representative product's ratings plus the full product name
list, rather than trying to render up to 4 parallel rating sets on one ticket. `overall_nps_score`
and `additional_feedback` are constant across a response's slots (per `nps_source.py`'s own
finding) and copied as-is. Inserts into `CLS_NPS_calling` with `lead_type = 'product'`.

### `assignDetractorLeadsToAgent` — merge, not two separate loops

Each iteration of the existing claim loop peeks the top eligible candidate from **both** sources
(`getNextDetractorLead`-style `SELECT ... LIMIT 1` against `nps_delivery`, and the equivalent
against `nps_product`, both already excluding rows already in `CLS_NPS_calling` via the existing
`LEFT JOIN ... IS NULL` pattern) and claims whichever candidate's `submitted_date` wins under the
admin's configured lead order (oldest/newest — same `getCallingLeadOrder('detractor')` setting
applies to both pools, not a per-type setting). The existing dup-retry-on-race handling
(`ER_DUP_ENTRY`, up to `DETRACTOR_CLAIM_DUP_RETRIES`) applies to whichever pool's claim raced.

If one pool is exhausted, the loop simply keeps drawing from the other — no special-casing
needed, since "peek returns nothing" and "peek returns a row" are already the two outcomes the
merge step handles.

### `getUnassignedDetractorLeads` — merge for the admin preview

Same merge, read-only: union the two pools' unclaimed previews, sorted oldest-first together,
each row tagged with its `lead_type` for the admin preview's badge.

## API changes

- `api/detractor/tickets.js` — no signature change; `getDetractorTicketsForAgent` /
  `getAllDetractorTickets` / `getUnassignedDetractorLeads` responses gain `lead_type` (and, for
  product leads, the product-specific fields) per row.
- `api/admin/[action].js`'s `handleDispositions` — GET resolves `leadType` from `?leadType=`
  alongside the existing `teamId` resolution; POST/PUT/DELETE pass `body.leadType` through the
  same way `body.teamId` already is.
- `api/detractor/lead-assignment.js` — no logic change; `disposeDetractorLead`'s `disposition`
  value is free text either way, validated against whichever tree the agent's UI rendered client-
  side (same trust boundary as today — the server doesn't re-validate label text against the
  tree, unchanged from current behavior).

## UI changes

- `app/nps-calling/NpsCallingClient.js`:
  - `AREAS` (Delivery's rating/reason/openend layout) stays as-is; a new parallel `PRODUCT_AREAS`
    (or equivalent) config drives `TicketSurveyDetails` for `lead_type === 'product'` tickets —
    `results`, `texture`, `fragrance`, `packaging`, `skin_type_category`, `overall_nps_score`,
    `additional_feedback` in place of Delivery's per-area rating/reason/openend blocks.
  - Ticket list/queue shows both types together (oldest-first, per the shared-quota decision),
    each row carrying a small type badge (Delivery / Product).
  - `useProcessDispositions(PROCESS_KEY, { googleUser, showToast, leadType })` — `leadType` comes
    from the ticket currently open in the dispose modal (or from the admin's own Lead Type
    selector when editing the tree), refetching when it changes, same pattern `teamId` already
    established.
- `app/_calling/CallingAdminPanel.js`:
  - `useProcessDispositions` gains a `leadType` option, sent on load and every mutation.
  - `ProcessDispositionsCard` gains a Lead Type selector next to the existing Team selector (only
    rendered for processes where it's meaningful — i.e. `'detractor'` for now, gated the same way
    the existing Team selector already is conditional on a process having teams) and its heading
    names which tree is open: `Disposition List — NPS-Calling · Product`, or no suffix for the
    shared/Delivery tree.

## Migration — `scripts/migrate_nps_calling_lead_type.py`

Same shape as `scripts/migrate_team_dispositions.py`: dry-run by default, `--apply` performs the
work, idempotent (checked via `information_schema` before altering).

1. Add `CLS_NPS_calling.lead_type` (default `'delivery'`) if absent.
2. Rebuild `live_response_id`'s generated expression to the `CONCAT(lead_type, ':', response_id)`
   form above (`ALTER TABLE ... MODIFY COLUMN`) if it doesn't already match — a generated column's
   definition can be altered in place; existing data re-derives automatically, no backfill loop
   needed.
3. Add `calling_process_dispositions.lead_type` (nullable) and its index if absent.

**Run order matters**, same reason as the per-team migration: apply before the `api/` deploy that
selects the new columns, or reads throw `ER_BAD_FIELD_ERROR`.

Rollback: drop `calling_process_dispositions.lead_type` (plain nullable column, no FK, safe to
drop directly); revert `CLS_NPS_calling.live_response_id`'s generated expression back to
`IF(reassigned_away_at IS NULL, response_id, NULL)` before dropping `lead_type` itself (the
generated column references it).

## Testing

No live-DB or dev-server runs (user performs live testing). Pure-logic pieces get an
`assert`-based self-check, per repo convention:

- `claimOneProductDetractorLead`'s dedup: multi-slot response collapses to one lead; `'NA'`-named
  slots are dropped from the aggregated product list; 30-day/brand-filter behavior matches
  `nps_delivery`'s existing test coverage shape.
- The merge step in `assignDetractorLeadsToAgent`/`getUnassignedDetractorLeads`: picks the older
  (or newer, per lead order) of the two pools' candidates; falls back cleanly when one pool is
  empty; never double-claims (peek-then-claim race between the two pools is covered by the
  existing per-pool dup-retry, not new logic).
- Disposition resolution: a `'product'` scope with no rows falls back to the shared tree; a
  `'product'` scope with its own rows never leaks into a Delivery ticket's tree and vice versa.
- Migration script: idempotency (`--apply` twice is a no-op the second time) and the generated-
  column rewrite, following `migrate_team_dispositions.py`'s self-check shape.

Manual verification steps for the user:

1. A Detractor `nps_product` response, not present in `nps_delivery`, becomes claimable and shows
   up in an agent's queue tagged "Product".
2. Disposing a Product ticket offers the Product tree only; disposing a Delivery ticket is
   unaffected (still the tree configured today).
3. Admin Panel's Disposition List has a Product/Delivery (or unset) selector for NPS-Calling only
   — RTO/NDR/Escalation panels unchanged.
4. Going Online / self-refill still fills to quota with a mix of both types, oldest lead first
   regardless of which table it came from.

## Out of scope

- Any change to `nps_delivery`'s own claim logic, fields, or disposition tree — this spec only
  adds a second pool alongside it.
- Sentiment-based reclassification of Promoter/Passive responses in either table (a separate,
  already-identified gap — not addressed here).
- Per-agent or per-team routing by lead type (e.g. "this agent only gets Product leads") — the
  user explicitly chose one shared, mixed quota.
- A seeded starter Product disposition tree (like `seed_nps_calling_dispositions.py` did for
  Delivery's launch) — the admin configures Product's tree from scratch via the existing
  Disposition List UI; add a seed script later only if that proves tedious in practice.
