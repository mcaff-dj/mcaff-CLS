'use client';

import { CallingHoursCard } from '../_calling/CallingAdminPanel';

// Business hours only, this round - reuses CallingHoursCard exactly as NDR does
// (app/_calling/CallingAdminPanel.js), already generic per-process. Admin-editable
// resolution types (RESOLVE_TYPES in EscalationClient.js) stay hardcoded per the approved
// design spec - the generic calling_process_dispositions table has no columns for the
// needsOrder/needsAwb/isBulkable metadata the resolve form and BULK_ALLOWED depend on.
export default function SettingsPanel({ hours }) {
  return (
    <div className="overviewPanel">
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Settings</h1>
          <p className="pageSubtitle">Escalation desk configuration.</p>
        </div>
      </div>
      <CallingHoursCard processKey="escalation" processLabel="Escalation" hours={hours} />
    </div>
  );
}
