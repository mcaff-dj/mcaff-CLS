'use client';

import { useState } from 'react';
import { initials } from './escalationHelpers';

// Modeled directly on NDR's renderNdrRosterTable (app/ndr-calling/NdrCallingClient.js) -
// deliberately the SIMPLER of the two existing roster patterns in this app (RTO's own
// reconciles a legacy localStorage/ticket-scraped roster Escalation has no equivalent of).
// Membership is exactly processAgents (who's actually invited via report_tab_permissions) -
// there is no add/remove button here; inviting someone is an Admin -> Permissions action.
const HOURS_STATUS_OPTIONS = [
  { key: 'Online', label: 'Online' },
  { key: 'OnCall', label: 'Busy (on a call)' },
  { key: 'Busy', label: 'On Break' },
  { key: 'Offline', label: 'Offline' },
];

export default function AgentManagementPanel({ session }) {
  const { processAgents, processAgentsError, saveProcessAgent, savingAgentEmail, sessionIsAdmin, setStatusForAgent } = session;
  const [statusFilter, setStatusFilter] = useState('');

  const rows = (processAgents || []).filter((a) => !statusFilter || a.status === statusFilter);

  return (
    <div className="overviewPanel">
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Agent Management</h1>
          <p className="pageSubtitle">Everyone invited to Escalation, their live status, quota, and process-admin rights.</p>
        </div>
        <select className="filterSelect" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">All Statuses</option>
          {HOURS_STATUS_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      <div className="card">
        {processAgentsError ? (
          <div className="emptyState">
            <span className="emptyEmoji">⚠️</span>
            <div className="emptyTitle">Could not load roster</div>
            <div className="emptyDesc">{processAgentsError}</div>
          </div>
        ) : processAgents === null ? (
          <div className="emptyState"><span className="emptyEmoji">⏳</span><div className="emptyTitle">Loading roster…</div></div>
        ) : rows.length === 0 ? (
          <div className="emptyState">
            <span className="emptyEmoji">👥</span>
            <div className="emptyTitle">No one invited yet</div>
            <div className="emptyDesc">Grant access from Admin → Permissions.</div>
          </div>
        ) : (
          <table className="overviewTable">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Max Quota</th>
                <th style={{ textAlign: 'center' }}>Process Admin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.email}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className="userAvatar" style={{ fontSize: 10, width: 24, height: 24 }}>{initials(a.name)}</div>
                      <div>
                        <strong>{a.name}</strong>
                        <div style={{ color: 'var(--fg-muted)', fontSize: 11 }}>{a.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <select
                      className="assignDropdown"
                      value={a.status}
                      disabled={savingAgentEmail === a.email}
                      onChange={(e) => setStatusForAgent(a.email, e.target.value, a.name)}
                    >
                      {HOURS_STATUS_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  </td>
                  <td>
                    <input
                      key={`${a.email}-${a.maxQuota ?? 'default'}`}
                      type="number"
                      min="0"
                      className="field"
                      style={{ width: 90 }}
                      defaultValue={a.maxQuota ?? ''}
                      placeholder="Default"
                      disabled={savingAgentEmail === a.email}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        saveProcessAgent(a.email, { maxQuota: v === '' ? null : Number(v) });
                      }}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {a.isAdmin ? (
                      <span style={{ color: 'var(--fg-muted)', fontSize: 11 }} title="Company-wide admin already administers every process">all</span>
                    ) : (
                      <input
                        type="checkbox"
                        className="rowCheckbox"
                        checked={!!a.isProcessAdmin}
                        disabled={!sessionIsAdmin || savingAgentEmail === a.email}
                        onChange={(e) => saveProcessAgent(a.email, { isProcessAdmin: e.target.checked })}
                        title={sessionIsAdmin ? 'Let this person manage Escalation' : 'Only a full admin can change this'}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
