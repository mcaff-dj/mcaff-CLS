'use client';

// Same reasoning as app/ndr-calling/NdrCallingClientLoader.js: this page's first render reads
// localStorage (search/filter draft state), which doesn't exist during server-side rendering.
// ssr:false sidesteps the hydration-mismatch class of bug entirely - fine here since this is an
// authenticated internal tool with no SEO/no-JS requirement.
import dynamic from 'next/dynamic';

const DeliveryEscalationClient = dynamic(() => import('./DeliveryEscalationClient'), { ssr: false });

export default DeliveryEscalationClient;
