#!/usr/bin/env python3
"""One-off: backfills delivery_partner on MySQL PEP_CLS.CLS_RTO_calling for rows that have an
awb_code but no delivery_partner - 7729 such rows measured 2026-08-20, ALL of them resolvable
from their existing awb_code alone (unlike payment_mode/rto_reason, this needs no external
sheet or CSV lookup: delivery_partner is a pure, deterministic function of awb_code via
lead_priority.prefix_rule_partner - the same rule assign_leads.py/db.js's claimRtoLead/
recordLeadDisposition already apply on every write).

Root cause: these are legacy rows written before delivery_partner existed on this table (see
migrate_cls_rto_calling_schema.py) or via a path that stored awb_code without ever computing
delivery_partner from it. Every CURRENT write path already recomputes delivery_partner from
awb_code on every insert/update, so this is a one-time catch-up for historical rows, not a
symptom of a live bug.

Only fills rows where delivery_partner IS STILL NULL/blank - never overwrites an
already-set value. Not scoped to live cycles only - delivery_partner is an AWB-level fact
like rto_reason, so it's backfilled for every cycle still missing it.

Dry run by default; --apply performs the writes.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib
from lead_priority import prefix_rule_partner

SCHEMA = "PEP_CLS"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the writes (default is a dry run).")
    args = ap.parse_args()

    if mysql_lib.get_credential() is None:
        raise SystemExit("MYSQL_* credentials not configured.")

    rows = mysql_lib.query(
        "SELECT DISTINCT awb_code FROM CLS_RTO_calling "
        "WHERE (delivery_partner IS NULL OR delivery_partner = '') "
        "AND awb_code IS NOT NULL AND awb_code <> ''",
        database=SCHEMA,
    ) or []
    print(f"{len(rows)} distinct awb_code(s) missing delivery_partner.")

    pairs = []  # (delivery_partner, awb_code)
    not_resolved = 0
    for (awb,) in rows:
        partner = prefix_rule_partner(awb)
        if not partner:
            not_resolved += 1
            continue
        pairs.append((partner, awb))

    print(f"{len(pairs)} awb_code(s) resolvable via the current prefix rules; "
          f"{not_resolved} not matched by any rule (left NULL).")
    if not args.apply:
        print("\nDry run - re-run with --apply to write.")
        return

    CHUNK_SIZE = 500
    cred = mysql_lib.get_credential()
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        for start in range(0, len(pairs), CHUNK_SIZE):
            chunk = pairs[start:start + CHUNK_SIZE]
            cur.executemany(
                "UPDATE CLS_RTO_calling SET delivery_partner = %s "
                "WHERE awb_code = %s AND (delivery_partner IS NULL OR delivery_partner = '')",
                chunk,
            )
            conn.commit()
        print(f"Backfilled delivery_partner for {len(pairs)} awb_code(s).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
