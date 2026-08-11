// app/escalation/escalationHelpers.js
// Real agents (from calling_agent_process, via getCallingProcessAgents) carry only
// email/name - no stored avatar string like the old hardcoded AGENTS array had. This derives
// a 2-letter initials badge from a display name, used everywhere Escalation shows a small
// avatar circle (topbar, sidebar footer, assignment chips, roster table).
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
