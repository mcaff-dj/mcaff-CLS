'use client';

// NPS-Calling's own workspace (process key 'detractor' - see api/_lib/callingProcesses.json).
// Built on the same shared app/_calling/ pieces as RTO/NDR, but its data flow is deliberately
// simpler than either: there is no Sheet and no CSV upload, because the lead pool is the MySQL
// table nps_delivery (read-only, external) copied on-assign into CLS_NPS_calling - see
// api/_lib/db.js's getNextDetractorLead/disposeDetractorLead. So this file has no sync-from-
// sheet loop, no upload modal, and no team split (single shared queue/disposition tree for v1).
import { useState, useEffect, useCallback, useMemo } from 'react';
import { XIcon, CheckIcon, PhoneIcon, CustomSelect, Overlay, CalendarIcon, SearchIcon } from '../_calling/ui';
import { useCallingSession, ROSTER_STATUS_OPTIONS, STATUS_OPTIONS } from '../_calling/useCallingSession';
import { useBusinessHours, CallingHoursCard, useDefaultQuota, DefaultQuotaCard, useLeadOrder, LeadOrderCard, useProcessDispositions, ProcessDispositionsCard } from '../_calling/CallingAdminPanel';
import { CallingShell } from '../_calling/CallingShell';
import { scopeToDateBounds } from '../_calling/util';

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
// id -> {id, path} kept in NpsCallingClient's own dispose-modal state; `ancestors` is the chain
// of labels above `nodes` in this recursion, so a checked leaf's `path` carries its whole
// breadcrumb (e.g. ['Delivery Related', 'Late delivery']) for saveDisposition to join on.
//
// productOptions/productsByReason/onProductsChange: only meaningful under "Product Related
// Issue" - a checked reason there gets its OWN inline product picker right below it (rather
// than one picker for the whole category), since different products on the same order can each
// have a different problem and the agent needs to say which product goes with which reason.
function DispositionChecklist({ nodes, selected, onToggle, ancestors = [], productOptions = [], productsByReason = {}, onProductsChange }) {
  if (!nodes || !nodes.length) {
    return <p className="text-[12px] text-zinc-500">No disposition options configured yet - an admin can add some under Admin Panel.</p>;
  }
  // Top-level nodes (categories, e.g. "Product Related Issue") get their own card so the eye can
  // chunk the list into groups instead of scanning one long undifferentiated run of checkboxes -
  // nested children (there are none deeper than one level today) fall back to the plain list.
  const isTopLevel = ancestors.length === 0;
  return (
    <div className="space-y-2.5">
      {nodes.map((n) => {
        const path = [...ancestors, n.label];
        const hasChildren = n.children && n.children.length > 0;
        if (hasChildren) {
          const body = (
            <DispositionChecklist
              nodes={n.children} selected={selected} onToggle={onToggle} ancestors={path}
              productOptions={productOptions} productsByReason={productsByReason} onProductsChange={onProductsChange}
            />
          );
          return isTopLevel ? (
            <div key={n.id} className="bg-zinc-950/60 border border-zinc-800/80 rounded-lg p-3 space-y-2">
              <p className="text-[12px] font-bold text-zinc-200 tracking-tight">{n.label}</p>
              {body}
            </div>
          ) : (
            <div key={n.id} className="space-y-1.5">
              <p className="text-[12px] font-bold text-zinc-300">{n.label}</p>
              <div className="pl-3 border-l border-zinc-800">{body}</div>
            </div>
          );
        }
        const checked = selected.has(n.id);
        const showProductPicker = checked && productOptions.length > 0 && path.includes('Product Related Issue');
        const picked = productsByReason[n.id] || [];
        return (
          <div key={n.id}>
            <label
              className="flex items-center gap-2 text-[13px] text-zinc-200 cursor-pointer rounded-md px-1.5 py-1 -mx-1.5 hover:bg-zinc-800/40 transition-colors"
              title={n.description || ''}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(n.id, path)}
                className="accent-indigo-500 w-4 h-4"
              />
              {n.label}
            </label>
            {showProductPicker && (
              <div className="pl-6 pb-1.5">
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
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function NpsCallingClient() {
  // No date-scope filter UI in v1 (unlike RTO/NDR's Overview date picker) - Overview below is
  // roster-wide, all-time counts. getDateBounds is still wired through so Logged In At/Total
  // Break Time in the shared session hook have a sane (unbounded) answer.
  const session = useCallingSession(PROCESS_KEY, {
    getDateBounds: () => scopeToDateBounds('ALL_TIME', '', ''),
  });
  const {
    googleUser, sessionIsAdmin, invitedProcessKeys, processPermsLoaded,
    processAgents, isProcessAdmin, saveProcessAgent, savingAgentEmail,
    setStatusForAgent, showToast,
  } = session;

  const hours = useBusinessHours(PROCESS_KEY, { userRole: session.userRole, isProcessAdmin, showToast });
  const defaultQuota = useDefaultQuota(PROCESS_KEY, { userRole: session.userRole, isProcessAdmin, showToast });
  const leadOrder = useLeadOrder(PROCESS_KEY, { userRole: session.userRole, isProcessAdmin, showToast });
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
  const [rosterStatusFilter, setRosterStatusFilter] = useState('All');
  const [allLeadsSearch, setAllLeadsSearch] = useState('');
  const [allLeadsAgentFilter, setAllLeadsAgentFilter] = useState('ALL');
  // Defaults to DISPOSED, not ALL - the tab is literally labelled "All Leads (Disposed)" and its
  // count badge only counts disposed tickets, so showing Pending rows under it by default
  // contradicted both the label and the badge.
  const [allLeadsStatusFilter, setAllLeadsStatusFilter] = useState('DISPOSED');
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

  useEffect(() => {
    if (tab !== 'predicted' || !canAdminTab || predictedLeads !== null) return;
    (async () => {
      try {
        const r = await fetch('/api/detractor/tickets?scope=unassigned');
        const d = await r.json().catch(() => ({}));
        setPredictedLeads(r.ok ? (d.leads || []) : []);
      } catch (e) {
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

  // Leaves only ever come from whichever branch pickBranch chose (visibleDispositionNodes is
  // filtered to it), so cross-branch cleanup here is just a belt-and-suspenders guard.
  const toggleReason = (id, path) => {
    setSelectedReasons((prev) => {
      const next = new Map(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      const branch = path[0];
      for (const [existingId, existing] of next) {
        if (existing.path[0] !== branch) next.delete(existingId);
      }
      next.set(id, { id, path });
      return next;
    });
  };

  // Every checked leaf's breadcrumb, joined "Category > Reason", one per selection - lets one
  // call carry several reasons (even across categories) in the single `disposition` column
  // rather than forcing the whole call into one final label.
  const joinedDisposition = useMemo(
    () => Array.from(selectedReasons.values()).map((r) => r.path.join(' > ')).join('; '),
    [selectedReasons],
  );

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

  const visibleDispositionNodes = useMemo(() => {
    if (!branchChoice) return [];
    return (dispForTicket.processDispositions || []).filter((n) => n.label === (branchChoice === 'Yes' ? 'Connected' : 'Non Connected'));
  }, [dispForTicket.processDispositions, branchChoice]);

  // This lead's own product_name_list ("Product A, Product B") split into options - only ever
  // meaningful once "Product Related Issue" has a reason checked.
  const productOptions = useMemo(() => {
    const list = detailTkt && detailTkt.product_name_list;
    return hasValue(list) ? splitProductNameList(list) : [];
  }, [detailTkt]);
  const setReasonProducts = (reasonId, products) => {
    setProductsByReason((prev) => ({ ...prev, [reasonId]: products }));
  };

  // "<reason label>: <products>; <reason label>: <products>" - one entry per checked "Product
  // Related Issue" reason that actually has products picked (a reason with none contributes
  // nothing, same "only what's relevant" shape used throughout this file).
  const affectedProductsText = useMemo(
    () => Array.from(selectedReasons.values())
      .filter((r) => r.path.includes('Product Related Issue'))
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

  const tabsList = [
    { key: 'overview', label: 'Overview (Agents Data)', count: (processAgents || []).length },
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

  // Shared by the All Leads and Fresh Leads admin tabs - same search/agent filter controls and
  // table shape, just a different base list (every ticket vs undisposed-only) and whether the
  // status filter makes sense (Fresh Leads is already fixed to undisposed).
  const renderAdminLeadsTable = (source, { title, subtitle, showStatusFilter }) => {
    const search = allLeadsSearch.trim().toLowerCase();
    const filtered = (source || []).filter((t) => {
      if (allLeadsAgentFilter !== 'ALL' && (t.agent_email || '').toLowerCase() !== allLeadsAgentFilter.toLowerCase()) return false;
      if (showStatusFilter) {
        if (allLeadsStatusFilter === 'DISPOSED' && isUndisposed(t)) return false;
        if (allLeadsStatusFilter === 'PENDING' && !isUndisposed(t)) return false;
      }
      if (!search) return true;
      return [t.customer_name, t.channel_order_id, t.agent_email, t.customer_phone]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(search));
    });
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
              value={allLeadsAgentFilter}
              onChange={setAllLeadsAgentFilter}
              options={[
                { value: 'ALL', label: 'All Agents' },
                ...(processAgents || []).map((a) => ({ value: a.email, label: a.name || a.email })),
              ]}
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
                          {!t.disposed_at && (
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
                  {predictedLeads === null && <p className="text-[12px] text-zinc-500">Loading…</p>}
                  {predictedLeads && !predictedLeads.length && (
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
                        </tr></thead>
                        <tbody className="divide-y divide-zinc-800/50">
                          {predictedLeads.map((t, i) => (
                            <tr key={t.response_id} className="hover:bg-zinc-900/40 transition-colors">
                              <td className="py-2.5 px-4 text-zinc-500">{i + 1}</td>
                              <td className="py-2.5 px-4 text-zinc-200">{t.customer_name || '—'}</td>
                              <td className="py-2.5 px-4 text-zinc-400">{[t.brand, t.channel_order_id].filter(Boolean).join(' · ') || '—'}</td>
                              <td className="py-2.5 px-4 text-zinc-400">{t.nps_score ?? '—'}</td>
                              <td className="py-2.5 px-4 text-zinc-400">{[t.category, t.sub_category].filter(Boolean).join(' · ') || '—'}</td>
                              <td className="py-2.5 px-4 text-zinc-500 text-[11px]">{t.submitted_date || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {tab === 'overview' && (
                <div className="space-y-3">
                  <div>
                    <h3 className="text-[15px] font-bold text-zinc-100 tracking-tight">Overview</h3>
                    <p className="text-[12px] text-zinc-500 mt-0.5">
                      {canAdminTab ? "Roster-wide totals, all agents, all time." : 'Your own totals, all time.'}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {(() => {
                      const source = allTickets || tickets;
                      const total = source.length;
                      const disposedCount = source.filter((t) => !isUndisposed(t)).length;
                      const undisposedCount = total - disposedCount;
                      const connectedCount = source.filter((t) => t.connected === 'Yes').length;
                      const stats = [
                        { label: 'Total Leads', value: total, icon: '📋' },
                        { label: 'Disposed', value: disposedCount, icon: '✅' },
                        { label: 'Pending', value: undisposedCount, icon: '⏳' },
                        { label: 'Connected', value: connectedCount, icon: '📞' },
                      ];
                      return stats.map((s) => (
                        <div key={s.label} className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-4">
                          <p className="text-[11px] text-zinc-500 font-semibold uppercase flex items-center gap-1.5">
                            <span>{s.icon}</span>{s.label}
                          </p>
                          <p className="text-2xl font-extrabold text-zinc-100 tracking-tight">{s.value}</p>
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              )}

              {tab === 'admin' && canAdminTab && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-[15px] font-bold text-zinc-100 tracking-tight">Admin Panel & Roster</h3>
                    <p className="text-[12px] text-zinc-500 mt-0.5">Calling hours, default quota, dispositions, and the agent roster below.</p>
                  </div>
                  <CallingHoursCard processKey={PROCESS_KEY} processLabel="NPS-Calling" hours={hours} />
                  <DefaultQuotaCard processLabel="NPS-Calling" fallback={FALLBACK_QUOTA} quota={defaultQuota} />
                  <LeadOrderCard processLabel="NPS-Calling" order={leadOrder} />
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
                  />

                  <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between flex-wrap gap-3 p-4 pb-3">
                      <div>
                        <h3 className="text-[15px] font-bold text-zinc-100">Team Roster</h3>
                        <p className="text-[12px] text-zinc-500 mt-0.5">
                          Manage agent status and lead capacity limits. New agents appear here
                          automatically once granted NPS-Calling under Admin → Permissions.
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

                    {!agentMetrics.length && (
                      <p className="text-[12px] text-zinc-500 px-4 pb-4">No agents invited yet - grant access from Admin → Permissions.</p>
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
                            <th className="py-3 px-4 text-center font-medium" title="Can manage this process's roster and calling hours - nothing else">Process admin</th>
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

            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-zinc-400 font-semibold">Connected:</span>
                <button
                  type="button"
                  onClick={() => pickBranch('Yes')}
                  className={`px-3 py-1 rounded-lg text-[12px] font-bold border ${
                    branchChoice === 'Yes' ? 'bg-emerald-600 border-emerald-500 text-white' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                  }`}
                >
                  Connected
                </button>
                <button
                  type="button"
                  onClick={() => pickBranch('No')}
                  className={`px-3 py-1 rounded-lg text-[12px] font-bold border ${
                    branchChoice === 'No' ? 'bg-rose-600 border-rose-500 text-white' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                  }`}
                >
                  Non Connected
                </button>
              </div>
              <div className="flex items-center gap-2 pl-4 border-l border-zinc-800">
                <span className="text-[12px] text-zinc-400 font-semibold">Attempt</span>
                <input
                  type="number"
                  min="1"
                  value={attempt}
                  onChange={(e) => setAttempt(e.target.value)}
                  className="w-16 h-8 px-2 rounded-lg bg-zinc-950 border border-zinc-800 text-[12px] text-zinc-200"
                />
              </div>
            </div>

            <div>
              <p className="text-[12px] text-zinc-400 font-semibold mb-1.5 tracking-tight">
                Disposition{selectedReasons.size ? ` · ${selectedReasons.size} selected` : ''}
              </p>
              {branchChoice
                ? (
                  <DispositionChecklist
                    nodes={visibleDispositionNodes} selected={selectedReasons} onToggle={toggleReason}
                    productOptions={productOptions} productsByReason={productsByReason} onProductsChange={setReasonProducts}
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
    </div>
  );
}
