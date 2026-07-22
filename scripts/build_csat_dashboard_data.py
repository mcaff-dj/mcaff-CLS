import sys
from pathlib import Path

import pandas as pd
import json
import re
from collections import Counter

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mysql_lib
import pymysql

OUT = r"mcaff-CLS/data/csat_dashboard_data.json"

# CSAT/ticket tables live in the mcaff_dwh schema specifically, not whatever
# database MYSQL_DATABASE points at (mcaff_prod) - host/user/password still come
# from mysql_lib's normal env var / .env.local resolution.
DWH_DATABASE = "mcaff_dwh"

# agent := 'AI' whenever the ticket was AI-resolved (overrides whatever's in
# assigned_to for that handful of tickets where a human name leaked through)
# or when no agent name was recorded at all, else the real agent name.
# "(unassigned)" used to be its own bucket but is now folded into "AI".
BRAND_TABLES = [
    ("mcaff_tickets_csat", "mcaff_tickets", "mCaffeine"),
    ("hyphen_tickets_csat", "hyphen_tickets", "Hyphen"),
]

# `category` is a messy comma-joined tag (sentiment, resolution status, and/or class,
# not in a fixed order/position) - so Query Class is inferred by matching known class
# names anywhere in it, most-specific first to avoid substring collisions (e.g. check
# "Product Suggestion/Recommendation" before plain "Product"). Falls back to '(none)'
# for tickets with only a sentiment tag and no class assigned (~5-12% of rows).
QUERY_CLASS_CASE = """
    CASE
      WHEN t.category LIKE '%Product Suggestion/Recommendation%' THEN 'Product Suggestion/Recommendation'
      WHEN t.category LIKE '%Packaging and Operational%' THEN 'Packaging and Operational'
      WHEN t.category LIKE '%Requests & Enquiries%' THEN 'Requests & Enquiries'
      WHEN t.category LIKE '%Awaiting Response%' THEN 'Awaiting Response'
      WHEN t.category LIKE '%Delivery%' THEN 'Delivery'
      WHEN t.category LIKE '%Warehouse%' THEN 'Warehouse'
      WHEN t.category LIKE '%Technical%' THEN 'Technical'
      WHEN t.category LIKE '%Product%' THEN 'Product'
      WHEN t.category LIKE '%Others%' THEN 'Others'
      ELSE NULL
    END
"""


def fetch_brand_csat(cred, csat_table, tickets_table, brand_name):
    conn = pymysql.connect(
        host=cred["host"], user=cred["user"], password=cred["password"],
        database=DWH_DATABASE, port=cred["port"], ssl={"ssl": {}}, connect_timeout=30,
    )
    try:
        cur = conn.cursor()
        cur.execute(f"""
            SELECT
              CASE WHEN t.status = 'Resolved by AI' THEN 'AI'
                   WHEN t.assigned_to IS NULL OR t.assigned_to = 'Unassigned' THEN 'AI'
                   ELSE t.assigned_to END AS `Agent Name`,
              CASE WHEN t.status = 'Resolved by AI' THEN 'Yes' ELSE 'No' END AS `Is AI Agent`,
              {QUERY_CLASS_CASE} AS `Query Class`,
              t.subcategory AS `Query Category`,
              t.source AS `Channel`,
              cs.csat_rating AS `Rating`,
              cs.csat_comment AS `Comment`,
              cs.csat_submitted_at AS `Submitted Date`
            FROM {csat_table} cs
            LEFT JOIN {tickets_table} t ON t.ticket_number = cs.ticket_number
            WHERE cs.csat_status = 'Completed'
        """)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    finally:
        conn.close()
    sub = pd.DataFrame(rows, columns=cols)
    sub["Brand name"] = brand_name
    return sub


cred = mysql_lib.get_credential()
if cred is None:
    raise RuntimeError("MySQL credentials not configured - set MYSQL_HOST/USER/PASSWORD/DATABASE (or .env.local).")

df = pd.concat(
    [fetch_brand_csat(cred, csat_t, tickets_t, brand) for csat_t, tickets_t, brand in BRAND_TABLES],
    ignore_index=True,
)
df["Channel"] = df["Channel"].fillna("(none)")

df["dt"] = pd.to_datetime(df["Submitted Date"])
df["month_p"] = df["dt"].dt.to_period("M")
df["month"] = df["month_p"].dt.strftime("%b %Y")
df["resolver"] = df["Is AI Agent"].map({"Yes": "AI", "No": "Human"})
df["qclass"] = df["Query Class"].fillna("(none)")
df["qcat"] = df["Query Category"].fillna("(none)")
df["agent"] = df["Agent Name"].fillna("AI")
df["rating"] = df["Rating"].astype(int)

