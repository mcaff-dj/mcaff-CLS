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
  calling: [
    { key: 'overview', label: 'Overview' },
    { key: 'ndr', label: 'NDR-Calling' },
    { key: 'rto', label: 'RTO-Calling' },
  ],
  deepdive: [
    { key: 'csat', label: 'CSAT Deep Dive' },
    { key: 'agent', label: 'Agent wise analysis' },
    { key: 'agentactivity', label: 'Agent Activity Analysis' },
  ],
};

module.exports = { CARD_TABS };
