"""Single source of truth for the escalation BigQuery tables.

Imported by the ticket loader, the sheet sweep, and the migration, so all three agree on column
names, ownership, and the row key. Node has its own copy of the read/write SQL but issues no DDL
at all - the tables are created here and only here, so the two languages cannot drift.

THE ONE INVARIANT: three writers, disjoint column groups.

    loader  -> TICKET_COLUMNS   (from MySQL)
    sweep   -> SHEET_COLUMNS    (formulas L:P and the logistics paste Q:S)
    the app -> APP_COLUMNS      (resolutions and assignment)

No writer's statement may name another's column. Cross that line and one run silently destroys
the other's data, which is why scripts/test_escalation_ingest.py asserts it on the generated SQL
rather than trusting review.

ONE TABLE FOR BOTH BRANDS. escalation.orders holds HYPHEN and mCaffeine rows together, separated
by the `brand` column. Those literals match the sheet tab names and the hyphen_tickets /
mcaff_tickets MySQL split, so nothing anywhere has to translate them.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bq_lib

ORDERS = "orders"
STAGING = "orders_staging"
EVENTS = "assignment_events"

BRANDS = ["HYPHEN", "mCaffeine"]

IDENTITY_COLUMNS = ["brand", "parent_order", "awb_number", "awb_key"]

TICKET_COLUMNS = [
    "added_date", "query_class", "query_category", "delivery_partner_name",
    "order_date", "order_month", "query_date", "query_month", "wh_name", "ticket_number",
]

SHEET_COLUMNS = [
    "total_times_consumer_reached", "delivered_date", "status_as_per_awb", "solv_date",
    "tat", "update_from_logistics", "city", "state",
]

APP_COLUMNS = [
    "new_order_id", "new_awb", "status", "notes",
    "resolved_at", "resolved_by", "assigned_to", "assigned_at",
]

LIFECYCLE_COLUMNS = ["synced_at", "ticket_loaded_at", "deleted_from_sheet_at", "row_number"]

# Position in a 26-cell sheet row (A..Z) -> BigQuery column.
#
# sync_delivery_tickets_to_sheet.build_sheet_row() returns a list in exactly this order, so the
# loader maps its rows through the same table the sweep uses - one definition of "which cell is
# which", not two that can drift.
#
# 23 and 24 (columns X and Y) are absent on purpose: unused by the app, not carried across.
SHEET_INDEX_TO_COLUMN = {
    0: "added_date", 1: "query_class", 2: "query_category", 3: "parent_order",
    4: "awb_number", 5: "delivery_partner_name", 6: "order_date", 7: "order_month",
    8: "query_date", 9: "query_month", 10: "wh_name", 11: "total_times_consumer_reached",
    12: "delivered_date", 13: "status_as_per_awb", 14: "solv_date", 15: "tat",
    16: "update_from_logistics", 17: "city", 18: "state", 19: "new_order_id",
    20: "new_awb", 21: "status", 22: "notes", 25: "ticket_number",
}

_TIMESTAMP_COLUMNS = {"resolved_at", "assigned_at", "synced_at", "ticket_loaded_at",
                      "deleted_from_sheet_at"}


def _field(name):
    if name == "row_number":
        return {"name": name, "type": "INT64"}
    if name in _TIMESTAMP_COLUMNS:
        return {"name": name, "type": "TIMESTAMP"}
    return {"name": name, "type": "STRING"}


ORDERS_SCHEMA = (
    [{"name": "brand", "type": "STRING", "mode": "REQUIRED"},
     {"name": "parent_order", "type": "STRING", "mode": "REQUIRED"},
     {"name": "awb_number", "type": "STRING"},
     {"name": "awb_key", "type": "STRING", "mode": "REQUIRED"}]
    + [_field(c) for c in TICKET_COLUMNS + SHEET_COLUMNS + APP_COLUMNS + LIFECYCLE_COLUMNS]
)

# Staging holds exactly what a sheet row supplies: identity, ticket columns (legacy rows can
# carry these too, read straight off the sheet), sheet-computed columns, and the T:W cells
# (new_order_id/new_awb/status/notes) - not because the sweep's MERGE writes those on an existing
# row (it doesn't; build_sweep_merge's matched arm never names them), but because
# migrate_escalation_to_bq.py's historical-resolution backfill needs them off legacy rows that
# predate the ticket job. Listed explicitly rather than derived by subtraction, so the set is
# checkable by eye.
STAGING_SCHEMA = [
    _field(c) if c != "brand" else {"name": "brand", "type": "STRING", "mode": "REQUIRED"}
    for c in (["brand", "parent_order", "awb_number", "awb_key"] + TICKET_COLUMNS + SHEET_COLUMNS
              + ["new_order_id", "new_awb", "status", "notes", "row_number"])
]

EVENTS_SCHEMA = [
    {"name": "parent_order", "type": "STRING", "mode": "REQUIRED"},
    {"name": "brand", "type": "STRING"},
    {"name": "awb_key", "type": "STRING"},
    {"name": "email", "type": "STRING"},
    {"name": "event", "type": "STRING", "mode": "REQUIRED"},
    {"name": "resolution", "type": "STRING"},
    {"name": "agent_remarks", "type": "STRING"},
    {"name": "ts", "type": "TIMESTAMP", "mode": "REQUIRED"},
]


def awb_key(value):
    return ("" if value is None else str(value)).strip().lower()


def sheet_row_to_bq(cells, brand, row_number=None):
    """Map one sheet row (or one build_sheet_row() output) onto BigQuery columns.

    The Sheets API truncates trailing empty cells, so rows arrive short - every unmapped column
    defaults to empty string rather than raising or producing NULL.
    """
    row = {c: "" for c in
           list(SHEET_INDEX_TO_COLUMN.values()) + ["parent_order", "awb_number"]}
    for index, column in SHEET_INDEX_TO_COLUMN.items():
        if index < len(cells) and cells[index] is not None:
            row[column] = str(cells[index])
    row["brand"] = brand
    row["awb_key"] = awb_key(row.get("awb_number"))
    row["row_number"] = row_number
    return row


def count_duplicate_keys(rows):
    """How many rows the MERGE's QUALIFY will discard.

    Reported rather than silently dropped: a blank AWB makes two rows for the same parent order
    collide legitimately, but a sheet developing real key collisions is something to notice.
    """
    seen = set()
    duplicates = 0
    for r in rows:
        key = (r.get("brand"), r.get("parent_order"), r.get("awb_key"))
        if key in seen:
            duplicates += 1
        else:
            seen.add(key)
    return duplicates


def _ddl(table, schema, cluster_by=None):
    cols = ",\n".join(
        f"  {f['name']} {f['type']}" + (" NOT NULL" if f.get("mode") == "REQUIRED" else "")
        for f in schema
    )
    suffix = f"\nCLUSTER BY {cluster_by}" if cluster_by else ""
    return f"CREATE TABLE IF NOT EXISTS `{table}` (\n{cols}\n){suffix};"


def create_tables():
    """Not partitioned: a few thousand rows, where partition metadata costs more than it saves.
    Clustered on the row-key prefix so MERGEs and per-order writes prune."""
    bq_lib.query("\n".join([
        _ddl(ORDERS, ORDERS_SCHEMA, "brand, parent_order"),
        _ddl(STAGING, STAGING_SCHEMA),
        _ddl(EVENTS, EVENTS_SCHEMA, "parent_order"),
    ]))


_KEY_JOIN = ("ON  T.brand = S.brand\n"
             "AND T.parent_order = S.parent_order\n"
             "AND T.awb_key = S.awb_key")


def build_sweep_merge():
    """Sheet -> BigQuery. Matched updates sheet columns only; unmatched inserts the whole row.

    The insert arm carries ticket columns deliberately: rows predating the ticket job exist only
    in the sheet, and a sweep is the only thing that will ever bring them into BigQuery. The
    matched arm must never carry them, or a stale sheet value would overwrite fresh loader data.
    """
    matched = ",\n".join(f"  {c} = S.{c}" for c in SHEET_COLUMNS)
    insert_cols = IDENTITY_COLUMNS + TICKET_COLUMNS + SHEET_COLUMNS + ["row_number"]
    return f"""MERGE `{ORDERS}` T