month_order = sorted(df["month_p"].dropna().unique())
MONTH_ORDER = [m.strftime("%b %Y") for m in month_order]

# ---- top query categories (cover most volume), rest bucketed as Other ----
# Query Class itself is small (~9 classes + "(none)") so it's never bucketed.
qcat_counts = df["qcat"].value_counts()
TOP_N = 20
top_qcats = set(qcat_counts.head(TOP_N).index)
df["qcat_bucket"] = df["qcat"].apply(lambda c: c if c in top_qcats else "Other")

# ---- GRANULAR: month x brand x resolver x channel x qclass x qcat_bucket x rating -> n ----
# "c" (qclass) drives the top-level heatmap rows; "cat" (qcat_bucket) is the Query
# Category breakdown shown when a Query Class row is expanded.
grp = df.groupby(["month", "Brand name", "resolver", "Channel", "qclass", "qcat_bucket", "rating"]).size().reset_index(name="n")
GRANULAR = [
    {"m": r["month"], "b": r["Brand name"], "r": r["resolver"], "ch": r["Channel"], "c": r["qclass"], "cat": r["qcat_bucket"], "rt": str(r["rating"]), "n": int(r["n"])}
    for _, r in grp.iterrows()
]

# ---- GRANULAR_AGENT: month x brand x resolver x channel x agent x rating -> n ----
# Only ~40 distinct agents total (incl. "AI", which also absorbs unassigned
# tickets), so no Other bucket needed.
grp_agent = df.groupby(["month", "Brand name", "resolver", "Channel", "agent", "rating"]).size().reset_index(name="n")
GRANULAR_AGENT = [
    {"m": r["month"], "b": r["Brand name"], "r": r["resolver"], "ch": r["Channel"], "c": r["agent"], "rt": str(r["rating"]), "n": int(r["n"])}
    for _, r in grp_agent.iterrows()
]

# ---- GRANULAR_AGENT_CLASS: month x brand x resolver x channel x agent x qclass x rating -> n ----
# Query Class breakdown shown when an agent row in the by-Agent heatmap is expanded.
grp_agent_class = df.groupby(["month", "Brand name", "resolver", "Channel", "agent", "qclass", "rating"]).size().reset_index(name="n")
GRANULAR_AGENT_CLASS = [
    {"m": r["month"], "b": r["Brand name"], "r": r["resolver"], "ch": r["Channel"], "ag": r["agent"], "c": r["qclass"], "rt": str(r["rating"]), "n": int(r["n"])}
    for _, r in grp_agent_class.iterrows()
]

# ---- KPI tiles ----
def avg_rating(sub):
    return round(sub["rating"].mean(), 2) if len(sub) else None

kpis = {
    "total": int(len(df)),
    "date_min": df["dt"].min().strftime("%d %b %Y"),
    "date_max": df["dt"].max().strftime("%d %b %Y"),
    "overall_avg": avg_rating(df),
    "ai_avg": avg_rating(df[df["resolver"] == "AI"]),
    "ai_n": int((df["resolver"] == "AI").sum()),
    "human_avg": avg_rating(df[df["resolver"] == "Human"]),
    "human_n": int((df["resolver"] == "Human").sum()),
    "promoters_pct": round(100 * (df["rating"] >= 4).mean(), 1),
    "detractors_pct": round(100 * (df["rating"] <= 2).mean(), 1),
    "brands": {
        b: {"n": int(len(sub)), "avg": avg_rating(sub)}
        for b, sub in df.groupby("Brand name")
    },
    "channels": {
        c: {"n": int(len(sub)), "avg": avg_rating(sub)}
        for c, sub in df.groupby("Channel")
    },
}

# ---- word cloud data: per (brand, month) word counts from Comment ----
STOPWORDS = set("""
the a an and or but if is are was were be been being to of in on for with as at by from
this that these those it its it's i you he she they we me my your his her our their
not no yes very good bad nice ok okay thanks thank you're im i'm dont don't did didn't
have has had do does doing done will would can could should just so than then also
about into out up down over under again further here there when where why how all
any both each few more most other some such only own same too can't cannot won't
got get getting still much many well even one two order product service delivery
customer app time day days please issue still bhi hai ho hi ka ki ke ko se h m mera
meri mere apka aapka apne aapki tha thi the please pls u ur
""".split())

def tokenize(text):
    words = re.findall(r"[a-zA-Z']{3,}", str(text).lower())
    return [w.strip("'") for w in words if w not in STOPWORDS and len(w) >= 3]

