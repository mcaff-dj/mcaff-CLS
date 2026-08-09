"""Sweeps the escalation sheet's computed columns into BigQuery.

Columns L:P are formulas the spreadsheet itself computes, and Q:S are pasted by an external
logistics pipeline. Neither has a source this repo can reach, so the sheet remains their only
implementation and this job is how they reach the application. Everything else about the sheet
is now downstream of BigQuery, not upstream of it.

The MERGE's three arms do different jobs, and the difference is the whole design:

  matched              -> sheet columns only, so a stale sheet value can never overwrite the
                          ticket loader's fresher data
  not matched by target-> the whole row including ticket columns, which is what backfills the
                          legacy rows predating the ticket job and repairs any row whose loader
                          MERGE failed
  not matched by source-> soft-delete stamp scoped to this brand; never a hard DELETE, which
                          would destroy agent resolutions the moment someone filters the sheet

TRIGGER: none yet. Run it by hand or via workflow_dispatch until a cadence is decided. Until
then, formula recalculations and logistics pastes do not reach the queue on their own.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bq_lib
import escalation_bq_schema as schema
import lib

SPREADSHEET_ID = "1fopbKSrg-U9ixZi6Tfq13Q7mzRMPtceXkfEuN4Wko-w"

# What actually gets uploaded to staging. The MERGE decides which of these survive onto an
# existing row; staging itself carries the full sheet row so the insert arm has everything.
STAGING_FIELDS = [f["name"] for f in schema.STAGING_SCHEMA]


def sweep_brand(brand, dry_run=False):
    if brand not in schema.BRANDS:
        raise ValueError(f"Unknown brand: {brand!r}")
    print(f"--- {brand} ---")
    schema.create_tables()

    # A2:Z - row 1 is the header. The Sheets API truncates trailing empties, so rows arrive
    # ragged; sheet_row_to_bq pads them.
    values = lib.get_sheet_values(SPREADSHEET_ID, f"'{brand}'!A2:Z") or []
    rows = [schema.sheet_row_to_bq(cells, brand, row_number=i + 2)
            for i, cells in enumerate(values)]
    print(f"  read {len(rows)} row(s)")

    duplicates = schema.count_duplicate_keys(rows)
    if duplicates:
        print(f"  note: {duplicates} row(s) share a (brand, parent_order, awb_key) key "
              f"and will collapse to one")

    if dry_run:
        for r in rows[:3]:
            print("   ", {k: r[k] for k in ("row_number", "parent_order", "awb_key",
                                            "status_as_per_awb", "tat")})
        if len(rows) > 3:
            print(f"    ... and {len(rows) - 3} more")
        return {"brand": brand, "read": len(rows), "loaded": 0, "duplicates": duplicates}

    # WRITE_TRUNCATE on staging, so a retried sweep never accumulates. Load job, not a streaming
    # insert - streamed rows would be un-MERGEable for up to 90 minutes.
    ndjson = "".join(
        json.dumps({k: r.get(k) for k in STAGING_FIELDS}) + "\n" for r in rows
    )
    loaded = bq_lib.load_ndjson(schema.STAGING, ndjson, schema.STAGING_SCHEMA)
    print(f"  loaded {loaded} row(s) into {schema.STAGING}")

    bq_lib.query(schema.build_sweep_merge(), [bq_lib.str_param("brand", brand)])
    print(f"  merged into {schema.ORDERS}")
    return {"brand": brand, "read": len(rows), "loaded": loaded, "duplicates": duplicates}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brand", choices=sorted(schema.BRANDS),
                        help="Omit to sweep every brand")
    parser.add_argument("--dry-run", action="store_true",
                        help="Read and print only, no BigQuery writes")
    args = parser.parse_args()
    for brand in ([args.brand] if args.brand else schema.BRANDS):
        sweep_brand(brand, args.dry_run)


if __name__ == "__main__":
    main()
