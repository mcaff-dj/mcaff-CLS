"""Monthly NPS - Overall / NPS - Product data for the main report, sourced from the
PEP_CLS.nps_delivery / PEP_CLS.nps_product MySQL tables instead of the old
hand-maintained "MoM" / "*:PRODUCT NPS" Google Sheet tabs.

Both tables were inspected directly (DESCRIBE + sample queries) before writing this, since
neither is self-explanatory from its column names alone:

  - nps_delivery: one row per survey response (response_id is the sole primary key).
    `nps_category` (Promoter/Passive/Detractor) already reflects the standard 9-10/7-8/0-6
    bucketing of `nps_score` - verified, not assumed - so NPS% is computed from that column
    rather than re-deriving the buckets from nps_score.

  - nps_product: one row per (response_id, product_slot) - a respondent can rate up to 4
    products in one survey (product_slot 0-3), so response_id is NOT unique here (177,113
    rows / 76,615 distinct responses). `overall_nps_score` and `nps_category` are the
    survey-level score, constant across every slot of a given response_id (verified: 0
    responses have more than one distinct nps_category across their slots) - `product_nps`
    is the varying per-product rating instead. This module reports one NPS value per
    PERSON (overall_nps_score, deduped by response_id) to match "Total Responses" meaning
    unique respondents, not product-rating rows - see the GROUP BY response_id subquery
    below.

Confirmed against the sheet tabs these replace before wiring in: Apr-Jun'26 matched
exactly on both tables (e.g. mCaffeine nps_delivery Apr'26: 9,037/59.1 either way). Jan/Feb
'26 do NOT match - nps_delivery has 13/16 rows those months as against the sheet's
1,987/2,660 - these MySQL tables only carry reliable volume from ~Mar'26 on. Every other
month (including the pre-Jan'26 history the sheet never had at all) is MySQL-sourced;
Jan'26/Feb'26 specifically are overridden back to the sheet's own numbers by
override_months_from_sheet() below - see generate_report.py's NPS_SHEET_OVERRIDE_MONTHS -
since 13/16 responses produces a visibly wrong spike/dip on the chart rather than a
meaningful monthly figure.

submitted_date is stored as text in DD/MM/YYYY, not a real DATE column - the "%%d/%%m/%%Y"
in the query below (doubled %% ) is required because mysql_lib.query()'s
cur.execute(sql, params or ()) always passes a (possibly empty) args tuple, which makes
pymysql's mogrify() run Python %-style substitution over the SQL text regardless; a lone
%d/%m/%Y token in STR_TO_DATE's format string would otherwise be swallowed by that,
not passed through to MySQL.
"""
import calendar

import mysql_lib

DWH_DATABASE = "PEP_CLS"


def _month_label(yr, mo):
    """Matches the sheet's own month-label format (e.g. "7_Jul'26") that
    pretty_month()/year_of() in report_context.py expect."""
    return f"{mo}_{calendar.month_abbr[mo]}'{str(yr)[2:]}"


def _rows_to_sheet_shape(rows):
    """rows: [(ym 'YYYY-MM', total, promoters, detractors), ...] -> the sheet-shaped 2D
    array (header + [month_label, total, nps_pct] rows) build_combo2() already expects."""
    out = [["Month", "Total Responses", "NPS"]]
    for ym, total, promoters, detractors in rows:
        total = int(total)
        if not total:
            continue
        yr, mo = int(ym[:4]), int(ym[5:7])
        # promoters/detractors arrive as Decimal (SUM() of a boolean expression in MySQL) -
        # cast to plain float so nothing downstream trips on a Decimal it doesn't expect.
        nps_pct = round(float(promoters - detractors) / total * 100, 1)
        out.append([_month_label(yr, mo), total, nps_pct])
    return out


def fetch_delivery_nps(mysql_brand):
    """NPS - Overall: nps_delivery is already one row per response, so this is a
    straight GROUP BY - no dedup needed."""
    rows = mysql_lib.query(
        """
        SELECT DATE_FORMAT(STR_TO_DATE(submitted_date, "%%d/%%m/%%Y"), "%%Y-%%m") AS ym,
               COUNT(*) AS total,
               SUM(nps_category = "Promoter") AS promoters,
               SUM(nps_category = "Detractor") AS detractors
        FROM nps_delivery
        WHERE brand = %s
        GROUP BY ym
        ORDER BY ym
        """,
        params=(mysql_brand,),
        database=DWH_DATABASE,
    )
    if rows is None:
        raise RuntimeError("MySQL credentials not configured - set MYSQL_HOST/USER/PASSWORD/DATABASE (or .env.local).")
    return _rows_to_sheet_shape(rows)


