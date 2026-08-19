# RTO CRM Performance Audit — 2026-08-18

Where the tool is slow, why, and what to change — ordered by what agents actually feel.

Figures marked **[measured]** were taken against production during this audit (Sheets payloads and
timings, MySQL `EXPLAIN` and query timings, index inventory, assignment cadence from
`CLS_RTO_calling`). Figures marked **[estimated]** are read from code and benchmarked off-device —
confirm the magnitudes before relying on them.

## Headline numbers

| Metric | Value |
| --- | --- |
| Sheet response vs the 6 MB Lambda ceiling | **93% used** (5.59 MB) [measured] |
| Main-thread freeze parsing the sheet, every 60 s | **1546 ms** [measured] |
| Rows scanned on every disposition | **15,166** [measured] |
| Median gap between assignment runs | **220 s** [measured] |

---

## 1. Fix first — this is an outage, not a slowdown

### The sheet response sits at 93% of the hard Lambda limit, with no compression anywhere

`app/rto-crm/RtoCrmClient.js:25` sets `DEFAULT_SHEET_RANGE = 'Data'` — the entire tab, all 30
columns — fetched through the Lambda.

- Measured payload: **5.59 MB** against AWS Lambda's **6.00 MB** synchronous response limit.
- Headroom: **0.41 MB**. The payload crosses the ceiling at roughly **15,134 rows**.
- The sheet holds **14,102 rows** today.

There is no compression: no `compression` middleware in the Express app, and it is not even a
dependency. Gateway-level compression would not save this either — the 6 MB limit applies to what
the Lambda returns *to* the gateway, so the compression has to happen inside the function.

When it crosses, the CRM does not get slow. It returns an opaque 500 and goes blank. This matches
the known failure mode already recorded for unbounded sheet reads elsewhere in this codebase.

**Fix.** Add gzip inside the Lambda (JSON of this shape compresses ~85–90%, taking 5.59 MB well
under 1 MB) *and* stop sending all 30 columns — `mapTkt` consumes about 22 of them, and the cron
needs only 12 (`A:AD` → `A:Z` is a one-character start). Either alone buys headroom; both together
end the risk.

**How urgent, honestly.** Not a countdown. The sheet is a rolling ~18-day window (oldest RTO date
2026-07-30, newest 2026-08-17) at a median 639 rows/day, so it sits near equilibrium rather than
growing without bound. But equilibrium is only ~7% below the cliff, on a metric nobody is watching.
A single heavy import week, or extending retention by two days, crosses it.

---

## 2. Biggest single code win — the hottest write path

### `recordLeadDisposition` full-scans the table, and the index for it already exists

`api/_lib/db.js:944` matches `WHERE order_id = ? AND reassigned_away_at IS NULL`.
`CLS_RTO_calling` has only three indexes — `PRIMARY (id)`, `UNIQUE live_order_id_key`,
`UNIQUE live_awb_code_key` — and the old index on `order_id` was dropped. So every disposition
full-scans and row-lock-scans the table.

But `live_order_id` is a generated column defined as exactly
`IF(reassigned_away_at IS NULL, order_id, NULL)`, with a unique index on it. The rewrite is
semantically identical and needs no migration. Verified against production:

| Query | type | key | rows scanned |
| --- | --- | --- | --- |
| `order_id = ? AND reassigned_away_at IS NULL` | ALL | none | 15,166 |
| `live_order_id = ?` | const | live_order_id_key | 1 |

Equivalence confirmed on live data: all **15,984** rows with `reassigned_away_at IS NULL` have
`live_order_id = order_id`.

**Fix.** Change the predicate to `WHERE live_order_id = ${orderId}`. Same treatment for
`fetchAllLeadDates` (`db.js:2054`) → `WHERE live_order_id IS NOT NULL`. Then add
`INDEX (reassigned_away_at, assigned_at)` and `INDEX (disposed_at)` for the reporting queries,
which are still full scans.

---

## 3. Why it feels slow all day

With a tab open, agents lose roughly two seconds of main thread every minute, in long blocking
tasks.

### 3.1 Column lookup re-scans the header for every field of every row — 1546 ms [measured]

`app/rto-crm/RtoCrmClient.js:298`, the `g()` helper inside `mapTkt`.

`g()` runs `Object.keys(r).find(...)` against a 60-key object, lowercasing and regex-stripping both
the header *and* the search key on every comparison. It is called 14 times per row with 2–6
candidate names each — roughly 163 million string operations across 14,100 rows. The header is
identical for all of them.

