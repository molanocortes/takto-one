// sim_badge.js - the SIMULATED DATA indicator, one rule for every surface.
//
// The default source tries the live bridge first and falls back to the
// in-browser simulation (telemetry.js AutoSource). A thesis demo must never
// pass simulated data off as live, so whenever the simulation is the source:
//   - a surface with a top bar shows its own badge (sourceBadges), and
//   - every other surface gets the global banner (mountSimBanner), fixed to
//     the viewport corner, which hides itself while a surface badge is up.
// Both offer "try live": one probe of the bridge, no page reload.

import { el, toast } from "./ui.js";
import { store } from "./store.js";

let _claims = 0;
let _banner = null;
let _update = () => {};

function bridgeUrl() {
  const t = store.tele;
  return (t && (t.url || (t.ws && t.ws.url))) || "ws://localhost:8765/ws";
}

async function tryLive(btn) {
  if (!store.tele.retryNow) {
    // a forced ?mock page: going live means leaving the forced simulation
    const u = new URL(location.href);
    u.searchParams.delete("mock");
    u.searchParams.set("auto", "1");
    location.href = u.toString();
    return;
  }
  if (btn) { btn.disabled = true; btn.dataset.busy = "1"; }
  const ok = await store.retryLive();
  if (btn) { btn.disabled = false; delete btn.dataset.busy; }
  toast(ok ? "Live bridge connected" : `No bridge answering at ${bridgeUrl()}`, { tone: ok ? "ok" : "warn" });
}

/** The global banner (call once per app, from main.js). */
export function mountSimBanner() {
  if (_banner) return _banner;
  const word = el("b", null, "SIMULATED DATA");
  const sub = el("span", { class: "sim-sub" }, "");
  const btn = el("button", { class: "sim-try", type: "button" }, "Try live bridge");
  btn.addEventListener("click", () => tryLive(btn));
  _banner = el("div", { class: "sim-banner", role: "status", "aria-live": "polite" },
    el("span", { class: "sim-dot" }), word, sub, btn);
  _banner.hidden = true;
  document.body.append(_banner);
  _update = () => {
    const sim = store.sourceKind === "mock";
    sub.textContent = store.tele.retryNow ? "no bridge answering" : "forced with ?mock";
    _banner.hidden = !sim || _claims > 0;
  };
  store.onSource(_update);
  _update();
  return _banner;
}

/**
 * Top-bar badges for a surface: [simBadge, linkBadge]. The sim badge shows
 * while the simulation is the source (and "LOOKING FOR BRIDGE" during the
 * first probe); the link badge shows when the live bridge stopped answering.
 * Claims the indicator so the global banner steps aside while mounted.
 */
export function sourceBadges(cleanups, { linkTitle } = {}) {
  const sim = el("button", { class: "mock-badge sim-badge", type: "button",
    title: "The in-browser simulation is the data source: nothing here is measured. Click to look for the live bridge again." },
    "SIMULATED DATA");
  sim.addEventListener("click", () => {
    if (store.sourceKind === "pending") return;
    tryLive(sim);
  });
  const link = el("button", { class: "mock-badge", type: "button",
    title: linkTitle || "The live bridge is not answering. Reconnecting automatically; click to reload now." },
    "LINK DOWN");
  link.addEventListener("click", () => location.reload());
  const paint = () => {
    const kind = store.sourceKind;
    sim.style.display = kind === "ws" ? "none" : "";
    sim.textContent = kind === "pending" ? "LOOKING FOR BRIDGE" : "SIMULATED DATA";
    sim.classList.toggle("pending", kind === "pending");
    link.style.display = kind === "ws" && !store.connected ? "" : "none";
  };
  paint();
  _claims++;
  _update();
  const offS = store.onSource(paint);
  const offL = store.onLink(paint);
  cleanups.push(() => { offS(); offL(); _claims = Math.max(0, _claims - 1); _update(); });
  return [sim, link];
}