def override_months_from_sheet(mysql_rows, sheet_rows, override_ym_set):
    """Replaces mysql_rows' Total Responses/NPS for specific (year, month) pairs with the
    matching sheet_rows values, leaving every other row (and mysql_rows' own, consistently
    "N_Mon'YY"-formatted label) untouched. sheet_rows' labels aren't matched on directly -
    the sheet's own raw labels are inconsistent (e.g. "1_Jan 26" with a space, vs "2_Feb'26"
    with an apostrophe) - so both sides are matched via report_context.parse_month_label's
    (year, month) tuple instead.

    override_ym_set entries with no corresponding row in sheet_rows are left as whatever
    mysql_rows already had for that month - this never removes a month, only replaces one
    that's present on both sides."""
    from report_context import parse_month_label
    sheet_by_ym = {}
    for row in sheet_rows[1:]:
        parsed = parse_month_label(row[0])
        if parsed:
            sheet_by_ym[parsed] = row

    out = [mysql_rows[0]]
    for row in mysql_rows[1:]:
        parsed = parse_month_label(row[0])
        sheet_row = sheet_by_ym.get(parsed) if parsed in override_ym_set else None
        if sheet_row is None:
            out.append(row)
            continue
        total = int(float(str(sheet_row[1]).replace(",", "")))
        nps_pct = float(str(sheet_row[2]).replace(",", ""))
        out.append([row[0], total, nps_pct])
    return out


def fetch_product_nps(mysql_brand):
    """NPS - Product: nps_product has up to 4 rows per response_id (one per rated
    product), but overall_nps_score/nps_category/submitted_date/brand are constant across
    a response's own slots - the inner query collapses to one row per response_id before
    the same monthly GROUP BY, so "Total Responses" counts people, not product ratings.

    brand is filtered INSIDE the dedup subquery, not on its result: neither nps_product nor
    nps_delivery has an index on `brand` (verified via SHOW INDEX - only the primary key
    exists on either table), so every query here is a full-table scan regardless: this at
    least keeps the expensive GROUP BY response_id itself scoped to one brand's ~half of the
    177k rows rather than deduping every row on the table before the caller's brand is ever
    considered."""
    rows = mysql_lib.query(
        """
        SELECT DATE_FORMAT(STR_TO_DATE(submitted_date, "%%d/%%m/%%Y"), "%%Y-%%m") AS ym,
               COUNT(*) AS total,
               SUM(nps_category = "Promoter") AS promoters,
               SUM(nps_category = "Detractor") AS detractors
        FROM (
            SELECT response_id,
                   MIN(submitted_date) AS submitted_date,
                   MIN(nps_category) AS nps_category
            FROM nps_product
            WHERE brand = %s
            GROUP BY response_id
        ) per_response
        GROUP BY ym
        ORDER BY ym
        """,
        params=(mysql_brand,),
        database=DWH_DATABASE,
    )
    if rows is None:
        raise RuntimeError("MySQL credentials not configured - set MYSQL_HOST/USER/PASSWORD/DATABASE (or .env.local).")
    return _rows_to_sheet_shape(rows)


def fetch_product_wise_nps(mysql_brand):
    """Product wise NPS: unlike fetch_product_nps() above (which dedupes to one row per
    person for the monthly "NPS - Product" trend), this groups nps_product BY PRODUCT NAME
    instead of by month - each (response_id, product_slot) row IS one product rating, so no
    response_id dedup applies here. Returns one dict per product, sorted by response volume
    (highest first) - same brand values as fetch_product_nps (brands.py's nps_mysql_brand)."""
    rows = mysql_lib.query(
        """
        SELECT product_name,
               COUNT(*) AS responses,
               AVG(overall_nps_score) AS avg_overall,
               AVG(packaging) AS avg_packaging,
               AVG(product_nps) AS avg_product_nps,
               SUM(nps_category = "Promoter") AS promoters,
               SUM(nps_category = "Passive") AS passives,
               SUM(nps_category = "Detractor") AS detractors
        FROM nps_product
        WHERE brand = %s AND product_name IS NOT NULL AND TRIM(product_name) NOT IN ('', 'NA')
        GROUP BY product_name
        ORDER BY responses DESC
        """,
        params=(mysql_brand,),
        database=DWH_DATABASE,
    )
    if rows is None:
        raise RuntimeError("MySQL credentials not configured - set MYSQL_HOST/USER/PASSWORD/DATABASE (or .env.local).")
    out = []
    for product_name, responses, avg_overall, avg_packaging, avg_product_nps, promoters, passives, detractors in rows:
        responses = int(responses)
        out.append({
            "product": product_name,
            "responses": responses,
            "avg_overall_nps": round(float(avg_overall), 1) if avg_overall is not None else None,
            "avg_packaging_score": round(float(avg_packaging), 1) if avg_packaging is not None else None,
            "avg_product_nps": round(float(avg_product_nps), 1) if avg_product_nps is not None else None,
            "promoters": int(promoters), "passives": int(passives), "detractors": int(detractors),
            "detractor_rate_pct": round(int(detractors) / responses * 100, 1) if responses else None,
        })
    return out
