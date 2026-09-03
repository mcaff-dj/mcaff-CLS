'use client';

// Calling Team's "Exports" tab hub - a small tab bar over this desk's export/import actions:
// the read-only Refund Export (unchanged, just re-hosted under this tab bar instead of being
// the whole page), Order Punch (creates real orders in Unicommerce - see
// docs/superpowers/specs/2026-08-21-order-punch-design.md), Export Product NPS, and Update
// Sales Pincode. HomeClient.js's own exports entry now points here instead of straight at
// /refund-export; that route still exists and still works on its own for anything that links
// to it directly.
//
// Every sub-tab has its own tab permission (refund-export/order-punch/nps-product-export/
// sales-pincode in api/_lib/tabs.js's CARD_TABS.calling) checked here AND server-side by that
// sub-tab's own API endpoint - the check here only controls what's shown, the server-side one
// is what actually matters. Order Punch is the one exception: isAdmin OR the explicit
// 'order-punch' tab (not "unrestricted = everything", unlike the other three - see
// tabs.js's own comment on why).
import { useEffect, useState } from 'react';
import RefundExportClient from '../refund-export/RefundExportClient';
import OrderPunchClient from './OrderPunchClient';
import NpsProductExportClient from './NpsProductExportClient';
import SalesPincodeImportClient from './SalesPincodeImportClient';

const TABS = [
  { key: 'refund', label: 'Refund Export' },
  { key: 'order-punch', label: 'Order Punch' },
  { key: 'nps-product', label: 'Export Product NPS' },
  { key: 'sales-pincode', label: 'Update Sales Pincode' },
];

function GatedTab({ access, deniedLabel, children }) {
  if (access === null) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!access) return <div style={{ padding: 24, color: '#666' }}>You do not have access to {deniedLabel}.</div>;
  return children;
}

export default function ExportsClient() {
  const [tab, setTab] = useState('refund');
  const [isAdmin, setIsAdmin] = useState(null); // null = not yet known
  const [access, setAccess] = useState({}); // { refundExport, orderPunch, npsProductExport, salesPincode }, null values = not yet known

  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => {
      setIsAdmin(!!(d && d.authenticated && d.isAdmin));
      const callingTabs = d?.tabPerms?.calling;
      // Unrestricted (tabPerms.calling absent/empty) = every ordinary sub-tab, same convention
      // each endpoint's own checkAccess uses server-side.
      const unrestricted = !Array.isArray(callingTabs) || !callingTabs.length;
      setAccess({
        refundExport: unrestricted || callingTabs.includes('refund-export'),
        npsProductExport: unrestricted || callingTabs.includes('nps-product-export'),
        salesPincode: unrestricted || callingTabs.includes('sales-pincode'),
        // Order Punch is NOT covered by "unrestricted" - requires the explicit tab (or isAdmin,
        // checked separately below) regardless of whether the list is otherwise empty.
        orderPunch: Array.isArray(callingTabs) && callingTabs.includes('order-punch'),
      });
    }).catch(() => {
      setIsAdmin(false);
      setAccess({ refundExport: false, npsProductExport: false, salesPincode: false, orderPunch: false });
    });
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #ddd', padding: '0 24px' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '10px 16px',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: tab === t.key ? 700 : 400,
              borderBottom: tab === t.key ? '2px solid #333' : '2px solid transparent',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'refund' && (
        <GatedTab access={access.refundExport ?? null} deniedLabel="Refund Export">
          <RefundExportClient />
        </GatedTab>
      )}
      {tab === 'order-punch' && (
        isAdmin === null || access.orderPunch === undefined ? (
          <div style={{ padding: 24 }}>Loading…</div>
        ) : isAdmin || access.orderPunch ? (
          <OrderPunchClient />
        ) : (
          <div style={{ padding: 24, color: '#666' }}>Order Punch is admin-only.</div>
        )
      )}
      {tab === 'nps-product' && (
        <GatedTab access={access.npsProductExport ?? null} deniedLabel="Export Product NPS">
          <NpsProductExportClient />
        </GatedTab>
      )}
      {tab === 'sales-pincode' && (
        <GatedTab access={access.salesPincode ?? null} deniedLabel="Update Sales Pincode">
          <SalesPincodeImportClient />
        </GatedTab>
      )}
    </div>
  );
}
