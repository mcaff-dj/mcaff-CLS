"""Shared per-brand report state + low-level helpers.

PowerShell dot-sources Generate-Report.ps1's variables/functions into gen-insights.ps1,
gen-weekly.ps1, gen-monthly.ps1 and gen-panels.ps1 (all share one script scope). Python has
no equivalent, so this module holds the small set of pure helpers those files all use
(HTML/JSON escaping, month/year formatting) plus a plain `Ctx` object that generate_report.py
builds once per brand and every other module receives explicitly - the direct replacement
for that shared script scope.
"""
import math
import re


def ci_key(value, cache):
    """Resolves `value` to the first-seen casing recorded in `cache` (a plain dict mapping
    casefolded string -> first-seen original string). PowerShell's default @{}/[ordered]@{}
    hashtable compares string keys case-insensitively but preserves the casing of whichever
    variant was inserted first - two rows spelling the same category "Product not Sealed"
    and "product NOT sealed" collapse into one bucket there. Python dicts are always
    case-sensitive, so every grouping-by-text-value operation ported from a PowerShell
    hashtable must pre-resolve its key through this function first to match exactly.
    Pass a fresh `cache = {}` per independent grouping operation (matching one `@{}`
    instantiation in the original) - a single cache shared across unrelated groupings would
    let an unrelated part of the report "lock in" a casing before this one sees it, which
    isn't how independently-scoped PowerShell hashtables behave."""
    if not isinstance(value, str):
        return value
    cf = value.casefold()
    if cf in cache:
        return cache[cf]
    cache[cf] = value
    return value

# The older KYC raw-dump sheet (see brands.py "secondary") worded some Query Category
# values differently than the primary sheet - normalized here so both sides of a merged
# report count as one category instead of splitting the same complaint type into two rows.
CAT_NORM_MAP = {
    "Reattempt Request/ Fake update": "Fake update",
    "Pincode non Serviceable": "Pincode not serviceable",
    "Lost order/Destroyed/Damaged": "Lost/Damaged/Destroyed",
    "Marked Delivered but customer did not received the order": "Marked Delivered but customer did not receive order",
}
# Same reasoning as CAT_NORM_MAP above, but for Delivery Partner Name: the older KYC
# raw-dump sheet has messy operational sub-labels (surface/air legs, direct/hyphen
# routing codes, brand-specific suffixes) for couriers the primary sheet already
# reports under clean canonical names.
PARTNER_NORM_MAP = {
    "Blue Dart Air": "Blue Dart",
    "Blue Dart Surface": "Blue Dart",
    "Bluedart": "Blue Dart",
    "Bluedart brands 500 g Surface": "Blue Dart",
    "Bluedart Surface - Select  500gm": "Blue Dart",
    "Bluedart Surface - Select 500gm": "Blue Dart",
    "Bluedart Surface 500 gms- Select": "Blue Dart",
    "Cuberooteeine": "PurpleDrone",
    "Purpledrone_mCaff": "PurpleDrone",
    "Delhivery Air": "DELHIVERY",
    "DELHIVERY_SMYTTEN": "DELHIVERY",
    "DLSRF_Direct": "DELHIVERY",
    "Dlv_Direct_Air": "DELHIVERY",
    "HYP_DELHIVERY": "DELHIVERY",
    "SR_Delhivery": "DELHIVERY",
    "DTDC Surface": "DTDC",
    "DTDC_Surface_Direct": "DTDC",
    "Ekart Logistics Surface": "Ekart",
    "Elasticrun_direct_M": "ElasticRun",
    "Pidge_Omnivio": "Pidge",
    "Pikndel_M_SDD": "Pikndel",
    "Shadowfax Surface": "Shadowfax",
    "SHADOWFAX_ESSENTIAL": "Shadowfax",
    "Shadowfax_M_NDD": "Shadowfax",
    "Shadowfax_M_SDD": "Shadowfax",
    "Fedex Air": "Fedex",
    "SR_Fedex_Courier": "Fedex",
    "XBSRF_ Air_Direct": "Xpressbees",
    "XBSRF_Direct": "Xpressbees",
    "XBSRF_Direct_NDD": "Xpressbees",
    "xpressbees": "Xpressbees",
    "Xpressbees Surface": "Xpressbees",
    "na": "(blank)",
}


