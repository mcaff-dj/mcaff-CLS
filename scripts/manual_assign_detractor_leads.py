#!/usr/bin/env python3
"""Manually claim NPS-Calling ('detractor' process) leads for one or more agents, using the
exact same eligibility rules as the real auto-assign path (api/_lib/db.js's
getNextDetractorLeadEitherPool/getNextDetractorLead/claimOneProductDetractorLead) - 30-day
recency, not already in CLS_NPS_calling, the agent's own brand_filter/lead_type_filter, and the
admin's configured lead_order (oldest/newest).

Stopgap for when the going-Online auto-fill trigger isn't firing (see
handleProcessPresence in api/auth/[action].js) - this performs the same claim directly against
MySQL instead of going through that HTTP trigger, so an agent gets leads without needing that
bug fixed first.

Dry-run by default (reports quota/load/eligible-candidate-counts, no writes). --apply actually
claims, one at a time, committing each successful claim immediately (so a later agent in the
same run, or a concurrent real assignment, correctly sees earlier claims as already taken).

Usage:
  python scripts/manual_assign_detractor_leads.py ali.ansari@mcaffeine.com shilpa.mallah@mcaffeine.com
  python scripts/manual_assign_detractor_leads.py --apply --count 5 ali.ansari@mcaffeine.com
"""
import argparse
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mysql_lib import get_credential

SCHEMA = "PEP_CLS"


def parse_ddmmyyyy(s):
    if not s:
        return None
    try:
        return datetime.strptime(str(s).strip(), "%d/%m/%Y").date()
    except ValueError:
        return None


def pick_older(delivery_date_str, product_date_str, sort_dir):
    """Mirrors api/_lib/detractorMerge.js's pickOlderDetractorCandidate."""
    d = parse_ddmmyyyy(delivery_date_str)
    p = parse_ddmmyyyy(product_date_str)
    if d is None and p is None:
        return None
    if d is None:
        return "product"
    if p is None:
        return "delivery"
    if d == p:
        return "delivery"
    return "delivery" if (d - p).days * sort_dir < 0 else "product"


def pool_allowed(pool, lead_type_filter):
    return not lead_type_filter or lead_type_filter == pool


def get_agent_settings(cur, email):
    cur.execute(
        "SELECT status, max_quota, detractor_brand_filter, detractor_lead_type_filter "
        "FROM calling_agent_process WHERE LOWER(email) = LOWER(%s) AND process_key = 'detractor'",
        (email,),
    )
    row = cur.fetchone()
    if not row:
        return {"status": "Offline", "max_quota": None, "brand_filter": "", "lead_type_filter": ""}
    return {
        "status": row["status"],
        "max_quota": row["max_quota"],
        "brand_filter": row["detractor_brand_filter"] or "",
        "lead_type_filter": row["detractor_lead_type_filter"] or "",
    }


def get_default_quota(cur):
    cur.execute("SELECT default_quota FROM calling_process_settings WHERE process_key = 'detractor'")
    row = cur.fetchone()
    return row["default_quota"] if row and row["default_quota"] is not None else None


def get_lead_order_sort_dir(cur):
    cur.execute("SELECT lead_order FROM calling_process_settings WHERE process_key = 'detractor'")
    row = cur.fetchone()
    return -1 if row and row["lead_order"] == "newest" else 1


def get_load(cur, email):
    cur.execute(
        "SELECT COUNT(*) AS n FROM CLS_NPS_calling "
        "WHERE LOWER(agent_email) = LOWER(%s) AND live_response_id IS NOT NULL AND disposed_at IS NULL",
        (email,),
    )
    return cur.fetchone()["n"]