**Fix.** Build a header → column-index map once in `parseRows`, then index directly. Measured at
**11 ms**, a 140× reduction. This also lets you delete the 60-key per-row object build entirely.

### 3.2 The localStorage cache exceeds quota, so it has never worked — 99 ms/min wasted [measured]

`app/rto-crm/RtoCrmClient.js:1172`.

`JSON.stringify` of 10,000 tickets produces **6.81 MB**. The browser localStorage quota is about
5 MB, so `setItem` throws, the bare `catch{}` swallows it, and nothing is ever cached. Every cold
load still waits for the full fetch and parse — while paying 99 ms of blocking stringify every
minute for the privilege.

**Fix.** Delete the write; nothing depends on it working today. If you want the cache back later,
store the ~10 fields the table paints for the first few hundred rows (~150 KB), or move it to
IndexedDB.

### 3.3 Overview metrics re-scan all tickets per agent, five times, every ~20 s — 569 ms [estimated]

`app/rto-crm/RtoCrmClient.js:2188–2701`.

Five independent full passes over every ticket, per roster agent — 2.82 M comparisons at 40 agents,
with `.toLowerCase()` allocated inside the filter predicates. Worse, it re-runs constantly: the
30-second presence poll calls `setServerPresence(d.agents)` with a fresh object identity even when
the bytes are unchanged, invalidating the memo for nothing.

**Fix.** Bucket tickets into a `Map<agentEmail, Ticket[]>` in one pass, then compute each agent's
metrics from their own bucket. Precompute `assignedAgentLower` in `mapTkt`. Bail out of the presence
`setState` when the payload is unchanged — that alone stops the 30 s and 5 min recomputes.

### 3.4 Search filters every row synchronously on each keystroke [estimated]

`app/rto-crm/RtoCrmClient.js:2719` and `:3303`. No debounce anywhere. Each keystroke re-runs the
full filter plus a sort, with up to 8 `.toLowerCase()` allocations per ticket, then cascades through
every un-memoized counter in the render path.

**Fix.** `useDeferredValue` — React 18 is already in use, so this is two lines and no debounce
logic. Also wrap the three un-memoized counters at `:1609–1614`, the roster table at `:1861`, and
the audit filter at `:3334` in `useMemo`.

### 3.5 Every disposition rebuilds and re-sorts the whole ticket list — ~600 ms [estimated]

`app/rto-crm/RtoCrmClient.js:1399` and the memo chain below it. `setOverrides` invalidates
`allTickets`, which re-maps, re-dedups and re-sorts every row, then cascades into six downstream
memos ending at the 569 ms overview block. This is the interaction agents perform most.

**Fix.** Keep the sorted, deduped base list in a memo keyed only on `tickets`, and apply overrides
in a second memo that touches only `Object.keys(overrides)`. The expensive dedup and sort then never
re-run on a disposal.

### 3.6 Smaller client wins

- `RtoCrmClient.js:3221` — Converted Orders renders every matching row with no `.slice()`; default
  scope is All Time. Cap at 200 with a "showing 200 of N" line; the CSV export already covers the
  rest.
- `RtoCrmClient.js:3641`/`:3712` — every lead row is rendered twice (desktop table + mobile cards,
  one hidden by CSS). React builds and diffs both.
- `app/_calling/ui.js:28-32` — every `CustomSelect` registers its own `document` mousedown listener;
  the roster renders ~5 per agent row. Register only while open.
- `RtoCrmClient.js:3577` — the date-scope selector calls `sync(false)`, a full sheet refetch, for a
  purely client-side filter. Delete the call.

---

## 4. Server and database

### 4.1 The sheet cache is cleared on every write, so it almost never hits [estimated]

`api/rto/sheet.js:123` calls `_readCache.clear()` on every `batchUpdate` — and every disposition and
bulk reassign is a batchUpdate. During a shift those arrive far more often than the 20-second TTL,
so the single largest object in the system is re-fetched from Google essentially every time. The
cache is also per-container, so N warm containers hold N independent copies.

**Fix.** Evict only the ranges the write touched (writes are single cells), or drop the blanket
clear — the browser already applies optimistic overrides, so a ≤20 s stale read costs nothing. Then
raise `READ_CACHE_TTL_MS` to 45–60 s so one fetch serves the whole team's poll minute.

### 4.2 Every API request re-derives the session with three uncached queries [estimated]

`api/_lib/session.js:69–76`. Each request runs `getUserById` plus permissions and tab-permissions
lookups. At roughly 224 requests/hour/agent, a ten-agent team re-derives permissions that change
monthly about 6,700 times an hour — all queued behind a pool capped at 5 connections per container.

