"""Monthly Agent/AI CSAT summary for the main report's CSAT tab, sourced from the
mcaff_dwh MySQL tables instead of the old hand-maintained AGENT/AI Google Sheet
tabs. Uses the same 'Resolved by AI' vs 'Resolved by Agent' split as
build_csat_dashboard_data.py, so the two pipelines agree on what counts as AI.
"""
import calendar

import mysql_lib
from report_context import parse_month_label

DWH_DATABASE = "mcaff_dwh"


def _month_label(yr, mo):
    """Matches the sheet's own month-label format (e.g. "7_Jul'26") that
    pretty_month()/year_of() in report_context.py expect."""
    return f"{mo}_{calendar.month_abbr[mo]}'{str(yr)[2:]}"


def fetch_agent_ai_csat(csat_table, tickets_table):
    """Returns (agent_rows, ai_rows), each a sheet-shaped 2D array (a header row
    plus data rows of [month_label, total_responses, avg_rating]) - the exact
    shape build_combo2() already expects from the Google Sheet tabs it replaces."""
    rows = mysql_lib.query(
        f"""
        SELECT
          CASE WHEN t.status = 'Resolved by AI' THEN 'AI' ELSE 'Agent' END AS resolver,
          YEAR(cs.csat_submitted_at) AS yr,
          MONTH(cs.csat_submitted_at) AS mo,
          COUNT(*) AS n,
          AVG(CAST(cs.csat_rating AS UNSIGNED)) AS avg_rating
        FROM {csat_table} cs
        LEFT JOIN {tickets_table} t ON t.ticket_number = cs.ticket_number
        WHERE cs.csat_status = 'Completed'
        GROUP BY resolver, yr, mo
        ORDER BY yr, mo
        """,
        database=DWH_DATABASE,
    )
    if rows is None:
        raise RuntimeError(
            "MySQL credentials not configured - set MYSQL_HOST/USER/PASSWORD/DATABASE (or .env.local)."
        )

    agent_rows, ai_rows = [["Month", "Total Responses", "CSAT"]], [["Month", "Total Responses", "CSAT"]]
    for resolver, yr, mo, n, avg_rating in rows:
        target = ai_rows if resolver == "AI" else agent_rows
        target.append([_month_label(yr, mo), n, round(float(avg_rating), 2)])
    return agent_rows, ai_rows


def splice_with_sheet_history(sheet_rows, mysql_rows):
    """Prepends whatever sheet rows precede mysql_rows' earliest month - the frozen
    Dec'25-Feb'26 history that predates the mcaff_dwh CSAT tables (which only start
    Mar'26). A sheet row with no explicit year (e.g. "12_Dec") always precedes the
    MySQL data in this fixed historical span, so it's kept as-is and left for
    build_combo2()'s own backfill logic to resolve from row order, same as when
    this data came purely from the sheet."""
    mysql_data = mysql_rows[1:]
    if not mysql_data:
        return sheet_rows  # MySQL unavailable/empty - fall back to sheet-only
    cutoff = min(parse_month_label(r[0]) for r in mysql_data if parse_month_label(r[0]))

    def before_cutoff(row):
        parsed = parse_month_label(row[0])
        return parsed is None or parsed < cutoff

    header = sheet_rows[0]
    kept_history = [r for r in sheet_rows[1:] if before_cutoff(r)]
    return [header] + kept_history + mysql_data
