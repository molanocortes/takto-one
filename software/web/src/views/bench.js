// bench.js - SEA bench view: the live tuning aid for the series-elastic
// tendon controller (the host-side SEA runner, not in this release).
//
// Renders what the SEA runner publishes through the bridge (snap.sea):
// commanded vs measured joint angle, ESTIMATED flexor/extensor tension and
// spring stretch (the spring model is the sensor - the labels say estimated
// because they are), inner-loop current, and the mode / release / rescue
// flags. Sliders + Home/Run/Stop reach the runner through the bridge's
// seq'd sea_target relay; this view never talks to motors directly.
//
// Honesty rules carried from DATA_CONTRACT.md: the SIM chip mirrors the
// frame's own `sim` flag, every force panel carries the ESTIMATED tag, and
// when no runner publishes the view says so instead of pretending.

import { el, clamp } from "../ui.js";
import { store } from "../store.js";
import { StripChart } from "../charts.js";

const JOINTS = ["mcp", "pip"];
const JLIMIT = { mcp: [-10, 90], pip: [-10, 110] };
const STROKE_MM = 16;                  // config.STROKE, band shown on stretch plots

function styleOnce() {
  if (document.getElementById("bench-style")) return;
  const s = el("style", { id: "bench-style" });
  s.textContent = `
  .bch { max-width:1060px; margin:0 auto; padding:26px 22px 60px; }
  .bch-head { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; margin-bottom:6px; }
  .bch-back { text-decoration:none; color:var(--text-2); font-size:13px; letter-spacing:.04em;
    padding:4px 10px; border:1px solid var(--line,#DFDAD0); border-radius:999px;
    transition:color .15s ease, border-color .15s ease; }
  .bch-back:hover { color:var(--text-0); border-color:var(--text-2); }
  .bch-kicker { font:600 11px/1 ui-monospace,monospace; letter-spacing:.14em;
    text-transform:uppercase; color:#C9401B; }
  .bch-title { font:600 26px/1.15 var(--font,system-ui); color:var(--ink,#23201A); margin:0; }
  .bch-chips { display:flex; gap:8px; margin-left:auto; }
  .bch-chip { font:600 10px/1 ui-monospace,monospace; letter-spacing:.08em;
    text-transform:uppercase; padding:5px 9px; border-radius:6px;
    background:rgba(35,30,22,.08); color:var(--sub,#8B8474); }
  .bch-chip.warn { background:rgba(192,131,39,.16); color:#8a6216; }
  .bch-chip.live { background:rgba(95,138,92,.16); color:#3f6b3c; }
  .bch-sub { font:400 13px/1.5 var(--font,system-ui); color:var(--sub,#8B8474); margin:0 0 20px; }
  .bch-none { padding:42px; text-align:center; border:1px dashed rgba(35,30,22,.25);
    border-radius:14px; color:var(--sub,#8B8474); font:400 14px/1.6 var(--font,system-ui); }
  .bch-none code { font:600 12px ui-monospace,monospace; color:var(--ink,#23201A); }
  .bch-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width: 860px) { .bch-grid { grid-template-columns:1fr; } }
  .bch-card { border:1px solid rgba(35,30,22,.14); border-radius:14px; padding:14px 16px;
    background:rgba(255,255,255,.55); }
  .bch-card h3 { display:flex; align-items:center; gap:8px; margin:0 0 10px;
    font:600 13px/1 ui-monospace,monospace; letter-spacing:.1em; text-transform:uppercase;
    color:var(--ink,#23201A); }
  .bch-flag { font:600 9px/1 ui-monospace,monospace; letter-spacing:.06em; padding:3px 6px;
    border-radius:5px; background:rgba(35,30,22,.08); color:var(--sub,#8B8474); }
  .bch-flag.on { background:rgba(201,64,27,.16); color:#A23214; }
  .bch-row { display:flex; justify-content:space-between; align-items:baseline; margin:8px 0 3px; }
  .bch-lab { font:600 10px/1 ui-monospace,monospace; letter-spacing:.06em;
    text-transform:uppercase; color:var(--sub,#8B8474); }
  .bch-val { font:600 12px/1 ui-monospace,monospace; color:var(--ink,#23201A); }
  .bch-est { font:600 8px/1 ui-monospace,monospace; letter-spacing:.06em; padding:2px 5px;
    border-radius:4px; background:rgba(192,131,39,.14); color:#8a6216; }
  .bch-chart { display:block; width:100%; height:64px; }
  .bch-ctl { margin-top:18px; border:1px solid rgba(35,30,22,.14); border-radius:14px;
    padding:16px; display:flex; gap:22px; flex-wrap:wrap; align-items:flex-end; }
  .bch-slider { flex:1; min-width:220px; }
  .bch-slider input { width:100%; accent-color:#C9401B; }
  .bch-btns { display:flex; gap:8px; }
  .bch-btn { appearance:none; border:1px solid rgba(35,30,22,.25); background:transparent;
    color:var(--ink,#23201A); font:600 12px/1 var(--font,system-ui); padding:10px 16px;
    border-radius:9px; cursor:pointer; }
  .bch-btn:hover { background:rgba(35,30,22,.06); }
  .bch-btn.primary { border-color:rgba(201,64,27,.5); background:rgba(201,64,27,.08); color:#A23214; }
  .bch-btn.primary:hover { background:rgba(201,64,27,.15); }
  `;
  document.head.append(s);
}

