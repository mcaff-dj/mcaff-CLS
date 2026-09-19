'use client';

// NPS-Calling's own workspace (process key 'detractor' - see api/_lib/callingProcesses.json).
// Built on the same shared app/_calling/ pieces as RTO/NDR, but its data flow is deliberately
// simpler than either: there is no Sheet and no CSV upload, because the lead pool is the MySQL
// table nps_delivery (read-only, external) copied on-assign into CLS_NPS_calling - see
// api/_lib/db.js's getNextDetractorLead/disposeDetractorLead. So this file has no sync-from-
// sheet loop, no upload modal, and no team split (single shared queue/disposition tree for v1).
import { useState, useEffect, useCallback, useMemo } from 'react';
import { XIcon, CheckIcon, PhoneIcon, CustomSelect, Overlay, CalendarIcon, SearchIcon, DownloadIcon, MultiSelectDropdown, ChevronDown } from '../_calling/ui';
import { useCallingSession, ROSTER_STATUS_OPTIONS, STATUS_OPTIONS } from '../_calling/useCallingSession';
import { useBusinessHours, CallingHoursCard, useDefaultQuota, DefaultQuotaCard, useLeadOrder, LeadOrderCard, useDateRange, DateRangeCard, useProcessDispositions, ProcessDispositionsCard } from '../_calling/CallingAdminPanel';
import { CallingShell } from '../_calling/CallingShell';
import { safeStorage as localStorage, scopeToDateBounds, isLeadDateInScope, istMinutesSinceMidnightClient, istDayKeyClient, formatTimeOfDay, formatBreakMinutes, formatFrt, formatPct } from '../_calling/util';
// "Avg Time to Dispose" - the gap BETWEEN consecutive disposals, shared/tested the same way RTO's
// own Overview uses it (see that module's own comment).
import { disposalGaps } from '../../api/_lib/disposalGaps';

const PROCESS_KEY = 'detractor';
// Keep in sync with api/_lib/db.js's own DETRACTOR_FALLBACK_QUOTA - shown in the admin card so
// "blank" reads as a real number instead of an unexplained empty field.
const FALLBACK_QUOTA = 15;

// Every surveyed area from nps_delivery (see scripts/add_nps_area_ratings_to_calling.py), not
// just whichever area's detractor_reason happened to trigger the overall Detractor status - a
// customer can be an overall detractor while still having rated another area well, and that
// contrast is worth showing the agent. `rating` is one of the four columns scripts/nps_source.py's
// AREA_RATING_COLUMNS also uses (not on one consistent scale over time - see that file's own
// comment - so shown as the source's raw value, not normalized). `buckets` lists every
// promoter/passive/detractor reason+openend pair that exists for the area; only whichever
// bucket the customer's response actually filled in ever has text, same "only what's relevant"
// shape the old single-bucket version already had.
// Product-lead equivalent of AREAS: nps_product has no promoter/passive/detractor reason buckets
// (unlike nps_delivery) - just five per-product ratings, plus product_nps (that product's own
// 0-10 score, distinct from the survey-level nps_score every ticket already carries). Order
// matches nps_product's own column order.
const PRODUCT_RATING_FIELDS = [
  { label: 'Product NPS', field: 'product_nps' },
  { label: 'Results', field: 'product_results' },
  { label: 'Texture', field: 'product_texture' },
  { label: 'Fragrance', field: 'product_fragrance' },
  { label: 'Packaging', field: 'product_packaging_rating' },
  { label: 'Skin type', field: 'product_skin_type' },
];

const AREAS = [
  {
    label: 'Order Placement / Website',
    rating: 'order_placement_experience',
    buckets: [{ reason: 'order_placement_promoter_reason', openend: 'order_placement_promoter_openend' }],
  },
  {
    label: 'Platform',
    rating: null,
    buckets: [
      { reason: 'platform_passive_reason', openend: 'platform_passive_openend' },
      { reason: 'platform_detractor_reason', openend: 'platform_detractor_openend' },
    ],
  },
  {
    label: 'Product / Packaging',
    rating: 'product_first_impression',
    buckets: [
      { reason: 'product_packaging_promoter_reason', openend: 'product_packaging_promoter_openend' },
      { reason: 'product_first_impression_passive_reason', openend: 'product_first_impression_passive_openend' },
      { reason: 'product_packaging_detractor_reason', openend: 'product_packaging_detractor_openend' },
    ],
  },
  {
    label: 'Customer Service',
    rating: 'cs_team_rating',
    reach: 'cs_reach',
    buckets: [
      { reason: 'cs_promoter_reason', openend: 'cs_promoter_openend' },
      { reason: 'cs_passive_reason', openend: 'cs_passive_openend' },
      { reason: 'cs_detractor_reason', openend: 'cs_detractor_openend' },
    ],
  },
  {
    label: 'Delivery',
    rating: 'delivery_service_rating',
    buckets: [
      { reason: 'delivery_promoter_reason', openend: 'delivery_promoter_openend' },
      { reason: 'delivery_passive_reason', openend: 'delivery_passive_openend' },
      { reason: 'delivery_detractor_reason', openend: 'delivery_detractor_openend' },
    ],
  },
];

// nps_delivery stores an unfilled field as the literal string "NA", not NULL/blank.
function hasValue(v) {
  return !!v && v !== 'NA';
}

// AI-classified sentiment of additional_feedback (see api/_lib/sentiment.js) - null on leads
// assigned before this shipped, or whenever ANTHROPIC_API_KEY isn't configured; the badge just
// doesn't render then (hasValue gate at the call site).
const SENTIMENT_BADGE = {
  Positive: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  Neutral: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
  Negative: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
};

// product_name_list is comma-separated between products, but at least one product's own name
// ALSO embeds a comma before its size (e.g. "Naked Raw Coffee Face Wash, 100 ml" sits right next
// to "Naked Raw Coffee Face Scrub100g", which has no comma at all before its own size) - the
// source data isn't consistent about it. A naive split therefore breaks that one entry into a
// real product name plus a bare "100 ml" fragment with no product attached. Any split fragment
// that's JUST a quantity (a number + unit, nothing else) is never a product on its own, so it's
// re-joined onto whichever fragment came before it instead of kept as its own option.
const PRODUCT_SIZE_ONLY = /^\d+(\.\d+)?\s*(ml|g|gm|gms|kg|l|ltr|litres?)s?$/i;
function splitProductNameList(list) {
  const parts = list.split(',').map((p) => p.trim()).filter(Boolean);
  const merged = [];
  for (const part of parts) {
    if (PRODUCT_SIZE_ONLY.test(part) && merged.length) merged[merged.length - 1] += `, ${part}`;
    else merged.push(part);
  }
  return merged;
}

// top_rated_area is a raw numeric code in the source survey with no label of its own - mapping
// confirmed against the survey's own question options, not guessed. Falls back to the raw code
// for anything outside 1-4, rather than hiding it, so an unexpected value is still visible.
const TOP_RATED_AREA_LABELS = {
  '1': 'Delivery experience',
  '2': 'Customer support',
  '3': 'Product',
  '4': 'Website / app experience',
};

// The survey-detail block (category, top-rated area, per-area ratings/reasons, free-text
// feedback) - shared by the ticket card (queue/disposed lists) and the dispose modal, so an
// agent still has the customer's full context in front of them while filling out the
// disposition rather than having to close the modal to re-check the card behind it.
function TicketSurveyDetails({ t }) {
  return (
    <>
      <div className="space-y-1 mb-2">
        <p className="text-[11px] font-bold uppercase tracking-wide text-indigo-300">
          {t.lead_type === 'product' ? 'Product' : 'Delivery'}
        </p>

        {(t.category || t.sub_category) && (
          <p className="text-[12px] text-zinc-400">{[t.category, t.sub_category].filter(Boolean).join(' · ')}</p>
        )}

        {hasValue(t.product_name_list) && (
          <p className="text-[12px] text-zinc-400"><span className="font-semibold text-zinc-300">Product(s):</span> {t.product_name_list}</p>
        )}

        {(hasValue(t.payment_method) || hasValue(t.courier_company)) && (
          <p className="text-[12px] text-zinc-400">
            {hasValue(t.payment_method) && <span className="uppercase">{t.payment_method}</span>}
            {hasValue(t.payment_method) && hasValue(t.courier_company) && ' · '}
            {hasValue(t.courier_company) && <span>{t.courier_company}</span>}
          </p>
        )}

        {(hasValue(t.top_rated_area) || hasValue(t.other_l1_specify)) && (
          <p className="text-[12px] text-zinc-400">
            {hasValue(t.top_rated_area) && <span><span className="font-semibold text-zinc-300">Top-rated area:</span> {TOP_RATED_AREA_LABELS[t.top_rated_area] || t.top_rated_area}</span>}
            {hasValue(t.top_rated_area) && hasValue(t.other_l1_specify) && ' · '}
            {hasValue(t.other_l1_specify) && <span><span className="font-semibold text-zinc-300">Other:</span> {t.other_l1_specify}</span>}
          </p>
        )}
      </div>

      <div className="space-y-2">
        {t.lead_type === 'product' ? (
          PRODUCT_RATING_FIELDS.filter(({ field }) => hasValue(t[field])).map(({ label, field }) => (
            <p key={field} className="text-[12px] text-zinc-300">
              <span className="font-semibold text-zinc-200">{label}:</span> {t[field]}
            </p>
          ))
        ) : AREAS.map(({ label, rating, reach, buckets }) => {
          const ratingVal = rating && t[rating];
          const reachVal = reach && t[reach];
          // Customer service specifically: never reached CS means nothing else about this area
          // (rating/reasons) is meaningful either - skip the whole block rather than showing a
          // bare "Reached CS: No" that just invites the agent to look for detail that isn't there.
          if (reach && reachVal === 'No') return null;
          const filledBuckets = buckets
            .map(({ reason, openend }) => ({ reason: t[reason], openend: t[openend] }))
            .filter((b) => hasValue(b.reason) || hasValue(b.openend));
          if (!hasValue(ratingVal) && !hasValue(reachVal) && !filledBuckets.length) return null;
          return (
            <div key={label} className="text-[12px] text-zinc-300">
              <p>
                <span className="font-semibold text-zinc-200">{label}</span>
                {hasValue(ratingVal) && <span className="text-zinc-500"> · Rating: {ratingVal}</span>}
                {hasValue(reachVal) && <span className="text-zinc-500"> · Reached CS: {reachVal}</span>}
              </p>
              {filledBuckets.map((b, i) => (
                <p key={i} className="pl-2">{[b.reason, b.openend].filter(hasValue).join(' — ')}</p>
              ))}
            </div>
          );
        })}
        {hasValue(t.additional_feedback) && (
          <p className="text-[12px] text-zinc-300"><span className="font-semibold text-zinc-200">Feedback:</span> {t.additional_feedback}</p>
        )}
      </div>
    </>
  );
}

function isUndisposed(t) {
  return !t.disposed_at;
}

// Recursive multi-select over the admin-configured disposition tree (calling_process_
// dispositions, shared across every process - see useProcessDispositions). A detractor often
// raises more than one issue in a single call, so unlike RTO/NDR's single cascading pick, every
// leaf (no children) is its own checkbox and any number can be checked - independently, across
// categories - rather than the call being forced into one final label. A node WITH children is
// just a section header; it's never itself selectable. `selected` is the Map from
// id -> {id, path, needsProduct} kept in NpsCallingClient's own dispose-modal state; `ancestors`
// is the chain of labels above `nodes` in this recursion, so a checked leaf's `path` carries its
// whole breadcrumb (e.g. ['Delivery Related', 'Late delivery']) for saveDisposition to join on.
//
// productOptions/productsByReason/onProductsChange: only meaningful under a node whose own
// admin-configured triggersProductFollowup flag is set, OR that sits under an ancestor that has
// it set (ancestorNeedsProduct, threaded down through the recursion below) - a checked reason
// there gets its OWN inline "which product?" follow-up right below it (rather than one for the
// whole category), since different products on the same order can each have a different problem
// and the agent needs to say which product goes with which reason. Always asked once checked,
// never skipped for lack of data - productOptions empty (this ticket's own product_name_list has
// nothing usable) falls back to catalogProductNames, a searchable multi-select over every
// product actually rated for this ticket's brand in the last 3 months (see showProductFollowUp
// below and getDetractorProductNames's own comment) - catalogLoading distinguishes "still
// fetching" from "brand genuinely has nothing recent" while it's empty.
//
// This flag replaced a hardcoded label match (isProductFollowUpPath, matching literal strings
// like "Product Related Issue"/"Query Category"/"Query Class") that broke silently every time an
// admin renamed the category it was chasing - twice, in production. It's now a real column
// (calling_process_dispositions.triggers_product_followup), edited from a checkbox in
// CallingAdminPanel.js's DispNode (allowProductFollowupControl), so a rename can no longer unhook
// it - flip the checkbox back on after a rename instead of shipping a code change.
// Every id in a subtree, the node's own included - what a pick has to clear when it's undone or
// when a one-of sibling takes over, so an answer the agent can no longer see can never still be
// sitting in selectedReasons at save time.
function collectIds(node, out = []) {
  out.push(node.id);
  (node.children || []).forEach((c) => collectIds(c, out));
  return out;
}