USING (
  SELECT * FROM `{STAGING}`
  WHERE brand = @brand
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY brand, parent_order, awb_key ORDER BY row_number
  ) = 1
) S
{_KEY_JOIN}
WHEN MATCHED THEN UPDATE SET
{matched},
  row_number = S.row_number,
  synced_at = CURRENT_TIMESTAMP(),
  deleted_from_sheet_at = NULL
WHEN NOT MATCHED BY TARGET THEN
  INSERT ({', '.join(insert_cols)}, synced_at)
  VALUES ({', '.join('S.' + c for c in insert_cols)}, CURRENT_TIMESTAMP())
WHEN NOT MATCHED BY SOURCE
  AND T.brand = @brand
  AND T.deleted_from_sheet_at IS NULL
THEN UPDATE SET deleted_from_sheet_at = CURRENT_TIMESTAMP()"""


def build_ticket_merge():
    """MySQL -> BigQuery. Ticket columns only, so it can run before or after a sweep."""
    matched = ",\n".join(f"  {c} = S.{c}" for c in TICKET_COLUMNS)
    insert_cols = IDENTITY_COLUMNS + TICKET_COLUMNS
    return f"""MERGE `{ORDERS}` T
USING UNNEST(@items) S
{_KEY_JOIN}
WHEN MATCHED THEN UPDATE SET
{matched},
  ticket_loaded_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED BY TARGET THEN
  INSERT ({', '.join(insert_cols)}, ticket_loaded_at)
  VALUES ({', '.join('S.' + c for c in insert_cols)}, CURRENT_TIMESTAMP())"""
