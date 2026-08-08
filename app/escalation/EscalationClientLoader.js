'use client';

// Same reasoning as app/rto-crm/RtoCrmClientLoader.js and app/ndr-calling/NdrCallingClientLoader.js:
// EscalationClient's very first render depends on localStorage (via useCallingSession's cached
// role/agent status - see app/_calling/util.js's safeStorage), which doesn't exist during
// server-side rendering. ssr:false sidesteps the resulting hydration-mismatch class of bug
// entirely by never rendering this component on the server at all - appropriate here since this
// is an authenticated internal tool with no SEO/no-JS requirement.
import dynamic from 'next/dynamic';

const EscalationClient = dynamic(() => import('./EscalationClient'), { ssr: false });

export default EscalationClient;
