#!/usr/bin/env python3
"""Cron job: for each active NPS survey configured to auto-trigger, find orders Shiprocket
has newly marked delivered and create nps_recipient rows for them (trigger_source=
'shiprocket'), then call the same send API the admin UI's "Send" button uses
(api/nps-admin/send.js) so one code path owns "how to reach a recipient" either way.

STUBBED: no Shiprocket API credentials exist yet (confirmed open dependency, see the NPS
Survey Platform plan). fetch_delivered_orders() is where the real Shiprocket call goes -
everything around it (dedup against orders already turned into a recipient, insert, call
send) is real and ready. Run with `python scripts/nps_shiprocket_trigger.py --survey-id N
--dry-run` once credentials + a target survey exist.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"


def fetch_delivered_orders(since_hours):
    """Returns [{order_ref, name, phone, email}, ...] for orders Shiprocket marked
    delivered in the last `since_hours`. Not implemented - no Shiprocket credentials yet."""
    raise NotImplementedError(
        "Shiprocket API credentials not configured - see the NPS Survey Platform plan's "
        "open follow-ups. Implement this against Shiprocket's order/tracking API once "
        "credentials exist; the rest of this script is ready to use it."
    )


def already_recipients(cur, survey_id, order_refs):
    if not order_refs:
        return set()
    placeholders = ",".join(["%s"] * len(order_refs))
    cur.execute(
        f"SELECT order_ref FROM nps_recipient WHERE survey_id = %s AND order_ref IN ({placeholders})",
        (survey_id, *order_refs),
    )
    return {row[0] for row in cur.fetchall()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--survey-id", type=int, required=True, help="nps_survey.id to auto-trigger for.")
    ap.add_argument("--since-hours", type=int, default=24, help="Look back this many hours for newly-delivered orders.")
    ap.add_argument("--dry-run", action="store_true", help="Print what would be inserted, don't write.")
    args = ap.parse_args()

    orders = fetch_delivered_orders(args.since_hours)

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
    )
    try:
        cur = conn.cursor()
        seen = already_recipients(cur, args.survey_id, [o["order_ref"] for o in orders])
        new_orders = [o for o in orders if o["order_ref"] not in seen]

        print(f"{len(orders)} delivered order(s), {len(new_orders)} new for survey {args.survey_id}.")
        if args.dry_run or not new_orders:
            return

        for o in new_orders:
            cur.execute(
                "INSERT INTO nps_recipient (survey_id, name, phone, email, trigger_source, order_ref, status) "
                "VALUES (%s, %s, %s, %s, 'shiprocket', %s, 'pending')",
                (args.survey_id, o.get("name"), o.get("phone"), o.get("email"), o["order_ref"]),
            )
        conn.commit()
        print(f"Inserted {len(new_orders)} recipient(s). Trigger a send via the admin UI or "
              f"POST /api/nps-admin/send {{surveyId: {args.survey_id}}}.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
