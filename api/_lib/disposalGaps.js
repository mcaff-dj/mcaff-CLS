// "Avg Time to Dispose" - how long an agent takes to get to their NEXT disposal after
// finishing one. Distinct from the FRT column beside it: FRT is one lead's own
// assigned -> disposed handle time, this is the gap BETWEEN consecutive disposals, which is
// what answers "how quickly are they picking up the next call".
//
// Lives here, CJS, for the same reason leadQuota.js and trendChart.js do: the browser bundle
// imports it while `node` runs its self-check directly - see disposalGaps.test.js.
//
// One rule: gaps never span a calendar day (IST) - otherwise every agent's first disposal of
// the morning would carry the whole night as its gap. Every same-day gap counts toward the
// average at its real duration, breaks included - this used to drop anything over an hour as
// "not call handling", but that quietly hid the actual time an agent took, which is the number
// asked for here.

// Fixed +05:30, matching istDayKeyClient/istMinutesSinceMidnightClient in app/_calling/util.js
// and CONVERT_TZ('+00:00','+05:30') server-side. A named zone would need zoneinfo tables RDS
// does not guarantee, and the browser's own zone is not necessarily IST.
function istDayKey(ms) {
  const d = new Date(ms + 5.5 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// entries: [{ key, disposedAt }] in any order - disposedAt an ISO string, Date or ms.
// Returns { gapByKey, averageMinutes }:
//   gapByKey      key -> minutes since that agent's previous disposal the same day, or null
//                 for the first disposal of a day (nothing to measure from).
//   averageMinutes plain mean of every same-day gap, rounded; null when an agent has no
//                 measurable gap at all - null, not 0, because "never got a second lead" and
//                 "answered instantly" are different facts and 0 reads as the latter.
function disposalGaps(entries) {
  const points = [];
  for (const e of entries || []) {
    if (!e || e.disposedAt == null) continue;
    const ms = e.disposedAt instanceof Date ? e.disposedAt.getTime() : new Date(e.disposedAt).getTime();
    if (!Number.isFinite(ms)) continue; // unparseable timestamp - drop, never guess an order
    points.push({ key: e.key, ms });
  }
  // Sort by time, not by whatever order the caller had: a gap is only meaningful against the
  // disposal that actually preceded it.
  points.sort((a, b) => a.ms - b.ms);

  const gapByKey = new Map();
  const kept = [];
  let prev = null;
  for (const p of points) {
    const sameDay = prev !== null && istDayKey(prev.ms) === istDayKey(p.ms);
    if (!sameDay) {
      gapByKey.set(p.key, null);
    } else {
      const minutes = (p.ms - prev.ms) / 60000;
      gapByKey.set(p.key, minutes);
      kept.push(minutes);
    }
    prev = p;
  }
  const averageMinutes = kept.length
    ? Math.round(kept.reduce((s, m) => s + m, 0) / kept.length)
    : null;
  return { gapByKey, averageMinutes };
}

module.exports = { disposalGaps };