// The tree an admin builds in CallingAdminPanel's ProcessDispositionsCard has four levels, and
// each one means something different here:
//
//   Connected / Non Connected   the branch - picked by the segmented control in the modal, so
//                               this component is handed its CHILDREN and never draws the branch
//                               itself (drawing it asked the agent to pick "Connected" twice)
//     Have you reached out…     depth 1, a question - a heading, never answerable itself
//       Yes / No                depth 2, an answer
//         Query not resolved…   depth 3+, a follow-up answer
//
// `inputType` is the parent's own children_input_type column and says how the nodes in THIS array
// are answered: 'single' draws them as one-of pills, 'multi' draws checkboxes. Either way the pick
// keeps drilling - a checked checkbox still reveals its own children, unlike delivery-escalation's
// linear walk where a multi level ends the path (DeliveryEscalationClient.js's dispLevels), because
// these trees hang further reasons off a checkbox option ("Query Class > Product issue > …").
//
// A node's children only appear once that node itself is picked, so the agent is only ever shown
// the follow-up to an answer they actually gave.
function DispositionChecklist({
  nodes, selected, onToggle, ancestors = [], depth = 1, inputType = 'single', ancestorNeedsProduct = false,
  productOptions = [], productsByReason = {}, onProductsChange,
  catalogProductNames = [], catalogLoading = false,
}) {
  if (!nodes || !nodes.length) {
    return <p className="text-[12px] text-zinc-500">No disposition options configured yet - an admin can add some under Admin Panel.</p>;
  }

  // Sticky once true - a descendant three levels down a flagged question still needs the
  // follow-up even if none of ITS own ancestors between here and there are individually flagged
  // (e.g. "Query Class" flagged, "Packaging issue" not, "Broken Nozzle" not - the leaf still
  // needs it because Query Class does).
  const needsProductFor = (n) => ancestorNeedsProduct || !!n.triggersProductFollowup;
  // ...but only the end of the line actually ANSWERS it: "Query Class" is flagged and "Product
  // issue" inherits that, yet the product belongs to whichever of its eight reasons was checked.
  // Passed to onToggle so a parent picked on the way down never lands in affectedProductsText
  // (nor gets its products pre-filled) for a picker it was never shown.
  const asksProduct = (n) => needsProductFor(n) && !(n.children && n.children.length);

  const productFollowUp = (n) => {
    const picked = productsByReason[n.id] || [];
    // Always asked once checked - not gated on productOptions.length. Most tickets carry their
    // own product_name_list (order/response line items), so the common case is the picker below;
    // a ticket with none (nothing to pick from - the ticket's own product name never made it into
    // product_name_list) still must not skip the question entirely, so it falls back to the
    // recent catalog instead of silently showing nothing.
    if (productOptions.length > 0) {
      return (
        <>
          <label className="text-[11px] text-zinc-500 font-semibold mb-1 block">
            Which product(s)? {picked.length ? `· ${picked.length} selected` : ''}
          </label>
          <select
            multiple
            value={picked}
            onChange={(e) => onProductsChange(n.id, Array.from(e.target.selectedOptions, (o) => o.value))}
            size={Math.min(productOptions.length, 4)}
            className="w-full text-[12px] bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 p-1"
          >
            {productOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </>
      );
    }
    if (catalogProductNames.length > 0) {
      return (
        <>
          <label className="text-[11px] text-zinc-500 font-semibold mb-1 block">
            Which product(s)? (not on this ticket's own list - search the recent catalog below)
          </label>
          <MultiSelectDropdown
            value={picked}
            onChange={(vals) => onProductsChange(n.id, vals)}
            options={catalogProductNames}
            searchable
            placeholder="Search products…"
            itemNoun="products"
          />
        </>
      );
    }
    return (
      <p className="text-[11px] text-zinc-500">
        {catalogLoading ? 'Loading product catalog…' : 'No recent products found for this brand.'}
      </p>
    );
  };

  // Whatever a picked answer still has to ask: its own children (the next question), or - once
  // there are none left - the "which product?" follow-up if this path is flagged for it. Asked
  // only at the end of the line, so a flagged question doesn't ask it again at every level down.
  const revealed = (n) => {
    const hasChildren = n.children && n.children.length > 0;
    if (!hasChildren) {
      return asksProduct(n)
        ? <div className="mt-2 pl-3 border-l-2 border-indigo-500/30">{productFollowUp(n)}</div>
        : null;
    }
    return (
      <div className="mt-2 pl-3 border-l-2 border-indigo-500/30">
        <DispositionChecklist
          nodes={n.children} selected={selected} onToggle={onToggle}
          ancestors={[...ancestors, n.label]} depth={depth + 1} inputType={n.childrenInputType || 'single'}
          ancestorNeedsProduct={needsProductFor(n)}
          productOptions={productOptions} productsByReason={productsByReason} onProductsChange={onProductsChange}
          catalogProductNames={catalogProductNames} catalogLoading={catalogLoading}
        />
      </div>
    );
  };

  // The question level: a label and its answers, one card each. Always open - these are the
  // call's script, so collapsing them would only hide the next question from the agent.
  if (depth === 1) {
    return (
      <div className="space-y-2">
        {nodes.map((n) => {
          const hasChildren = n.children && n.children.length > 0;
          if (!hasChildren) {
            // A reason hung straight off the branch with no answers of its own - not a question,
            // so it stays an answer row rather than becoming an empty heading.
            return (
              <div key={n.id} className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3">
                <DispositionChecklist
                  nodes={[n]} selected={selected} onToggle={onToggle} ancestors={ancestors}
                  depth={2} inputType={inputType} ancestorNeedsProduct={ancestorNeedsProduct}
                  productOptions={productOptions} productsByReason={productsByReason} onProductsChange={onProductsChange}
                  catalogProductNames={catalogProductNames} catalogLoading={catalogLoading}
                />
              </div>
            );
          }
          return (
            <div key={n.id} className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3 space-y-2">
              <p className="text-[12.5px] font-bold text-zinc-100 tracking-tight leading-snug">{n.label}</p>
              <DispositionChecklist
                nodes={n.children} selected={selected} onToggle={onToggle}
                ancestors={[...ancestors, n.label]} depth={2} inputType={n.childrenInputType || 'single'}
                ancestorNeedsProduct={needsProductFor(n)}
                productOptions={productOptions} productsByReason={productsByReason} onProductsChange={onProductsChange}
                catalogProductNames={catalogProductNames} catalogLoading={catalogLoading}
              />
            </div>
          );
        })}
      </div>
    );
  }

  // One-of: pills on one row, and since at most one of them can be picked, whatever that pick
  // still has to ask goes underneath the whole row rather than beside a pill.
  if (inputType === 'single') {
    const picked = nodes.find((n) => selected.has(n.id));
    const clearIdsFor = (n) => nodes.filter((s) => s.id !== n.id).flatMap((s) => collectIds(s)).concat(collectIds(n).slice(1));
    return (
      <div>
        <div className="flex flex-wrap gap-2">
          {nodes.map((n) => {
            const isPicked = selected.has(n.id);
            return (
              <button
                key={n.id}
                type="button"
                title={n.description || ''}
                onClick={() => onToggle(n.id, [...ancestors, n.label], asksProduct(n), clearIdsFor(n))}
                className={`px-3 py-1.5 rounded-lg text-[12.5px] font-semibold border transition-colors ${
                  isPicked
                    ? 'bg-indigo-500/15 border-indigo-500 text-indigo-200'
                    : 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                }`}
              >
                {n.label}
              </button>
            );
          })}
        </div>
        {picked && revealed(picked)}
      </div>
    );
  }

  // Pick-many: a checkbox per answer, each revealing whatever it still has to ask once checked -
  // its own reasons ("Product issue" has eight of them), or the product question at the end.
  return (
    <div className="space-y-0.5">
      {nodes.map((n) => {
        const checked = selected.has(n.id);
        const followUp = checked ? revealed(n) : null;
        return (
          <div key={n.id}>
            <label
              className={`flex items-center gap-2.5 text-[13px] cursor-pointer rounded-lg px-2 py-1.5 -mx-2 transition-colors ${
                checked ? 'bg-indigo-500/10 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/40'
              }`}
              title={n.description || ''}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(n.id, [...ancestors, n.label], asksProduct(n), collectIds(n).slice(1))}
                className="sr-only"
              />
              <span
                className={`shrink-0 w-[18px] h-[18px] rounded-[6px] border flex items-center justify-center transition-colors ${
                  checked ? 'bg-indigo-500 border-indigo-500' : 'border-zinc-600'
                }`}
              >
                {checked && <CheckIcon className="text-white" style={{ width: 11, height: 11 }} />}
              </span>
              {n.label}
            </label>
            {followUp && <div className="pl-[26px]">{followUp}</div>}
          </div>
        );
      })}
    </div>
  );
}

export default function NpsCallingClient() {
  // Overview tab's date-scope filter (Today/Yesterday/7 Days/30 Days/Custom) - same shape as
  // RTO/NDR's own. getDateBounds is a getter (not the values themselves), same "temporal dead
  // zone" reasoning as useCallingSession's own comment: dateScope/customDateFrom/customDateTo
  // are declared further down this component, but nothing actually CALLS this closure until a
  // later effect, by which point this render pass has already run every line below and the
  // state exists.
  const session = useCallingSession(PROCESS_KEY, {
    getDateBounds: () => scopeToDateBounds(dateScope, customDateFrom, customDateTo),
  });
  const {
    googleUser, sessionIsAdmin, invitedProcessKeys, processPermsLoaded,
    processAgents, isProcessAdmin, saveProcessAgent, savingAgentEmail,
    inviteAgent, invitingAgent,
    setStatusForAgent, showToast, serverPresence,
  } = session;

  const hours = useBusinessHours(PROCESS_KEY, { userRole: session.userRole, isProcessAdmin, showToast });
  const defaultQuota = useDefaultQuota(PROCESS_KEY, { userRole: session.userRole, isProcessAdmin, showToast });
  const leadOrder = useLeadOrder(PROCESS_KEY, { userRole: session.userRole, isProcessAdmin, showToast });
  const dateRange = useDateRange(PROCESS_KEY, { userRole: session.userRole, isProcessAdmin, showToast });
  // Which tree the Admin Panel's Disposition List editor is currently showing/editing - null
  // (Delivery, today's shared tree) or 'product'. Independent of any ticket's own lead_type;
  // an admin picks this explicitly to configure either tree.
  const [adminDispLeadType, setAdminDispLeadType] = useState(null);
  const disp = useProcessDispositions(PROCESS_KEY, { googleUser, showToast, leadType: adminDispLeadType, strict: true });

  useEffect(() => {
    document.documentElement.className = 'light';
    document.body.className = 'font-sans antialiased min-h-screen theme-light';
  }, []);

  const canAdminTab = sessionIsAdmin || isProcessAdmin;
  const [tab, setTab] = useState('fresh');
  useEffect(() => {
    if ((tab === 'admin' || tab === 'predicted') && !canAdminTab) setTab('fresh');
  }, [tab, canAdminTab]);
  // Overview tab's date-scope filter, persisted per-browser like RTO's own (rto_date_scope)
  // under its own key so the two pages don't stomp each other's last-picked scope.
  const [dateScope, setDateScope] = useState(() => localStorage.getItem('nps_calling_date_scope') || 'ALL_TIME');
  const [customDateFrom, setCustomDateFrom] = useState(() => localStorage.getItem('nps_calling_custom_date_from') || '');
  const [customDateTo, setCustomDateTo] = useState(() => localStorage.getItem('nps_calling_custom_date_to') || '');

  // Time-of-Day Distribution table's own two filters (below the Agent Performance Summary) -
  // local to that one table, not the page-wide date-scope filter above. No 'converted' metric
  // option (unlike RTO's) - NPS-Calling has no order/conversion concept, just Connected/Non
  // Connected dispositions.
  const [heatmapMetric, setHeatmapMetric] = useState(() => localStorage.getItem('nps_calling_heatmap_metric') || 'dialled');
  const [heatmapIntervalMinutes, setHeatmapIntervalMinutes] = useState(() => Number(localStorage.getItem('nps_calling_heatmap_interval')) || 30);
  // Server-side (MySQL CLS_NPS_calling via getDetractorTimeOfDay), not computed from
  // allTickets/tickets - same "the client can't see everything, and doesn't need to re-derive
  // what MySQL can already aggregate" reasoning as RTO's own timeOfDay state, just simpler (see
  // getDetractorTimeOfDay's own comment for why). Fetched at 15-minute grain with both metrics
  // per bucket, so changing either dropdown above is then a pure re-render, not a refetch.
  const [timeOfDay, setTimeOfDay] = useState({ buckets: [], loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    const { dateFrom, dateTo } = scopeToDateBounds(dateScope, customDateFrom, customDateTo);
    const qs = new URLSearchParams();
    if (dateFrom) qs.set('dateFrom', dateFrom);
    if (dateTo) qs.set('dateTo', dateTo);
    setTimeOfDay((prev) => ({ ...prev, loading: true }));
    fetch(`/api/report/data/detractor-timeofday?${qs}`)
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || `HTTP ${r.status}`)))))
      .then((d) => { if (!cancelled) setTimeOfDay({ buckets: d.buckets || [], loading: false, error: null }); })
      .catch((e) => { if (!cancelled) setTimeOfDay({ buckets: [], loading: false, error: e.message || 'Could not load' }); });
    return () => { cancelled = true; };
  }, [dateScope, customDateFrom, customDateTo]);

  const [rosterStatusFilter, setRosterStatusFilter] = useState('All');
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [allLeadsSearch, setAllLeadsSearch] = useState('');
  // Agent picker is multi-select (an admin comparing two agents' pending piles shouldn't have to
  // look at them one at a time) - empty array means unrestricted, the same thing the old single
  // 'ALL' value meant. Holds DISPLAY LABELS, not emails: MultiSelectDropdown stores its option
  // strings as its value, so allLeadsAgentEmails below expands them back (same collapse-on-pick/
  // expand-on-use convention DE_TAB_LABELS documents in DeliveryEscalationClient.js).
  const [allLeadsAgentFilter, setAllLeadsAgentFilter] = useState([]);
  // One brand per lead (nps_delivery/nps_product both carry it), so unlike the agent picker this
  // is a plain one-of, with the same 'ALL' sentinel the status filter below already uses.
  const [allLeadsBrandFilter, setAllLeadsBrandFilter] = useState('ALL');
  // Defaults to DISPOSED, not ALL - the tab is literally labelled "All Leads (Disposed)" and its
  // count badge only counts disposed tickets, so showing Pending rows under it by default
  // contradicted both the label and the badge.
  const [allLeadsStatusFilter, setAllLeadsStatusFilter] = useState('DISPOSED');
  // Disposed-date range for the All Leads (Disposed) tab's CSV export - blank means unbounded on
  // that side. Only meaningful there (Fresh Leads has no disposed_at yet), gated the same way the
  // status filter already is (showStatusFilter).
  const [allLeadsDisposedFrom, setAllLeadsDisposedFrom] = useState('');
  const [allLeadsDisposedTo, setAllLeadsDisposedTo] = useState('');
  // Read-only "what did the agent write" detail for one disposed lead - separate from
  // detailTkt/openDispose (the editable Dispose modal) since this never lets an admin change
  // anything, just see it.
  const [viewTicket, setViewTicket] = useState(null);
  // Next to Assign preview (admin/process-admin only) - fetched once on first visit to that tab,
  // not eagerly alongside allTickets, since it's a rarely-opened peek rather than core workflow.
  const [predictedLeads, setPredictedLeads] = useState(null);

  // My tickets: everything CLS_NPS_calling holds for this agent, undisposed and disposed alike -
  // split client-side (queue vs disposed) rather than two separate fetches, since one agent's
  // own row count is small.
  const [tickets, setTickets] = useState([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const [lastSync, setLastSync] = useState('—');
  const fetchMyTickets = useCallback(async () => {
    setTicketsLoading(true);
    try {
      const r = await fetch('/api/detractor/tickets');
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setTickets(d.tickets || []);
        setLastSync(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      } else {
        showToast(`⚠️ ${d.error || 'Could not load tickets'}`);
      }
    } catch (e) {
      showToast(`⚠️ ${e.message}`);
    } finally {
      setTicketsLoading(false);
    }
  }, [showToast]);
  useEffect(() => { if (googleUser?.email) fetchMyTickets(); }, [googleUser, fetchMyTickets]);

  // Every agent's tickets, admin/process-admin only - Overview tab's roster-wide counts.
  const [allTickets, setAllTickets] = useState(null);
  const fetchAllTickets = useCallback(async () => {
    try {
      const r = await fetch('/api/detractor/tickets?scope=all');
      const d = await r.json().catch(() => ({}));
      if (r.ok) setAllTickets(d.tickets || []);
    } catch (e) { /* Overview falls back to own tickets below - not worth a toast */ }
  }, []);
  useEffect(() => { if (canAdminTab) fetchAllTickets(); }, [canAdminTab, fetchAllTickets]);

  // Team Roster's own "Product" filter (per-agent detractor_product_filter) picks from this -
  // every product rated for EITHER brand in the last 3 months (see getDetractorProductNames'
  // own comment), unlike the dispose modal's own catalogProductNames below which is scoped to
  // one ticket's own brand - an admin setting a roster-wide filter has no single ticket's brand
  // to scope it to, so this fetches both combined (no brand param = unrestricted, same
  // convention the endpoint's own brand filter already uses for "unset").
  const [rosterProductCatalog, setRosterProductCatalog] = useState([]);
  useEffect(() => {
    if (!canAdminTab) return;
    let cancelled = false;
    fetch('/api/report/data/detractor-product-names')
      .then((r) => (r.ok ? r.json() : { productNames: [] }))
      .then((d) => { if (!cancelled) setRosterProductCatalog(d.productNames || []); })
      .catch(() => { if (!cancelled) setRosterProductCatalog([]); });
    return () => { cancelled = true; };
  }, [canAdminTab]);

  // Manual stopgap for the going-Online auto-fill trigger - lets an admin/process admin fill
  // one agent's queue on demand (fills to that agent's own quota minus current load, same
  // default the real trigger uses) instead of waiting for the agent to toggle their own status.
  const [assigningEmail, setAssigningEmail] = useState('');
  const manualAssignNow = async (email) => {
    setAssigningEmail(email);
    try {
      const r = await fetch('/api/admin/calling-assign-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processKey: PROCESS_KEY, email }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        showToast(`⚠️ ${d.error || 'Could not assign leads'}`);
        return;
      }
      showToast(d.claimed > 0 ? `✅ Assigned ${d.claimed} lead(s)` : 'Pool is empty for this agent right now - nothing to assign');
      fetchAllTickets();
    } catch (e) {
      showToast(`⚠️ ${e.message || 'Could not assign leads'}`);
    } finally {
      setAssigningEmail('');
    }
  };

  const handleInviteSubmit = async () => {
    const email = inviteEmail.trim();
    if (!email) { showToast('⚠️ Email is required'); return; }
    const result = await inviteAgent(email, inviteName.trim());
    if (result.ok) {
      setInviteEmail('');
      setInviteName('');
      setShowInviteForm(false);
    }
  };

  // A FAILED pool read must never render as "nothing waiting" - the two are opposite problems
  // (a broken query/permission to fix now, vs. a genuinely empty pool to wait out) and this tab
  // used to show the identical empty-state line for both, which is exactly what hid a real
  // server error behind a plausible-looking zero while thousands of unclaimed leads sat in
  // nps_delivery/nps_product. The error text comes from the endpoint itself
  // (api/detractor/tickets.js), so whatever actually broke is on screen instead of in a log
  // nobody is watching.
  const [predictedError, setPredictedError] = useState('');
  useEffect(() => {
    if (tab !== 'predicted' || !canAdminTab || predictedLeads !== null) return;
    (async () => {
      try {
        const r = await fetch('/api/detractor/tickets?scope=unassigned');
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setPredictedError(d.error || `Could not load the pool (HTTP ${r.status})`);
          setPredictedLeads([]);
          return;
        }
        setPredictedError('');
        setPredictedLeads(d.leads || []);
      } catch (e) {
        setPredictedError(e.message || 'Could not reach the server');
        setPredictedLeads([]);
      }
    })();
  }, [tab, canAdminTab, predictedLeads]);


  // Disposition modal state
  const [detailTkt, setDetailTkt] = useState(null);
  // Which reasons are checked, id -> {id, path} (path = the leaf's own breadcrumb of ancestor
  // labels + itself, e.g. ['Delivery Related', 'Late delivery']) - a Map so toggling one leaf is
  // an O(1) add/delete regardless of how many categories/reasons are in the tree. Rebuilt as a
  // fresh Map on every toggle so React sees a new reference and re-renders.
  const [selectedReasons, setSelectedReasons] = useState(new Map());
  const [dispRemarks, setDispRemarks] = useState('');
  const [attempt, setAttempt] = useState(1);
  const [dispSaving, setDispSaving] = useState(false);
  // Top-level branch pick ('' | 'Yes' | 'No') - gates the whole checklist below. Agent must
  // click Connected/Non Connected first; nothing renders until then, so the full ~30-reason
  // tree never shows before a branch is chosen.
  const [branchChoice, setBranchChoice] = useState('');
  // Which of this lead's own product_name_list the agent says goes with EACH checked "Product
  // Related Issue" reason - reason id -> string[], since different products on the same order
  // can each have a different problem (one flat per-call product list would lose that).
  const [productsByReason, setProductsByReason] = useState({});

  const openDispose = (t) => {
    setDetailTkt(t);
    setSelectedReasons(new Map());
    setDispRemarks(t.agent_remarks || '');
    setAttempt(t.attempt || 1);
    setBranchChoice('');
    setProductsByReason({});
  };
  const closeDispose = () => setDetailTkt(null);
  const pickBranch = (choice) => {
    setBranchChoice(choice);
    setSelectedReasons(new Map());
  };

  // Leaves only ever come from whichever branch pickBranch chose (branchNode is filtered to it),
  // so cross-branch cleanup here is just a belt-and-suspenders guard.
  // needsProduct comes from DispositionChecklist's asksProduct (this node or an ancestor has
  // triggersProductFollowup set, AND it's the end of the line - the one actually shown the
  // picker) - computed there, not re-derived here, since only that recursion still has the actual
  // node objects; selectedReasons only ever stores the flat {id, path} breadcrumb, plus this bit,
  // for every later reader (affectedProductsText, saveDisposition) to use without re-walking.
  //
  // clearIds is everything this pick invalidates, also computed there for the same reason: the
  // node's own descendants (answers to a follow-up the agent is now taking back), plus, in a
  // one-of group, the sibling being replaced and ITS descendants. Without it an answer that
  // scrolled off screen when its parent changed would still be saved.
  const toggleReason = (id, path, needsProduct = false, clearIds = []) => {
    const willCheck = !selectedReasons.has(id);
    setSelectedReasons((prev) => {
      const next = new Map(prev);
      for (const clearId of clearIds) next.delete(clearId);
      if (!willCheck) {
        next.delete(id);
        return next;
      }
      const branch = path[0];
      for (const [existingId, existing] of next) {
        if (existing.path[0] !== branch) next.delete(existingId);
      }
      next.set(id, { id, path, needsProduct });
      return next;
    });
    // Pre-fill "which product?" with this ticket's own known product(s) - via
    // product_name_list, already split into productOptions below - the moment a reason needing
    // the follow-up is checked, instead of starting blank and making the agent re-pick what the
    // data already told us. Only sets the initial default (guarded by `!prev[id]`) - never
    // overwrites a pick the agent already made, e.g. re-checking after an uncheck, or a second
    // reason under the same category with its own products.
    if (willCheck && productOptions.length > 0 && needsProduct) {
      setProductsByReason((prev) => (prev[id] ? prev : { ...prev, [id]: productOptions }));
    }
  };

  // Every checked leaf's breadcrumb, joined "Category > Reason", one per selection - lets one
  // call carry several reasons (even across categories) in the single `disposition` column
  // rather than forcing the whole call into one final label.
  //
  // An answer stays checked while its own follow-up is being answered (that's what keeps the
  // follow-up on screen), so drop any breadcrumb another selection already continues - "… > Yes"
  // says nothing next to "… > Yes > Query not resolved", and the saved string would otherwise
  // carry both.
  const joinedDisposition = useMemo(() => {
    const paths = Array.from(selectedReasons.values()).map((r) => r.path.join(' > '));
    return paths.filter((p) => !paths.some((other) => other.startsWith(`${p} > `))).join('; ');
  }, [selectedReasons]);

  // branchChoice is the picked top-level branch; the checklist below only ever shows that
  // branch's categories (nothing renders until it's picked), so every selected leaf's path[0]
  // already agrees with it.
  const derivedConnected = branchChoice;

  // Independent of the admin's own disp/adminDispLeadType above - an agent (who never sees the
  // Admin Panel) still needs whichever tree matches the TICKET they're disposing, not whatever
  // the admin toggle above happens to be set to.
  const dispForTicket = useProcessDispositions(PROCESS_KEY, {
    googleUser, showToast,
    leadType: detailTkt && detailTkt.lead_type === 'product' ? 'product' : null,
  });

  // The branch the segmented control picked. Its CHILDREN are what the checklist draws - drawing
  // the branch node itself made the agent pick "Connected" a second time, in a card, right after
  // picking it in the toggle above.
  const branchNode = useMemo(() => {
    if (!branchChoice) return null;
    const label = branchChoice === 'Yes' ? 'Connected' : 'Non Connected';
    return (dispForTicket.processDispositions || []).find((n) => n.label === label) || null;
  }, [dispForTicket.processDispositions, branchChoice]);

  // This lead's own product_name_list ("Product A, Product B") split into options - only ever
  // meaningful once a reason with the product follow-up (triggersProductFollowup, see
  // DispositionChecklist) has been checked.
  const productOptions = useMemo(() => {
    const list = detailTkt && detailTkt.product_name_list;
    return hasValue(list) ? splitProductNameList(list) : [];
  }, [detailTkt]);
  const setReasonProducts = (reasonId, products) => {
    setProductsByReason((prev) => ({ ...prev, [reasonId]: products }));
  };

  // Fallback catalog for the "which product?" follow-up when productOptions above is empty -
  // every product this ticket's own brand has actually been rated on in the last 3 months (see
  // getDetractorProductNames's own comment), most-rated first. Fetched lazily: only when a
  // dispose modal is actually open AND its ticket's own product list came up empty, so the
  // common case (a ticket that already knows its product) never makes this call at all.
  const [catalogProductNames, setCatalogProductNames] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  useEffect(() => {
    if (!detailTkt || productOptions.length > 0) { setCatalogProductNames([]); return; }
    let cancelled = false;
    setCatalogLoading(true);
    fetch(`/api/report/data/detractor-product-names?brand=${encodeURIComponent(detailTkt.brand || '')}`)
      .then((r) => (r.ok ? r.json() : { productNames: [] }))
      .then((d) => { if (!cancelled) setCatalogProductNames(d.productNames || []); })
      .catch(() => { if (!cancelled) setCatalogProductNames([]); })
      .finally(() => { if (!cancelled) setCatalogLoading(false); });
    return () => { cancelled = true; };
  }, [detailTkt, productOptions]);

  // "<reason label>: <products>; <reason label>: <products>" - one entry per checked reason
  // that needed the product follow-up (r.needsProduct, set by toggleReason from
  // DispositionChecklist's own ancestor walk) and actually has products picked (a reason with
  // none contributes nothing, same "only what's relevant" shape used throughout this file).
  const affectedProductsText = useMemo(
    () => Array.from(selectedReasons.values())
      .filter((r) => r.needsProduct)
      .map((r) => {
        const products = productsByReason[r.id];
        return products && products.length ? `${r.path[r.path.length - 1]}: ${products.join(', ')}` : null;
      })
      .filter(Boolean)
      .join('; '),
    [selectedReasons, productsByReason],
  );

  const saveDisposition = async () => {
    if (!detailTkt || !selectedReasons.size || !derivedConnected) return;
    setDispSaving(true);
    try {
      const r = await fetch('/api/detractor/lead-assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'dispose',
          responseId: detailTkt.response_id,
          disposition: joinedDisposition,
          agentRemarks: dispRemarks,
          connected: derivedConnected,
          attempt: Number(attempt) || 1,
          affectedProducts: affectedProductsText,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(`⚠️ ${d.error || 'Could not save disposition'}`); return; }
      const patch = (t) => (
        t.response_id === detailTkt.response_id
          ? {
              ...t, disposed_at: new Date().toISOString(), disposition: joinedDisposition, agent_remarks: dispRemarks,
              connected: derivedConnected, attempt,
              affected_products: affectedProductsText || t.affected_products,
            }
          : t
      );
      setTickets((prev) => prev.map(patch));
      // detailTkt can be someone else's lead (admin/process-admin override via the All/Fresh
      // Leads tables, not just this agent's own tickets array) - patch allTickets too so the
      // admin table reflects it without a refetch.
      setAllTickets((prev) => (prev ? prev.map(patch) : prev));
      // Self-refill (api/detractor/lead-assignment.js): 0 or 1 freshly-claimed lead for THIS
      // agent, replacing the one just disposed. Absent for an admin-override dispose onto
      // someone else's lead - see that endpoint's own isOverrideOntoSomeoneElse check.
      if (Array.isArray(d.assignedLeads) && d.assignedLeads.length) {
        const now = new Date().toISOString();
        setTickets((prev) => [
          ...d.assignedLeads.map((lead) => ({ ...lead, agent_email: googleUser?.email, assigned_at: now })),
          ...prev,
        ]);
        showToast(`Disposition saved. New lead: ${d.assignedLeads[0].customer_name || d.assignedLeads[0].response_id}`);
      } else {
        showToast('Disposition saved');
      }
      closeDispose();
    } catch (e) {
      showToast(`⚠️ ${e.message}`);
    } finally {
      setDispSaving(false);
    }
  };

  const pendingTickets = tickets.filter(isUndisposed);
  const disposedTickets = tickets.filter((t) => !isUndisposed(t));
  // Fresh/All counts read allTickets (every agent) for admin/process-admin, own tickets
  // otherwise - same admin-sees-everyone/agent-sees-own split RTO's Fresh Leads and All Leads
  // tabs already use.
  const freshCount = canAdminTab ? (allTickets || []).filter(isUndisposed).length : pendingTickets.length;
  const allDisposedCount = canAdminTab ? (allTickets || []).filter((t) => !isUndisposed(t)).length : disposedTickets.length;

  // Overview tab's date-scope selector - same options as RTO/NDR's own.
  const dateOptions = [
    { value: 'ALL_TIME', label: 'All time' },
    { value: 'TODAY', label: 'Today' },
    { value: 'YESTERDAY', label: 'Yesterday' },
    { value: '7_DAYS', label: 'Last 7 days' },
    { value: '30_DAYS', label: 'Last 30 days' },
    { value: 'CUSTOM', label: 'Custom range' },
  ];
  // Time-of-Day Distribution table's own two filters - no 'converted' option (unlike RTO's),
  // NPS-Calling has no order/conversion concept.
  const heatmapIntervalOptions = [
    { value: 15, label: '15 min' },
    { value: 30, label: '30 min' },
    { value: 60, label: '1 hour' },
  ];
  const heatmapMetricOptions = [
    { value: 'dialled', label: 'Total Dialled' },
    { value: 'connected', label: 'Total Connected' },
  ];

  const tabsList = [
    { key: 'overview', label: canAdminTab ? 'Overview (Agents Data)' : 'My Overview', count: (processAgents || []).length },
    { key: 'all', label: 'All Leads (Disposed)', count: allDisposedCount },
    { key: 'fresh', label: 'Fresh Leads (Assigned)', count: freshCount },
    ...(canAdminTab ? [{ key: 'admin', label: 'Admin Panel & Roster', count: (processAgents || []).length }] : []),
    ...(canAdminTab ? [{ key: 'predicted', label: 'Next to Assign', count: predictedLeads ? predictedLeads.length : 0 }] : []),
  ];

  const hasAccess = sessionIsAdmin || !invitedProcessKeys || invitedProcessKeys.includes(PROCESS_KEY);

  // Per-agent Assigned/Disposed/Connect % for the roster table below - computed from allTickets
  // (every CLS_NPS_calling row, admin-only fetch) rather than a dedicated endpoint, same as RTO's
  // own agentMetrics does against its Sheet-derived tickets array.
  const agentMetrics = useMemo(() => {
    const source = allTickets || [];
    return (processAgents || []).map((a) => {
      const mine = source.filter((t) => (t.agent_email || '').toLowerCase() === a.email.toLowerCase());
      const disposed = mine.filter((t) => t.disposed_at);
      const connected = disposed.filter((t) => t.connected === 'Yes');
      return {
        ...a,
        assigned: mine.length,
        disposed: disposed.length,
        connectRate: disposed.length ? Math.round((connected.length / disposed.length) * 100) : 0,
      };
    });
  }, [processAgents, allTickets]);
  const visibleAgentMetrics = agentMetrics.filter((a) => rosterStatusFilter === 'All' || a.status === rosterStatusFilter);

  // Overview tab's per-agent KPI/table/heatmap/export data - the date-scoped counterpart to
  // agentMetrics above (which stays all-time, for the Admin Panel roster table). Unlike RTO,
  // an NPS-Calling ticket carries its own real assigned_at/disposed_at timestamps directly (no
  // separate Calling Date/Order Date sheet column, and no Postgres leadDates lookup needed), so
  // one metrics pass covers both the KPI tiles and the Agent Performance Summary table, where
  // RTO needs two (computeAgentMetrics vs computeTableAgentMetrics) to reconcile its sheet-
  // derived scope against Postgres's real assignedAt/disposedAt scope.
  const overviewMetrics = useMemo(() => {
    const assignedDateInScope = (t) => isLeadDateInScope(t.assigned_at, dateScope, customDateFrom, customDateTo);
    const disposedDateInScope = (t) => isLeadDateInScope(t.disposed_at, dateScope, customDateFrom, customDateTo);

    const computeAgentMetrics = (ag, ticketSource) => {
      const email = ag.email.toLowerCase();
      const mineAll = ticketSource.filter((t) => (t.agent_email || '').toLowerCase() === email);

      const assigned = mineAll.filter(assignedDateInScope);
      const pending = assigned.filter((t) => !t.disposed_at);
      const disposed = mineAll.filter((t) => t.disposed_at && disposedDateInScope(t));
      const connected = disposed.filter((t) => t.connected === 'Yes');

      // First/Last Called At: average time-of-day of the first/last disposition across the
      // range's active days - an average across different calendar days can only be expressed
      // as a time-of-day, not one specific instant (same reasoning as RTO's own).
      const firstCallMinutesByDay = new Map();
      const lastCallMinutesByDay = new Map();
      for (const t of disposed) {
        const at = new Date(t.disposed_at);
        if (Number.isNaN(at.getTime())) continue;
        const dayKey = istDayKeyClient(at);
        const mins = istMinutesSinceMidnightClient(at);
        if (!firstCallMinutesByDay.has(dayKey) || mins < firstCallMinutesByDay.get(dayKey)) firstCallMinutesByDay.set(dayKey, mins);
        if (!lastCallMinutesByDay.has(dayKey) || mins > lastCallMinutesByDay.get(dayKey)) lastCallMinutesByDay.set(dayKey, mins);
      }
      const firstCallMinutesList = [...firstCallMinutesByDay.values()];
      const firstCalledAtMinutes = firstCallMinutesList.length
        ? Math.round(firstCallMinutesList.reduce((s, m) => s + m, 0) / firstCallMinutesList.length) : null;
      const lastCallMinutesList = [...lastCallMinutesByDay.values()];
      const lastCalledAtMinutes = lastCallMinutesList.length
        ? Math.round(lastCallMinutesList.reduce((s, m) => s + m, 0) / lastCallMinutesList.length) : null;

      // FRT: disposed_at - assigned_at, averaged in minutes over disposed tickets with both
      // timestamps. Negative gaps (bad data - disposed logged before assigned) are dropped
      // rather than dragging the average down.
      const frtMinutesList = [];
      for (const t of disposed) {
        if (!t.assigned_at || !t.disposed_at) continue;
        const diffMin = (new Date(t.disposed_at).getTime() - new Date(t.assigned_at).getTime()) / 60000;
        if (diffMin >= 0) frtMinutesList.push(diffMin);
      }
      const frtMinutes = frtMinutesList.length
        ? Math.round(frtMinutesList.reduce((s, m) => s + m, 0) / frtMinutesList.length) : null;

      // Avg Time to Dispose: gap between one disposition and this agent's next, same-day only.
      const { averageMinutes: disposeGapMinutes } = disposalGaps(disposed.map((t) => ({
        key: t.response_id, disposedAt: t.disposed_at,
      })));

      return {
        ...ag,
        assigned: assigned.length,
        disposed: disposed.length,
        pending: pending.length,
        connected: connected.length,
        connectRate: disposed.length ? Math.round((connected.length / disposed.length) * 100) : 0,
        firstCalledAtMinutes, lastCalledAtMinutes, frtMinutes, disposeGapMinutes,
      };
    };

    // A plain Agent's Overview must only ever reflect their own performance - ticketSource
    // stays `tickets` (their own fetch; allTickets is admin/process-admin only and stays null
    // for them), and the roster below is trimmed to just their own entry.
    const myEmailLower = (googleUser?.email || '').toLowerCase();
    const roster = canAdminTab
      ? (processAgents || [])
      : (processAgents || []).filter((a) => a.email.toLowerCase() === myEmailLower);
    const ticketSource = canAdminTab ? (allTickets || []) : tickets;
    const agentRows = roster.map((ag) => computeAgentMetrics(ag, ticketSource));
    const summaryRows = agentRows.filter((am) => am.assigned > 0 || am.disposed > 0);

    // Team Total row - team aggregates per column, not a per-agent row total (this table mixes
    // counts, percentages and times). Logged In At/Total Break Time/Total Busy Time average
    // across agents that have a real value (null excluded, not treated as 0), same as RTO's own.
    const summaryTotals = summaryRows.reduce((acc, am) => {
      acc.assigned += am.assigned; acc.disposed += am.disposed; acc.pending += am.pending; acc.connected += am.connected;
      return acc;
    }, { assigned: 0, disposed: 0, pending: 0, connected: 0 });
    const summaryLoggedInList = summaryRows.map((am) => serverPresence[am.email.toLowerCase()]?.loggedInMinutes).filter((m) => m !== null && m !== undefined);
    const summaryBreakList = summaryRows.map((am) => serverPresence[am.email.toLowerCase()]?.breakMinutes).filter((m) => m !== null && m !== undefined);
    const summaryBusyList = summaryRows.map((am) => serverPresence[am.email.toLowerCase()]?.busyMinutes).filter((m) => m !== null && m !== undefined);
    const summaryAvgLoggedIn = summaryLoggedInList.length ? Math.round(summaryLoggedInList.reduce((s, m) => s + m, 0) / summaryLoggedInList.length) : null;
    const summaryAvgBreak = summaryBreakList.length ? Math.round(summaryBreakList.reduce((s, m) => s + m, 0) / summaryBreakList.length) : 0;
    const summaryAvgBusy = summaryBusyList.length ? Math.round(summaryBusyList.reduce((s, m) => s + m, 0) / summaryBusyList.length) : 0;
    const summaryFrtList = summaryRows.map((am) => am.frtMinutes).filter((m) => m !== null && m !== undefined);
    const summaryAvgFrt = summaryFrtList.length ? Math.round(summaryFrtList.reduce((s, m) => s + m, 0) / summaryFrtList.length) : null;
    // Mean of the agents' own averages, not a pooled recount - the Team Total row answers "what
    // does a typical agent look like", same reasoning as RTO's own.
    const summaryGapList = summaryRows.map((am) => am.disposeGapMinutes).filter((m) => m !== null && m !== undefined);
    const summaryAvgDisposeGap = summaryGapList.length ? Math.round(summaryGapList.reduce((s, m) => s + m, 0) / summaryGapList.length) : null;

    const totalAssigned = summaryTotals.assigned;
    const totalDisposed = summaryTotals.disposed;
    const totalPending = summaryTotals.pending;
    const avgConnectRate = totalDisposed > 0 ? Math.round((summaryTotals.connected / totalDisposed) * 100) : 0;
    const onlineCount = roster.filter((a) => a.status === 'Online').length;

    const escapeCsv = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const downloadBlob = (lines, filename) => {
      const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    // Same Blob/anchor download pattern as RTO's downloadAgentSummaryCsv - exports exactly
    // what's on screen, one row per agent plus the Team Total row.
    function downloadAgentSummaryCsv() {
      const header = ['Agent Name', 'Total Leads Assigned', 'Total Disposed', 'First Called At', 'Last Called At', 'FRT', 'Avg Time to Dispose', 'Total Connected', 'Connected %', 'Logged In At', 'Total Break Time', 'Total Busy Time'];
      const rowFor = (am) => {
        const presence = serverPresence[am.email.toLowerCase()];
        return [
          am.name, am.assigned, am.disposed, formatTimeOfDay(am.firstCalledAtMinutes), formatTimeOfDay(am.lastCalledAtMinutes),
          formatFrt(am.frtMinutes), formatFrt(am.disposeGapMinutes), am.connected, formatPct(am.connected, am.disposed),
          formatTimeOfDay(presence?.loggedInMinutes), formatBreakMinutes(presence?.breakMinutes), formatBreakMinutes(presence?.busyMinutes),
        ];
      };
      const lines = [header.map(escapeCsv).join(',')];
      summaryRows.forEach((am) => lines.push(rowFor(am).map(escapeCsv).join(',')));
      if (summaryRows.length > 0) {
        lines.push([
          'Team Total', summaryTotals.assigned, summaryTotals.disposed, '—', '—', formatFrt(summaryAvgFrt), formatFrt(summaryAvgDisposeGap),
          summaryTotals.connected, formatPct(summaryTotals.connected, summaryTotals.disposed),
          formatTimeOfDay(summaryAvgLoggedIn), formatBreakMinutes(summaryAvgBreak), formatBreakMinutes(summaryAvgBusy),
        ].map(escapeCsv).join(','));
      }
      downloadBlob(lines, `nps-calling-agent-summary-${new Date().toISOString().slice(0, 10)}.csv`);
    }

    // Raw per-lead detail behind the summary table above - one row per ticket rather than
    // aggregated per agent, so an admin can audit exactly which leads make up a summary number.
    // Union of assignedDateInScope OR (disposed AND disposedDateInScope), same as RTO's own
    // rawLeadDetailsList, so a lead assigned yesterday and disposed today appears once, not
    // double counted.
    const rawLeadDetailsList = roster.flatMap((ag) => {
      const email = ag.email.toLowerCase();
      const mine = ticketSource.filter((t) => (t.agent_email || '').toLowerCase() === email
        && (assignedDateInScope(t) || (t.disposed_at && disposedDateInScope(t))));
      const { gapByKey } = disposalGaps(mine.map((t) => ({ key: t.response_id, disposedAt: t.disposed_at })));
      return mine.map((t) => {
        const frtMinutes = (t.assigned_at && t.disposed_at)
          ? (new Date(t.disposed_at).getTime() - new Date(t.assigned_at).getTime()) / 60000 : null;
        return {
          responseId: t.response_id,
          customerName: t.customer_name || '',
          agentName: ag.name,
          assignedAt: t.assigned_at || '',
          disposedAt: t.disposed_at || '',
          frtMinutes: (frtMinutes !== null && frtMinutes >= 0) ? Math.round(frtMinutes) : null,
          disposeGapMinutes: (() => {
            const g = gapByKey.get(t.response_id);
            return (g === null || g === undefined) ? null : Math.round(g);
          })(),
          connected: t.connected || '',
          disposition: t.disposition || '',
        };
      });
    }).sort((a, b) => a.agentName.localeCompare(b.agentName) || String(a.responseId).localeCompare(String(b.responseId)));

    function downloadRawLeadDetailsCsv() {
      const formatCsvDate = (iso) => iso
        ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
        : '';
      const lines = [
        ['Response ID', 'Customer', 'Agent Name', 'Assigned Date', 'Disposed Date', 'FRT', 'Time Since Prev Disposal', 'Connected', 'Disposition'].join(','),
        ...rawLeadDetailsList.map((r) => [
          r.responseId, r.customerName, r.agentName, formatCsvDate(r.assignedAt), formatCsvDate(r.disposedAt),
          formatFrt(r.frtMinutes), formatFrt(r.disposeGapMinutes), r.connected, r.disposition,
        ].map(escapeCsv).join(',')),
      ];
      downloadBlob(lines, `nps-calling-raw-leads-${new Date().toISOString().slice(0, 10)}.csv`);
    }

    // Time-of-Day Distribution - server buckets (timeOfDay above), not computed from
    // allTickets/tickets: same "Dialled" (every disposed lead)/"Connected" (narrows to
    // connected='Yes') shape as RTO's own, just without a 'converted' option.
    const bucketsByAgent = new Map();
    for (const b of timeOfDay.buckets) {
      if (!bucketsByAgent.has(b.agentEmail)) bucketsByAgent.set(b.agentEmail, []);
      bucketsByAgent.get(b.agentEmail).push(b);
    }
    const heatmapAgentData = roster.map((ag) => {
      const email = ag.email.toLowerCase();
      const bucketCounts = new Map();
      for (const b of bucketsByAgent.get(email) || []) {
        const value = b[heatmapMetric] || 0;
        if (!value) continue;
        const bucketIndex = Math.floor((b.bucket15 * 15) / heatmapIntervalMinutes);
        bucketCounts.set(bucketIndex, (bucketCounts.get(bucketIndex) || 0) + value);
      }
      return { ...ag, bucketCounts };
    });
    const visibleHeatmapAgentData = heatmapAgentData.filter((a) => a.bucketCounts.size > 0);
    // Columns span only the buckets SOMEONE actually has activity in, not a fixed full-day grid.
    const allHeatmapBucketIndexes = visibleHeatmapAgentData.flatMap((a) => [...a.bucketCounts.keys()]);
    const heatmapBucketIndexes = [];
    if (allHeatmapBucketIndexes.length) {
      const minBucket = Math.min(...allHeatmapBucketIndexes);
      const maxBucket = Math.max(...allHeatmapBucketIndexes);
      for (let i = minBucket; i <= maxBucket; i++) heatmapBucketIndexes.push(i);
    }
    // Global min/max across every rendered cell (Total row/column excluded) drives the
    // "lower = more highlighted" tint - amber-500, matching this table's Total Break Time accent.
    const allHeatmapValues = visibleHeatmapAgentData.flatMap((a) => heatmapBucketIndexes.map((idx) => a.bucketCounts.get(idx) || 0));
    const heatmapMin = allHeatmapValues.length ? Math.min(...allHeatmapValues) : 0;
    const heatmapMax = allHeatmapValues.length ? Math.max(...allHeatmapValues) : 0;
    function heatmapCellStyle(value) {
      if (heatmapMax <= heatmapMin) return undefined;
      const t = (heatmapMax - value) / (heatmapMax - heatmapMin);
      return { backgroundColor: `rgba(245, 158, 11, ${(t * 0.4).toFixed(2)})` };
    }

    return {
      roster, summaryRows, summaryTotals, summaryAvgFrt, summaryAvgDisposeGap, summaryAvgLoggedIn, summaryAvgBreak, summaryAvgBusy,
      downloadAgentSummaryCsv, rawLeadDetailsList, downloadRawLeadDetailsCsv,
      totalAssigned, totalDisposed, totalPending, avgConnectRate, onlineCount,
      visibleHeatmapAgentData, heatmapBucketIndexes, heatmapCellStyle,
      timeOfDayState: { loading: timeOfDay.loading, error: timeOfDay.error },
    };
  }, [allTickets, tickets, processAgents, canAdminTab, googleUser, dateScope, customDateFrom, customDateTo, serverPresence, timeOfDay, heatmapMetric, heatmapIntervalMinutes]);

  // Best-effort "who would get this" for the Next to Assign preview below - real assignment is
  // demand-pulled (an agent's own going-Online/heartbeat/self-refill claims whatever their own
  // brand+lead-type filter allows, oldest first), not a batch plan against this exact list, so
  // this is a live eligibility snapshot, not a guarantee: an eligible agent's own claim can beat
  // this page's next 30s poll, and TWO eligible agents can both be shown for one lead when only
  // one will actually win it. currentLoad mirrors getDetractorLoadByAgent (mine minus disposed,
  // i.e. still-undisposed) and quota falls back the same way getDetractorQuotaAndLoad does
  // (per-agent override -> admin default -> FALLBACK_QUOTA) so this agrees with the server's
  // own quota-load check in topUpDetractorAgent, not just the roster table's own quota column.
  const eligibleAgentsFor = useCallback((lead) => {
    if (!lead) return [];
    return agentMetrics.filter((a) => {
      if (a.status !== 'Online') return false;
      const quota = a.maxQuota != null ? a.maxQuota : (defaultQuota.quota != null ? defaultQuota.quota : FALLBACK_QUOTA);
      const currentLoad = a.assigned - a.disposed;
      if (currentLoad >= quota) return false;
      if (a.detractorBrandFilter && a.detractorBrandFilter !== lead.brand) return false;
      if (a.detractorLeadTypeFilter && a.detractorLeadTypeFilter !== lead.lead_type) return false;
      // detractorProductFilter is NOT checked here - lead (from getUnassignedDetractorLeads)
      // only carries has_product (a boolean), not the actual product name(s), so there's
      // nothing to match an agent's filter against without a second round trip. This preview
      // is already documented as approximate (see this function's own comment above); an agent
      // with a product filter set may show here as eligible for a lead their filter would
      // actually exclude server-side.
      return true;
    });
  }, [agentMetrics, defaultQuota.quota]);

  const renderTicketCard = (t, { showDisposeButton }) => (
    <div key={t.response_id} className="bg-zinc-900/90 border border-zinc-800/90 rounded-xl p-4 space-y-2.5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-[14px] font-bold text-zinc-100 truncate">{t.customer_name || 'Unknown customer'}</p>
          <p className="text-[12px] text-zinc-500 flex items-center gap-1.5 flex-wrap">
            {t.customer_phone && <span className="flex items-center gap-1"><PhoneIcon /> {t.customer_phone}</span>}
            {t.customer_email && <span>{t.customer_email}</span>}
            {t.brand && <span className="uppercase">{t.brand}</span>}
            {t.channel_order_id && <span>Order {t.channel_order_id}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30">
            NPS {t.nps_score ?? '—'} · {t.nps_category}
          </span>
          {hasValue(t.sentiment) && (
            <span
              title={t.sentiment_reason || ''}
              className={`px-2 py-0.5 rounded-md text-[11px] font-bold border ${SENTIMENT_BADGE[t.sentiment] || SENTIMENT_BADGE.Neutral}`}
            >
              {t.sentiment}
            </span>
          )}
          {t.submitted_date && (
            <span className="text-[11px] text-zinc-500 flex items-center gap-1"><CalendarIcon /> {t.submitted_date}</span>
          )}
        </div>
      </div>

      <TicketSurveyDetails t={t} />

      {(t.address_city || t.address_state || t.address_pincode) && (
        <p className="text-[11px] text-zinc-500">{[t.address_city, t.address_state, t.address_pincode].filter(Boolean).join(', ')}</p>
      )}

      {t.disposed_at ? (
        <div className="text-[12px] text-emerald-400 space-y-0.5">
          {(t.disposition || '').split(';').map((s) => s.trim()).filter(Boolean).map((line, i) => (
            <p key={i} className="flex items-center gap-1.5"><CheckIcon /> {line}</p>
          ))}
          <p className="text-zinc-500">Connected: {t.connected || '—'} · Attempt {t.attempt ?? '—'}</p>
          {hasValue(t.affected_products) && <p className="text-zinc-500">Product(s): {t.affected_products}</p>}
        </div>
      ) : showDisposeButton ? (
        <button
          type="button"
          onClick={() => openDispose(t)}
          className="mt-1 px-3 py-1.5 rounded-lg text-[12px] font-bold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
        >
          Call &amp; Dispose
        </button>
      ) : null}
    </div>
  );

  // Agent picker options, and the map back to the email each one filters on. The label is the
  // agent's name, but two agents really can share one - and a colliding label would silently make
  // one of them unfilterable - so a repeated name carries its email to tell them apart.
  const agentLabelToEmail = useMemo(() => {
    const perName = new Map();
    for (const a of processAgents || []) {
      const name = a.name || a.email;
      perName.set(name, (perName.get(name) || 0) + 1);
    }
    return new Map((processAgents || []).map((a) => {
      const name = a.name || a.email;
      return [perName.get(name) > 1 ? `${name} (${a.email})` : name, a.email];
    }));
  }, [processAgents]);
  const agentFilterOptions = useMemo(() => Array.from(agentLabelToEmail.keys()), [agentLabelToEmail]);
  // A label with no agent behind it (the roster changed under a pick that's still in state) falls
  // back to itself, so it simply matches nothing rather than widening the filter.
  const allLeadsAgentEmails = useMemo(
    () => allLeadsAgentFilter.map((label) => String(agentLabelToEmail.get(label) || label).toLowerCase()),
    [allLeadsAgentFilter, agentLabelToEmail],
  );

  // Shared by the All Leads and Fresh Leads admin tabs - same search/agent/brand filter controls
  // and table shape, just a different base list (every ticket vs undisposed-only) and whether the
  // status filter makes sense (Fresh Leads is already fixed to undisposed).
  const renderAdminLeadsTable = (source, { title, subtitle, showStatusFilter }) => {
    const search = allLeadsSearch.trim().toLowerCase();
    // Whichever brands this tab's own rows actually carry - a fixed list would offer brands that
    // can't match anything here, and the leads only ever come from the brands already on screen.
    const brandOptions = Array.from(new Set((source || []).map((t) => t.brand).filter(Boolean))).sort();
    const filtered = (source || []).filter((t) => {
      if (allLeadsAgentEmails.length && !allLeadsAgentEmails.includes((t.agent_email || '').toLowerCase())) return false;
      if (allLeadsBrandFilter !== 'ALL' && (t.brand || '') !== allLeadsBrandFilter) return false;
      if (showStatusFilter) {
        if (allLeadsStatusFilter === 'DISPOSED' && isUndisposed(t)) return false;
        if (allLeadsStatusFilter === 'PENDING' && !isUndisposed(t)) return false;
      }
      // Disposed-date range only applies where disposed_at is meaningful (showStatusFilter -
      // the All Leads tab); Fresh Leads' rows have no disposed_at yet, so this is a no-op there
      // even if the state happened to be set from a prior tab visit.
      if (showStatusFilter && (allLeadsDisposedFrom || allLeadsDisposedTo)) {
        if (!t.disposed_at) return false;
        const disposedDay = new Date(t.disposed_at).toISOString().slice(0, 10);
        if (allLeadsDisposedFrom && disposedDay < allLeadsDisposedFrom) return false;
        if (allLeadsDisposedTo && disposedDay > allLeadsDisposedTo) return false;
      }
      if (!search) return true;
      return [t.customer_name, t.channel_order_id, t.agent_email, t.customer_phone]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(search));
    });

    // Client-side only, same pattern as RTO Calling's CSV exports (RtoCrmClient.js) - no server
    // round trip, exports exactly what's currently on screen (search/agent/brand/status/date
    // filters already applied to `filtered`).
    const escapeCsv = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const exportCsv = () => {
      const lines = [
        ['Customer', 'Brand', 'Order ID', 'Type', 'NPS Score', 'NPS Category', 'Agent', 'Submitted', 'Assigned',
         'Disposed', 'Status', 'Disposition', 'Agent Remarks', 'Connected', 'Attempt', 'Affected Products'].join(','),
        ...filtered.map((t) => [
          t.customer_name, t.brand, t.channel_order_id, t.lead_type === 'product' ? 'Product' : 'Delivery',
          t.nps_score, t.nps_category, t.agent_email,
          t.submitted_date, t.assigned_at ? new Date(t.assigned_at).toLocaleString() : '',
          t.disposed_at ? new Date(t.disposed_at).toLocaleString() : '',
          t.disposed_at ? 'Disposed' : 'Pending', t.disposition, t.agent_remarks, t.connected, t.attempt,
          t.affected_products,
        ].map(escapeCsv).join(',')),
      ];
      const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nps-calling-leads-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    return (
      <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between flex-wrap gap-3 p-4 pb-3">
          <div>
            <h3 className="text-[15px] font-bold text-zinc-100">{title}</h3>
            <p className="text-[12px] text-zinc-500 mt-0.5">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                value={allLeadsSearch}
                onChange={(e) => setAllLeadsSearch(e.target.value)}
                placeholder="Search customer, order, agent…"
                className="w-52 pl-8 pr-3 py-1.5 text-[12px] bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <CustomSelect
              value={allLeadsBrandFilter}
              onChange={setAllLeadsBrandFilter}
              options={[
                { value: 'ALL', label: 'All Brands' },
                ...brandOptions.map((b) => ({ value: b, label: b })),
              ]}
            />
            <MultiSelectDropdown
              value={allLeadsAgentFilter}
              onChange={setAllLeadsAgentFilter}
              options={agentFilterOptions}
              placeholder="All Agents"
              itemNoun="agents"
              searchable
            />
            {showStatusFilter && (
              <CustomSelect
                value={allLeadsStatusFilter}
                onChange={setAllLeadsStatusFilter}
                options={[
                  { value: 'ALL', label: 'All Statuses' },
                  { value: 'DISPOSED', label: 'Disposed' },
                  { value: 'PENDING', label: 'Pending' },
                ]}
              />
            )}
            {showStatusFilter && (
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={allLeadsDisposedFrom}
                  onChange={(e) => setAllLeadsDisposedFrom(e.target.value)}
                  title="Disposed from"
                  className="h-8 px-2 rounded-lg bg-zinc-900 border border-zinc-800 text-[12px] text-zinc-300 focus:outline-none focus:border-indigo-500"
                />
                <span className="text-zinc-600 text-[12px]">–</span>
                <input
                  type="date"
                  value={allLeadsDisposedTo}
                  onChange={(e) => setAllLeadsDisposedTo(e.target.value)}
                  title="Disposed to"
                  className="h-8 px-2 rounded-lg bg-zinc-900 border border-zinc-800 text-[12px] text-zinc-300 focus:outline-none focus:border-indigo-500"
                />
              </div>
            )}
            <button
              type="button"
              onClick={exportCsv}
              disabled={!filtered.length}
              title="Export the leads currently shown below to CSV"
              className="h-8 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-[12px] font-bold transition-colors disabled:opacity-40"
            >
              ⬇ Export CSV
            </button>
          </div>
        </div>

        {source == null
          ? <p className="text-[12px] text-zinc-500 px-4 pb-4">Loading…</p>
          : !filtered.length
            ? <p className="text-[12px] text-zinc-500 px-4 pb-4">No leads match.</p>
            : (
              <div className="overflow-x-auto custom-scroll">
                <table className="w-full text-[13px]">
                  <thead><tr className="border-b border-zinc-800/80 text-zinc-500">
                    <th className="py-2.5 px-4 text-left font-medium">Customer</th>
                    <th className="py-2.5 px-4 text-left font-medium">Order</th>
                    <th className="py-2.5 px-4 text-left font-medium" title="Which detractor pool this lead was claimed from - nps_delivery or nps_product">Type</th>
                    <th className="py-2.5 px-4 text-left font-medium">NPS</th>
                    <th className="py-2.5 px-4 text-left font-medium">Sentiment</th>
                    <th className="py-2.5 px-4 text-left font-medium">Agent</th>
                    <th className="py-2.5 px-4 text-left font-medium">Submitted</th>
                    <th className="py-2.5 px-4 text-left font-medium">Assigned</th>
                    <th className="py-2.5 px-4 text-left font-medium">Status</th>
                    <th className="py-2.5 px-4 text-left font-medium">Disposition</th>
                    <th className="py-2.5 px-4 text-center font-medium">Connected</th>
                    <th className="py-2.5 px-4 text-center font-medium">Action</th>
                  </tr></thead>
                  <tbody className="divide-y divide-zinc-800/50">
                    {filtered.map((t) => (
                      <tr key={t.response_id} className="hover:bg-zinc-900/40 transition-colors">
                        <td className="py-2.5 px-4 text-zinc-200">{t.customer_name || '—'}</td>
                        <td className="py-2.5 px-4 text-zinc-400">{[t.brand, t.channel_order_id].filter(Boolean).join(' · ') || '—'}</td>
                        <td className="py-2.5 px-4">
                          <span className={`px-2 py-0.5 rounded-md text-[11px] font-bold border ${
                            t.lead_type === 'product' ? 'bg-violet-950/50 text-violet-300 border-violet-800/50' : 'bg-sky-950/50 text-sky-300 border-sky-800/50'
                          }`}>
                            {t.lead_type === 'product' ? 'Product' : 'Delivery'}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-zinc-400">{t.nps_score ?? '—'} · {t.nps_category || '—'}</td>
                        <td className="py-2.5 px-4">
                          {hasValue(t.sentiment)
                            ? <span title={t.sentiment_reason || ''} className={`px-2 py-0.5 rounded-md text-[11px] font-bold border ${SENTIMENT_BADGE[t.sentiment] || SENTIMENT_BADGE.Neutral}`}>{t.sentiment}</span>
                            : <span className="text-zinc-600">—</span>}
                        </td>
                        <td className="py-2.5 px-4 text-zinc-400 font-mono text-[11px]">{t.agent_email || '—'}</td>
                        <td className="py-2.5 px-4 text-zinc-500 text-[11px]">{t.submitted_date || '—'}</td>
                        <td className="py-2.5 px-4 text-zinc-500 text-[11px]">{t.assigned_at ? new Date(t.assigned_at).toLocaleString() : '—'}</td>
                        <td className="py-2.5 px-4">
                          {t.disposed_at
                            ? <span className="text-emerald-400 font-semibold">Disposed</span>
                            : <span className="text-amber-400 font-semibold">Pending</span>}
                        </td>
                        <td className="py-2.5 px-4 text-zinc-400 max-w-[220px] truncate" title={t.disposition || ''}>{t.disposition || '—'}</td>
                        <td className="py-2.5 px-4 text-center text-zinc-400">{t.connected || '—'}</td>
                        <td className="py-2.5 px-4 text-center">
                          {t.disposed_at ? (
                            <button
                              type="button"
                              onClick={() => setViewTicket(t)}
                              title="View what the agent recorded"
                              className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition-colors"
                            >
                              View
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openDispose(t)}
                              title="Dispose on this agent's behalf"
                              className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                            >
                              Dispose
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </div>
    );
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#09090b]">
      <CallingShell
        logoLabel="NPS"
        title="NPS-Calling Agent Portal"
        lastSync={lastSync}
        syncing={ticketsLoading}
        syncError={null}
        onSync={() => fetchMyTickets()}
        session={session}
      />

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-5 py-5 space-y-5">
        {processPermsLoaded && !hasAccess && (
          <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-8 shadow-xl backdrop-blur-md">
            <div className="max-w-2xl space-y-3">
              <h2 className="text-lg font-bold text-zinc-100">No access to NPS-Calling</h2>
              <p className="text-[13px] text-zinc-400 leading-relaxed">
                This account hasn&apos;t been invited to NPS-Calling yet. An admin can grant it
                from Admin &rarr; Permissions by ticking NPS-Calling under the Calling card.
              </p>
              <p className="text-[13px] text-zinc-500">Signed in as {googleUser?.email || 'an unknown account'}.</p>
            </div>
          </div>
        )}

        {hasAccess && (
          <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-1.5 shadow-xl backdrop-blur-md">
            <nav className="flex items-center gap-1 overflow-x-auto no-scrollbar w-full mb-1.5">
              {tabsList.map((t) => {
                const isActive = tab === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => setTab(t.key)}
                    className={`relative px-4 py-2 rounded-xl text-[13px] font-bold whitespace-nowrap transition-all flex items-center gap-2.5 ${
                      isActive
                        ? 'text-white bg-indigo-600 shadow-md shadow-indigo-950/50 border border-indigo-500/40'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 border border-transparent'
                    }`}
                  >
                    {t.key === 'overview' && <span className="text-indigo-300">📊</span>}
                    {t.key === 'all' && <span className="text-sky-300">📦</span>}
                    {t.key === 'fresh' && <span className="text-amber-300">⚡</span>}
                    {t.key === 'admin' && <span className="text-emerald-300">🛡️</span>}
                    {t.key === 'predicted' && <span className="text-violet-300">🔮</span>}
                    <span>{t.label}</span>
                    <span className={`text-[11px] tabular-nums px-2 py-0.5 rounded-md font-mono font-bold ${
                      isActive ? 'text-white bg-indigo-950/80 border border-indigo-400/30' : 'text-zinc-400 bg-zinc-800 border border-zinc-700/50'
                    }`}>
                      {t.count.toLocaleString('en-IN')}
                    </span>
                  </button>
                );
              })}
            </nav>

            <div className="p-3">
              {tab === 'fresh' && (
                canAdminTab ? (
                  renderAdminLeadsTable((allTickets || []).filter(isUndisposed), {
                    title: 'Fresh Leads',
                    subtitle: 'Assigned but not yet disposed, across every agent.',
                    showStatusFilter: false,
                  })
                ) : (
                  <div className="space-y-3">
                    {ticketsLoading && <p className="text-[13px] text-zinc-500">Loading…</p>}
                    {!ticketsLoading && !pendingTickets.length && (
                      <p className="text-[13px] text-zinc-500">No leads in your queue. Go Online to get assigned automatically.</p>
                    )}
                    {pendingTickets.map((t) => renderTicketCard(t, { showDisposeButton: true }))}
                  </div>
                )
              )}

              {tab === 'all' && (
                canAdminTab ? (
                  renderAdminLeadsTable(allTickets, {
                    title: 'All Leads',
                    subtitle: "Every agent's tickets, admin/process-admin view.",
                    showStatusFilter: true,
                  })
                ) : (
                  <div className="space-y-3">
                    {!disposedTickets.length && <p className="text-[13px] text-zinc-500">Nothing disposed yet.</p>}
                    {disposedTickets.map((t) => renderTicketCard(t, { showDisposeButton: false }))}
                  </div>
                )
              )}

              {tab === 'predicted' && canAdminTab && (
                <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl overflow-hidden p-4 space-y-3">
                  <div>
                    <h3 className="text-[15px] font-bold text-zinc-100 tracking-tight">Next to Assign</h3>
                    <p className="text-[12px] text-zinc-500 mt-0.5">
                      The next leads waiting to be pulled, oldest first. Read-only - nobody is
                      assigned yet.
                    </p>
                  </div>
                  {predictedLeads === null && !predictedError && <p className="text-[12px] text-zinc-500">Loading…</p>}
                  {/* Distinct from the empty-state line below on purpose - see the fetch's own comment. */}
                  {!!predictedError && (
                    <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2">
                      <p className="text-[12px] font-bold text-red-300">Could not read the unassigned pool</p>
                      <p className="text-[12px] text-red-200/80 mt-0.5 break-words">{predictedError}</p>
                      <p className="text-[11px] text-red-200/60 mt-1">
                        This is a server error, not an empty pool - leads may well be waiting.
                      </p>
                    </div>
                  )}
                  {predictedLeads && !predictedLeads.length && !predictedError && (
                    <p className="text-[12px] text-zinc-500">No unassigned detractor leads waiting right now.</p>
                  )}
                  {predictedLeads && !!predictedLeads.length && (
                    <div className="overflow-x-auto custom-scroll">
                      <table className="w-full text-[13px]">
                        <thead><tr className="border-b border-zinc-800/80 text-zinc-500">
                          <th className="py-2.5 px-4 text-left font-medium">#</th>
                          <th className="py-2.5 px-4 text-left font-medium">Customer</th>
                          <th className="py-2.5 px-4 text-left font-medium">Order</th>
                          <th className="py-2.5 px-4 text-left font-medium">NPS</th>
                          <th className="py-2.5 px-4 text-left font-medium">Category</th>
                          <th className="py-2.5 px-4 text-left font-medium">Submitted</th>
                          <th className="py-2.5 px-4 text-left font-medium" title="Best-effort - whichever eligible agent claims first actually gets it">Likely Agent</th>
                        </tr></thead>
                        <tbody className="divide-y divide-zinc-800/50">
                          {predictedLeads.map((t, i) => {
                            const eligible = eligibleAgentsFor(t);
                            return (
                            <tr key={t.response_id} className="hover:bg-zinc-900/40 transition-colors">
                              <td className="py-2.5 px-4 text-zinc-500">{i + 1}</td>
                              <td className="py-2.5 px-4 text-zinc-200">{t.customer_name || '—'}</td>
                              <td className="py-2.5 px-4 text-zinc-400">{[t.brand, t.channel_order_id].filter(Boolean).join(' · ') || '—'}</td>
                              <td className="py-2.5 px-4 text-zinc-400">{t.nps_score ?? '—'}</td>
                              <td className="py-2.5 px-4 text-zinc-400">{[t.category, t.sub_category].filter(Boolean).join(' · ') || '—'}</td>
                              <td className="py-2.5 px-4 text-zinc-500 text-[11px]">{t.submitted_date || '—'}</td>
                              <td className="py-2.5 px-4 text-[12px]">
                                {eligible.length
                                  ? <span className="text-emerald-400">{eligible.map((a) => a.name).join(', ')}</span>
                                  : <span className="text-zinc-600">— none online</span>}
                              </td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {tab === 'overview' && (() => {
                const {
                  roster, summaryRows, summaryTotals, summaryAvgFrt, summaryAvgDisposeGap,
                  summaryAvgLoggedIn, summaryAvgBreak, summaryAvgBusy,
                  downloadAgentSummaryCsv, rawLeadDetailsList, downloadRawLeadDetailsCsv,
                  totalAssigned, totalDisposed, totalPending, avgConnectRate, onlineCount,
                  visibleHeatmapAgentData, heatmapBucketIndexes, heatmapCellStyle, timeOfDayState,
                } = overviewMetrics;
                return (
                  <div className="space-y-5 animate-fadeIn">
                    {/* Header */}
                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <div>
                        <h3 className="text-[15px] font-bold text-zinc-100 tracking-tight">
                          {canAdminTab ? '📊 Overview & Agents Performance' : '📊 My Overview'}
                        </h3>
                        <p className="text-[12px] text-zinc-500 mt-0.5">
                          {canAdminTab
                            ? `Real-time metrics and per-agent performance across all ${roster.length} team members.`
                            : 'Your own real-time metrics and performance, scoped to the date range below.'}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <CustomSelect
                          value={dateScope}
                          onChange={(val) => { setDateScope(val); localStorage.setItem('nps_calling_date_scope', val); }}
                          options={dateOptions}
                          icon={CalendarIcon}
                          placeholder="Date Scope"
                        />
                        {dateScope === 'CUSTOM' && (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="date"
                              value={customDateFrom}
                              onChange={(e) => { setCustomDateFrom(e.target.value); localStorage.setItem('nps_calling_custom_date_from', e.target.value); }}
                              className="h-8 px-2 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[12px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                            />
                            <span className="text-zinc-500 text-[12px]">to</span>
                            <input
                              type="date"
                              value={customDateTo}
                              onChange={(e) => { setCustomDateTo(e.target.value); localStorage.setItem('nps_calling_custom_date_to', e.target.value); }}
                              className="h-8 px-2 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[12px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                            />
                          </div>
                        )}
                        {canAdminTab && (
                          <span className="text-[12px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-2.5 py-1 rounded-lg font-mono flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 pulse-dot"></span>
                            {onlineCount}/{roster.length} Active
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Top KPI Stat Cards */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { label: 'Total Assigned', value: totalAssigned, icon: '📋' },
                        { label: 'Total Disposed', value: totalDisposed, icon: '✅' },
                        { label: 'Pending Queue', value: totalPending, icon: '⏳' },
                        { label: 'Avg Connect Rate', value: `${avgConnectRate}%`, icon: '📞' },
                      ].map((s) => (
                        <div key={s.label} className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-4">
                          <p className="text-[11px] text-zinc-500 font-semibold uppercase flex items-center gap-1.5">
                            <span>{s.icon}</span>{s.label}
                          </p>
                          <p className="text-2xl font-extrabold text-zinc-100 tracking-tight">{s.value}</p>
                        </div>
                      ))}
                    </div>

                    {/* Agent Performance Summary */}
                    <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-5 space-y-4">
                      <div className="flex items-start justify-between flex-wrap gap-3">
                        <div>
                          <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">📋 Agent Performance Summary</h3>
                          <p className="text-[12px] text-zinc-500 mt-0.5">
                            Follows the date range above - Total Leads Assigned uses when the lead was actually handed to
                            the agent; Total Disposed/Connected use when the agent actually resolved it, so a lead assigned
                            yesterday and disposed today counts toward today's Disposed/Connected numbers even though it
                            doesn't count toward today's Assigned ones. First/Last Called At are the average time-of-day of
                            the first/last disposition each active day; Logged In At/Total Break Time/Total Busy Time follow
                            the same active-day average. FRT is the average time between a lead's assignment and its
                            disposition; Avg Time to Dispose is the average gap between one disposition and the agent's
                            next, same-day only.
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={downloadRawLeadDetailsCsv}
                            disabled={rawLeadDetailsList.length === 0}
                            title="One row per lead behind this table - Response ID, Customer, Agent Name, Assigned Date, Disposed Date, FRT, Time Since Prev Disposal, Connected, Disposition"
                            className="h-8 px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-[13px] font-medium text-zinc-200 transition-all shadow-xs disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <DownloadIcon />
                            Raw Lead Details
                          </button>
                          <button
                            type="button"
                            onClick={downloadAgentSummaryCsv}
                            disabled={summaryRows.length === 0}
                            title="This table exactly as shown, one row per agent plus Team Total"
                            className="h-8 px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-[13px] font-medium text-zinc-200 transition-all shadow-xs disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <DownloadIcon />
                            Export CSV
                          </button>
                        </div>
                      </div>
                      <div className="overflow-x-auto custom-scroll">
                        <table className="w-full min-w-[820px] text-[12.5px] border-collapse">
                          <thead>
                            <tr className="text-left text-zinc-500 uppercase text-[10px] tracking-wider border-b border-zinc-800">
                              <th className="py-2 pr-3 font-bold sticky left-0 z-10 bg-zinc-900 border-r border-zinc-800">Agent Name</th>
                              <th className="py-2 px-3 font-bold text-right" title="Scoped by the lead's real assignment date">Total Leads Assigned</th>
                              <th className="py-2 px-3 font-bold text-right" title="Scoped by the lead's real disposed date">Total Disposed</th>
                              <th className="py-2 px-3 font-bold" title="Average time-of-day of the first disposition across the range's active days">First Called At</th>
                              <th className="py-2 px-3 font-bold" title="Average time-of-day of the last disposition across the range's active days">Last Called At</th>
                              <th className="py-2 px-3 font-bold" title="Average time between a lead's assignment and its disposition, across disposed leads with both timestamps">FRT</th>
                              <th className="py-2 px-3 font-bold" title="Average gap between one disposition and the agent's next, same-day only">Avg Time to Dispose</th>
                              <th className="py-2 px-3 font-bold text-right" title="Scoped by the lead's real disposed date">Total Connected</th>
                              <th className="py-2 px-3 font-bold text-right" title="Total Connected / Total Disposed">Connected %</th>
                              <th className="py-2 px-3 font-bold" title="Average first-login time-of-day across the range's active days">Logged In At</th>
                              <th className="py-2 px-3 font-bold" title="Average break minutes per active day in the range">Total Break Time</th>
                              <th className="py-2 pl-3 font-bold" title="Average Busy (on-call) minutes per active day in the range">Total Busy Time</th>
                            </tr>
                          </thead>
                          <tbody>
                            {summaryRows.map((am) => {
                              const presence = serverPresence[am.email.toLowerCase()];
                              return (
                                <tr key={am.email} className="group border-b border-zinc-900 hover:bg-zinc-900/40 transition-colors">
                                  <td className="py-2.5 pr-3 font-semibold text-zinc-200 whitespace-nowrap sticky left-0 z-10 bg-zinc-900 group-hover:bg-zinc-800 border-r border-zinc-800 transition-colors">{am.name}</td>
                                  <td className="py-2.5 px-3 text-right tabular-nums text-zinc-300">{am.assigned}</td>
                                  <td className="py-2.5 px-3 text-right tabular-nums text-zinc-300">{am.disposed}</td>
                                  <td className="py-2.5 px-3 text-zinc-400 font-mono whitespace-nowrap">{formatTimeOfDay(am.firstCalledAtMinutes)}</td>
                                  <td className="py-2.5 px-3 text-zinc-400 font-mono whitespace-nowrap">{formatTimeOfDay(am.lastCalledAtMinutes)}</td>
                                  <td className="py-2.5 px-3 text-zinc-400 font-mono whitespace-nowrap">{formatFrt(am.frtMinutes)}</td>
                                  <td className="py-2.5 px-3 text-zinc-400 font-mono whitespace-nowrap">{formatFrt(am.disposeGapMinutes)}</td>
                                  <td className="py-2.5 px-3 text-right tabular-nums text-emerald-400">{am.connected}</td>
                                  <td className="py-2.5 px-3 text-right tabular-nums text-emerald-400">{formatPct(am.connected, am.disposed)}</td>
                                  <td className="py-2.5 px-3 text-zinc-400 font-mono whitespace-nowrap">{formatTimeOfDay(presence?.loggedInMinutes)}</td>
                                  <td className="py-2.5 px-3 text-amber-400 font-mono whitespace-nowrap">{formatBreakMinutes(presence?.breakMinutes)}</td>
                                  <td className="py-2.5 pl-3 text-rose-400 font-mono whitespace-nowrap">{formatBreakMinutes(presence?.busyMinutes)}</td>
                                </tr>
                              );
                            })}
                            {summaryRows.length > 0 && (
                              <tr className="border-t-2 border-zinc-700 bg-zinc-900/80 font-bold">
                                <td className="py-2.5 pr-3 text-zinc-100 whitespace-nowrap sticky left-0 z-10 bg-zinc-900 border-r border-zinc-800">Team Total</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-zinc-100">{summaryTotals.assigned}</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-zinc-100">{summaryTotals.disposed}</td>
                                <td className="py-2.5 px-3 text-zinc-500">—</td>
                                <td className="py-2.5 px-3 text-zinc-500">—</td>
                                <td className="py-2.5 px-3 text-zinc-300 font-mono whitespace-nowrap" title="Average across disposed leads with both timestamps">{formatFrt(summaryAvgFrt)}</td>
                                <td className="py-2.5 px-3 text-zinc-300 font-mono whitespace-nowrap" title="Mean of each agent's own average gap">{formatFrt(summaryAvgDisposeGap)}</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-emerald-300">{summaryTotals.connected}</td>
                                <td className="py-2.5 px-3 text-right tabular-nums text-emerald-300">{formatPct(summaryTotals.connected, summaryTotals.disposed)}</td>
                                <td className="py-2.5 px-3 text-zinc-300 font-mono whitespace-nowrap" title="Average across agents with a real value">{formatTimeOfDay(summaryAvgLoggedIn)}</td>
                                <td className="py-2.5 px-3 text-amber-300 font-mono whitespace-nowrap" title="Average across agents with a real value">{formatBreakMinutes(summaryAvgBreak)}</td>
                                <td className="py-2.5 pl-3 text-rose-300 font-mono whitespace-nowrap" title="Average across agents with a real value">{formatBreakMinutes(summaryAvgBusy)}</td>
                              </tr>
                            )}
                            {summaryRows.length === 0 && (
                              <tr><td colSpan={12} className="py-6 text-center text-zinc-500">No agents with assigned leads in this date range.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Time-of-Day Distribution */}
                    <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-5 space-y-4">
                      <div className="flex items-center justify-between flex-wrap gap-3">
                        <div>
                          <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">🕐 Time-of-Day Distribution</h3>
                          <p className="text-[12px] text-zinc-500 mt-0.5">
                            Same date range as above, bucketed by time of day - columns span only the buckets with any
                            activity (not a fixed full-day grid). A multi-day range sums every matching day into the same
                            time-of-day bucket. Cell shading is a whole-table scale - the darker the highlight, the lower
                            that count is relative to every other cell currently shown (Total row/column excluded from the
                            scale itself).
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <CustomSelect
                            value={heatmapMetric}
                            onChange={(v) => { setHeatmapMetric(v); localStorage.setItem('nps_calling_heatmap_metric', v); }}
                            options={heatmapMetricOptions}
                          />
                          <CustomSelect
                            value={heatmapIntervalMinutes}
                            onChange={(v) => { setHeatmapIntervalMinutes(v); localStorage.setItem('nps_calling_heatmap_interval', String(v)); }}
                            options={heatmapIntervalOptions}
                          />
                        </div>
                      </div>
                      <div className="overflow-x-auto custom-scroll">
                        <table className="w-full text-[12.5px] border-collapse">
                          <thead>
                            <tr className="text-left text-zinc-500 uppercase text-[10px] tracking-wider border-b border-zinc-800">
                              <th className="py-2 pr-3 font-bold whitespace-nowrap sticky left-0 z-10 bg-zinc-900 border-r border-zinc-800">Agent Name</th>
                              {heatmapBucketIndexes.map((idx) => (
                                <th key={idx} className="py-2 px-3 font-bold text-right whitespace-nowrap">
                                  {formatTimeOfDay(idx * heatmapIntervalMinutes)}
                                </th>
                              ))}
                              <th className="py-2 pl-3 font-bold text-right whitespace-nowrap border-l border-zinc-800">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleHeatmapAgentData.map((a) => {
                              const rowTotal = heatmapBucketIndexes.reduce((s, idx) => s + (a.bucketCounts.get(idx) || 0), 0);
                              return (
                                <tr key={a.email} className="group border-b border-zinc-900 hover:bg-zinc-900/40 transition-colors">
                                  <td className="py-2.5 pr-3 font-semibold text-zinc-200 whitespace-nowrap sticky left-0 z-10 bg-zinc-900 group-hover:bg-zinc-800 border-r border-zinc-800 transition-colors">{a.name}</td>
                                  {heatmapBucketIndexes.map((idx) => {
                                    const value = a.bucketCounts.get(idx) || 0;
                                    return (
                                      <td key={idx} className="py-2.5 px-3 text-right tabular-nums text-zinc-200" style={heatmapCellStyle(value)}>
                                        {value}
                                      </td>
                                    );
                                  })}
                                  <td className="py-2.5 pl-3 text-right tabular-nums text-zinc-100 font-bold border-l border-zinc-800">{rowTotal}</td>
                                </tr>
                              );
                            })}
                            {visibleHeatmapAgentData.length > 0 && (
                              <tr className="border-t-2 border-zinc-700 bg-zinc-900/80 font-bold">
                                <td className="py-2.5 pr-3 text-zinc-100 whitespace-nowrap sticky left-0 z-10 bg-zinc-900 border-r border-zinc-800">Team Total</td>
                                {heatmapBucketIndexes.map((idx) => {
                                  const columnTotal = visibleHeatmapAgentData.reduce((s, a) => s + (a.bucketCounts.get(idx) || 0), 0);
                                  return (
                                    <td key={idx} className="py-2.5 px-3 text-right tabular-nums text-zinc-100">{columnTotal}</td>
                                  );
                                })}
                                <td className="py-2.5 pl-3 text-right tabular-nums text-zinc-100 border-l border-zinc-800">
                                  {visibleHeatmapAgentData.reduce((s, a) => s + heatmapBucketIndexes.reduce((s2, idx) => s2 + (a.bucketCounts.get(idx) || 0), 0), 0)}
                                </td>
                              </tr>
                            )}
                            {visibleHeatmapAgentData.length === 0 && (
                              <tr>
                                <td colSpan={heatmapBucketIndexes.length + 2} className="py-6 text-center text-zinc-500">
                                  {timeOfDayState.loading
                                    ? 'Loading…'
                                    : timeOfDayState.error
                                      ? `Could not load time-of-day data: ${timeOfDayState.error}`
                                      : `No ${heatmapMetricOptions.find((o) => o.value === heatmapMetric)?.label.toLowerCase()} activity in this date range.`}
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {tab === 'admin' && canAdminTab && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-[15px] font-bold text-zinc-100 tracking-tight">Admin Panel & Roster</h3>
                    <p className="text-[12px] text-zinc-500 mt-0.5">Calling hours, default quota, dispositions, and the agent roster below.</p>
                  </div>
                  <CallingHoursCard processKey={PROCESS_KEY} processLabel="NPS-Calling" hours={hours} />
                  <DefaultQuotaCard processLabel="NPS-Calling" fallback={FALLBACK_QUOTA} quota={defaultQuota} />
                  <LeadOrderCard processLabel="NPS-Calling" order={leadOrder} />
                  <DateRangeCard processLabel="NPS-Calling" fallbackDays={30} range={dateRange} />
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[12px] text-zinc-400 font-semibold">Editing tree:</span>
                    <button
                      type="button"
                      onClick={() => setAdminDispLeadType(null)}
                      className={`px-3 py-1 rounded-lg text-[12px] font-bold border ${
                        adminDispLeadType == null ? 'bg-indigo-600 border-indigo-500 text-white' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                      }`}
                    >
                      Delivery
                    </button>
                    <button
                      type="button"
                      onClick={() => setAdminDispLeadType('product')}
                      className={`px-3 py-1 rounded-lg text-[12px] font-bold border ${
                        adminDispLeadType === 'product' ? 'bg-indigo-600 border-indigo-500 text-white' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                      }`}
                    >
                      Product
                    </button>
                  </div>
                  <ProcessDispositionsCard
                    processLabel={`NPS-Calling${adminDispLeadType === 'product' ? ' · Product' : ''}`}
                    disp={disp}
                    allowInputTypeControl
                    allowProductFollowupControl
                    helpText={`The dispose modal only shows reasons nested under two top-level options named exactly "Connected" and "Non Connected" - anything added outside those two is saved but never shown to an agent. Add "Connected" and "Non Connected" as top-level options first, then expand each to add its own reasons as children. Tick "Ask which product?" on a category (e.g. "Product Related Issue") to prompt for a product whenever the agent checks any reason under it - flip it back on if you ever rename that category.`}
                  />

                  <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between flex-wrap gap-3 p-4 pb-3">
                      <div>
                        <h3 className="text-[15px] font-bold text-zinc-100">Team Roster</h3>
                        <p className="text-[12px] text-zinc-500 mt-0.5">
                          Manage agent status and lead capacity limits. Invite someone below, or
                          they'll appear here automatically once granted NPS-Calling under
                          Admin → Permissions.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <CustomSelect
                          value={rosterStatusFilter}
                          onChange={setRosterStatusFilter}
                          options={ROSTER_STATUS_OPTIONS}
                          placeholder="Filter by status"
                        />
                        <button
                          type="button"
                          onClick={() => setShowInviteForm((v) => !v)}
                          className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-[12px] font-bold transition-all shadow-xs shrink-0"
                          title="Invite someone straight onto this process's roster"
                        >
                          ➕ Invite Agent
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (!window.confirm(`Mark all ${agentMetrics.length} agents Offline? This updates each agent's live status on the server.`)) return;
                            agentMetrics.forEach((a) => setStatusForAgent(a.email, 'Offline', a.email));
                            showToast('⚪ All agents marked Offline');
                          }}
                          className="px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-[12px] font-bold transition-all shadow-xs shrink-0"
                          title="Set every agent's status to Offline (syncs to the server for each row)"
                        >
                          ⚪ Mark All Offline
                        </button>
                      </div>
                    </div>

                    {showInviteForm && (
                      <div className="flex items-end flex-wrap gap-2 px-4 pb-3">
                        <input
                          type="email"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          placeholder="agent@mcaffeine.com"
                          className="min-w-[220px] flex-1 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-100 text-[12px] placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
                        />
                        <input
                          type="text"
                          value={inviteName}
                          onChange={(e) => setInviteName(e.target.value)}
                          placeholder="Name (optional)"
                          className="min-w-[160px] flex-1 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-100 text-[12px] placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
                        />
                        <button
                          type="button"
                          onClick={handleInviteSubmit}
                          disabled={invitingAgent}
                          className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[12px] font-bold transition-all disabled:opacity-40 shrink-0"
                        >
                          {invitingAgent ? 'Inviting…' : 'Send Invite'}
                        </button>
                      </div>
                    )}

                    {!agentMetrics.length && (
                      <p className="text-[12px] text-zinc-500 px-4 pb-4">No agents invited yet - use "Invite Agent" above, or grant access from Admin → Permissions.</p>
                    )}

                    {!!agentMetrics.length && (
                      <div className="overflow-x-auto custom-scroll">
                        <table className="w-full text-[13px]">
                          <thead><tr className="border-b border-zinc-800/80 text-zinc-500">
                            <th className="py-3 px-4 text-left font-medium">Agent</th>
                            <th className="py-3 px-4 text-left font-medium">Status</th>
                            <th className="py-3 px-4 text-center font-medium">Assigned</th>
                            <th className="py-3 px-4 text-center font-medium">Disposed</th>
                            <th className="py-3 px-4 text-center font-medium">Connect %</th>
                            <th className="py-3 px-4 text-left font-medium">Quota</th>
                            <th className="py-3 px-4 text-left font-medium" title="Brand restriction for lead assignment - All Brands means no restriction">Brand</th>
                            <th className="py-3 px-4 text-left font-medium" title="Which pool this agent is auto-assigned from - Both means the shared mixed-pool default">Process</th>
                            <th className="py-3 px-4 text-left font-medium" title="Restricts assignment to leads about these specific product(s) - checked against both Delivery NPS orders and Product NPS responses. Empty means no restriction.">Product</th>
                            <th className="py-3 px-4 text-center font-medium" title="Can manage this process's roster and calling hours - nothing else">Process admin</th>
                            <th className="py-3 px-4 text-center font-medium" title="Manually fill this agent's queue now instead of waiting for them to go Online">Assign</th>
                          </tr></thead>
                          <tbody className="divide-y divide-zinc-800/50">
                            {visibleAgentMetrics.map((a) => (
                              <tr key={a.email} className="hover:bg-zinc-800/30 transition-colors">
                                <td className="py-3 px-4">
                                  <div className="flex items-center gap-2.5">
                                    <div className="relative">
                                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-600 to-violet-700 flex items-center justify-center text-white font-bold text-[11px] shadow">
                                        {a.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)}
                                      </div>
                                      <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-zinc-900 ${a.status === 'Online' ? 'bg-emerald-500' : a.status === 'Busy' ? 'bg-amber-400' : a.status === 'OnCall' ? 'bg-rose-500' : 'bg-zinc-500'}`}></span>
                                    </div>
                                    <div className="min-w-0">
                                      <p className="font-semibold text-zinc-100 truncate">{a.name}</p>
                                      <p className="text-zinc-500 text-[11px] font-mono truncate">{a.email}</p>
                                    </div>
                                  </div>
                                </td>
                                <td className="py-3 px-4">
                                  <CustomSelect
                                    value={a.status}
                                    onChange={(val) => setStatusForAgent(a.email, val, a.email)}
                                    options={STATUS_OPTIONS}
                                  />
                                </td>
                                <td className="py-3 px-4 text-center font-bold text-zinc-100 tabular-nums">{a.assigned}</td>
                                <td className="py-3 px-4 text-center font-bold text-indigo-400 tabular-nums">{a.disposed}</td>
                                <td className="py-3 px-4 text-center font-bold text-emerald-400 tabular-nums">{a.connectRate}%</td>
                                <td className="py-3 px-4">
                                  <CustomSelect
                                    value={a.maxQuota ?? ''}
                                    onChange={(val) => saveProcessAgent(a.email, { maxQuota: val === '' ? null : +val })}
                                    options={[
                                      { value: '', label: 'Default (15)' },
                                      { value: 5, label: '5 leads' },
                                      { value: 10, label: '10 leads' },
                                      { value: 15, label: '15 leads' },
                                      { value: 20, label: '20 leads' },
                                      { value: 30, label: '30 leads' },
                                    ]}
                                  />
                                </td>
                                <td className="py-3 px-4">
                                  <CustomSelect
                                    value={a.detractorBrandFilter || ''}
                                    onChange={(val) => saveProcessAgent(a.email, { detractorBrandFilter: val })}
                                    options={[
                                      { value: '', label: 'All Brands' },
                                      { value: 'Mcaffeine', label: 'Mcaffeine' },
                                      { value: 'Hyphen', label: 'Hyphen' },
                                    ]}
                                  />
                                </td>
                                <td className="py-3 px-4">
                                  <CustomSelect
                                    value={a.detractorLeadTypeFilter || ''}
                                    onChange={(val) => saveProcessAgent(a.email, { detractorLeadTypeFilter: val })}
                                    options={[
                                      { value: '', label: 'Both' },
                                      { value: 'delivery', label: 'Delivery NPS' },
                                      { value: 'product', label: 'Product NPS' },
                                    ]}
                                  />
                                </td>
                                <td className="py-3 px-4">
                                  <MultiSelectDropdown
                                    value={a.detractorProductFilter ? a.detractorProductFilter.split(',').map((s) => s.trim()).filter(Boolean) : []}
                                    onChange={(vals) => saveProcessAgent(a.email, { detractorProductFilter: vals.join(', ') })}
                                    options={rosterProductCatalog}
                                    searchable
                                    placeholder="Any product"
                                    itemNoun="products"
                                  />
                                </td>
                                <td className="py-3 px-4 text-center">
                                  {a.isAdmin ? (
                                    <span className="text-[11px] text-zinc-500" title="Company-wide admin - already administers every process">all</span>
                                  ) : (
                                    <input
                                      type="checkbox"
                                      checked={!!a.isProcessAdmin}
                                      disabled={!sessionIsAdmin || savingAgentEmail === a.email}
                                      onChange={(e) => saveProcessAgent(a.email, { isProcessAdmin: e.target.checked })}
                                      className="accent-emerald-500"
                                      title={sessionIsAdmin ? 'Let this person manage this process' : 'Only a full admin can change this'}
                                    />
                                  )}
                                </td>
                                <td className="py-3 px-4 text-center">
                                  <button
                                    type="button"
                                    onClick={() => manualAssignNow(a.email)}
                                    disabled={assigningEmail === a.email}
                                    title="Fill this agent's queue up to quota right now"
                                    className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-40"
                                  >
                                    {assigningEmail === a.email ? 'Assigning…' : 'Assign Now'}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {detailTkt && (
        <Overlay onClose={closeDispose}>
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 w-full max-w-xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-bold text-zinc-100 tracking-tight">Dispose lead — {detailTkt.customer_name || detailTkt.response_id}</h3>
              <button type="button" onClick={closeDispose}><XIcon className="text-zinc-500 hover:text-zinc-200" /></button>
            </div>

            <div className="max-h-52 overflow-y-auto custom-scroll bg-zinc-950/60 border border-zinc-800/80 rounded-lg p-3">
              <TicketSurveyDetails t={detailTkt} />
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex items-center bg-zinc-950 border border-zinc-800 rounded-xl p-1 flex-1 min-w-[220px]">
                {branchChoice && (
                  <div
                    className={`absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-lg transition-transform duration-300 ease-out ${
                      branchChoice === 'Yes' ? 'bg-emerald-600' : 'bg-rose-600 translate-x-[calc(100%+4px)]'
                    }`}
                  />
                )}
                <button
                  type="button"
                  onClick={() => pickBranch('Yes')}
                  className={`relative z-[1] flex-1 py-1.5 rounded-lg text-[12px] font-bold transition-colors ${
                    branchChoice === 'Yes' ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Connected
                </button>
                <button
                  type="button"
                  onClick={() => pickBranch('No')}
                  className={`relative z-[1] flex-1 py-1.5 rounded-lg text-[12px] font-bold transition-colors ${
                    branchChoice === 'No' ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Non Connected
                </button>
              </div>
              <div className="flex items-center gap-2 pl-3 border-l border-zinc-800">
                <span className="text-[12px] text-zinc-400 font-semibold">Attempt</span>
                <div className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1">
                  <span className="w-5 text-center text-[13px] font-bold text-zinc-100 tabular-nums">{attempt}</span>
                  <div className="flex flex-col rounded-md overflow-hidden border border-zinc-800">
                    <button
                      type="button"
                      aria-label="Increase attempt"
                      onClick={() => setAttempt((a) => Math.max(1, Number(a || 1) + 1))}
                      className="w-5 h-3.5 flex items-center justify-center bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border-b border-zinc-800"
                    >
                      <ChevronDown className="rotate-180" style={{ width: 8, height: 8 }} />
                    </button>
                    <button
                      type="button"
                      aria-label="Decrease attempt"
                      onClick={() => setAttempt((a) => Math.max(1, Number(a || 1) - 1))}
                      className="w-5 h-3.5 flex items-center justify-center bg-zinc-900 hover:bg-zinc-800 text-zinc-400"
                    >
                      <ChevronDown style={{ width: 8, height: 8 }} />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <p className="text-[12px] text-zinc-400 font-semibold mb-1.5 tracking-tight">
                Disposition{selectedReasons.size ? ` · ${selectedReasons.size} selected` : ''}
              </p>
              {branchChoice
                ? (
                  <DispositionChecklist
                    nodes={branchNode ? branchNode.children : []} selected={selectedReasons} onToggle={toggleReason}
                    ancestors={branchNode ? [branchNode.label] : []} depth={1}
                    inputType={branchNode && branchNode.childrenInputType ? branchNode.childrenInputType : 'multi'}
                    ancestorNeedsProduct={!!(branchNode && branchNode.triggersProductFollowup)}
                    productOptions={productOptions} productsByReason={productsByReason} onProductsChange={setReasonProducts}
                    catalogProductNames={catalogProductNames} catalogLoading={catalogLoading}
                  />
                )
                : <p className="text-[12px] text-zinc-500">Pick Connected or Non Connected above to see reasons.</p>}
            </div>

            <textarea
              value={dispRemarks}
              onChange={(e) => setDispRemarks(e.target.value)}
              placeholder="Agent remarks"
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-[13px] text-zinc-200"
            />

            <button
              type="button"
              disabled={!selectedReasons.size || !derivedConnected || dispSaving}
              onClick={saveDisposition}
              className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-[13px] font-bold text-white transition-colors"
            >
              {dispSaving ? 'Saving…' : 'Save Disposition'}
            </button>
          </div>
        </Overlay>
      )}

      {viewTicket && (
        <Overlay onClose={() => setViewTicket(null)}>
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 w-full max-w-xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-bold text-zinc-100 tracking-tight">
                {viewTicket.customer_name || viewTicket.response_id}
              </h3>
              <button type="button" onClick={() => setViewTicket(null)}><XIcon className="text-zinc-500 hover:text-zinc-200" /></button>
            </div>

            <div className="max-h-52 overflow-y-auto custom-scroll bg-zinc-950/60 border border-zinc-800/80 rounded-lg p-3">
              <TicketSurveyDetails t={viewTicket} />
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
              <p className="text-zinc-500">Agent <span className="text-zinc-200 font-mono">{viewTicket.agent_email || '—'}</span></p>
              <p className="text-zinc-500">Connected <span className="text-zinc-200">{viewTicket.connected || '—'}</span></p>
              <p className="text-zinc-500">Submitted <span className="text-zinc-200">{viewTicket.submitted_date || '—'}</span></p>
              <p className="text-zinc-500">Attempt <span className="text-zinc-200">{viewTicket.attempt ?? '—'}</span></p>
              <p className="text-zinc-500">Assigned <span className="text-zinc-200">{viewTicket.assigned_at ? new Date(viewTicket.assigned_at).toLocaleString() : '—'}</span></p>
              <p className="text-zinc-500">Disposed <span className="text-zinc-200">{viewTicket.disposed_at ? new Date(viewTicket.disposed_at).toLocaleString() : '—'}</span></p>
            </div>

            <div>
              <p className="text-[12px] text-zinc-400 font-semibold mb-1.5 tracking-tight">Disposition</p>
              <div className="text-[13px] text-emerald-400 space-y-0.5 bg-zinc-950/60 border border-zinc-800/80 rounded-lg p-3">
                {(viewTicket.disposition || '').split(';').map((s) => s.trim()).filter(Boolean).map((line, i) => (
                  <p key={i} className="flex items-center gap-1.5"><CheckIcon /> {line}</p>
                ))}
                {!hasValue(viewTicket.disposition) && <p className="text-zinc-500">—</p>}
              </div>
            </div>

            {hasValue(viewTicket.affected_products) && (
              <div>
                <p className="text-[12px] text-zinc-400 font-semibold mb-1.5 tracking-tight">Affected Product(s)</p>
                <p className="text-[13px] text-zinc-300 bg-zinc-950/60 border border-zinc-800/80 rounded-lg p-3">{viewTicket.affected_products}</p>
              </div>
            )}

            <div>
              <p className="text-[12px] text-zinc-400 font-semibold mb-1.5 tracking-tight">Agent Remarks</p>
              <p className="text-[13px] text-zinc-300 bg-zinc-950/60 border border-zinc-800/80 rounded-lg p-3 whitespace-pre-wrap">
                {hasValue(viewTicket.agent_remarks) ? viewTicket.agent_remarks : '—'}
              </p>
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}
