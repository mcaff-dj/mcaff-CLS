"""One-off: recomputes delivery_partner for every PEP_CLS.Delivery_escalation row that has an
awb_code but no delivery_partner, using the exact same rule (lead_priority.prefix_rule_partner)
sync_delivery_tickets_to_sheet.py's own build_delivery_escalation_row already applies as a
fallback on every live insert (`partner = partner or prefix_rule_partner(awb) or None`).

That fallback only ever runs at INSERT time, and each ticket_number is normally only ever fetched
once (see that job's own header comment) - so a row inserted before the fallback existed, or one
whose Flowcall-reported partner and prefix-rule result were BOTH blank at that moment, stays blank
forever with no future sync run left to revisit it. This is the Delivery_escalation counterpart
to scripts/backfill_delivery_partner.py, which already does the identical recompute for
CLS_RTO_calling - that script never covered this table.

Only writes when prefix_rule_partner resolves to a real value; an awb_code whose prefix isn't in
leadAssignmentRules.json's awbPrefixRules is left alone and reported as unmatched.

Dry-run by default (counts + a breakdown); --apply performs the updates.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib
from lead_priority import prefix_rule_partner

SCHEMA = "PEP_CLS"
TABLE = "Delivery_escalation"
CHUNK_SIZE = 500


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the updates (default is a dry run).")
    args = ap.parse_args()

    if mysql_lib.get_credential() is None:
        raise SystemExit("MYSQL_* credentials not configured.")

    rows = mysql_lib.query(
        f"SELECT id, awb_code FROM `{TABLE}` "
        f"WHERE awb_code IS NOT NULL AND awb_code != '' "
        f"AND (delivery_partner IS NULL OR delivery_partner = '')",
        database=SCHEMA,
    )
    print(f"Found {len(rows)} row(s) with an AWB but no delivery_partner.")

    pairs = []  # (partner, row_id)
    unmatched = {}
    for row_id, awb_code in rows:
        partner = prefix_rule_partner(awb_code)
        if not partner:
            unmatched[awb_code[:3]] = unmatched.get(awb_code[:3], 0) + 1
            continue
        pairs.append((partner, row_id))

    print(f"{len(pairs)} row(s) would be filled from a matching AWB-prefix rule.")
    if unmatched:
        total_unmatched = sum(unmatched.values())
        print(f"{total_unmatched} row(s) have no matching prefix rule - would stay blank:")
        for prefix, n in sorted(unmatched.items(), key=lambda kv: -kv[1]):
            print(f"  {prefix}... x{n}")

    if not args.apply:
        print("DRY RUN - nothing written. Re-run with --apply to perform the updates.")
        return
    if not pairs:
        print("Nothing to do.")
        return

    updated = 0
    for start in range(0, len(pairs), CHUNK_SIZE):
        chunk = pairs[start:start + CHUNK_SIZE]
        mysql_lib.executemany(
            f"UPDATE `{TABLE}` SET delivery_partner = %s WHERE id = %s "
            f"AND (delivery_partner IS NULL OR delivery_partner = '')",
            chunk,
            database=SCHEMA,
        )
        updated += len(chunk)
    print(f"Backfilled {updated} row(s).")


if __name__ == "__main__":
    main()
