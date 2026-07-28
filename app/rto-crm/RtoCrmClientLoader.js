'use client';

// RtoCrmClient's very first render depends on localStorage (cached role, agent
// status, roster, theme, etc. - all read directly inside useState initializers).
// localStorage doesn't exist during server-side rendering, so the server always
// renders using the hardcoded fallback values while the client re-renders using
// whatever's actually cached - for a returning user with different cached state
// than the server's defaults, that mismatch is exactly what triggers React's
// hydration-mismatch errors (#418/#423/#425), which can leave parts of the page
// in a broken state (e.g. computed queues/counts silently coming up empty)
// without any user-visible error unless the browser console is checked.
//
// ssr:false sidesteps this whole class of bug entirely by never rendering this
// component on the server at all - it only ever mounts client-side, where
// localStorage is available from the very first render, so there's nothing for
// server and client output to disagree about. Appropriate here since this is an
// authenticated internal tool with no SEO/no-JS requirement - unlike the report
// pages, there's no value being given up by skipping SSR for this one.
import dynamic from 'next/dynamic';

const RtoCrmClient = dynamic(() => import('./RtoCrmClient'), { ssr: false });

export default RtoCrmClient;
