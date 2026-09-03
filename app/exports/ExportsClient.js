'use client';

// Calling Team's "Exports" tab hub - a small tab bar over the two things this desk has here:
// the existing read-only Refund Export (unchanged, just re-hosted under this tab bar instead
// of being the whole page) and the new Order Punch action (admin-only - creates real orders in
// Unicommerce, see docs/superpowers/specs/2026-08-21-order-punch-design.md). HomeClient.js's
// own exports entry now points here instead of straight at /refund-export; that route still
// exists and still works on its own for anything that links to it directly.
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

export default function ExportsClient() {
  const [tab, setTab] = useState('refund');
  const [isAdmin, setIsAdmin] = useState(null); // null = not yet known

  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => {
      setIsAdmin(!!(d && d.authenticated && d.isAdmin));
    }).catch(() => setIsAdmin(false));
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

      {tab === 'refund' && <RefundExportClient />}
      {tab === 'order-punch' && (
        isAdmin === null ? (
          <div style={{ padding: 24 }}>Loading…</div>
        ) : isAdmin ? (
          <OrderPunchClient />
        ) : (
          <div style={{ padding: 24, color: '#666' }}>Order Punch is admin-only.</div>
        )
      )}
      {tab === 'nps-product' && <NpsProductExportClient />}
      {tab === 'sales-pincode' && <SalesPincodeImportClient />}
    </div>
  );
}
