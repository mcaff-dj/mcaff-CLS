// One-off build helper: rewrites the standalone Escalation app's stylesheet
// ("NDR Calling"/styles/globals.css - a full design system written for a page that owned the
// whole document) into app/escalation/escalation.css, with every rule scoped under
// .escalation-page.
//
// Why this is needed: app/layout.js imports app/globals.css for EVERY route, and both
// stylesheets define :root tokens (--accent, --border), body typography/background and a
// `fadeIn`/`spin`/`pulse` keyframe. Dropping the source file in as-is would repaint the
// dashboard, the login page and every report - and would silently redefine the `pulse`
// keyframe Tailwind's own `animate-pulse` utility uses. Scoping follows the convention
// app/globals.css already documents for .login-page/.admin-page/.dashboard-page/.deepdive-page.
//
// Rerun after pulling changes from the standalone app:
//   node scripts/scope_escalation_css.js "NDR Calling/styles/globals.css" app/escalation/escalation.css
const fs = require('fs');

const SRC = process.argv[2];
const OUT = process.argv[3];
const SCOPE = '.escalation-page';
const KF_PREFIX = 'esc-';

if (!SRC || !OUT) {
  console.error('usage: node scripts/scope_escalation_css.js <src.css> <out.css>');
  process.exit(1);
}

let css = fs.readFileSync(SRC, 'utf8');

// ── 1. Namespace every @keyframes so they can't collide with app/globals.css's own
// fadeIn/spin or with Tailwind's `pulse` (used by animate-pulse in CallingShell). ──
const kfNames = [];
css = css.replace(/@keyframes\s+([A-Za-z0-9_-]+)/g, (_m, name) => {
  if (!kfNames.includes(name)) kfNames.push(name);
  return `@keyframes ${KF_PREFIX}${name}`;
});
// Update the shorthand/longhand references to the names renamed above.
css = css.replace(/(animation(?:-name)?\s*:\s*)([^;}]*)/g, (_m, prop, val) => {
  let v = val;
  for (const n of kfNames) v = v.replace(new RegExp(`\\b${n}\\b`, 'g'), KF_PREFIX + n);
  return prop + v;
});

// ── 2. Prefix every selector with .escalation-page. ──
// Document-level selectors have no meaning once scoped to a subtree, so they're folded onto
// the wrapper element itself (:root/body -> .escalation-page) or dropped (html).
function scopeSelector(sel) {
  const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
  const mapped = parts.map(p => {
    if (p === 'html') return null;                       // wrapper isn't the document
    if (p === ':root' || p === 'body') return SCOPE;     // tokens/typography land on the wrapper
    if (p.startsWith(':root')) return SCOPE + p.slice(':root'.length);
    if (p.startsWith('body')) return SCOPE + p.slice('body'.length);
    if (p.startsWith('[')) return SCOPE + p;             // [data-theme='light'] -> .escalation-page[...]
    return `${SCOPE} ${p}`;
  }).filter(Boolean);
  return mapped.length ? mapped.join(',\n') : null;
}

function scopeBlock(input) {
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (input.startsWith('/*', i)) {                     // pass comments through verbatim
      const end = input.indexOf('*/', i + 2);
      const stop = end === -1 ? input.length : end + 2;
      out += input.slice(i, stop);
      i = stop;
      continue;
    }
    if (/\s/.test(input[i])) { out += input[i++]; continue; }

    // Read the rule header up to its '{' (or ';' for a blockless at-rule).
    let j = i;
    while (j < input.length && input[j] !== '{' && input[j] !== ';') {
      if (input.startsWith('/*', j)) {
        const e = input.indexOf('*/', j + 2);
        j = e === -1 ? input.length : e + 2;
        continue;
      }
      j++;
    }
    if (j >= input.length) { out += input.slice(i); break; }
    if (input[j] === ';') { out += input.slice(i, j + 1); i = j + 1; continue; }

    // Find the matching close brace for this block.
    let depth = 1;
    let k = j + 1;
    while (k < input.length && depth > 0) {
      if (input.startsWith('/*', k)) {
        const e = input.indexOf('*/', k + 2);
        k = e === -1 ? input.length : e + 2;
        continue;
      }
      if (input[k] === '{') depth++;
      else if (input[k] === '}') depth--;
      k++;
    }

    const header = input.slice(i, j);
    const body = input.slice(j + 1, k - 1);
    const trimmed = header.trim();

    if (/^@keyframes/i.test(trimmed)) {
      out += `${header}{${body}}`;                       // from/to/percent stops must not be scoped
    } else if (/^@(media|supports|layer|container)/i.test(trimmed)) {
      out += `${header}{${scopeBlock(body)}}`;           // scope the rules nested inside
    } else if (trimmed.startsWith('@')) {
      out += `${header}{${body}}`;
    } else {
      // Leading whitespace was already emitted by the branch at the top of the loop, so
      // `header` starts at the selector itself and only ever has trailing space to lose.
      const scoped = scopeSelector(trimmed);
      if (scoped) out += `${scoped} {${body}}`;
      // a dropped selector (html) takes its declarations with it
    }
    i = k;
  }
  return out;
}

const banner = `/* ============================================================
   Escalation — scoped build artifact. DO NOT EDIT BY HAND.

   Generated from the standalone app's stylesheet by
   scripts/scope_escalation_css.js; edit that source and rerun:
     node scripts/scope_escalation_css.js "NDR Calling/styles/globals.css" app/escalation/escalation.css

   Every rule is scoped under .escalation-page and every @keyframes is
   prefixed esc-, because app/layout.js loads app/globals.css on every
   route and the two stylesheets would otherwise fight over :root tokens,
   body typography and the fadeIn/spin/pulse keyframes (the last of which
   Tailwind's own animate-pulse utility depends on).
   ============================================================ */
`;

fs.writeFileSync(OUT, banner + scopeBlock(css), 'utf8');
console.log(`wrote ${OUT} (${kfNames.length} keyframes namespaced: ${kfNames.join(', ')})`);
