#!/usr/bin/env python3
"""Adds PEP_CLS.nps_product.sku_code (VARCHAR(64) NULL) and backfills it from
"SKU master.xlsx" at the repo root, mapping each row's product_name back to a SKU.

nps_product only ever stored product_name (the human title), not the SKU that produced it -
report_context.py's sku_title_map() already does the forward direction (SKU -> title) for the
mCaffeine SKU drill-down; this script needs the reverse (title -> SKU) to backfill here, so it
rebuilds that map itself rather than importing report_context (which pulls in the whole report
pipeline for one dict).

Title -> SKU is inherently lossy where the master lists more than one SKU under the same
Product title (e.g. different pack sizes/variants sharing a title) - first-seen SKU wins per
title, same "first occurrence wins" convention as sku_title_map's own SKU -> title direction.
Any product_name with zero or multiple candidate SKUs is reported, not guessed at.

Whatever the master still can't resolve falls back to mcaff_prod.Item_level_data (same RDS
host, different schema - see sync_shopify_qty_to_sheet.py's ITEM_LEVEL_SCHEMA) - it carries its
own Item_Type_Name -> Item_SKU_Code pairing from ~50M actual order-item rows, so a product the
SKU master's sheet never listed can often still be resolved from what was actually sold.
Same first-seen-wins/ambiguous-reporting treatment as the master; only consulted for names the
master left unresolved, and the master's answer always wins where both have one.

Column add and backfill are both idempotent / safe to re-run:
  - ADD COLUMN is skipped if sku_code already exists (information_schema check first).
  - Backfill only ever targets rows where sku_code IS NULL, so a second run only fills in
    whatever a later master.xlsx update newly resolves - it never overwrites a value already set.

Dry-run by default (reports column-add plan + match counts, no write); --apply performs the
DDL and the UPDATE.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"
TABLE = "nps_product"
COLUMN = "sku_code"
COLUMN_DDL = "VARCHAR(64) NULL"
MASTER_FILE = Path(__file__).resolve().parent.parent / "SKU master.xlsx"
CHUNK_SIZE = 500

ITEM_LEVEL_SCHEMA = "mcaff_prod"
ITEM_LEVEL_TABLE = "Item_level_data"


def _column_exists(cur):
    cur.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (SCHEMA, TABLE, COLUMN),
    )
    return cur.fetchone() is not None


def title_to_sku_map(path):
    """Product title (casefold) -> SKU, first-seen wins. Returns (map, ambiguous) where
    ambiguous is {title: [skus...]} for titles the master lists under more than one SKU -
    those still get the first SKU in the map, but are surfaced separately so a caller can
    decide those products need a manual look rather than silently picking one."""
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    return _title_sku_pairs_to_map(wb.worksheets[0].iter_rows(min_row=2, values_only=True))


def _title_sku_pairs_to_map(pairs):
    """Shared reduction for both the master-sheet and Item_level_data sources: title
    (casefold) -> first-seen SKU, plus {title: [skus...]} for titles more than one distinct
    SKU claims."""
    seen = {}
    for title, sku in pairs:
        if not title or not sku:
            continue
        seen.setdefault(str(title).strip().casefold(), []).append(str(sku).strip())
    m, ambiguous = {}, {}
    for key, skus in seen.items():
        m[key] = skus[0]
        if len(set(skus)) > 1:
            ambiguous[key] = sorted(set(skus))
    return m, ambiguous


def item_level_title_to_sku_map(cur):
    """Fallback source for whatever "SKU master.xlsx" doesn't resolve: mcaff_prod's
    Item_level_data carries its own Item_Type_Name -> Item_SKU_Code pairing from actual
    order-item rows. Item_Type_Name isn't an indexed column here (only Tracking_Number is -
    see gen_geo_insights.py), so scoping this to just the still-unresolved titles would cost
    a full ~50M-row scan per IN() chunk; one single DISTINCT pass over the whole table is
    cheaper than many. Expect this one query to take a few minutes."""
    cur.execute(
        f"SELECT DISTINCT Item_Type_Name, Item_SKU_Code FROM `{ITEM_LEVEL_TABLE}` "
        "WHERE Item_Type_Name IS NOT NULL AND Item_SKU_Code IS NOT NULL"
    )
    return _title_sku_pairs_to_map(cur.fetchall())


def chunk(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def self_check():
    assert list(chunk([1, 2, 3, 4, 5], 2)) == [[1, 2], [3, 4], [5]]
    m, ambiguous = _title_sku_pairs_to_map([("Foo", "SKU1"), ("foo", "SKU2"), ("Bar", "SKU3"), (None, "SKU4"), ("Baz", None)])
    assert m == {"foo": "SKU1", "bar": "SKU3"}, m
    assert ambiguous == {"foo": ["SKU1", "SKU2"]}, ambiguous
    print("self-check ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Perform the DDL + backfill (default is a dry run).")
    ap.add_argument("--file", default=str(MASTER_FILE))
    ap.add_argument("--skip-item-level", action="store_true",
                     help=f"Don't fall back to {ITEM_LEVEL_TABLE} for titles the master sheet misses.")
    ap.add_argument("--self-check", action="store_true")
    args = ap.parse_args()
    if args.self_check:
        return self_check()

    if not Path(args.file).exists():
        raise SystemExit(f"{args.file} not found.")
    title_to_sku, ambiguous = title_to_sku_map(args.file)
    print(f"{len(title_to_sku)} product title(s) in {args.file}"
          + (f" ({len(ambiguous)} map to more than one SKU - first SKU used for each)" if ambiguous else ""))

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
        # 600s, not mysql_lib's usual 180s - the Item_level_data fallback below is a genuine
        # full scan of a ~50M-row table (no usable index on Item_Type_Name), not a hang to
        # guard against tightly.
        read_timeout=600, write_timeout=600,
    )
    try:
        cur = conn.cursor()

        if _column_exists(cur):
            print(f"{TABLE}.{COLUMN} already exists - skipping ADD COLUMN.")
        else:
            print(f"Plan: ALTER TABLE `{TABLE}` ADD COLUMN `{COLUMN}` {COLUMN_DDL}")
            if args.apply:
                cur.execute(f"ALTER TABLE `{TABLE}` ADD COLUMN `{COLUMN}` {COLUMN_DDL}")
                conn.commit()
                print("column added.")

        # Not filtered by sku_code IS NULL here (the column may not exist yet on a dry run) -
        # the backfill UPDATE below re-applies that guard itself, so an already-filled row is
        # never touched regardless of what this SELECT returns.
        cur.execute(f"SELECT DISTINCT product_name FROM `{TABLE}` WHERE product_name IS NOT NULL")
        distinct_names = [r[0] for r in cur.fetchall()]

        resolved = {name: title_to_sku[name.strip().casefold()]
                    for name in distinct_names if name.strip().casefold() in title_to_sku}
        unresolved = sorted(set(distinct_names) - set(resolved))
        print(f"{len(distinct_names)} distinct product_name(s) needing sku_code; "
              f"{len(resolved)} resolved against the master, {len(unresolved)} not found in it")

        if unresolved and not args.skip_item_level:
            print(f"looking up the {len(unresolved)} unresolved title(s) against "
                  f"{ITEM_LEVEL_SCHEMA}.{ITEM_LEVEL_TABLE} (one full-table pass, may take a few minutes)...")
            conn.select_db(ITEM_LEVEL_SCHEMA)
            item_level_map, item_level_ambiguous = item_level_title_to_sku_map(cur)
            conn.select_db(SCHEMA)
            from_item_level = {name: item_level_map[name.strip().casefold()]
                                for name in unresolved if name.strip().casefold() in item_level_map}
            resolved.update(from_item_level)
            unresolved = sorted(set(unresolved) - set(from_item_level))
            print(f"  {len(from_item_level)} resolved against {ITEM_LEVEL_TABLE}"
                  + (f" ({len(item_level_ambiguous)} titles there map to more than one SKU - first used)"
                     if item_level_ambiguous else "")
                  + f", {len(unresolved)} still unresolved")

        if unresolved:
            print("  unresolved (no sku_code set for these): "
                  + ", ".join(unresolved[:20]) + (" ..." if len(unresolved) > 20 else ""))

        if not resolved:
            print("Nothing to backfill.")
            return
        if not args.apply:
            print("Dry run - re-run with --apply to add the column and backfill sku_code.")
            return

        pairs = list(resolved.items())
        total_updated = 0
        for batch in chunk(pairs, CHUNK_SIZE):
            case_when = " ".join(["WHEN %s THEN %s"] * len(batch))
            names = [name for name, _ in batch]
            placeholders = ", ".join(["%s"] * len(names))
            case_params = [v for pair in batch for v in pair]
            cur.execute(
                f"""
                UPDATE `{TABLE}`
                SET `{COLUMN}` = CASE product_name {case_when} END
                WHERE product_name IN ({placeholders}) AND `{COLUMN}` IS NULL
                """,
                case_params + names,
            )
            total_updated += cur.rowcount
        conn.commit()
        print(f"backfilled {COLUMN} on {total_updated} row(s).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