**Fix.** Wrap the `{user, perms, tabPerms}` triple in `cachedRead` with a 60 s TTL. The stated
requirement — a removed user loses access on their next request — is preserved to within a minute.

### 4.3 The lead-dates cache is invalidated by the writes it should outlive [estimated]

`api/_lib/db.js:947` and `:976`. `fetchAllLeadDates` returns roughly 16,000 entries (~1.5–2 MB),
polled every 5 minutes per agent. Its 300 s TTL matches the poll interval exactly, but
`invalidateCache('calling:leadDates')` fires on every disposition and every claim, so the hit rate
collapses to near zero. The invalidation is per-container anyway, so it cannot make another
container fresh — ineffective for correctness, maximally effective at destroying the cache.

**Fix.** Delete both `invalidateCache` calls and keep the 300 s TTL.

### 4.4 Presence polling computes company-wide stats to return one agent's row [estimated]

`api/_lib/db.js:748–855`. A window function over the whole `agent_presence_log` history, with no
index on `email`, computed for every agent — then a single entry is indexed out of the result.
Uncached, 120 times an hour per agent.

**Fix.** Add `INDEX (email, changed_at)` on `agent_presence_log`, push an email filter into both
queries for the self-only path, and wrap the admin path in `cachedRead` with a 30–60 s TTL. Also
fold the `isCallingProcessAdmin` await into the existing `Promise.all`.

### 4.5 Other server notes

- `db.js:1491-1501` — `getCallingOverviewStats` has **no WHERE clause**; date bounds live inside the
  `SUM(CASE …)` expressions, so no index can ever help. Hoist the bounds into a real `WHERE`.
- `db.js:2008-2017` — `getCallingOverviewData` fires 5 full scans concurrently into a pool of 5,
  saturating the container. Wrap in `cachedRead`.
- `db.js:281-283` — three blind full-table `UPDATE`s on every cold start for a long-completed
  rename. Delete.
- `db.js:1436-1449` — `bulkDisposeDeliveryEscalationByAwb` is one serial UPDATE per AWB (N+1).
- `api/auth/[action].js:366-380` — `recentAssignments` has no caller anywhere in `app/`. Dead code
  that full-scans the table.

---

## 5. Making assignment faster

A new lead reaches an agent in about 3.5 minutes at the median and up to 7 minutes at worst. Almost
none of that is the robot's own work.

| Stage | Cost | What it is |
| --- | --- | --- |
| Waiting for the 5-minute tick | 0–300 s | Dominates. The instant trigger rarely fires. |
| The run itself | 35–50 s | Of a 60 s hard timeout, with the assignment write last. |
| Client noticing the write | 0–80 s | 60 s poll plus a 20 s server cache. |

### 5.1 The instant-assignment trigger almost never fires [estimated]

`api/auth/[action].js:358–360` requires `status === 'Online' && pendingBox === 0`, but the 2-minute
heartbeat (`app/_calling/useCallingSession.js:330-332`) sends no `pendingBox` at all — so it only
fires on an explicit status change or a page mount. Disposal never triggers it. An agent who works
their queue to zero simply waits for the next tick.

**Fix.** Trigger from `handleRecordDisposition` when the queue has just hit zero. Fire on that
**edge** only — reserved concurrency is 1 and async invokes retry for hours, so a per-heartbeat
trigger across idle agents would build a queue of duplicate full runs. Keep concurrency at 1; it is
what prevents double-assigning a blank row.

### 5.2 The assignment write happens last, behind deferrable bookkeeping [estimated]

`scripts/assign_leads.py:1134–1183` (refund stamps, punch stamps, cache flush) all sit between the
pool being finalised and the assignment write at `:1223`. This ordering is precisely why the
35-minute stall earlier today lost every bit of work it had done.

**Fix.** Move those three blocks to after `record_lead_assignments`. Write the assignment as early
as it is known, and let bookkeeping be what a timeout kills.

### 5.3 The Lambda runs on 256 MB — about 0.15 vCPU [estimated]

`lambda/deploy_infra.sh:67`. Every CPU-bound stage — cold-start imports, the RSA JWT signature,
JSON-parsing a multi-megabyte sheet, the 14,100-row loop — runs roughly seven times slower than at a
full vCPU.

**Fix.** Raise to 1536 MB. Lambda bills GB-seconds, so a 5× speedup at 6× memory is roughly
cost-neutral, and it buys real headroom under the 60 s kill. Note the deploy workflow only runs
`update-function-code`, so the memory change must be applied to the live function too.

