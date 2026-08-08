# NDR Team Roster: Latest NDR Reason hard filter

## Problem

NDR Calling's Team Roster (`app/ndr-calling/NdrCallingClient.js`) already lets an admin
restrict an agent to leads within a delivery-attempt-count bucket (the "Attempts" column,
backed by `attempt_count_filter`). The request was for more controls like that, specifically
naming Brand, Payment Mode, and Latest NDR Reason.

Brand and Payment Mode are not read anywhere in the NDR pipeline (`mapNdrRow` has no such
fields, and no sheet column letters are known for them) - out of scope until that data exists.
Latest NDR Reason (`latestNdrReason`, sheet column Q) is already read and displayed per lead,
so it's the one addition this spec covers.

## Design

One more hard filter, same shape as `attemptCountFilter`, but free-text instead of a fixed
bucket list (courier NDR-reason strings aren't a small enumerable set the way attempt buckets
are: 1/2/3/More than 3).

- **Storage:** `ndr_reason_filter TEXT` on `calling_agent_process`, comma-separated substrings.
  Empty string = explicit "unrestricted" (same NULL-vs-'' contract as `attempt_count_filter` -
  omitted means leave alone, `''` means clear).
- **Match semantics:** substring match against a lead's `latestNdrReason`, same as
  `attempt_count_filter`'s bucket match - no filter values set means unrestricted.
- **UI:** one new "Latest NDR Reason" column on the Team Roster table, plain
  `<input type="text">` (not a new tag-input component - reuses local draft state + save-on-blur,
  no new shared UI primitive). Placeholder shows an example like "Customer not available,
  Address issue". Same column position/style as the existing Attempts column.
- **Predicted assignment preview** ("Next to Assign" tab's client-side `covers()`/`onlineAgents`
  logic in `NdrCallingClient.js`) gates on this filter alongside the existing attempt-bucket
  check, so the preview matches what the cron will actually do.
- **Cron** (`scripts/assign_ndr_leads.py`) reads `ndr_reason_filter` per agent alongside
  `attempt_count_filter`, reads sheet column Q (currently unread there), and applies the same
  substring-match gate before assigning a lead to that agent.

## Touch points

1. `api/_lib/db.js` - `ALTER TABLE`, `getCallingProcessAgents` SELECT+map, `setCallingProcessAgent`
   param + INSERT/UPDATE COALESCE, mirroring `attempt_count_filter` exactly.
2. `api/admin/[action].js` - whitelist `body.ndrReasonFilter` through to `setCallingProcessAgent`;
   update the route's doc comment.
3. `app/ndr-calling/NdrCallingClient.js` - new roster column (text input + save-on-blur); extend
   the predicted-assignment `covers()` check.
4. `scripts/assign_ndr_leads.py` - read the new DB column, read sheet column Q, apply the gate in
   the assignment loop.

## Out of scope

Brand and Payment Mode filters - no data source in the NDR sheet/pipeline today. Revisit once
those columns exist and are mapped in `mapNdrRow`.