def h_enc(s):
    """Matches .NET Core's HttpUtility.HtmlEncode for the plain-ASCII case used here:
    escapes &, <, >, " and ' (as the numeric entity &#39;, not &apos;)."""
    s = "" if s is None else str(s)
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;").replace("'", "&#39;"))


def round1(n):
    return round(n, 1)


def j_enc(s):
    s = "" if s is None else str(s)
    s = s.replace("\\", "\\\\").replace('"', '\\"')
    s = s.replace("\r\n", "\\n").replace("\r", "\\n").replace("\n", "\\n").replace("\t", "\\t")
    return s


def pretty_month(raw):
    parts = raw.split("_", 1)
    if len(parts) < 2:
        return raw
    return parts[1].replace("'", " '")


_year_of_cache = {}
_year_re = re.compile(r"['\s](\d{2})$")


def year_of(mo):
    if mo in _year_of_cache:
        return _year_of_cache[mo]
    m = _year_re.search(mo)
    y = f"20{m.group(1)}" if m else ""
    _year_of_cache[mo] = y
    return y


def nice_max(v):
    if v <= 0:
        return 10
    m = math.pow(10, math.floor(math.log10(v)))
    for s in (1, 2, 2.5, 5, 10):
        c = s * m
        if c >= v:
            return c
    return 10 * m


def fnum(v):
    """Approximates .NET's default double.ToString() for SVG coordinate/dimension values:
    no trailing '.0' for whole numbers (Python's str(float) always adds one), and rounds
    away floating-point noise so equivalent-but-differently-ordered arithmetic doesn't
    produce visually-identical-but-longer strings like 115.57000000000001 vs 115.57."""
    v = round(v, 6)
    if v == int(v):
        return str(int(v))
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return s


def n0(v):
    """Matches PowerShell's $n.ToString('N0') under this machine's culture, which formats
    with Indian digit grouping (lakh/crore: 1,67,751) rather than Western thousands
    grouping (167,751) - confirmed by diffing against the live PowerShell output."""
    iv = round(v)
    neg = iv < 0
    s = str(abs(iv))
    if len(s) <= 3:
        result = s
    else:
        last3 = s[-3:]
        rest = s[:-3]
        parts = []
        while len(rest) > 2:
            parts.insert(0, rest[-2:])
            rest = rest[:-2]
        if rest:
            parts.insert(0, rest)
        result = ",".join(parts) + "," + last3
    return ("-" if neg else "") + result


# $script:CatNormMap/$script:PartnerNormMap in the original are also plain @{} hashtables,
# so their .ContainsKey() lookups are case-insensitive too - matched here via a lowercased
# lookup table built once at import time.
_CAT_NORM_MAP_CI = {k.casefold(): v for k, v in CAT_NORM_MAP.items()}
_PARTNER_NORM_MAP_CI = {k.casefold(): v for k, v in PARTNER_NORM_MAP.items()}


class Ctx:
    """Per-brand shared state, built once by generate_report.py and passed to every
    panel-builder module - the direct replacement for PowerShell's shared script scope."""

    def __init__(self, brand):
        self.b = brand
        self.col = brand["col"]

    def cell(self, row, i):
        if row is None:
            return ""
        if isinstance(row, list):
            if i < len(row):
                v = row[i]
                if v is None:
                    return ""
            else:
                return ""
        elif i == 0:
            v = row
        else:
            return ""
        if i == self.col["cat"] and isinstance(v, str) and v.casefold() in _CAT_NORM_MAP_CI:
            return _CAT_NORM_MAP_CI[v.casefold()]
        if i == self.col["partner"] and isinstance(v, str) and v.casefold() in _PARTNER_NORM_MAP_CI:
            return _PARTNER_NORM_MAP_CI[v.casefold()]
        return v

    def count_by(self, data, i):
        d = {}
        ci_cache = {}
        for r in data:
            v = self.cell(r, i)
            if not str(v).strip():
                v = "(blank)"
            v = ci_key(v, ci_cache)
            d[v] = d.get(v, 0) + 1
        return d

    @staticmethod
    def top_n(d, n):
        items = sorted(d.items(), key=lambda kv: kv[1], reverse=True)[:n]
        return [{"key": k, "value": v} for k, v in items]
