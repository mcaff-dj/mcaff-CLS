'use client';

// Same reasoning as app/rto-crm/RtoCrmClientLoader.js and app/ndr-calling/NdrCallingClientLoader.js:
// EscalationClient's first paint depends on browser-only state (it sets its own data-theme and
// reads window/document in effects), and it is an authenticated internal tool with no SEO or
// no-JS requirement - so there's nothing to gain from server-rendering it, and a hydration
// mismatch to lose. ssr:false means it only ever mounts client-side.
import dynamic from 'next/dynamic';

const EscalationClient = dynamic(() => import('./EscalationClient'), { ssr: false });

export default EscalationClient;
