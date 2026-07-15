"""Pull NDR + RTO leads from Shiprocket and upsert them into Supabase.

Usage:
    python sync_leads.py                  # sync NDR + RTO leads into Supabase
    python sync_leads.py --dry-run         # fetch + print one sample record per source, write nothing
    python sync_leads.py --lookback-days 45   # RTO orders window (default 30)

Run this on a schedule (Windows Task Scheduler / cron) to keep leads fresh, e.g. hourly.
"""
import argparse
import json
import sys
from datetime import date, timedelta

import config
import db
from shiprocket_client import ShiprocketClient


def run(dry_run=False, lookback_days=30):
    client = ShiprocketClient()

    print("Fetching NDR leads...")
    ndr_leads = client.get_ndr_leads()
    print(f"  {len(ndr_leads)} NDR leads fetched")

    to_date = date.today()
    from_date = to_date - timedelta(days=lookback_days)
    print(f"Fetching RTO leads from orders between {from_date} and {to_date}...")
    rto_leads = client.get_rto_leads(from_date.isoformat(), to_date.isoformat())
    print(f"  {len(rto_leads)} RTO leads fetched")

    if dry_run:
        print("\n--dry-run: not writing to Supabase. Sample records:")
        if ndr_leads:
            print("\nNDR sample:")
            print(json.dumps(ndr_leads[0], indent=2, default=str))
        if rto_leads:
            print("\nRTO sample:")
            print(json.dumps(rto_leads[0], indent=2, default=str))
        if not ndr_leads and not rto_leads:
            print("(no records returned from either endpoint)")
        return

    all_leads = ndr_leads + rto_leads
    if not all_leads:
        print("Nothing to sync.")
        return

    print(f"Upserting {len(all_leads)} leads into Supabase...")
    db.upsert_leads(all_leads)
    print("Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="fetch and print samples, write nothing")
    parser.add_argument("--lookback-days", type=int, default=30, help="RTO orders window in days (default 30)")
    args = parser.parse_args()

    try:
        run(dry_run=args.dry_run, lookback_days=args.lookback_days)
    except Exception as exc:  # noqa: BLE001 - top-level CLI error surface
        print(f"Sync failed: {exc}", file=sys.stderr)
        sys.exit(1)
