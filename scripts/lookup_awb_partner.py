#!/usr/bin/env python3
"""Looks up delivery-partner name per AWB/tracking number from the mcaff_prod
MySQL DWH, batched to keep each IN(...) query small. Python port of
lookup-awb-partner.ps1.
"""
import argparse
import csv
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--awb-list-path", required=True)
    parser.add_argument("--output-csv-path", required=True)
    parser.add_argument("--batch-size", type=int, default=500)
    args = parser.parse_args()

    with open(args.awb_list_path, "r", encoding="utf-8") as f:
        seen = set()
        awb_list = []
        for line in f:
            v = line.strip()
            if v and v not in seen:
                seen.add(v)
                awb_list.append(v)

    total = len(awb_list)
    print(f"Total unique AWBs to look up: {total}")

    results = []
    batch_size = args.batch_size
    total_batches = math.ceil(total / batch_size) if total else 0

    for batch_num, i in enumerate(range(0, total, batch_size), start=1):
        batch = awb_list[i:i + batch_size]
        placeholders = ",".join(["%s"] * len(batch))
        sql = f"SELECT DISTINCT Tracking_Number, Shipping_provider FROM Item_level_data WHERE Tracking_Number IN ({placeholders})"
        rows = mysql_lib.query(sql, tuple(batch))
        if rows:
            results.extend(rows)
        print(f"Batch {batch_num}/{total_batches} done ({min(i + batch_size, total)}/{total} AWBs queried, {len(results)} matches so far)")

    with open(args.output_csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Tracking_Number", "Shipping_provider"])
        writer.writerows(results)

    print(f"Wrote {len(results)} mapping rows to {args.output_csv_path}")


if __name__ == "__main__":
    main()
