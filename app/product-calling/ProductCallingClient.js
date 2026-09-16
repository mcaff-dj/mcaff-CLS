'use client';

// Product Calling's own workspace (process key 'productkyc' - see
// api/_lib/callingProcesses.json). Built on the same shared app/_calling/ pieces as every other
// calling page. Unlike NPS-Calling, leads arrive via admin CSV upload (Task 11's Admin tab), not
// copy-on-assign from a read-only source table - see
// docs/superpowers/specs/2026-09-16-product-calling-design.md.
import { useState, useEffect, useCallback } from 'react';
import { XIcon, CheckIcon, PhoneIcon, CustomSelect, Overlay } from '../_calling/ui';
import { useCallingSession } from '../_calling/useCallingSession';
import { useProcessDispositions } from '../_calling/CallingAdminPanel';
import { CallingShell } from '../_calling/CallingShell';
import { scopeToDateBounds } from '../_calling/util';

const PROCESS_KEY = 'productkyc';

export default function ProductCallingClient() {
  const session = useCallingSession(PROCESS_KEY, {
    getDateBounds: () => scopeToDateBounds('ALL_TIME', '', ''),
  });
  const { googleUser, sessionIsAdmin, isProcessAdmin, showToast } = session;

  const disp = useProcessDispositions(PROCESS_KEY, { googleUser, showToast, strict: true });

  useEffect(() => {
    document.documentElement.className = 'light';
    document.body.className = 'font-sans antialiased min-h-screen theme-light';
  }, []);

  const canAdminTab = sessionIsAdmin || isProcessAdmin;
  const [tab, setTab] = useState('fresh');
  useEffect(() => {
    if (tab === 'admin' && !canAdminTab) setTab('fresh');
  }, [tab, canAdminTab]);

  const [tickets, setTickets] = useState([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const [lastSync, setLastSync] = useState('—');
  const fetchMyTickets = useCallback(async () => {
    setTicketsLoading(true);
    try {
      const r = await fetch('/api/productcalling/tickets');
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

  const freshTickets = tickets.filter((t) => !t.disposed_at);
  const disposedTickets = tickets.filter((t) => t.disposed_at);

  // Dispose modal state - a simple two-level pick (category, then leaf) against the admin-
  // configured disposition tree, rather than NPS-Calling's multi-select-with-path tree: this
  // process has no per-area survey/affected-products concern to justify that complexity (see
  // the design spec's "Out of scope" section).
  const [detailTkt, setDetailTkt] = useState(null);
  const [categoryId, setCategoryId] = useState('');
  const [leafId, setLeafId] = useState('');
  const [dispRemarks, setDispRemarks] = useState('');
  const [connected, setConnected] = useState('');
  const [attempt, setAttempt] = useState(1);
  const [dispSaving, setDispSaving] = useState(false);

  const openDispose = (t) => {
    setDetailTkt(t);
    setCategoryId('');
    setLeafId('');
    setDispRemarks(t.agent_remarks || '');
    setConnected(t.connected || '');
    setAttempt(t.attempt || 1);
  };
  const closeDispose = () => setDetailTkt(null);

  const categories = (disp.processDispositions || []).filter((n) => !n.parent_id);
  const leaves = (disp.processDispositions || []).filter((n) => String(n.parent_id) === String(categoryId));
  const selectedLeaf = leaves.find((l) => String(l.id) === String(leafId));

  const submitDispose = async () => {
    if (!detailTkt || !selectedLeaf) { showToast('⚠️ Pick a disposition first'); return; }
    setDispSaving(true);
    try {
      const r = await fetch('/api/productcalling/lead-assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'dispose',
          leadRef: detailTkt.lead_ref,
          disposition: selectedLeaf.label,
          agentRemarks: dispRemarks,
          connected,
          attempt,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(`⚠️ ${d.error || 'Could not save'}`); return; }
      showToast(d.assignedLeads?.length ? '✅ Saved - next lead assigned' : '✅ Saved');
      closeDispose();
      fetchMyTickets();
    } catch (e) {
      showToast(`⚠️ ${e.message}`);
    } finally {
      setDispSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50">
      <CallingShell
        logoLabel="PC"
        title="Product Calling"
        lastSync={lastSync}
        syncing={ticketsLoading}
        onSync={fetchMyTickets}
        session={session}
      >
        <div className="max-w-[1440px] mx-auto px-3 sm:px-5 py-4">
          <div className="flex gap-2 mb-4">
            <button onClick={() => setTab('fresh')} className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${tab === 'fresh' ? 'bg-indigo-600 text-white' : 'bg-white text-zinc-600 border border-zinc-200'}`}>
              Fresh Leads ({freshTickets.length})
            </button>
            <button onClick={() => setTab('disposed')} className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${tab === 'disposed' ? 'bg-indigo-600 text-white' : 'bg-white text-zinc-600 border border-zinc-200'}`}>
              Disposed ({disposedTickets.length})
            </button>
            {canAdminTab && (
              <button onClick={() => setTab('admin')} className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${tab === 'admin' ? 'bg-indigo-600 text-white' : 'bg-white text-zinc-600 border border-zinc-200'}`}>
                Admin
              </button>
            )}
          </div>

          {(tab === 'fresh' || tab === 'disposed') && (
            <div className="bg-white rounded-xl border border-zinc-200 divide-y divide-zinc-100">
              {(tab === 'fresh' ? freshTickets : disposedTickets).length === 0 && (
                <div className="p-8 text-center text-sm text-zinc-400">
                  {ticketsLoading ? 'Loading…' : (tab === 'fresh' ? 'No leads assigned yet.' : 'Nothing disposed yet.')}
                </div>
              )}
              {(tab === 'fresh' ? freshTickets : disposedTickets).map((t) => (
                <div key={t.id} className="p-3 sm:p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm text-zinc-800 truncate">{t.customer_name || '—'}</div>
                    <div className="text-xs text-zinc-500 flex items-center gap-1.5">
                      <PhoneIcon /> {t.customer_phone}
                      {t.product_key && <span className="ml-2 px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">{t.product_key}</span>}
                    </div>
                    {t.disposed_at && <div className="text-xs text-emerald-600 mt-1">{t.disposition}</div>}
                  </div>
                  {tab === 'fresh' && (
                    <button onClick={() => openDispose(t)} className="shrink-0 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold">
                      Dispose
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'admin' && canAdminTab && (
            <div id="product-calling-admin-tab" className="text-sm text-zinc-500">
              {/* Populated by Task 11: roster/hours/quota/lead-order/dispositions cards + CSV upload. */}
            </div>
          )}
        </div>
      </CallingShell>

      {detailTkt && (
        <Overlay onClose={closeDispose}>
          <div className="bg-white rounded-2xl p-5 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-zinc-800">Dispose — {detailTkt.customer_name || detailTkt.customer_phone}</h3>
              <button onClick={closeDispose}><XIcon /></button>
            </div>

            <label className="block text-xs font-semibold text-zinc-500 mb-1">Connected?</label>
            <CustomSelect
              value={connected}
              onChange={setConnected}
              options={[{ value: 'Yes', label: 'Connected' }, { value: 'No', label: 'Not Connected' }]}
              placeholder="Select…"
              className="mb-3 w-full"
            />

            <label className="block text-xs font-semibold text-zinc-500 mb-1">Category</label>
            <CustomSelect
              value={categoryId}
              onChange={(v) => { setCategoryId(v); setLeafId(''); }}
              options={categories.map((c) => ({ value: String(c.id), label: c.label }))}
              placeholder="Select a category…"
              className="mb-3 w-full"
            />

            {categoryId && (
              <>
                <label className="block text-xs font-semibold text-zinc-500 mb-1">Disposition</label>
                <CustomSelect
                  value={leafId}
                  onChange={setLeafId}
                  options={leaves.map((l) => ({ value: String(l.id), label: l.label }))}
                  placeholder="Select a disposition…"
                  className="mb-3 w-full"
                />
              </>
            )}

            <label className="block text-xs font-semibold text-zinc-500 mb-1">Remarks</label>
            <textarea
              value={dispRemarks}
              onChange={(e) => setDispRemarks(e.target.value)}
              className="w-full border border-zinc-200 rounded-lg p-2 text-sm mb-4"
              rows={3}
            />

            <button
              onClick={submitDispose}
              disabled={dispSaving || !leafId}
              className="w-full py-2 rounded-lg bg-indigo-600 text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              <CheckIcon /> {dispSaving ? 'Saving…' : 'Save Disposition'}
            </button>
          </div>
        </Overlay>
      )}
    </div>
  );
}