function chartBlock(title, canvasRefs, name, estimated) {
  const canvas = el("canvas", { class: "bch-chart" });
  canvasRefs[name] = canvas;
  return el("div", {},
    el("div", { class: "bch-row" },
      el("span", { class: "bch-lab" }, title),
      estimated ? el("span", { class: "bch-est" }, "estimated") : null,
      el("span", { class: "bch-val", "data-val": name }, "—")),
    canvas);
}

export function mountBench(rootHost) {
  styleOnce();
  const cleanups = [];
  const canvases = {};
  const charts = {};

  const chips = {
    link: el("span", { class: "bch-chip" }, "no runner"),
    sim: el("span", { class: "bch-chip" }, ""),
    mode: el("span", { class: "bch-chip" }, ""),
  };
  const none = el("div", { class: "bch-none" },
    el("div", {}, "No SEA runner is publishing."),
    el("p", {}, "Start it with ", el("code", {}, "python3 -m sea.runner --sim"),
      " to validate the complete loop here. Hardware RUN remains deliberately gated until MCP and PIP are each neutralled, direction-identified, and spring/spool/friction/current-to-tension identification is complete."));

  const flags = {};
  const jointCard = (j) => {
    flags[j] = {
      alive: el("span", { class: "bch-flag" }, "enc"),
      rel: el("span", { class: "bch-flag" }, "release"),
      resc: el("span", { class: "bch-flag" }, "rescue"),
    };
    return el("div", { class: "bch-card" },
      el("h3", {}, j.toUpperCase(), flags[j].alive, flags[j].rel, flags[j].resc),
      chartBlock("angle · cmd vs measured (deg)", canvases, `ang:${j}`, false),
      chartBlock("tendon tension · flex / ext (N)", canvases, `ten:${j}`, true),
      chartBlock("spring stretch · flex / ext (mm)", canvases, `str:${j}`, true),
      chartBlock("goal current (mA)", canvases, `cur:${j}`, false));
  };

  const grid = el("div", { class: "bch-grid" }, jointCard("mcp"), jointCard("pip"));

  // ---- controls: targets + mode, through the bridge's sea_target relay ----
  const sliders = {};
  const sliderOut = {};
  const sliderBlock = (j) => {
    const [lo, hi] = JLIMIT[j];
    const input = el("input", { type: "range", min: lo, max: hi, step: 1, value: 0 });
    const out = el("span", { class: "bch-val" }, "0°");
    sliders[j] = input;
    sliderOut[j] = out;
    input.addEventListener("input", () => {
      out.textContent = `${input.value}°`;
      moved.add(j);
      sendTargets();
    });
    return el("div", { class: "bch-slider" },
      el("div", { class: "bch-row" },
        el("span", { class: "bch-lab" }, `${j} target`), out),
      input);
  };
  let sendTimer = null;
  const moved = new Set();                     // joints whose slider the operator actually moved
  function sendTargets() {
    if (sendTimer) return;                     // ~10 Hz while dragging
    sendTimer = setTimeout(() => {
      sendTimer = null;
      // send ONLY the moved joint. The relay treats a missing key as "unchanged",
      // so transmitting both would command the untouched joint to whatever its
      // slider happens to read (0 on a fresh mount) and physically drive it there.
      const target = {};
      for (const j of moved) target[`${j}_deg`] = Number(sliders[j].value);
      moved.clear();
      if (Object.keys(target).length) store.send({ cmd: "sea_target", target });
    }, 100);
  }
  // A slider the operator is not holding FOLLOWS the runner's own target, so it
  // can never sit at a stale 0 while the joint tracks 45 deg.
  function syncSliders(sea) {
    for (const j of JOINTS) {
      const d = sea.joints[j];
      if (!d || typeof d.target_deg !== "number" || !isFinite(d.target_deg)) continue;
      if (moved.has(j) || document.activeElement === sliders[j]) continue;
      const [lo, hi] = JLIMIT[j];
      const v = String(Math.round(clamp(d.target_deg, lo, hi)));
      if (sliders[j].value !== v) { sliders[j].value = v; sliderOut[j].textContent = `${v}°`; }
    }
  }
  const action = (a) => () => store.send({ cmd: "sea_target", action: a });
  const controls = el("div", { class: "bch-ctl" },
    sliderBlock("mcp"), sliderBlock("pip"),
    el("div", { class: "bch-btns" },
      el("button", { class: "bch-btn" , onclick: action("home") }, "Home"),
      el("button", { class: "bch-btn primary", onclick: action("run") }, "Run"),
      el("button", { class: "bch-btn", onclick: action("stop") }, "Stop")));

  const root = el("div", { class: "bch" },
    el("div", { class: "bch-head" },
      // same dead end the IMU bench had: this surface replaces the console, so
      // it owes the reader an explicit way back
      el("a", { class: "bch-back", href: "#/operator", title: "Back to the console" },
        "← Console"),
      el("div", {},
        el("div", { class: "bch-kicker" }, "Bench · Series-elastic control"),
        el("h2", { class: "bch-title" }, "The loop, visibly working.")),
      el("div", { class: "bch-chips" }, chips.link, chips.sim, chips.mode)),
    el("p", { class: "bch-sub" },
      "Commanded vs measured joint angle, and the spring model working as a force sensor. ",
      "Tensions and stretches are estimates from identified spring deflection, not load-cell readings."),
    none, grid, controls);

  for (const j of JOINTS) {
    const [lo, hi] = JLIMIT[j];
    charts[`ang:${j}`] = new StripChart(canvases[`ang:${j}`], { min: lo, max: hi, windowMs: 10000 });
    charts[`ten:${j}`] = new StripChart(canvases[`ten:${j}`], { min: 0, max: 16, windowMs: 10000, fill: false });
    charts[`str:${j}`] = new StripChart(canvases[`str:${j}`], { min: -3, max: STROKE_MM + 2, windowMs: 10000, fill: false });
    charts[`cur:${j}`] = new StripChart(canvases[`cur:${j}`], { min: -160, max: 160, windowMs: 10000, fill: false });
  }

  const setVal = (name, text) => {
    const n = root.querySelector(`[data-val="${name}"]`);
    if (n) n.textContent = text;
  };

  const unFrame = store.onFrame(() => {
    const s = store.snap;
    const sea = s && s.sea;
    const has = !!(sea && sea.joints);
    none.style.display = has ? "none" : "";
    grid.style.display = has ? "" : "none";
    controls.style.display = has ? "" : "none";
    chips.link.textContent = has ? "runner live" : "no runner";
    chips.link.className = "bch-chip" + (has ? " live" : "");
    if (!has) return;
    chips.sim.textContent = sea.sim ? "sim plant" : "hardware";
    chips.sim.className = "bch-chip" + (sea.sim ? " warn" : " live");
    chips.mode.textContent = sea.mode || "";
    syncSliders(sea);
    const tNow = s.t_ms;
    for (const j of JOINTS) {
      const d = sea.joints[j];
      if (!d) continue;
      const F = flags[j];
      F.alive.textContent = d.enc_alive ? "enc ok" : "enc FALLBACK";
      F.alive.className = "bch-flag" + (d.enc_alive ? "" : " on");
      F.rel.textContent = d.released ? `release ${d.released}` : "release —";
      F.rel.className = "bch-flag" + (d.released ? " on" : "");
      F.resc.textContent = d.rescued ? "RESCUE" : "rescue —";
      F.resc.className = "bch-flag" + (d.rescued ? " on" : "");
      charts[`ang:${j}`].draw([
        { ...toSeries(`sea:tgt:${j}`), color: "#8B8474", fill: false },
        { ...toSeries(`sea:th:${j}`), color: "#C9401B" },
      ], tNow);
      charts[`ten:${j}`].draw([
        { ...toSeries(`sea:tf:${j}`), color: "#C9401B" },
        { ...toSeries(`sea:te:${j}`), color: "#5F8A5C" },
      ], tNow);
      charts[`str:${j}`].draw([
        { ...toSeries(`sea:xf:${j}`), color: "#C9401B" },
        { ...toSeries(`sea:xe:${j}`), color: "#5F8A5C" },
      ], tNow);
      charts[`cur:${j}`].draw([{ ...toSeries(`sea:i:${j}`), color: "#C08327" }], tNow);
      setVal(`ang:${j}`, `${fmt(d.target_deg)}° → ${fmt(d.theta_deg)}°`);
      setVal(`ten:${j}`, d.tension_est_n
        ? `${fmt(d.tension_est_n.flex)} / ${fmt(d.tension_est_n.ext)} N` : "—");
      setVal(`str:${j}`, d.stretch_est_mm
        ? `${fmt(d.stretch_est_mm.flex)} / ${fmt(d.stretch_est_mm.ext)} mm` : "—");
      setVal(`cur:${j}`, `${fmt(d.i_ma)} mA`);
    }
  });
  cleanups.push(unFrame);

  function toSeries(name) {
    const ser = store.getSeries(name);
    return ser ? { t: ser.t, v: ser.v } : { t: [], v: [] };
  }
  const fmt = (v) => (typeof v === "number" && isFinite(v) ? v.toFixed(1) : "—");

  rootHost.append(root);
  return () => {
    for (const c of cleanups) c();
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }   // no sea_target after unmount
    root.remove();                                                  // the router's unmount contract
  };
}