word_recs = Counter()
comments = df[df["Comment"].notna()][["Comment", "Brand name", "month"]]
for _, row in comments.iterrows():
    for w in tokenize(row["Comment"]):
        word_recs[(row["Brand name"], row["month"], w)] += 1

WORDS_BY_FILTER = [
    {"b": b, "m": m, "w": w, "c": c}
    for (b, m, w), c in word_recs.items()
    if c >= 3
]

# ---- findings: computed stats for prose ----
def stats_by(group_cols, min_n=1):
    g = df.groupby(group_cols)["rating"].agg(["mean", "count"]).reset_index()
    g = g[g["count"] >= min_n]
    return g

qcat_overall = stats_by(["qcat"], min_n=15).sort_values("mean")
weakest = qcat_overall.head(8).rename(columns={"qcat": "task"}).to_dict("records")

qcat_resolver = df.groupby(["qcat", "resolver"])["rating"].agg(["mean", "count"]).unstack("resolver")
qcat_resolver.columns = ["_".join(c) for c in qcat_resolver.columns]
tr = qcat_resolver.dropna(subset=["mean_AI", "mean_Human"])
tr = tr[(tr["count_AI"] >= 30) & (tr["count_Human"] >= 30)]
tr["gap"] = tr["mean_Human"] - tr["mean_AI"]
tr = tr.sort_values("gap", ascending=False)
tr.index.name = "task"
ai_worse = tr.head(6).reset_index().to_dict("records")
ai_better_or_tied = tr[tr["gap"] <= 0.1].sort_values("count_AI", ascending=False).head(4).reset_index().to_dict("records")

# month over month AI decline for top volume query categories
mom = df[df["resolver"] == "AI"].groupby(["qcat", "month"])["rating"].agg(["mean", "count"]).reset_index()
mom_pivot = mom.pivot(index="qcat", columns="month", values="mean")
mom_n = mom.pivot(index="qcat", columns="month", values="count")
declines = []
months_present = [m for m in MONTH_ORDER if m in mom_pivot.columns]
for t in mom_pivot.index:
    vals = mom_pivot.loc[t, months_present]
    ns = mom_n.loc[t, months_present]
    valid = [(m, vals[m], ns[m]) for m in months_present if pd.notna(vals[m]) and ns[m] >= 30]
    if len(valid) >= 2:
        first_m, first_v, first_n = valid[0]
        last_m, last_v, last_n = valid[-1]
        drop = first_v - last_v
        if drop > 0.3:
            declines.append({"task": t, "first_m": first_m, "first_v": round(first_v, 2), "first_n": int(first_n),
                              "last_m": last_m, "last_v": round(last_v, 2), "last_n": int(last_n), "drop": round(drop, 2)})
declines.sort(key=lambda x: -x["drop"])

top_volume_qcat = df["qcat"].value_counts().idxmax()
tv = df[df["qcat"] == top_volume_qcat]
tv_ai = tv[tv["resolver"] == "AI"]
tv_human = tv[tv["resolver"] == "Human"]
top_volume_compare = {
    "task": top_volume_qcat,
    "n": int(len(tv)),
    "ai_avg": avg_rating(tv_ai), "ai_n": int(len(tv_ai)),
    "human_avg": avg_rating(tv_human), "human_n": int(len(tv_human)),
}

result = {
    "kpis": kpis,
    "month_order": MONTH_ORDER,
    "granular": GRANULAR,
    "granular_agent": GRANULAR_AGENT,
    "granular_agent_class": GRANULAR_AGENT_CLASS,
    "n_agents_total": int(df["agent"].nunique()),
    "words_by_filter": WORDS_BY_FILTER,
    "weakest": weakest,
    "ai_worse": ai_worse,
    "ai_better_or_tied": ai_better_or_tied,
    "declines": declines[:4],
    "top_volume_compare": top_volume_compare,
    "task_coverage_pct": round(100 * qcat_counts.head(TOP_N).sum() / len(df), 1),
    "n_tasks_total": int(df["qcat"].nunique()),
    "n_query_classes_total": int(df["qclass"].nunique()),
}

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False)

print("wrote", OUT)
print("granular rows:", len(GRANULAR))
print("granular_agent rows:", len(GRANULAR_AGENT))
print("granular_agent_class rows:", len(GRANULAR_AGENT_CLASS))
print("word rows:", len(WORDS_BY_FILTER))
print(json.dumps({k: v for k, v in result.items() if k not in ("granular", "words_by_filter")}, indent=2, default=str)[:4000])
