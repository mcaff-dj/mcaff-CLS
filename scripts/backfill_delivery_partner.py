"""One-off: recomputes delivery_partner for every Postgres lead_assignments row that has an
awb_code but no delivery_partner, using the exact same rule (lead_priority.prefix_rule_partner)
every live write already applies.

These rows exist for one specific historical reason: delivery_partner was found to be a
GENERATED ALWAYS STORED column on the live DB (see fix_delivery_partner_generated_column.py),
altered there outside this codebase. Whatever partial/incomplete expression that generated
column used is now gone - DROP EXPRESSION preserved only its last-computed value, and never
re-derived anything. This recomputes those frozen values from awb_code using the current,
correct rule instead of leaving them stale.

Every write is a pure re-derivation of data already in the row (awb_code -> delivery_partner),
not new information from an external source - unlike rto_reason, which has no such source of
truth left in Postgres and is not touched here.

Not scoped to live cycles only (contrast backfill_awb_code.py): delivery_partner carries no
uniqueness constraint and is never read from a retired cycle by any code path, so recomputing
it everywhere it's missing is harmless and keeps the whole table's history internally
consistent, not just the currently-active rows.

Only writes when prefix_rule_partner resolves to a real value; an awb_code whose prefix isn't
in leadAssignmentRules.json is left NULL rather than guessed at, and reported as unmatched.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib
from lead_priority import prefix_rule_partner


def main(conn_str):
    with lib.get_pg_connection(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, awb_code FROM lead_assignments "
                "WHERE awb_code IS NOT NULL AND delivery_partner IS NULL"
            )
            rows = cur.fetchall()

    print(f"Found {len(rows)} row(s) with an AWB but no delivery_partner.")

    # Resolved locally up front, same as before - only the write below changed.
    pairs = []  # (partner, row_id)
    unmatched = {}
    for row_id, awb_code in rows:
        partner = prefix_rule_partner(awb_code)
        if not partner:
            unmatched[awb_code[:3]] = unmatched.get(awb_code[:3], 0) + 1
            continue
        pairs.append((partner, row_id))

    # Batched via executemany instead of one UPDATE + one commit per row - id is the table's
    # own primary key, so unlike backfill_rto_reason.py's order_id (which can span several
    # physical rows), each pair here maps to exactly one row and len(chunk) is an exact
    # updated count, no separate rowcount tracking needed. CHUNK_SIZE bounds each transaction
    # rather than one all-or-nothing commit for the whole backfill.
    CHUNK_SIZE = 500
    updated = 0
    # prepare_threshold=None: POSTGRES_URL is Supabase's pooled (PgBouncer transaction-mode)
    # endpoint, which cannot guarantee the same backend across statements - psycopg3's default
    # server-side prepared-statement caching then collides with another session's leftover
    # prepared statement on the same pooled backend ("prepared statement already exists").
    # Disabling it makes every statement a plain unnamed query, which the pooler handles fine.
    with lib.get_pg_connection(conn_str, prepare_threshold=None) as conn:
        with conn.cursor() as cur:
            for start in range(0, len(pairs), CHUNK_SIZE):
                chunk = pairs[start:start + CHUNK_SIZE]
                cur.executemany(
                    "UPDATE lead_assignments SET delivery_partner = %s "
                    "WHERE id = %s AND delivery_partner IS NULL",
                    chunk,
                )
                conn.commit()
                updated += len(chunk)

    print(f"Backfilled {updated} row(s).")
    if unmatched:
        total_unmatched = sum(unmatched.values())
        print(f"{total_unmatched} row(s) had no matching prefix rule - left NULL:")
        for prefix, n in sorted(unmatched.items(), key=lambda kv: -kv[1]):
            print(f"  {prefix}... x{n}")


if __name__ == "__main__":
    conn_str = os.environ.get("POSTGRES_URL")
    if not conn_str:
        raise SystemExit("POSTGRES_URL not configured.")
    main(conn_str)
