'use client';

// Same reasoning as app/nps-calling/NpsCallingClientLoader.js: the client's first render depends
// on localStorage (via useCallingSession), which doesn't exist during SSR. ssr:false sidesteps
// the resulting hydration-mismatch class of bug entirely.
import dynamic from 'next/dynamic';

const ProductCallingClient = dynamic(() => import('./ProductCallingClient'), { ssr: false });

export default ProductCallingClient;
