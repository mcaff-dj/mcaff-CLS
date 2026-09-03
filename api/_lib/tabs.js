// Static manifest of each report's internal tabs, for the "restrict to specific
// tabs within a card" admin feature (UI-level convenience only - see
// report_tab_permissions in db.js). Keep this in sync BY HAND with the tab lists
// actually built in scripts/gen_panels.py's assemble_report() (csat/nps/overview/
// monthly/<brand classes>/prodpkg/rtoconv) and scripts/generate_product_kyc.py
// (PKYC_CATEGORY_LABELS in productkyc_config.py) - those are Python and can't be
// imported here, so nothing enforces this automatically. `calling`'s entries
// mirror index.html's own CALLING_TEAM_SUBITEMS (a hardcoded sidebar structure,
// not a generated report tab bar) - keep those two in sync by hand too. A card
// with no entry here has no tab-level structure (mom/onboarding are
// single-view reports) and only ever gets whole-card access.
const CARD_TABS = {
  mcaffeine: [
    { key: 'csat', label: 'CSAT' },
    { key: 'nps', label: 'NPS' },
    { key: 'prodwisenps', label: 'Product wise NPS' },
    { key: 'overview', label: 'Overview' },
    { key: 'monthly', label: 'Monthly Analysis' },
    { key: 'delivery', label: 'Delivery' },
    { key: 'warehouse', label: 'Warehouse' },
    { key: 'technical', label: 'Technical' },
    { key: 'packaging', label: 'Packaging & Operational' },
    { key: 'product', label: 'Product' },
    { key: 'suggestion', label: 'Product Suggestion' },
    { key: 'prodpkg', label: 'Product & Packaging wrt Sales' },
    { key: 'rtoconv', label: 'RTO-Conversion' },
  ],
  hyphen: [
    { key: 'csat', label: 'CSAT' },
    { key: 'nps', label: 'NPS' },
    { key: 'prodwisenps', label: 'Product wise NPS' },
    { key: 'overview', label: 'Overview' },
    { key: 'monthly', label: 'Monthly Analysis' },
    { key: 'delivery', label: 'Delivery' },
    { key: 'warehouse', label: 'Warehouse' },
    { key: 'technical', label: 'Technical' },
    { key: 'packaging', label: 'Packaging & Operational' },
    { key: 'product', label: 'Product' },
    { key: 'prodpkg', label: 'Product & Packaging wrt Sales' },
    { key: 'rtoconv', label: 'RTO-Conversion' },
  ],
  productkyc: [
    { key: 'bodywash', label: 'Body Wash' },
    { key: 'lotions', label: 'Lotions' },
    { key: 'lipbalms', label: 'Lip Balms' },
    { key: 'scrubs', label: 'Scrubs' },
  ],
  // 'overview' and 'exports' are the Calling Team's own sidebar views; every other entry is
  // one of the Calling CRM's processes, generated from callingProcesses.json so granting a
  // process here and the CRM's own Process switcher can't drift apart. A row in
  // report_tab_permissions (card 'calling', tab '<process key>') is what "this agent is
  // invited to this process" means - see that file's ACCESS note.
  //
  // 'sales-pincode'/'refund-export'/'order-punch'/'nps-product-export' are different from every
  // entry above them: none is a sidebar view of its own (index.html's CALLING_TEAM_SUBITEMS has
  // no matching key, unlike 'exports') - each is a sub-permission INSIDE the Exports tab bar
  // (app/exports/ExportsClient.js), checked there and by that sub-tab's own API endpoint on top
  // of 'exports' itself. A restricted user needs BOTH 'exports' (to reach the Exports sidebar
  // page at all) AND the specific sub-tab key (to see/use that one sub-tab) checked in the
  // admin's tab-customization checklist.
  //
  // 'order-punch' is the one exception to "empty tab list = unrestricted access to everything
  // on this card": Order Punch creates real Unicommerce orders, so its own endpoints
  // (api/order-punch/*.js) require this key EXPLICITLY present even for an otherwise-
  // unrestricted non-admin - being untouched/unrestricted on 'calling' does not imply Order
  // Punch access the way it does for every other sub-permission here. isAdmin still bypasses
  // this entirely, same as before this permission existed.
  calling: [
    { key: 'overview', label: 'Overview' },
    ...require('./callingProcesses.json').processes.map(p => ({ key: p.key, label: p.label })),
    { key: 'exports', label: 'Exports' },
    { key: 'refund-export', label: 'Exports: Refund Export' },
    { key: 'order-punch', label: 'Exports: Order Punch' },
    { key: 'nps-product-export', label: 'Exports: Export Product NPS' },
    { key: 'sales-pincode', label: 'Exports: Update Sales Pincode' },
  ],
  // Mirrors app/deepdive/DeepdiveClient.js's own TABS array (a React page, not a
  // gen_panels.py-generated tab bar) - keep those two in sync by hand.
  deepdive: [
    { key: 'csat', label: 'CSAT Deep Dive' },
    { key: 'nps', label: 'NPS' },
    { key: 'agent', label: 'Agent wise analysis' },
    { key: 'agentactivity', label: 'Agent Activity Analysis' },
  ],
  // Mirrors app/orgoverview/OrgOverviewClient.js's own TABS array, same reasoning as
  // deepdive's note above.
  orgoverview: [
    { key: 'kyctrends', label: 'Org_KYC_Trends' },
  ],
};

module.exports = { CARD_TABS };
