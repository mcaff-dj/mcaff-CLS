"""Reads NDR (non-delivery-report) lead candidates from lmd_courier_tracking (mcaff_prod
schema) for the NDR Calling pipeline - see scripts/sync_ndr_leads_to_sheet.py.

lmd_courier_tracking has ~2.9M rows total and no index on last_updated, so an unbounded scan
is both slow (a plain COUNT(*) with this WHERE takes well over a minute) and wrong: nearly
520k rows have cp_ndr_attempts >= 1 across the table's whole history, which is an archive, not
a queue of leads that still need a call today.

Bounded to exactly YESTERDAY's calendar date (not a rolling "last N days" window) - confirmed
with the user directly: the sync runs once a day at 8 AM IST (see
.github/workflows/sync-ndr-leads.yml), so "yesterday" is the one day of fresh leads that run
hasn't seen yet. A rolling window would re-fetch the same leads on every run; a fixed calendar
day means each day's leads are pulled exactly once, and awb_number is the sync's own duplicate
check (sync_ndr_leads_to_sheet.py upserts by awb_number, so a lead already in the sheet from a
previous day's run is never appended a second time - it's a resync of that same row instead).

current_status = 'RTO' is excluded: once a shipment has actually gone RTO, calling the
customer about a non-delivery attempt is moot - that's RTO Calling's lead now, not NDR's.

Contact fields (phone/address) come from a join to Item_level_data on Tracking_Number =
awb_number - lmd_courier_tracking itself has no phone number. Item_level_data has one row per
order ITEM, so multiple rows can share the same Tracking_Number; GROUP BY + MAX() collapses
that back to one row per awb (the address/phone fields are identical across every item in the
same order, so MAX() picking arbitrarily among identical values is safe). The HAVING clause
then drops any row where that join found no phone at all - a lead nobody can call is not a
lead.

courier_final_status is carried through so the daily resync can catch a status change on a
lead already sitting in the sheet from an earlier day - sync_ndr_leads_to_sheet.py's upsert
overwrites the whole row (all of COLUMNS) on a matching awb_number, so a changed value here
lands on the sheet automatically without any extra diff logic.
"""
import mysql_lib

NDR_SOURCE_SCHEMA = "mcaff_prod"
SOURCE_TABLE = "lmd_courier_tracking"
CONTACT_TABLE = "Item_level_data"

COLUMNS = ["awb_number", "uni_Display_Order_Code", "uni_Order_Date", "uni_Shipping_Courier",
           "uni_Facility", "uni_Channel_Name", "uni_brand_name", "cp_ndr_attempts",
           "cp_ndr_reason", "last_updated", "courier_final_status", "phone_number",
           "address_name", "city", "state", "pincode"]


def fetch_ndr_candidates():
    """Rows with at least one failed delivery attempt (cp_ndr_attempts >= 1), last_updated
    yesterday (calendar date), not already gone RTO, with a callable phone number. Returns
    None if MYSQL_* credentials aren't configured."""
    sql = f"""
        SELECT l.`awb_number`, l.`uni_Display_Order_Code`, l.`uni_Order_Date`,
               l.`uni_Shipping_Courier`, l.`uni_Facility`, l.`uni_Channel_Name`,
               l.`uni_brand_name`, l.`cp_ndr_attempts`, l.`cp_ndr_reason`, l.`last_updated`,
               l.`courier_final_status`,
               MAX(i.`Notification_Mobile`) AS phone_number,
               MAX(i.`Shipping_Address_Name`) AS address_name,
               MAX(i.`Shipping_Address_City`) AS city,
               MAX(i.`Shipping_Address_State`) AS state,
               MAX(i.`Pincode`) AS pincode
        FROM `{SOURCE_TABLE}` l
        LEFT JOIN `{CONTACT_TABLE}` i ON l.`awb_number` = i.`Tracking_Number`
        WHERE l.`cp_ndr_attempts` >= 1
          AND DATE(l.`last_updated`) = CURDATE() - INTERVAL 1 DAY
          AND (l.`current_status` IS NULL OR l.`current_status` != 'RTO')
        GROUP BY l.`awb_number`, l.`uni_Display_Order_Code`, l.`uni_Order_Date`,
                 l.`uni_Shipping_Courier`, l.`uni_Facility`, l.`uni_Channel_Name`,
                 l.`uni_brand_name`, l.`cp_ndr_attempts`, l.`cp_ndr_reason`, l.`last_updated`,
                 l.`courier_final_status`
        HAVING phone_number IS NOT NULL AND phone_number != ''
    """
    return mysql_lib.query(sql, database=NDR_SOURCE_SCHEMA)


if __name__ == "__main__":
    rows = fetch_ndr_candidates()
    if rows is None:
        print("MySQL credentials not configured.")
    else:
        print(f"{len(rows)} row(s) for yesterday:")
        for r in rows[:5]:
            print(" ", r)
