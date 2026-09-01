// sessions.js - guided-session history, kept on THIS device.
//
// Two different things are recorded when a guided session runs, on purpose:
//
//   1. THE TAKE. The session is bracketed with the existing record start/stop
//      commands (DATA_CONTRACT "record"), so a guided session lands in the
//      normal take library like any other capture - same machinery, replayable
//      in #/replay, no parallel recording path.
//   2. THE SUMMARY (this file). The take library stores the SIGNAL; it has no
//      notion of "which exercise, how many reps reached, what range". That
//      summary lives here in localStorage so the next session can say "your
//      best close last time was 84 deg" without a server, an account, or any
//      data leaving the machine.
//
// PRIVACY: local only. No upload, no identifiers beyond an optional first
// name the person types. Clearing site data clears it, which is the honest
// contract for a research prototype.
//
// PROGRESS IS SELF-REFERENTIAL, ALWAYS. Comparisons are against this person's
// own previous sessions and nothing else: no norms, no percentiles, no
// "expected" values. A research prototype must never imply a clinical yardstick.

const KEY = "takto.guided.sessions";
const MAX = 60;   // keep the last 60 sessions; older ones roll off

export function loadSessions() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function saveSession(s) {
  const all = loadSessions();
  all.unshift(s);
  try { localStorage.setItem(KEY, JSON.stringify(all.slice(0, MAX))); } catch {}
  return s;
}

/** Most recent session for a protocol, or null on a first-ever run. */
export function lastSession(protocolId) {
  return loadSessions().find((s) => s.protocol === protocolId) || null;
}

/**
 * Personal best peak flexion (deg) seen in any past session of this protocol.
 * Returns null when there is no history - the UI then says nothing rather
 * than inventing a baseline.
 */
export function personalBest(protocolId) {
  const all = loadSessions().filter((s) => s.protocol === protocolId);
  if (!all.length) return null;
  return all.reduce((m, s) => Math.max(m, s.peakFlexDeg || 0), 0) || null;
}

export function clearSessions() {
  try { localStorage.removeItem(KEY); } catch {}
}