DELIVERY_COLUMNS = [
    "response_id", "brand", "channel_order_id", "customer_name", "customer_phone", "customer_email",
    "address_city", "address_state", "address_pincode", "nps_score", "nps_category", "category", "sub_category",
    "top_rated_area", "other_l1_specify",
    "order_placement_experience", "order_placement_promoter_reason", "order_placement_promoter_openend",
    "platform_passive_reason", "platform_passive_openend",
    "platform_detractor_reason", "platform_detractor_openend",
    "product_first_impression", "product_packaging_promoter_reason", "product_packaging_promoter_openend",
    "product_first_impression_passive_reason", "product_first_impression_passive_openend",
    "product_packaging_detractor_reason", "product_packaging_detractor_openend",
    "cs_reach", "cs_team_rating", "cs_promoter_reason", "cs_promoter_openend",
    "cs_passive_reason", "cs_passive_openend",
    "cs_detractor_reason", "cs_detractor_openend",
    "delivery_service_rating", "delivery_promoter_reason", "delivery_promoter_openend",
    "delivery_passive_reason", "delivery_passive_openend",
    "delivery_detractor_reason", "delivery_detractor_openend",
    "additional_feedback", "product_name_list", "payment_method", "courier_company", "submitted_date",
]


def peek_delivery(cur, brand_filter, sort_dir):
    """Mirrors peekDeliveryDetractorCandidates in api/_lib/db.js."""
    cols = ", ".join(f"d.{c}" for c in DELIVERY_COLUMNS)
    cur.execute(
        f"""
        SELECT {cols}
        FROM nps_delivery d
        LEFT JOIN CLS_NPS_calling c ON c.response_id = d.response_id
        WHERE d.nps_category = 'Detractor' AND c.response_id IS NULL
          AND (%s = '' OR d.brand = %s)
          AND STR_TO_DATE(d.submitted_date, '%%d/%%m/%%Y') >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        ORDER BY TO_DAYS(STR_TO_DATE(d.submitted_date, '%%d/%%m/%%Y')) * %s ASC
        LIMIT 1
        """,
        (brand_filter, brand_filter, sort_dir),
    )
    return cur.fetchone()


def claim_delivery(cur, lead, email):
    cols = DELIVERY_COLUMNS + ["agent_email", "assigned_at"]
    placeholders = ", ".join(["%s"] * len(DELIVERY_COLUMNS) + ["%s", "NOW()"])
    values = [lead[c] for c in DELIVERY_COLUMNS] + [email]
    cur.execute(
        f"INSERT INTO CLS_NPS_calling ({', '.join(cols)}) VALUES ({placeholders})",
        values,
    )


def peek_product(cur, brand_filter, sort_dir):
    """Mirrors peekProductDetractorCandidates in api/_lib/db.js."""
    cur.execute(
        f"""
        SELECT p.response_id, MIN(p.submitted_date) AS submitted_date, MIN(p.nps_category) AS nps_category
        FROM nps_product p
        LEFT JOIN CLS_NPS_calling c ON c.response_id = p.response_id
        WHERE c.response_id IS NULL
          AND (%s = '' OR p.brand = %s)
          AND STR_TO_DATE(p.submitted_date, '%%d/%%m/%%Y') >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY p.response_id
        HAVING MIN(p.nps_category) = 'Detractor'
        ORDER BY TO_DAYS(STR_TO_DATE(MIN(p.submitted_date), '%%d/%%m/%%Y')) * %s ASC
        LIMIT 1
        """,
        (brand_filter, brand_filter, sort_dir),
    )
    return cur.fetchone()


def claim_product(cur, response_id, email):
    """Mirrors claimOneProductDetractorLead in api/_lib/db.js."""
    cur.execute(
        "SELECT GROUP_CONCAT(DISTINCT product_name ORDER BY product_slot SEPARATOR ', ') AS product_name_list "
        "FROM nps_product WHERE response_id = %s AND product_name IS NOT NULL AND TRIM(product_name) NOT IN ('', 'NA')",
        (response_id,),
    )
    product_name_list = cur.fetchone()["product_name_list"]

    cur.execute(
        """
        SELECT response_id, brand, channel_order_id, customer_name, customer_phone, customer_email,
               address_city, address_state, address_pincode, category, sub_category,
               payment_method, courier_company, submitted_date,
               overall_nps_score, nps_category, product_nps, results, texture, fragrance, packaging,
               skin_type_category, additional_feedback
        FROM nps_product
        WHERE response_id = %s
        ORDER BY (product_name IS NULL OR TRIM(product_name) IN ('', 'NA')) ASC, product_slot ASC
        LIMIT 1
        """,
        (response_id,),
    )
    lead = cur.fetchone()
    if not lead:
        return False

    cur.execute(
        """
        INSERT INTO CLS_NPS_calling (
          response_id, brand, channel_order_id, customer_name, customer_phone, customer_email,
          address_city, address_state, address_pincode, nps_score, nps_category, category, sub_category,
          additional_feedback, product_name_list, payment_method, courier_company, submitted_date,
          lead_type, product_results, product_texture, product_fragrance, product_packaging_rating,
          product_skin_type, product_nps, agent_email, assigned_at
        ) VALUES (
          %s, %s, %s, %s, %s,
          %s, %s, %s, %s,
          %s, %s, %s, %s,
          %s, %s, %s, %s, %s,
          'product', %s, %s, %s, %s,
          %s, %s, %s, NOW()
        )
        """,
        (
            lead["response_id"], lead["brand"], lead["channel_order_id"], lead["customer_name"], lead["customer_phone"],
            lead["customer_email"], lead["address_city"], lead["address_state"], lead["address_pincode"],
            lead["overall_nps_score"], lead["nps_category"], lead["category"], lead["sub_category"],
            lead["additional_feedback"], product_name_list, lead["payment_method"], lead["courier_company"], lead["submitted_date"],
            lead["results"], lead["texture"], lead["fragrance"], lead["packaging"],
            lead["skin_type_category"], lead["product_nps"], email,
        ),
    )
    return True


