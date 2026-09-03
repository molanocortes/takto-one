// diagBeacon.js - close the observability loop (2026-07-20).
//
// Round 1's diagnostics lived only in the in-headset dom-overlay HUD: if the
// overlay did not render (or nobody wrote down what it said) the information
// was gone. This module ships the SAME envDiag() snapshot off the device at
// every meaningful moment, over TWO channels at once:
//
//   1. {cmd:"diag", ...} over the telemetry socket -> the bridge appends it to
//      ~/.sensoryhand_diag.log (teensy_bridge.py). Works whenever the bridge
//      socket is live.
//   2. HTTP POST /diag to the SERVING ORIGIN -> serve_quest.py appends to the
//      same log file. This covers the blind spot where the transport is the
//      mock (no bridge socket at all) - the exact case that made round 1
//      undiagnosable. sendBeacon survives page teardown; fetch(keepalive) is
//      the fallback.
//
// After one owner attempt, an agent reads ~/.sensoryhand_diag.log and knows
// exactly where the capture broke - no HUD transcription, no guesswork.
// HONESTY: the payload is the real device state verbatim; nothing is edited.

let _seq = 0;

export function sendDiag(tele, event, diag) {
  const msg = {
    cmd: "diag", event, seq: _seq++,
    t_wall: Date.now(),
    page: "ar",
    href: typeof location !== "undefined" ? location.href : "",
    ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
    diag,
  };
  try { if (tele) tele.send(msg); } catch (_) { /* transport down: beacon still fires */ }
  try {
    if (typeof location !== "undefined" && /^https?:$/.test(location.protocol)) {
      const body = JSON.stringify(msg);
      let sent = false;
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        try {
          sent = navigator.sendBeacon("/diag",
            new Blob([body], { type: "application/json" }));
        } catch (_) { sent = false; }
      }
      if (!sent && typeof fetch === "function") {
        fetch("/diag", { method: "POST", body, keepalive: true,
          headers: { "Content-Type": "application/json" } }).catch(() => {});
      }
    }
  } catch (_) { /* diagnostics must never break the app */ }
  return msg;
}
