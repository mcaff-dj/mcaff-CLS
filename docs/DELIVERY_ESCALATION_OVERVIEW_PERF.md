# Delivery-Escalation Overview: slow-load fixes

Audit finding (2026-09-16): the Overview tab's `op=daywise` response is ~4.7 MB of JSON
rendered into 3 collapsed month rows. Everything below month grain is behind a click that
often never happens, and the single biggest contributor is a dimension nobody sees until
they expand a row three levels deep.

## Where the 4.7 MB goes

`buildDeliveryEscalationDaywiseResult` emits, per date (~78 dates in the default range):

| part | objects/date | bytes/date |
| --- | --- | --- |
| `partners[]` (~25 raw courier values) | 25 | 11 KB |
| `categories[]` (~8 query classes) | 8 | 4 KB |
| `contactBuckets[]` x nested `partners[]` | 4 x 26 | **47 KB** |
| the date's own counts/pct/ageCounts/agePct | - | 0.8 KB |

`contactBuckets[].partners` alone is ~72% of the payload. Every object carries `counts`
AND `pct` with the full bucket labels as keys, repeated - `pct` is exactly half the bytes
of every object and is pure arithmetic over `counts`.

## Fixes

### 1. `contactBuckets[].partners` becomes its own lazy op (~72% cut)

Server stops emitting it. A new `op=daywiseContactPartners&contactBucket=<bucket>` serves
one contact bucket's partner split from its own narrower `GROUP BY d, partner, bucket`
query, scoped by `de_contact_bucket = ?` so it reads only that population. The client
fetches it when the Repeat Contacts row is expanded and caches it by bucket - the same
fetch-on-expand pattern `toggleGeoState`/`awbHistory` already use in this file.

### 2. `pct` leaves the breakdown arrays (~2x cut on what remains)

`pct` is `Math.round(counts[b] / total * 100)`, but as a second full-width object keyed by
the same long bucket labels it was half the bytes of every entry emitted. It is dropped
from `partners[]` / `categories[]` / `contactBuckets[]` - ~37 entries per date, which is
where the bytes were - and KEPT on the date row itself, which costs ~200 bytes a date.

The asymmetry is a deploy-safety requirement. api/ and app/ deploy independently, so an
old bundle reads these responses for a while, and it indexes `day.pct[bucket]` /
`day.agePct[bucket]` directly when rendering the date table's leaf rows - a missing `pct`
there is a TypeError, not a blank cell. It never reads a breakdown entry's own `pct`:
`groupPartnerwiseRows` / `groupCategorywiseRows` / `groupContactBucketwiseRows` all funnel
through `mergeDayRowsByDate` / `sumDaywiseRows`, which recompute it from `counts`.

No client change needed at all, in either direction.

Combined with fix 1: ~4.7 MB -> ~0.65 MB.

The other direction of that deploy window: a NEW bundle can reach an OLD Lambda, which
does not reject `op=daywiseContactPartners` - it falls through to the ticket LIST query and
answers with a page of tickets. `fetchDaywiseContactPartners` therefore keeps only rows
that carry a `counts` object, so that window degrades to an empty partner split rather than
ticket rows rendered as courier names.

### 3. Overview cache TTL 60s -> 180s

`DE_OVERVIEW_CACHE_TTL_MS` was exactly the client's own poll interval, so every poll
landed just past expiry and missed. Every write path already calls `invalidateCache('de-')`,
so an agent's own dispose still updates the tiles immediately; the only other writer is a
2-hourly cron, against which 180s is nothing.

### 4. Per-user access allowlists get cached

`getDeliveryPartnerAccess` / `getDeliveryEscalationQueryCategoryAccess` ran two uncached
queries on EVERY request to this endpoint. Cached at 60s under a `deAccess:` prefix -
deliberately not `de-`, so a dispose's `invalidateCache('de-')` doesn't throw them away -
and invalidated by their own setters. 60s matches `SESSION_CACHE_TTL_MS`, which bounds the
same class of staleness for the same reason.

## Deliberately not done

- **Month-grain-by-default for the date tables.** Would add a network round trip to every
  month/week/day expand across five separate drill chains. After fixes 1+2 the whole
  payload is ~0.65 MB, so the drill stays instant and offline instead.
- **Array-encoding `counts` against the `buckets` order.** Another ~2.5x, but it means
  rewriting every `counts[bucketLabel]` index in both files. Revisit only if 0.65 MB
  measures as a real cost.
- **`de-partner-options` / `de-query-category-options`.** Both are full-table `DISTINCT`
  scans cached under the `de-` prefix, so every dispose's `invalidateCache('de-')` throws
  them away and the next admin read rescans. Same fix as #4 (their own prefix), but they
  are admin-picker reads, not on the Overview path this audit is about.
- **Splitting the 5-dimension `GROUP BY` into narrow per-dimension queries.** Trades one
  scan with a large dedup for four scans with small ones - genuinely uncertain which wins
  at 90k rows, and it needs a measurement this audit does not have.
- **Raising `connectionLimit: 5`.** `op=stats` fires 5 queries in `Promise.all` and
  saturates a container's pool, but the safe ceiling depends on RDS `max_connections`
  times Lambda concurrency, which is an infra decision, not a code one.