def assign_for_agent(conn, email, max_count, apply):
    cur = conn.cursor()
    settings = get_agent_settings(cur, email)
    default_quota = get_default_quota(cur)
    quota = max_count if max_count is not None else (
        settings["max_quota"] if settings["max_quota"] is not None
        else (default_quota if default_quota is not None else 15)
    )
    load = get_load(cur, email)
    to_claim = max(0, quota - load)
    sort_dir = get_lead_order_sort_dir(cur)
    brand_filter = settings["brand_filter"]
    lead_type_filter = settings["lead_type_filter"]

    print(f"\n=== {email} ===")
    print(f"  status={settings['status']} quota={quota} load={load} to_claim={to_claim} "
          f"brand_filter={brand_filter!r} lead_type_filter={lead_type_filter!r}")

    if to_claim == 0:
        print("  already at/over quota - nothing to claim")
        return

    claimed = []
    for _ in range(to_claim):
        delivery = peek_delivery(cur, brand_filter, sort_dir) if pool_allowed("delivery", lead_type_filter) else None
        product = peek_product(cur, brand_filter, sort_dir) if pool_allowed("product", lead_type_filter) else None
        pick = pick_older(
            delivery["submitted_date"] if delivery else None,
            product["submitted_date"] if product else None,
            sort_dir,
        )
        if pick is None:
            print("  pool exhausted - stopping")
            break
        if not apply:
            source = delivery if pick == "delivery" else product
            print(f"  [dry-run] would claim {pick} response_id={source['response_id']} "
                  f"submitted_date={source['submitted_date']}")
            claimed.append(source["response_id"])
            # Dry run can't rely on the real exclusion (nothing inserted), so just stop after
            # showing the single next-in-line candidate per pool rather than faking a full loop.
            break
        try:
            if pick == "delivery":
                claim_delivery(cur, delivery, email)
            else:
                claim_product(cur, product["response_id"], email)
            conn.commit()
            claimed.append(delivery["response_id"] if pick == "delivery" else product["response_id"])
        except Exception as e:
            conn.rollback()
            if "Duplicate entry" in str(e):
                print(f"  race on one slot ({e}) - retrying next iteration")
                continue
            raise

    print(f"  claimed {len(claimed)}: {claimed}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("emails", nargs="+")
    ap.add_argument("--apply", action="store_true", help="Actually claim leads (default is a dry run preview).")
    ap.add_argument("--count", type=int, default=None, help="Claim exactly this many leads instead of filling to quota.")
    args = ap.parse_args()

    cred = get_credential()
    if cred is None:
        raise SystemExit("MYSQL_* credentials not configured.")
    import pymysql
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=SCHEMA, port=cred["port"], ssl={"ssl": {}}, connect_timeout=15,
        cursorclass=pymysql.cursors.DictCursor, autocommit=False,
    )
    try:
        for email in args.emails:
            assign_for_agent(conn, email.strip().lower(), args.count, args.apply)
        if not args.apply:
            print("\nDry run - re-run with --apply to actually claim leads.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
