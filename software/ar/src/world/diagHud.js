// diagHud.js - the on-headset diagnostic HUD for room capture (2026-07-20).
//
// The owner reported "tap scan room, NOTHING visible happens". The root cause
// was invisible: depth-sensing may not be granted, or three.js's GPU depth
// path was freezing the loop, or the page was on the mock transport with no
// bridge - and every one of those failed SILENTLY. This HUD makes each state
// speak, in passthrough, at arm's length:
//
//   session : which WebXR features were actually granted (depth + its usage,
//             mesh, plane, hand) - the single most important line, because a
//             missing "depth cpu" or missing "mesh" explains an empty scan.
//   transport: mock vs ws://host, and whether the socket is live - a scan can
//             only be stored + sent over a live bridge.
//   depth   : did getDepthInformation return data THIS frame, and how many
//             samples were in range - distinguishes "no depth" from "depth but
//             the room is out of range / too dark".
//   counts  : live points / tris / meshes / planes.
//   coverage: how much of the room has been swept (drives the guidance).
//   guidance: the one active instruction (rotate / move / run Space Setup ...).
//   bridge  : the last ack or error from the host, verbatim.
//
// It renders through the session's dom-overlay (requested in main.js) so it is
// a flat, always-legible 2D layer over passthrough. It is READ-ONLY
// (pointer-events:none) so it can never steal an XR select. Toggle with the
// "h" key (desktop) or ?hud=0 to suppress. Pure DOM, no three dependency.

const AQUA = "#66B8FF", OK = "#5FE6C4", WARN = "#E7B45A", BAD = "#F4776A";

function bar(frac, n) {
  const filled = Math.round(Math.max(0, Math.min(1, frac)) * n);
  return "▓".repeat(filled) + "░".repeat(n - filled);
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[<>&]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}
// locale-independent thousands grouping ("4000" -> "4,000"); toLocaleString
// renders "4.000" in some locales, which reads as four points on the HUD.
function grp(n) { return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

export class DiagHud {
  constructor() {
    const p = new URLSearchParams(location.search);
    this._force = p.get("hud") === "1";          // force-show on desktop too
    this._suppressed = p.get("hud") === "0";
    this._el = document.createElement("div");
    this._el.id = "diaghud";
    // high-contrast, dark-backed, big enough to read across a room in passthrough
    this._el.style.cssText = [
      "position:fixed", "left:16px", "top:14px", "z-index:40",
      "max-width:min(560px,92vw)", "padding:12px 14px",
      "font:600 16px/1.42 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      "color:#EAF4FF", "background:rgba(6,10,16,0.72)",
      "border:1px solid rgba(102,184,255,0.35)", "border-radius:12px",
      "box-shadow:0 6px 30px rgba(0,0,0,0.45)", "backdrop-filter:blur(3px)",
      "white-space:pre-wrap", "pointer-events:none", "letter-spacing:0.2px",
      "display:none", "text-shadow:0 1px 2px rgba(0,0,0,0.8)",
    ].join(";");
    document.body.appendChild(this._el);
    addEventListener("keydown", (e) => {
      if (e.key === "h" || e.key === "H") { this._suppressed = !this._suppressed; }
    });
  }

  // presenting: are we in an XR session (HUD shows there by default)
  update(diag, presenting) {
    const show = !this._suppressed && (presenting || this._force);
    this._el.style.display = show ? "block" : "none";
    if (!show) return;

    const f = diag.features || {};
    const tone = (v, good) => `<span style="color:${v ? (good || OK) : BAD}">${v ? "yes" : "NO"}</span>`;
    const depthTag = f.depth
      ? `<span style="color:${OK}">yes ${esc(diag.depthUsage || "?")}</span>`
      : `<span style="color:${BAD}">NO</span>`;

    // transport line: a live ws bridge is required to store + send a room
    const t = diag.transport || {};
    let transport;
    if (t.kind === "ws") {
      transport = t.connected
        ? `<span style="color:${OK}">ws connected</span> ${esc(t.url || "")}`
        : `<span style="color:${WARN}">ws connecting...</span> ${esc(t.url || "")}`;
    } else {
      transport = `<span style="color:${BAD}">mock - no bridge</span> (add ?ws=wss://host:8443/ws to store)`;
    }

    const phaseColor = { done: OK, error: BAD, empty: WARN, scanning: AQUA, uploading: AQUA }[diag.phase] || "#9fb2c8";
    const cov = diag.coverage || 0;
    const covColor = cov > 0.7 ? OK : cov > 0.35 ? AQUA : WARN;

    // depth line: the clearest signal of whether real depth is flowing
    const depthLive = diag.depthFrames > 0;
    const depthLine = `<span style="color:${depthLive ? OK : WARN}">${esc(diag.depthReason || "-")}</span>`
      + `   <span style="opacity:0.75">frames ${diag.depthFrames || 0}</span>`;

    let ackLine = "-";
    if (diag.lastAck) {
      const a = diag.lastAck;
      if (a.event === "env_saved")
        ackLine = `<span style="color:${OK}">env_saved</span> ${esc(a.id || "")} · ${a.pts || 0} pts / ${a.tris || 0} tris`;
      else if (a.event === "error")
        ackLine = `<span style="color:${BAD}">error</span> ${esc(a.error || "")}`;
      else ackLine = `${esc(a.event || "")} ${esc(a.id || "")}`;
    }

    const rows = [
      `<span style="color:${AQUA};font-weight:700">TAKTO capture diagnostics</span>  <span style="opacity:0.6">press h to hide</span>`,
      `session : depth ${depthTag}   mesh ${tone(f.mesh)}   plane ${tone(f.plane)}   hand ${tone(f.hand)}`,
      `transport: ${transport}`,
      `scan    : <span style="color:${phaseColor};font-weight:700">${esc(diag.phase || "idle")}</span>  ${(diag.secs || 0).toFixed(1)}s`,
      `depth   : ${depthLine}`,
      `counts  : <b>${grp(diag.pts)}</b> pts   ${grp(diag.tris)} tris   ${diag.meshes || 0} mesh   ${diag.planes || 0} plane`,
      `coverage: <span style="color:${covColor}">${bar(cov, 12)}</span> ${Math.round(cov * 100)}%  (${diag.sectors || 0}/${diag.sectorsMax || 12} swept)`,
      `<span style="color:${OK}">&gt; ${esc(diag.guidance || "")}</span>`,
      `bridge  : ${ackLine}`,
    ];
    this._el.innerHTML = rows.join("\n");
  }

  dispose() { if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el); }
}