### 5.4 Refund and punch checks process the whole backlog, not what can be assigned [estimated]

`scripts/assign_leads.py:1093` and `:1109` check every pending lead, but a run can only hand out the
sum of remaining quota across online agents — typically tens. Everything beyond that is computed and
discarded.

**Fix.** Compute the run's real capacity after the main loop, sort the pool with the same key
`build_assignment_queue` uses, and check only the top slice. Strictly more correct than the current
fail-open budget cap, and it largely retires the need for `GOKWIK_MAX_CHECKS_PER_RUN`.

### 5.5 Agents wait up to 80 s to see a lead that is already theirs [estimated]

`app/rto-crm/RtoCrmClient.js:1217` — the client only learns about an assignment on its 60-second
full-sheet poll, behind a 20-second server cache.

**Fix.** The client already has a two-column probe (`fetchLiveOrderAndAgentMap`). Poll *that* every
15 s and trigger a full sync only when Column Q gains a row for the signed-in agent — 2 columns
instead of 30, detection drops from 80 s to ≤15 s.

### 5.6 Other assignment notes

- `assign_leads.py:594-596` and `:515` are unbounded reads that grow forever. Bound them
  (`assigned_at >= NOW() - INTERVAL 25 HOUR`; `refunded OR checked_at >= now() - interval '3 hours'`)
  — both exactly equivalent to current behaviour.
- `assign_leads.py:778-781` — `record_lead_assignments` opens a brand-new MySQL connection while
  `mysql_lib._conn` is already warm.
- `lib.py:108-113` mints two OAuth tokens per cold container; the write scope already covers reads.
- `lib.py:172-176` passes no `timeout=` on the sheet write — the one call that must not be lost can
  hang until the Lambda is killed. `mysql_lib.py:80` sets `read_timeout=180` on a 60 s function.
- `lambda/deploy_infra.sh:168-175` runs `rate(5 minutes)` 24/7; ~68% of invocations open a Postgres
  connection and exit at the business-hours gate.

---

## 6. Two regressions introduced on 2026-08-18 (the quota work)

### 6.1 The claim endpoint reads 155,000 sheet cells per claim — 2.37 s, 1.52 MB [measured]

`api/rto/claim.js:84` and `:157–171`. `getLoadByAgent` batch-reads `E2:E` plus `Q2:Z` to count one
agent's undisposed leads. The cache TTL is 15 s, but claims arrive further apart, so most claims pay
the full cost. The single-cell Column Q read is also awaited separately from the quota fan-out,
costing an extra round trip.

**Fix.** Raise `LOAD_CACHE_TTL_MS` to 60 s — it gates a cap of 20, so a minute of staleness costs at
most a couple of over-quota claims — and fire the Column Q read concurrently with the quota lookup.
Longer term this becomes an indexed `COUNT(*)` once `backfill_selfclaimed_rto_rows.py` has cleaned
the table.

### 6.2 `claimRtoLead` invalidates the 2 MB lead-dates cache on every claim [estimated]

`api/_lib/db.js:976` — copied from the disposal path. Same problem as 4.3: per-container, so useless
for correctness, while reliably destroying the largest cached read in the system. Remove it
alongside the disposal-path one.

---

## 7. Suggested order

1. **Compression and column pruning on the sheet response.** Ends the outage risk and makes every
   page load faster. Nothing else matters if the CRM returns 500.
2. **The `live_order_id` rewrite.** One predicate, no migration, turns the hottest write from a
   15,166-row scan into a single-row lookup.
3. **Stop clearing the sheet cache on write; drop the lead-dates invalidations; cache the session.**
   Three small deletions that between them fix the 60 s poll, the largest payload, and every request.
4. **Client: header-index map, delete the broken localStorage write, bucket the overview metrics.**
   Removes about two seconds of blocking work per minute per open tab.
5. **Assignment: trigger on queue-drain, move the write ahead of bookkeeping, raise Lambda memory.**
   Takes the common case from ~3.5 minutes to well under 30 seconds.
6. **The rest** — capacity-scoped refund checks, the 15 s client probe, indexes for the reporting
   queries, and the two regressions in section 6.

---

## Note on one withdrawn measurement

An earlier reading in this session put assignment cadence at a 34-second median, suggesting the
instant trigger was doing the work. That was wrong: 426 of the 476 sampled rows were created *by
disposals* (`recordLeadDisposition` inserts with `assigned_at = disposed_at` when no live row
exists), not by assignments. Filtering those out leaves 55 true assignment moments with a median gap
of **220 s**, which is what section 5 is based on.
