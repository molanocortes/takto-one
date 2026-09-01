// operator.js - the engineer's console. Instrument register: a calm dark
// cockpit around the live twin, with Health one tab away, developer tools
// behind one door, and a projector-grade Demo overlay.

import { el, svg, clamp, lerp, toast, fmtClock } from "../ui.js";
import { store } from "../store.js";
import { Twin } from "../twin.js";
import { StripChart, drawSpark } from "../charts.js";
import { unwrapCircularValues } from "../circular.js";
import { DeviceScreen, MODES, MODE_LABEL } from "../device_screen.js";

const FINGERS = ["index", "middle", "ring", "pinky"];
const SEGS = ["mcp", "pip", "dip"];
const JOINTS = FINGERS.flatMap((f) => SEGS.map((s) => `${f}_${s}`));
const N_CH = 14;

function backGlyph() {
  return svg("svg", { viewBox: "0 0 16 16", width: 16, height: 16 },
    svg("path", { d: "M 10 3 L 5 8 L 10 13", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }));
}

// small ring gauge (SVG), returns {node, set(v01, label)}
function ringGauge(size = 92, stroke = 5) {
  const r = (size - stroke * 2) / 2, c = 2 * Math.PI * r, cx = size / 2;
  const fill = svg("circle", { cx, cy: cx, r, fill: "none", stroke: "#2F76BF", "stroke-width": stroke,
    "stroke-linecap": "round", "stroke-dasharray": c, "stroke-dashoffset": c, transform: `rotate(-90 ${cx} ${cx})`,
    style: "transition: stroke-dashoffset 120ms linear" });
  const node = svg("svg", { viewBox: `0 0 ${size} ${size}`, class: "ring-gauge" },
    svg("circle", { cx, cy: cx, r, fill: "none", stroke: "rgba(35, 30, 22, 0.14)", "stroke-width": stroke }), fill);
  return { node, set(v) { fill.setAttribute("stroke-dashoffset", String(c * (1 - clamp(v, 0, 1)))); } };
}

// Schematic preview of an on-device face. These are crude abstractions drawn
// here in the browser, NOT renders of the 240x240 screen, and the panel says so
// beside them. Tint rides currentColor, so the caller only sets a color on the
// card. An unknown id still draws something: the face list is the device's, not
// ours, and it may grow.
function watchFaceThumb(faceId) {
  const c = 24, kids = [svg("circle", { cx: c, cy: c, r: 22, fill: "#15141A" })];
  if (faceId === "thesis") {
    const r = 15, circ = 2 * Math.PI * r;
    kids.push(svg("circle", { cx: c, cy: c, r, fill: "none", stroke: "currentColor", "stroke-width": 2.4, "stroke-opacity": 0.24 }),
      svg("circle", { cx: c, cy: c, r, fill: "none", stroke: "currentColor", "stroke-width": 2.4,
        "stroke-linecap": "round", "stroke-dasharray": `${(circ * 0.62).toFixed(1)} ${circ.toFixed(1)}`,
        transform: `rotate(-90 ${c} ${c})` }),
      svg("text", { x: c, y: 28.5, "text-anchor": "middle", fill: "currentColor",
        "font-size": 13, "font-weight": 600, "font-family": "ui-monospace, monospace" }, "62"));
  } else if (faceId === "ferro") {
    kids.push(svg("path", { d: "M25 11c7 .4 11 5.6 10.4 12.2-.6 6.8-6.2 12.2-12.8 11.6C16 34.2 12 29 12.6 22.4 13.2 16 18.4 10.6 25 11z",
        fill: "currentColor", "fill-opacity": 0.2 }),
      svg("path", { d: "M13.4 21C15 14.8 19.4 11.2 25 11", fill: "none", stroke: "currentColor",
        "stroke-width": 2.2, "stroke-linecap": "round" }));
  } else if (faceId === "rams") {
    for (let i = 0; i <= 12; i++) {
      const a = ((-135 + i * 22.5) * Math.PI) / 180, sn = Math.sin(a), cs = Math.cos(a);
      const idx = i === 9;
      kids.push(svg("line", { x1: c + sn * (idx ? 10 : 13), y1: c - cs * (idx ? 10 : 13),
        x2: c + sn * 17.5, y2: c - cs * 17.5, stroke: "currentColor",
        "stroke-width": idx ? 2.2 : 1.4, "stroke-opacity": idx ? 1 : 0.32, "stroke-linecap": "round" }));
    }
    kids.push(svg("circle", { cx: c, cy: c, r: 1.8, fill: "currentColor" }));
  } else {
    kids.push(svg("circle", { cx: c, cy: c, r: 15, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-opacity": 0.5 }),
      svg("text", { x: c, y: 28.5, "text-anchor": "middle", fill: "currentColor",
        "font-size": 13, "font-weight": 600, "font-family": "ui-monospace, monospace" },
        (faceId || "?").slice(0, 1).toUpperCase()));
  }
  return svg("svg", { viewBox: "0 0 48 48", class: "wf-thumb", "aria-hidden": "true" }, ...kids);
}

// The watch-face settings panel. The face list is NEVER hard-coded: it arrives
// as a `watch_catalog` frame and this renders whatever that frame holds
// (DATA_CONTRACT.md, "the on-device watch face"). snap.watch is the only
// statement about what the screen actually shows, so the panel follows it and
// never treats its own click as proof the device changed.
function buildWatchPanel(cleanups) {
  const waiting = el("p", { class: "tool-note" }, "Waiting for the face catalog from the host.");
  const faceRow = el("div", { class: "wf-faces" });
  const cwName = el("span", { class: "wf-cw-name" }, "—");
  const cwHead = el("div", { class: "wf-cw-head" }, el("span", { class: "vital-k" }, "colorway"), cwName);
  const swatchRow = el("div", { class: "wf-sws" });
  // TAKTO has one production interface. Do not mount the archived face-picker
  // at all: a stale bridge catalog must never bring Ferro/Rams buttons back.
  const node = el("div", { class: "wf" }, waiting, cwHead, swatchRow);

  let catalog = null;
  let cur = null;         // snap.watch / the last watch ack
  let pending = null;     // {face, colorway} just commanded, cleared by state or an error
  let swFace = null;      // which face the swatch row currently belongs to
  const cards = new Map();

  const faces = () => (catalog && catalog.faces) || [];
  const productionFace = () => faces().find((f) => f.id === "thesis") || faces()[0] || null;
  const faceOf = (id) => faces().find((f) => f.id === id) || null;
  const cwOf = (face, id) => ((face && face.colorways) || []).find((c) => c.id === id) || null;
  function tintOf(face, cwId) {
    const list = (face && face.colorways) || [];
    const cw = list.find((c) => c.id === cwId) || list.find((c) => c.canonical) || list[0];
    return cw ? `rgb(${cw.rgb.join(",")})` : "var(--text-2)";
  }

  function buildFaces() {
    faceRow.textContent = "";
    cards.clear();
    faceRow.style.display = "none";
  }

  function buildSwatches(face) {
    swFace = face.id;
    swatchRow.textContent = "";
    for (const cw of face.colorways || []) {
      const risk = (cw.note || "").includes("[panel-risk]");
      const b = el("button", { class: "wf-sw" + (cw.canonical ? "" : " alt"), dataset: { cw: cw.id },
        title: `${cw.name}${cw.canonical ? "" : " (non-canonical)"}${cw.note ? ": " + cw.note : ""}` },
        el("span", { class: "wf-dot" }),
        risk ? el("span", { class: "wf-risk", title: "legibility warning from the design canon" }) : null);
      b.style.setProperty("--sw", `rgb(${cw.rgb.join(",")})`);
      b.addEventListener("click", () => {
        pending = { face: face.id, colorway: cw.id };
        // Include the sole production face so an old Ferro/Rams selection in
        // a running bridge cannot receive a color command for the wrong face.
        store.send({ cmd: "watch", face: face.id, colorway: cw.id });
        render();
      });
      swatchRow.append(b);
    }
  }

  function render() {
    const has = faces().length > 0;
    waiting.style.display = has ? "none" : "";
    faceRow.style.display = "none";
    for (const [id, card] of cards) {
      const on = !!cur && cur.face === id;
      card.classList.toggle("on", on);
      card.classList.toggle("pending", !!pending && pending.face === id && !on);
      card.style.color = tintOf(faceOf(id), on ? cur.colorway : null);
    }

    const face = productionFace();
    cwHead.style.display = face ? "" : "none";
    swatchRow.style.display = face ? "" : "none";
    if (face) {
      if (swFace !== face.id) buildSwatches(face);
      for (const b of swatchRow.children) {
        const currentCw = cur && cur.face === face.id ? cur.colorway : face.colorways[0]?.id;
        const on = currentCw === b.dataset.cw;
        b.classList.toggle("on", on);
        b.classList.toggle("pending", !!pending && pending.colorway === b.dataset.cw && !on);
      }
      const activeColorway = cur && cur.face === face.id ? cur.colorway : face.colorways[0]?.id;
      const cw = cwOf(face, activeColorway);
      cwName.textContent = cw ? cw.name : activeColorway || "—";
    }

  }

  cleanups.push(store.onKind("watch_catalog", (f) => {
    catalog = f; swFace = null; buildFaces(); render();
  }));
  cleanups.push(store.onSnap((s) => {
    const w = s.watch;
    if (!w) return;
    if (cur && cur.face === w.face && cur.colorway === w.colorway
        && cur.persisted === w.persisted && cur.source === w.source && !pending) return;
    cur = w;
    if (pending && pending.face === w.face && (!pending.colorway || pending.colorway === w.colorway)) pending = null;
    render();
  }));
  cleanups.push(store.onAck((a) => {
    if (a.event === "watch") {
      cur = { face: a.face, colorway: a.colorway, persisted: !!a.persisted, source: a.source || "host" };
      pending = null;
      render();
    } else if (a.event === "error" && a.cmd === "watch") {
      pending = null;
      render();                        // visible selection falls back to snap.watch
      toast(a.error === "unknown_face" ? "Unknown face; the device kept its own."
        : "Unknown colorway; the device kept its own.", { tone: "warn" });
    }
  }));
  store.send({ cmd: "watch", action: "list" });   // in case the join push predates this mount
  render();
  return node;
}

// angular distance between two unit quaternions [w,x,y,z], in degrees. Divided by
// the sample dt this gives the body's angular SPEED (deg/s) regardless of axis.
function quatAngleDeg(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return null;
  const na = Math.hypot(...a), nb = Math.hypot(...b);
  if (!Number.isFinite(na) || !Number.isFinite(nb) || na < 0.5 || nb < 0.5) return null;
  // Snapshots round quaternions to four decimals. Normalize before the dot or
  // two identical rounded poses appear to move at ~17 deg/s; zero quaternions
  // previously appeared to move 180 degrees every frame (~9000 deg/s).
  let dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / (na * nb);
  dot = Math.min(1, Math.max(-1, Math.abs(dot)));
  return (2 * Math.acos(dot) * 180) / Math.PI;
}

// Fallback device_ui when the bridge doesn't provide one (e.g. mock): derive the
// stage from the console's own state so the device-screen twin still animates.
function deriveDeviceUi(sm, snap) {
  const act = snap.activation || {};
  const rec = snap.session && snap.session.recording;
  let screen = "home";
  if (snap.state === "fault") screen = "safe";
  else if (rec) screen = "capture";
  else if (act.present) screen = "transparent";
  const j = (snap.joints || []).find((x) => x.id === "index_pip");
  const ang = j && j.ok ? Math.max(0, Math.min(90, ((j.deg - 8) / 52) * 90)) : 0;
  const h = {};
  for (const x of snap.health || []) h[x.stream] = x.ok;
  return {
    screen, mode: "transparent", menuIndex: 1,
    modes: ["home", "transparent", "capture", "operator", "calibrate"],
    health: { imu: h.imu, enc: h.encoders, drv: h.motors, lnk: h.link },
    boot: 1, angleDeg: Math.round(ang), targetDeg: 62,
    effort: act.level || 0, assist: (act.level || 0) > 0.15,
    recSec: 0, recording: !!rec, takeName: "rec-live",
    calStep: 0, calProgress: 0, source: "web",
  };
}

export function mountOperator(rootHost) {
  localStorage.setItem("zero.role", "operator");
  const root = el("div", { class: "surf op" });
  const cleanups = [];

  // ============ top bar ============
  const statePillDot = el("span", { class: "dot ok" });
  const statePillText = el("span", null, "ready");
  const statePill = el("div", { class: "pill" }, statePillDot, statePillText);
  const segLive = el("button", { class: "on" }, "Live");
  const segHealth = el("button", null, "Health");
  const seg = el("div", { class: "seg" }, segLive, segHealth);
  const btnDemo = el("button", { class: "btn ghost sm" }, "Demo");
  // MOCK badge: the console silently defaults to simulated data when it is not
  // pointed at the live bridge. Make that state loud, and one click connects live.
  const mockBadge = el("button", { class: "mock-badge", title: "Showing simulated data. Click to connect to the live bridge (ws://localhost:8765/ws)." }, "MOCK DATA");
  mockBadge.addEventListener("click", () => {
    const u = new URL(location.href);
    u.searchParams.set("ws", "ws://localhost:8765/ws");
    location.href = u.toString();   // full reload into live mode (also remembered)
  });
  if (store.live) mockBadge.style.display = "none";
  // LINK badge: live mode with the bridge unreachable is NOT the same as mock
  // data; say so instead of silently holding the last frame.
  const linkBadge = el("button", { class: "mock-badge",
    title: "The live bridge is not answering. Reconnecting automatically; click to reload now." }, "LINK DOWN");
  linkBadge.addEventListener("click", () => location.reload());
  linkBadge.style.display = "none";
  if (store.live) {
    const updLink = (up) => { linkBadge.style.display = up ? "none" : ""; };
    updLink(store.connected);
    cleanups.push(store.onLink(updLink));
  }
  const bar = el("header", { class: "surf-bar" },
    el("div", { class: "surf-bar-left" },
      el("span", { class: "surf-back", "aria-hidden": "true" }, backGlyph()),
      el("span", { class: "wordmark sm" }, el("span", { class: "wordmark-dot" }), "TAKTO"),
      el("div", { class: "surf-name" }, "Operator")),
    el("div", { class: "surf-bar-mid" }, seg),
    el("div", { class: "surf-bar-right" }, mockBadge, linkBadge, statePill));

  // ============ LIVE tab ============
  // --- vitals column ---
  const dotDevice = el("span", { class: "dot ok" });
  const dotMotors = el("span", { class: "dot ok" });
  const vDevice = el("span", { class: "num vital-v" }, "30 Hz");
  const vMotors = el("span", { class: "num vital-v" }, "2");
  const linkDots = el("div", { class: "vital-rows" },
    el("div", { class: "vital-row" }, dotDevice, el("span", { class: "vital-k" }, "device"), vDevice),
    el("div", { class: "vital-row" }, dotMotors, el("span", { class: "vital-k" }, "motors"), vMotors));
  const vLink = el("div", { class: "card vital" }, el("div", { class: "kicker" }, "Link"), linkDots);

  // transparency crown: the device pot sweeps fully transparent (zero force,
  // pure follow) -> fully assisted, Apple-crown style. Rendered from the 60 fps
  // smoothed value so the dial glides with the physical knob.
  const blendFill = el("div", { class: "blend-fill" });
  const blendTrack = el("div", { class: "blend-track" }, blendFill);
  const blendWord = el("span", { class: "vital-k" }, "transparent");
  const blendPct = el("span", { class: "num vital-v" }, "");
  const vBlend = el("div", { class: "card vital" },
    el("div", { class: "kicker" }, "Transparency"),
    blendTrack,
    el("div", { class: "vital-row" }, blendWord, blendPct));
  vBlend.style.display = "none";                 // shown once the host reports a crown
  cleanups.push(store.onSnap((s) => {
    vBlend.style.display = s.blend && s.blend.present ? "" : "none";
  }));
  cleanups.push(store.onFrame((sm) => {
    if (sm.blend == null) return;
    const a = sm.blend;
    blendFill.style.width = (a * 100).toFixed(1) + "%";
    blendPct.textContent = Math.round(a * 100) + " %";
    blendWord.textContent = a < 0.15 ? "transparent" : a > 0.85 ? "assisted" : "blended";
  }));

  // motors: which are online + working. The motor bus is host-owned (U2D2), so
  // this stays "offline" until the motor host is bridged; then each motor lights
  // up here (green = torque on / working, amber = online but idle).
  const motorStatusRows = {};   // id -> { dot, val, node }
  const motorStatusList = el("div", { class: "vital-rows motor-status-list" });
  const motorStatusEmpty = el("div", { class: "vital-row motor-status-empty" },
    el("span", { class: "dot" }), el("span", { class: "vital-k" }, "no motors online"));
  motorStatusList.append(motorStatusEmpty);
  const vMotorsFoot = el("div", { class: "vital-foot num" }, "offline");
  // read-only now: the motor CONTROLS went with the developer drawer, so this
  // card no longer advertises a door that does not exist
  const vMotorsCard = el("div", { class: "card vital", title: "Motor status" },
    el("div", { class: "vital-krow" }, el("span", { class: "kicker" }, "Motors")),
    motorStatusList, vMotorsFoot);

  // frames: orientation dial + live angular SPEED (deg/s) per body; the header
  // shows the pipeline update rate (Hz) = how fast everything is running.
  const mkFrame = (label) => {
    const needle = el("div", { class: "frame-needle" });
    const roll = el("div", { class: "frame-dial" }, needle);
    const spd = el("span", { class: "num frame-spd" }, "0");
    return {
      node: el("div", { class: "vital-row frame-row" }, roll, el("span", { class: "vital-k" }, label),
        el("span", { class: "frame-val" }, spd, el("span", { class: "frame-unit" }, "°/s"))),
      needle, spd,
    };
  };
  const fHand = mkFrame("hand");
  const fFore = mkFrame("forearm");
  const framesRate = el("span", { class: "num frames-rate" }, "— Hz");
  const framesZero = el("button", { class: "frames-zero", title: "Set home: hold the straight pose, then click" }, "zero");
  framesZero.addEventListener("click", () => {
    store.send({ cmd: "calibrate", what: "imu" });
    toast("Home set to current pose", { tone: "ok" });
  });
  const vFrames = el("div", { class: "card vital" },
    el("div", { class: "vital-krow" }, el("span", { class: "kicker" }, "Frames"),
      el("span", { class: "frames-head-right" }, framesZero, framesRate)),
    el("div", { class: "vital-rows" }, fHand.node, fFore.node));

  // effort ring = EMG activation (Fable module: BayesianAmplitude + auto MVC)
  const effortGauge = ringGauge(96, 5);
  const effortVal = el("div", { class: "effort-val num" }, "0 %");
  const effortTag = el("span", { class: "effort-tag" }, "EMG");
  const effortFoot = el("div", { class: "vital-foot num effort-foot" }, "no EMG");
  const vEffort = el("div", { class: "card vital vital-effort", title: "A calm, display-only view of normalized EMG activity. It does not affect assistance control." },
    el("div", { class: "vital-krow effort-krow" }, el("span", { class: "kicker" }, "Effort"), effortTag),
    el("div", { class: "effort-wrap" }, effortGauge.node, effortVal),
    effortFoot);

  // EMG is sampled quickly so the control system can remain responsive.  The
  // person wearing the device should not have to watch a nervous 50–60 Hz
  // number, though.  This display-only channel eases over 1.6 s, then exposes
  // calm five-percent steps at most four times per second.  It never feeds
  // motor control or changes the recorded/raw signal.
  const calmEffort = { value: 0, shownPct: 0, lastT: null, lastPaintT: 0, ready: false };
  function presentEffort(raw, now) {
    const target = clamp(Number(raw) || 0, 0, 1);
    if (!calmEffort.ready) {
      calmEffort.value = target;
      calmEffort.shownPct = Math.round(target * 20) * 5;
      calmEffort.ready = true;
      calmEffort.lastT = now;
      calmEffort.lastPaintT = now;
      return { value: calmEffort.value, pct: calmEffort.shownPct, paint: true };
    }
    const dt = Math.min(250, Math.max(0, now - calmEffort.lastT));
    calmEffort.lastT = now;
    const alpha = 1 - Math.exp(-dt / 1600);
    calmEffort.value += (target - calmEffort.value) * alpha;
    const pct = Math.round(clamp(calmEffort.value, 0, 1) * 20) * 5;
    const paint = pct !== calmEffort.shownPct && now - calmEffort.lastPaintT >= 250;
    if (paint) { calmEffort.shownPct = pct; calmEffort.lastPaintT = now; }
    return { value: calmEffort.value, pct: calmEffort.shownPct, paint };
  }

  // calibration card: opens the guided range-of-motion sweep
  const calibBtn = el("button", { class: "btn primary sm vcalib-btn" }, "Calibrate hand");
  calibBtn.addEventListener("click", () => calib.open());
  const vCalib = el("div", { class: "card vital vcalib" },
    el("div", { class: "kicker" }, "Calibration"),
    el("div", { class: "vcalib-hint" }, "Learn the finger's open ↔ closed range"),
    calibBtn);
  const vitals = el("div", { class: "op-vitals" }, vLink, vBlend, vMotorsCard, vFrames, vCalib, vEffort);

  // --- stage (twin) ---
  const stage = el("div", { class: "op-stage panel" });
  const stageTag = el("div", { class: "stage-tag" }, el("span", { class: "dot live" }), el("span", { class: "mono" }, "LIVE TWIN"));
  const stageHint = el("div", { class: "stage-hint mono" }, "drag to orbit");
  // "Correct the twin" lives ON the stage, because the moment you want it is the
  // moment you are looking at a wrong pose. It captures the pose the device is
  // held in RIGHT NOW as home, which is what makes the live twin sit where the
  // disconnected one does. The same command is on the tiny FRAMES "zero" button,
  // which nobody could find.
  const stageFix = el("button", { class: "stage-fix" }, "Correct the twin");
  const stageFixNote = el("div", { class: "stage-fix-note mono" },
    "hold the device straight, then click");
  stageFix.addEventListener("click", () => {
    store.send({ cmd: "calibrate", what: "imu" });
    stageFix.classList.add("busy");
    stageFix.textContent = "Capturing…";
    // the ack only says the capture was ARMED; the tare lands on the next live
    // frame, so confirm against the twin's own input rather than the ack
    setTimeout(() => {
      stageFix.classList.remove("busy");
      stageFix.textContent = "Correct the twin";
    }, 1200);
  });
  stage.append(stageTag, stageHint, stageFix, stageFixNote);

  // --- charts column ---
  const mkChart = (label, sub) => {
    const cv = el("canvas", { class: "chart-cv" });
    const val = el("span", { class: "num chart-val" }, "");
    const node = el("div", { class: "card chart-card" },
      el("div", { class: "chart-head" }, el("span", { class: "kicker" }, label), val), cv);
    return { node, cv, val };
  };
  const chEff = mkChart("Effort");
  const chCur = mkChart("Motor current");
  chCur.node.classList.add("clickable", "motor-current-card");
  chCur.node.title = "Open motor telemetry";

  // encoder control board (replaces the old Curl strip): one LED per physical
  // channel, lit when present, glowing when moving; click a channel to maximize.
  const encChips = {};
  const encLast = {};
  const encGrid = el("div", { class: "enc-grid" });
  for (let ch = 0; ch < N_CH; ch++) {
    const light = el("span", { class: "dot" });
    const val = el("span", { class: "enc-chip-val num" }, "—");
    const chip = el("button", { class: "enc-chip absent", title: `channel ${ch} — click to inspect` },
      light, el("span", { class: "enc-chip-ch mono" }, String(ch).padStart(2, "0")), val);
    chip.addEventListener("click", () => inspector.open("enc", ch));
    encChips[ch] = { chip, light, val };
    encGrid.append(chip);
  }
  const encFoot = el("span", { class: "num enc-foot" }, "0 / 14");
  const encBoard = el("div", { class: "card enc-board" },
    el("div", { class: "chart-head" }, el("span", { class: "kicker" }, "Encoders"), encFoot),
    encGrid);

  // device screen twin: the physical GC9A01 face, driven by the bridge's device_ui
  // (falls back to a local derivation on mock). The nav row emulates the on-device
  // encoder (what the wearer can do); the mode row jumps straight to a named screen
  // (what an operator wants) without stepping through the crown menu.
  const deviceCanvas = el("canvas", { class: "device-screen-cv" });
  const deviceScreen = new DeviceScreen(deviceCanvas);
  const dsSrc = el("span", { class: "ds-src mono" }, "");
  // [BENCH 2026-08-06] Every one of these checks the send result. A command that
  // never left the browser must not leave the UI pretending it did - that is the
  // bug where a click set "pending", the link was down, and the button stayed
  // outlined forever waiting on an ack that could not arrive.
  const dsLinkDown = () => toast("Link down - command not sent. Reconnecting…", { tone: "warn" });
  const dsNav = (label, cls, cmd) => {
    const b = el("button", { class: "ds-nav " + cls }, label);
    b.addEventListener("click", () => { if (!store.send(cmd)) dsLinkDown(); });
    return b;
  };

  // direct screen select: one pending command in flight at a time, cleared by
  // its own ack or by the snapshot catching up, same idiom as the watch panel
  let dsPending = null;    // the screen name just requested (or "home"), until confirmed
  const dsModeBtns = new Map();
  const dsModeRow = el("div", { class: "ds-mode-row" });
  for (const m of MODES) {
    const b = el("button", { class: "ds-mode-btn" }, MODE_LABEL[m] || m.toUpperCase());
    b.addEventListener("click", () => {
      if (!store.send({ cmd: "device", action: "screen", screen: m, source: "website" })) {
        dsLinkDown();
        return;                       // no pending state for a command that never went out
      }
      dsPending = m;
      updateDeviceControls(lastDui);
    });
    dsModeBtns.set(m, b);
    dsModeRow.append(b);
  }
  const dsHomeBtn = el("button", { class: "ds-mode-btn ds-home" }, "Home");
  dsHomeBtn.addEventListener("click", () => {
    if (!store.send({ cmd: "device", action: "home", source: "website" })) {
      dsLinkDown();
      return;
    }
    dsPending = "home";
    updateDeviceControls(lastDui);
  });
  dsModeRow.append(dsHomeBtn);
  const dsOverride = el("p", { class: "ds-override" }, "");

  let lastDui = null;
  function updateDeviceControls(dui) {
    lastDui = dui;
    if (!dui) return;
    const requested = dui.requested || dui.screen || "home";
    for (const [m, b] of dsModeBtns) {
      b.classList.toggle("on", requested === m);
      b.classList.toggle("pending", dsPending === m && requested !== m);
    }
    dsHomeBtn.classList.toggle("on", requested === "home");
    dsHomeBtn.classList.toggle("pending", dsPending === "home" && requested !== "home");
    if (dsPending && requested === dsPending) dsPending = null;
    dsOverride.textContent = dui.override
      ? `Showing ${MODE_LABEL[dui.screen] || dui.screen} instead — ${dui.override}.`
      : "";
    dsOverride.style.display = dui.override ? "" : "none";
  }
  // A pending request is only meaningful while the link is up: its ack comes over
  // that socket. If the link drops, the ack is never coming, so clear it rather
  // than leaving a button outlined indefinitely.
  cleanups.push(store.onLink((up) => {
    if (!up && dsPending) { dsPending = null; updateDeviceControls(lastDui); }
  }));
  cleanups.push(store.onAck((a) => {
    if (a.event === "device") { dsPending = null; updateDeviceControls(lastDui); }
    else if (a.event === "error" && a.cmd === "device") {
      dsPending = null; updateDeviceControls(lastDui);
      toast("Unknown screen; the device kept its own.", { tone: "warn" });
    }
  }));

  const deviceCard = el("div", { class: "card device-card" },
    el("div", { class: "chart-head" }, el("span", { class: "kicker" }, "Device screen"), dsSrc),
    el("div", { class: "device-screen-wrap" }, deviceCanvas),
    el("div", { class: "ds-nav-row" },
      dsNav("‹", "", { cmd: "device", action: "nav", dir: "ccw" }),
      dsNav("›", "", { cmd: "device", action: "nav", dir: "cw" })),
    // The face picker sits INSIDE the device-screen card, because the face is a
    // property of this screen and nothing else. It used to be five sections deep
    // in a drawer, which is why nobody could find it.
    el("div", { class: "ds-face-sep" }),
    buildWatchPanel(cleanups));

  const charts = el("div", { class: "op-charts" }, deviceCard, encBoard, chEff.node, chCur.node);
  const effChart = new StripChart(chEff.cv, { min: 0, max: 1, color: "#2F76BF" });
  const curChart = new StripChart(chCur.cv, { min: 0, max: 60, fill: false });

  // --- motor strip ---
  // The compact Motors card already reports both spools.  Keep the detailed
  // rows available to the data update below, but do not mount a second,
  // full-width copy beneath the grid: it was the element covering the lower
  // cards on shorter desktop viewports.
  const motorStrip = el("div", { class: "op-motorstrip card" });
  const liveGrid = el("div", { class: "op-live" }, vitals, stage, charts);

  // ============ HEALTH tab ============
  const healthSummary = el("h2", { class: "health-summary" }, "All streams healthy");
  const healthSummaryDot = el("span", { class: "dot ok health-summary-dot" });
  const healthGrid = el("div", { class: "op-health-grid" });
  const healthWrap = el("div", { class: "op-health" },
    el("div", { class: "health-summary-row" }, healthSummaryDot, healthSummary),
    healthGrid);
  const healthTiles = {};
  function healthTile(stream) {
    const dot = el("span", { class: "dot ok" });
    const rate = el("div", { class: "health-rate num" }, "-");
    const detail = el("div", { class: "health-detail mono" }, "");
    const node = el("div", { class: "card health-tile" },
      el("div", { class: "health-head" }, dot, el("span", { class: "health-name" }, stream)),
      rate, detail);
    healthTiles[stream] = { node, dot, rate, detail };
    healthGrid.append(node);
    return healthTiles[stream];
  }

  const body = el("main", { class: "surf-body" }, liveGrid);
  root.append(bar, body);

  // ============ tab switching ============
  let tab = "live";
  function setTab(t) {
    if (t === tab) return;
    tab = t;
    segLive.classList.toggle("on", t === "live");
    segHealth.classList.toggle("on", t === "health");
    const swap = () => { body.replaceChildren(t === "live" ? liveGrid : healthWrap); };
    document.startViewTransition ? document.startViewTransition(swap) : swap();
  }
  segLive.addEventListener("click", () => setTab("live"));
  segHealth.addEventListener("click", () => setTab("health"));

  // ============ INSPECTOR (maximize) ============
  const inspector = buildInspector(cleanups);
  root.append(inspector.node);
  const motorInspector = buildMotorInspector(cleanups);
  root.append(motorInspector.node);
  chCur.node.addEventListener("click", () => motorInspector.open());

  // ============ CALIBRATION (guided range-of-motion sweep) ============
  const calib = buildCalib(cleanups);
  root.append(calib.node);


  // ============ DEMO overlay ============
  const demo = buildDemo(cleanups);
  root.append(demo.node);

  rootHost.append(root);

  // ============ life ============
  const COCKPIT_FRAMING = {
    orbit: true, idle: true, autoFrame: true,
    yaw: -0.75, pitch: 0.34, dist: 6.4, targetY: -0.1, targetZ: 0.1,
    autoFrameMinDist: 4.8, autoFrameMaxDist: 9.2, autoFrameMargin: 1.18,
  };
  const twin = Twin.acquire(stage, COCKPIT_FRAMING);
  cleanups.push(() => twin.dispose());

  let motorRows = {};
  const frameKin = { prevT: null, prevHand: null, prevFore: null, rate: 0,
    hand: 0, fore: 0, handLive: false, foreLive: false };
  const offSnap = store.onSnap((s) => {
    // state pill
    const st = s.state || "ready";
    statePillText.textContent = st;
    statePillDot.className = "dot " + (st === "fault" ? "stop" : st === "running" ? "live" : "ok");

    // link
    dotDevice.className = "dot " + (s.link?.device ? "ok" : "stop");
    dotMotors.className = "dot " + (s.link?.motors ? "ok" : "stop");
    const linkH = (s.health || []).find((x) => x.stream === "link");
    if (linkH) vDevice.textContent = `${linkH.rate_hz} Hz`;
    vMotors.textContent = String((s.motors || []).length);

    // motors: which are online + working
    const motorsArr = s.motors || [];
    const seenMotors = new Set();
    let mOnline = 0, mWorking = 0;
    for (const m of motorsArr) {
      mOnline++;
      if (m.torque_on) mWorking++;
      seenMotors.add(m.id);
      let row = motorStatusRows[m.id];
      if (!row) {
        const dot = el("span", { class: "dot" });
        const val = el("span", { class: "num vital-v" }, "");
        const node = el("div", { class: "vital-row" }, dot, el("span", { class: "vital-k" }, m.id.replace("_", " ")), val);
        row = motorStatusRows[m.id] = { dot, val, node };
        motorStatusList.append(node);
      }
      row.dot.className = "dot " + (m.torque_on ? "ok" : "warn");
      row.val.textContent = m.torque_on ? `${(m.current_ma ?? 0).toFixed(0)} mA` : (m.mode || "idle");
    }
    for (const id of Object.keys(motorStatusRows)) {
      if (!seenMotors.has(id)) { motorStatusRows[id].node.remove(); delete motorStatusRows[id]; }
    }
    const anyMotors = motorsArr.length > 0;
    motorStatusEmpty.style.display = anyMotors ? "none" : "";
    if (!anyMotors) {
      const mh = (s.health || []).find((x) => x.stream === "motors");
      motorStatusEmpty.querySelector(".vital-k").textContent = (mh && mh.detail) || "no motors online";
    }
    vMotorsFoot.textContent = anyMotors ? `${mWorking} / ${mOnline} working` : "offline";
    vMotorsFoot.style.color = anyMotors && mWorking < mOnline ? "var(--warn)" : "";

    // frames: pipeline update rate (Hz) + per-body angular speed (deg/s), both
    // measured from the device timestamps so they hold even if rAF is throttled.
    const tNow = s.t_ms;
    if (frameKin.prevT != null) {
      const dt = (tNow - frameKin.prevT) / 1000;
      if (dt > 0.0005) {
        // keep the EMAs accurate on every sample, but only REPAINT the numbers a
        // few times a second - readable, and far fewer DOM writes (the rate barely
        // moves, so churning it 40x/s is wasted work).
        frameKin.rate = lerp(frameKin.rate || 1 / dt, 1 / dt, 0.2);
        const ah = frameKin.handLive && frameKin.prevHand ? quatAngleDeg(frameKin.prevHand, s.hand?.quat) : null;
        const af = frameKin.foreLive && frameKin.prevFore ? quatAngleDeg(frameKin.prevFore, s.forearm?.quat) : null;
        if (ah != null) frameKin.hand = lerp(frameKin.hand, ah / dt, 0.35);
        if (af != null) frameKin.fore = lerp(frameKin.fore, af / dt, 0.35);
        if (tNow - (frameKin.lastPaintT || 0) >= 400) {   // repaint <= ~2.5 Hz (device time)
          frameKin.lastPaintT = tNow;
          framesRate.textContent = `${frameKin.rate.toFixed(0)} Hz`;
          fHand.spd.textContent = frameKin.handLive ? (frameKin.hand < 1.5 ? 0 : frameKin.hand).toFixed(0) : "—";
          fFore.spd.textContent = frameKin.foreLive ? (frameKin.fore < 1.5 ? 0 : frameKin.fore).toFixed(0) : "—";
        }
      }
    }
    frameKin.prevT = tNow;
    frameKin.handLive = s.hand?.live !== false && quatAngleDeg(s.hand?.quat, s.hand?.quat) != null;
    frameKin.foreLive = s.forearm?.live !== false && quatAngleDeg(s.forearm?.quat, s.forearm?.quat) != null;
    frameKin.prevHand = frameKin.handLive ? s.hand.quat : null;
    frameKin.prevFore = frameKin.foreLive ? s.forearm.quat : null;

    // effort = EMG activation (Fable module output); onset flashes the card
    const act = s.activation || {};
    effortFoot.textContent = act.present ? ("EMG · " + (act.quality || "live")) : "no EMG (pin 14)";
    effortTag.classList.toggle("on", !!act.present);
    // Raw onset can flicker around a threshold; only the calm presentation
    // below changes the visual state.

    // health tiles
    let allOk = true;
    for (const h of s.health || []) {
      const tile = healthTiles[h.stream] || healthTile(h.stream);
      tile.dot.className = "dot " + (h.ok ? "ok" : "stop");
      tile.rate.textContent = h.ok ? `${h.rate_hz} Hz` : "—";
      tile.rate.style.color = h.ok ? "" : "var(--stop)";
      tile.detail.textContent = h.detail || (h.ok ? "streaming" : "no signal");
      tile.node.classList.toggle("bad", !h.ok);
      if (!h.ok) allOk = false;
    }
    healthSummary.textContent = allOk ? "All streams healthy" : "Attention needed";
    healthSummaryDot.className = "dot health-summary-dot " + (allOk ? "ok" : "stop");

    // motor strip
    for (const m of s.motors || []) {
      if (!motorRows[m.id]) {
        const row = {
          mode: el("span", { class: "chip sm-chip" }, m.mode),
          torque: el("span", { class: "dot" }),
          pos: el("span", { class: "num" }),
          cur: el("span", { class: "num" }),
          temp: el("span", { class: "num" }),
        };
        motorRows[m.id] = row;
        motorStrip.append(el("div", { class: "motor-row" },
          el("span", { class: "motor-name mono" }, m.id.replace("_", " ")),
          row.mode, row.torque,
          el("span", { class: "motor-kv" }, row.pos, el("span", { class: "motor-u" }, "deg")),
          el("span", { class: "motor-kv" }, row.cur, el("span", { class: "motor-u" }, "mA")),
          el("span", { class: "motor-kv" }, row.temp, el("span", { class: "motor-u" }, "°C"))));
      }
      const r = motorRows[m.id];
      r.mode.textContent = m.mode;
      r.torque.className = "dot " + (m.torque_on ? "ok" : "");
      r.pos.textContent = m.pos_deg.toFixed(1);
      r.cur.textContent = m.current_ma.toFixed(0);
      r.temp.textContent = m.temp_c.toFixed(0);
    }
  });
  cleanups.push(offSnap);

  // the twin renders every frame; charts and readouts at half rate
  let frameNo = 0;
  const offFrame = store.onFrame((sm, snap, dt) => {
    if (!snap) return;
    // forward the store's measured dt - the twin's easings are exp(-dt/tau)
    if ((tab === "live" || demo.isOpen()) && !inspector.isOpen()) twin.render(sm, dt);
    frameNo++;
    const draw2d = (frameNo & 1) === 0;
    if (tab === "live" && !demo.isOpen() && draw2d) {
      fHand.needle.style.transform = `rotate(${(sm.handQuat[3] * 180)}deg)`;
      fFore.needle.style.transform = `rotate(${(sm.forearmQuat[3] * 180)}deg)`;
      const calm = presentEffort(sm.activation.level, performance.now());
      effortGauge.set(calm.value);
      if (calm.paint) effortVal.textContent = `${calm.pct} %`;
      vEffort.classList.toggle("onset", calm.value >= 0.6);

      // encoder board: raw channel lights + live angles
      let encLive = 0;
      for (const e of snap.encoders || []) {
        const c = encChips[e.ch];
        if (!c) continue;
        if (e.ok) {
          encLive++;
          c.val.textContent = e.deg.toFixed(1) + "°";
          c.light.className = "dot ok";
          c.chip.classList.remove("absent");
          c.chip.classList.toggle("mv", Math.abs((encLast[e.ch] ?? e.deg) - e.deg) > 0.2);
          encLast[e.ch] = e.deg;
        } else {
          c.val.textContent = "—";
          c.light.className = "dot";
          c.chip.classList.add("absent");
          c.chip.classList.remove("mv");
        }
      }
      if (snap.encoders) encFoot.textContent = `${encLive} / ${N_CH}`;

      effChart.draw(store.getSeries("activation"), snap.t_ms);
      if (calm.paint) chEff.val.textContent = `${calm.pct} %`;

      // device screen twin: bridge-owned device_ui, or a local fallback on mock
      const dui = snap.device_ui || deriveDeviceUi(sm, snap);
      // device_ui owns the stage; snap.watch owns the selected face/colorway.
      // Both are required to mirror the physical 240 px screen faithfully.
      deviceScreen.render({
        ...dui,
        effort: calm.value,
        watch: snap.watch,
        joints: snap.joints,
        activationPresent: !!snap.activation,
        battery: snap.battery,
      }, performance.now());
      dsSrc.textContent = dui.source && dui.source !== "device" ? dui.source.toUpperCase() : "";
      updateDeviceControls(dui);
      const motorSeries = (snap.motors || []).map((m, i) => {
        const ser = store.getSeries("i:" + m.id);
        return ser ? { t: ser.t, v: ser.v, color: i === 0 ? "#2F76BF" : "#6B8FB8", fill: false } : null;
      }).filter(Boolean);
      curChart.draw(motorSeries, snap.t_ms);
      chCur.val.textContent = (snap.motors || []).map((m) => m.current_ma.toFixed(0)).join(" / ") + " mA";
    }
    if (inspector.isOpen() && draw2d) inspector.frame(sm, snap);
    if (motorInspector.isOpen() && draw2d) motorInspector.frame(snap);
    if (demo.isOpen() && draw2d) demo.frame(sm, snap);
  });
  cleanups.push(offFrame);

  // ---------------------------------------------------------------- tools --

  // ------------------------------------------------------------ inspector --
  // A maximized master-detail scope: pick a raw encoder channel or a joint on
  // the left, read its live value, windowed stats, and a large autoscaled trace
  // on the right. Shared by the encoder board (mode "enc") and the Joints card
  // (mode "joint"); both are the same physical channels seen two ways.
  function buildInspector(cleanups) {
    let opened = false, mode = "enc", sel = 0;
    const rows = {};              // id -> { row, light, val, sparkCv, it }
    let sparkTick = 0;

    function statBlock(k) {
      const val = el("span", { class: "v num" }, "—");
      return { node: el("div", { class: "insp-stat" }, el("span", { class: "k" }, k), val), val };
    }

    const scrim = el("div", { class: "insp-scrim" });
    const title = el("span", { class: "insp-title" }, "Encoders");
    const sub = el("span", { class: "insp-sub mono" }, "");
    const closeBtn = el("button", { class: "surf-back insp-close", title: "Close (Esc)" }, "✕");
    const segJoints = el("button", null, "Joints");
    const segEnc = el("button", null, "Encoders");
    const modeSeg = el("div", { class: "seg seg-sm insp-modeseg" }, segJoints, segEnc);
    segJoints.addEventListener("click", () => switchMode("joint"));
    segEnc.addEventListener("click", () => switchMode("enc"));
    const rail = el("div", { class: "insp-rail" });
    const bigVal = el("span", { class: "insp-big num" }, "—");
    const stState = statBlock("state");
    const stRate = statBlock("rate");
    const stMin = statBlock("min");
    const stMax = statBlock("max");
    const stRange = statBlock("range");
    const stMap = statBlock("maps to");
    const chartCv = el("canvas", { class: "insp-chart" });
    // wrap: 360 - this plots a RAW AS5600 angle, which is modulo 360. Without it
    // a joint crossing its zero draws a full-height vertical stroke that looks
    // like high-frequency thrashing the finger never did.
    const bigChart = new StripChart(chartCv, { min: 0, max: 360, wrap: 360, fill: true, width: 2.0, windowMs: 12000 });
    const main = el("div", { class: "insp-main" },
      el("div", { class: "insp-readout" }, bigVal, el("span", { class: "insp-unit" }, "°"),
        el("span", { class: "insp-stats" }, stState.node, stRate.node, stMin.node, stMax.node, stRange.node, stMap.node)),
      el("div", { class: "insp-chart-wrap" }, chartCv));
    const panel = el("div", { class: "insp-panel" },
      el("div", { class: "insp-head" }, title, sub, closeBtn),
      el("div", { class: "insp-body" }, rail, main));
    const node = el("div", { class: "op-inspector" }, scrim, panel);

    const items = () =>
      mode === "enc"
        ? Array.from({ length: N_CH }, (_, ch) => ({ id: ch, key: "e:" + ch, label: "CH " + String(ch).padStart(2, "0") }))
        : JOINTS.map((id) => ({ id, key: "j:" + id, label: id.replace("_", " ") }));

    const jointCh = (id) => {
      const e = (store.snap?.encoders || []).find((x) => x.joint === id);
      return e ? String(e.ch).padStart(2, "0") : "—";
    };

    function liveValue(it, sm, snap) {
      if (mode === "enc") {
        const e = (snap.encoders || []).find((x) => x.ch === it.id);
        return { ok: !!(e && e.ok), v: e && e.ok ? e.deg : 0 };
      }
      const j = (snap.joints || []).find((x) => x.id === it.id);
      const ok = !!(j && j.ok);
      return { ok, v: ok ? (sm.joints[it.id] ?? j.deg) : 0 };
    }

    function windowMinMax(ser, tNow, windowMs, wrap = null) {
      const t0 = tNow - windowMs;
      const vals = [];
      for (let i = 0; i < ser.t.length; i++) {
        if (ser.t[i] < t0) continue;
        vals.push(ser.v[i]);
      }
      if (!vals.length) return [0, 1];
      const display = wrap ? unwrapCircularValues(vals, wrap) : vals;
      let lo = Infinity, hi = -Infinity;
      for (const v of display) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return [lo, hi];
    }

    function buildRail() {
      rail.replaceChildren();
      for (const k of Object.keys(rows)) delete rows[k];
      for (const it of items()) {
        const light = el("span", { class: "dot" });
        const val = el("span", { class: "insp-row-val num" }, "—");
        const sparkCv = el("canvas", { class: "insp-spark" });
        const row = el("button", { class: "insp-row" },
          light, el("span", { class: "insp-row-label mono" }, it.label), val, sparkCv);
        row.addEventListener("click", () => select(it.id));
        rows[it.id] = { row, light, val, sparkCv, it };
        rail.append(row);
      }
    }

    function select(id) {
      sel = id;
      for (const [k, r] of Object.entries(rows)) r.row.classList.toggle("on", String(k) === String(id));
      sub.textContent = mode === "enc" ? "raw channel" : "joint angle";
    }

    function setModeUI(m) {
      title.textContent = m === "enc" ? "Encoders" : "Joints";
      segJoints.classList.toggle("on", m === "joint");
      segEnc.classList.toggle("on", m === "enc");
    }

    function isLive(id, m) {
      const snap = store.snap;
      if (!snap) return false;
      if (m === "enc") { const e = (snap.encoders || []).find((x) => x.ch === id); return !!(e && e.ok); }
      const j = (snap.joints || []).find((x) => x.id === id); return !!(j && j.ok);
    }
    // default to the first LIVE item so opening lands on real data, not a dead channel
    function firstLiveId() {
      for (const it of items()) if (isLive(it.id, mode)) return it.id;
      return items()[0]?.id;
    }

    // switch Joints <-> Encoders in place, carrying the selection across the
    // joint<->channel mapping when that counterpart is live, else first live.
    function switchMode(m) {
      if (m === mode) return;
      let nextId = null;
      const encs = store.snap?.encoders || [];
      if (m === "enc") { const e = encs.find((x) => x.joint === sel); nextId = e ? e.ch : null; }
      else { const e = encs.find((x) => x.ch === sel); nextId = e && e.joint ? e.joint : null; }
      mode = m;
      setModeUI(m);
      buildRail();
      select(nextId != null && rows[nextId] && isLive(nextId, m) ? nextId : firstLiveId());
    }

    function open(m, id) {
      mode = m;
      setModeUI(m);
      buildRail();
      select(id != null && rows[id] ? id : firstLiveId());
      opened = true;
      node.classList.add("open");
      document.addEventListener("keydown", esc);
    }

    function frame(sm, snap) {
      if (!opened) return;
      sparkTick++;
      const drawSparks = sparkTick % 3 === 0;
      const list = items();
      for (const it of list) {
        const r = rows[it.id];
        if (!r) continue;
        const cur = liveValue(it, sm, snap);
        r.val.textContent = cur.ok ? cur.v.toFixed(1) + "°" : "—";
        r.light.className = "dot " + (cur.ok ? "ok" : "");
        if (drawSparks) {
          const ser = store.getSeries(it.key);
          if (ser && ser.v.length > 1) {
            drawSpark(r.sparkCv, ser.v.slice(-64), cur.ok ? "#2F76BF" : "#C9BFAC",
              mode === "enc" ? 360 : null);
          }
        }
      }
      const selIt = list.find((x) => String(x.id) === String(sel)) || list[0];
      const cur = liveValue(selIt, sm, snap);
      bigVal.textContent = cur.ok ? cur.v.toFixed(1) : "—";
      stState.val.textContent = cur.ok ? "live" : "absent";
      stState.val.style.color = cur.ok ? "var(--ok)" : "var(--stop)";
      const encH = (snap.health || []).find((x) => x.stream === "encoders");
      stRate.val.textContent = encH && encH.ok ? encH.rate_hz + " Hz" : "—";
      stMap.val.textContent = mode === "enc"
        ? ((store.snap?.encoders || []).find((x) => x.ch === sel)?.joint || "unmapped").replace("_", " ")
        : "ch " + jointCh(selIt.id);

      const ser = store.getSeries(selIt.key);
      if (ser && ser.v.length > 1) {
        const wrap = mode === "enc" ? 360 : null;
        const [lo, hi] = windowMinMax(ser, snap.t_ms, bigChart.o.windowMs, wrap);
        stMin.val.textContent = lo.toFixed(1) + "°";
        stMax.val.textContent = hi.toFixed(1) + "°";
        stRange.val.textContent = (hi - lo).toFixed(1) + "°";
        const span = Math.max(5, hi - lo), mid = (hi + lo) / 2, padv = span * 0.6;
        bigChart.o.min = mid - padv;
        bigChart.o.max = mid + padv;
        bigChart.o.wrap = wrap;
        bigChart.draw({ t: ser.t, v: ser.v, color: cur.ok ? "#2F76BF" : "#8B8474" }, snap.t_ms);
      } else {
        stMin.val.textContent = stMax.val.textContent = stRange.val.textContent = "—";
        bigChart.draw({ t: [], v: [] }, snap.t_ms);
      }
    }

    const esc = (e) => { if (e.key === "Escape") close(); };
    function close() {
      opened = false;
      node.classList.remove("open");
      document.removeEventListener("keydown", esc);
    }
    closeBtn.addEventListener("click", close);
    scrim.addEventListener("click", close);
    cleanups.push(() => document.removeEventListener("keydown", esc));

    return { node, open, isOpen: () => opened, frame };
  }

  // ------------------------------------------------------ motor telemetry --
  // This is deliberately read-only.  It exposes the measurements the Teensy
  // actually streams (position, velocity, present current and bus health),
  // without turning an observation view into another place to command torque.
  function buildMotorInspector(cleanups) {
    let opened = false, selected = null, trace = "current", railSig = "";
    const rows = new Map();
    const scrim = el("div", { class: "insp-scrim" });
    const title = el("span", { class: "insp-title" }, "Motor telemetry");
    const sub = el("span", { class: "insp-sub mono" }, "measured on the Teensy");
    const closeBtn = el("button", { class: "surf-back insp-close", title: "Close (Esc)" }, "✕");
    const rail = el("div", { class: "insp-rail motor-rail" });
    const big = el("span", { class: "insp-big num" }, "—");
    const unit = el("span", { class: "insp-unit" }, "mA");
    const state = el("div", { class: "motor-state" });
    const health = el("div", { class: "motor-health" });
    const traceTabs = el("div", { class: "seg seg-sm motor-trace-tabs" });
    const chartCv = el("canvas", { class: "insp-chart" });
    const chart = new StripChart(chartCv, { min: -45, max: 45, fill: false, width: 2, windowMs: 12000, color: "#2F76BF" });
    const main = el("div", { class: "insp-main motor-inspector-main" },
      el("div", { class: "insp-readout" }, big, unit, state), traceTabs,
      health, el("div", { class: "insp-chart-wrap" }, chartCv));
    const panel = el("div", { class: "insp-panel motor-inspector-panel" },
      el("div", { class: "insp-head" }, title, sub, closeBtn),
      el("div", { class: "insp-body" }, rail, main));
    const node = el("div", { class: "op-inspector motor-inspector" }, scrim, panel);
    const traces = {
      current: { label: "Current", key: "i:", field: "current_ma", unit: "mA", color: "#2F76BF", floor: 12 },
      position: { label: "Position", key: "p:", field: "pos_deg", unit: "°", color: "#4E7D57", floor: 15 },
      velocity: { label: "Velocity", key: "v:", field: "vel_dps", unit: "°/s", color: "#6B8FB8", floor: 20 },
    };
    const traceButtons = {};
    for (const [id, spec] of Object.entries(traces)) {
      const b = el("button", null, spec.label);
      b.addEventListener("click", () => { trace = id; syncTraceTabs(); });
      traceButtons[id] = b; traceTabs.append(b);
    }
    function syncTraceTabs() {
      for (const [id, b] of Object.entries(traceButtons)) b.classList.toggle("on", id === trace);
    }
    function num(v, digits = 1) { return Number.isFinite(v) ? v.toFixed(digits) : "—"; }
    function motorLabel(m) { return (m.id || "motor").replace("_", " "); }
    function select(id) {
      selected = id;
      for (const [key, row] of rows) row.classList.toggle("on", key === id);
    }
    function rebuildRail(ms) {
      railSig = ms.map((m) => m.id).join("|");
      rows.clear(); rail.replaceChildren();
      for (const m of ms) {
        const val = el("span", { class: "insp-row-val num" }, "—");
        const row = el("button", { class: "insp-row" }, el("span", { class: "dot" }),
          el("span", { class: "insp-row-label mono" }, motorLabel(m)), val);
        row.addEventListener("click", () => select(m.id));
        rows.set(m.id, row); rail.append(row);
      }
    }
    function renderHealth(m) {
      const d = m.diagnostic || {};
      const hw = Array.isArray(d.hardware_error) ? d.hardware_error.map((x) => `0x${Number(x || 0).toString(16).padStart(2, "0")}`).join(" / ") : "not streamed";
      const read = d.fast_read == null ? "feedback mode not streamed" : `${d.fast_read ? "fast sync" : "sync"} · ${d.indirect_read ? "indirect" : "direct"}`;
      const items = [
        ["Measured", "present current; no command/setpoint is inferred"],
        ["Supply", m.voltage_v == null ? "not streamed" : `${num(m.voltage_v, 2)} V`],
        ["Temperature", m.temp_c == null ? "not streamed" : `${num(m.temp_c)} °C`],
        ["Safety", m.fault ? (d.cause || "firmware fault") : "no fault reported"],
        ["Bus misses", `${d.consecutive_misses ?? "—"} consecutive · ${d.total_misses ?? "—"} total`],
        ["Hardware error", hw],
        ["Feedback", read],
        ["Read fallbacks", `${d.fast_fallbacks ?? "—"} fast · ${d.direct_fallbacks ?? "—"} direct`],
      ];
      health.replaceChildren(...items.map(([k, v]) => el("div", { class: "motor-health-row" },
        el("span", { class: "k" }, k), el("span", { class: "v mono" }, v))));
    }
    function frame(snap) {
      if (!opened) return;
      const ms = snap.motors || [];
      const sig = ms.map((m) => m.id).join("|");
      if (sig !== railSig) rebuildRail(ms);
      if (!ms.length) { big.textContent = "—"; health.textContent = "No motor telemetry is streaming."; return; }
      if (!selected || !ms.some((m) => m.id === selected)) select(ms[0].id);
      const m = ms.find((x) => x.id === selected) || ms[0];
      const spec = traces[trace];
      big.textContent = num(m[spec.field]); unit.textContent = spec.unit;
      for (const motor of ms) {
        const row = rows.get(motor.id); if (!row) continue;
        row.querySelector(".dot").className = "dot " + (motor.fault ? "stop" : motor.torque_on ? "ok" : "warn");
        row.querySelector(".insp-row-val").textContent = `${num(motor.current_ma)} mA`;
      }
      state.replaceChildren(
        el("span", { class: "chip sm-chip" }, m.mode || "idle"),
        el("span", { class: "chip sm-chip" }, m.torque_on ? "torque on" : "torque off"),
        el("span", { class: "chip sm-chip" }, m.bus_taken ? "bus taken" : "bus free"));
      renderHealth(m);
      const ser = store.getSeries(spec.key + m.id);
      if (ser && ser.v.length > 1) {
        const vals = ser.v.slice(-160);
        const lo = Math.min(...vals), hi = Math.max(...vals), span = Math.max(spec.floor, hi - lo);
        const mid = (hi + lo) / 2, pad = span * 0.65;
        chart.o.min = mid - pad; chart.o.max = mid + pad;
        chart.draw({ t: ser.t, v: ser.v, color: spec.color, fill: false }, snap.t_ms);
      } else chart.draw({ t: [], v: [] }, snap.t_ms);
    }
    function open() {
      opened = true; node.classList.add("open"); syncTraceTabs();
      rebuildRail(store.snap?.motors || []); frame(store.snap || {});
      document.addEventListener("keydown", esc);
    }
    function close() { opened = false; node.classList.remove("open"); document.removeEventListener("keydown", esc); }
    const esc = (e) => { if (e.key === "Escape") close(); };
    closeBtn.addEventListener("click", close); scrim.addEventListener("click", close);
    cleanups.push(() => document.removeEventListener("keydown", esc));
    return { node, open, isOpen: () => opened, frame };
  }

  // ------------------------------------------------------------ calibrate --
  // Guided calibration wizard. Each step derives real parameters from a known pose:
  //   1. Neutral (arm flat, fingers extended) -> IMU home tare + flexion OPEN reference.
  //   2. Fist (hand fully closed)             -> flexion CLOSED reference.
  // The bridge maps raw AS5600 -> the twin's open..closed range from these two poses,
  // so direction + travel are derived (no hardcoded guessing). Backend: teensy_bridge.py
  // { neutral, joints_closed }; mapping via calibrated_joint(); persisted to disk.
  function buildCalib(cleanups) {
    let opened = false, step = 0, waiting = false;
    const STEPS = [
      { icon: "🖐", title: "Neutral pose", btn: "Capture neutral",
        instr: "Rest your forearm flat on the table, palm down. Hold your hand and fingers straight and relaxed, then press capture. This sets your home (zeroes both IMUs) and the finger's open position.",
        send: { cmd: "calibrate", what: "neutral" } },
      { icon: "☝", title: "Index MCP range", btn: "Capture full MCP bend",
        instr: "Bend the index finger fully at the knuckle while keeping the middle joint as straight as practical, then hold. This records only the MCP endpoint.",
        send: { cmd: "calibrate", what: "joint_closed", channel: 8 } },
      { icon: "☝", title: "Index PIP range", btn: "Capture full PIP bend",
        instr: "Now bend the index finger's middle joint through its complete comfortable range and hold it at the real endpoint. This records only the PIP scale, so partial travel cannot be mistaken for fully closed.",
        send: { cmd: "calibrate", what: "joint_closed", channel: 9 } },
    ];
    const scrim = el("div", { class: "insp-scrim" });
    const title = el("span", { class: "insp-title" }, "Hand calibration");
    const closeBtn = el("button", { class: "surf-back insp-close", title: "Close (Esc)" }, "✕");
    const dotEls = [...STEPS, 0].map(() => el("span", { class: "calib-dot" }));
    const dots = el("div", { class: "calib-dots" }, ...dotEls);
    const icon = el("div", { class: "calib-icon" }, "");
    const stepTitle = el("div", { class: "calib-steptitle" }, "");
    const instr = el("p", { class: "calib-instr" }, "");
    const jbars = {};
    const mkBar = (label, key) => {
      const fill = el("div", { class: "calib-jbar-fill" });
      jbars[key] = fill;
      return el("div", { class: "calib-jrow" }, el("span", { class: "calib-jlabel mono" }, label),
        el("div", { class: "calib-jbar" }, fill));
    };
    const finger = el("div", { class: "calib-finger" }, mkBar("MCP", "index_pip"), mkBar("PIP", "index_dip"));
    const result = el("div", { class: "calib-result mono" }, "");
    const actionBtn = el("button", { class: "btn primary calib-action" }, "");
    const panel = el("div", { class: "insp-panel calib-panel" },
      el("div", { class: "insp-head" }, title, dots, closeBtn),
      el("div", { class: "calib-body" }, el("div", { class: "calib-stephead" }, icon, stepTitle), instr, finger, result, actionBtn));
    const node = el("div", { class: "op-inspector op-calib" }, scrim, panel);

    function render() {
      dotEls.forEach((d, i) => d.classList.toggle("on", i <= step));
      if (step < STEPS.length) {
        const s = STEPS[step];
        icon.textContent = s.icon; stepTitle.textContent = `Step ${step + 1} of ${STEPS.length}: ${s.title}`;
        instr.textContent = s.instr; actionBtn.textContent = s.btn; actionBtn.disabled = false;
        result.textContent = "";
      } else {
        icon.textContent = "✓"; stepTitle.textContent = "Calibrated";
        instr.textContent = "Your finger now tracks from open (straight) to fully closed (curled toward the palm), and the wrist is zeroed at the neutral pose.";
        actionBtn.textContent = "Finish";
      }
    }
    actionBtn.addEventListener("click", () => {
      if (step < STEPS.length) {
        if (waiting) return;
        waiting = true;
        actionBtn.disabled = true;
        actionBtn.textContent = "Capturing…";
        store.send(STEPS[step].send);
      }
      else close();
    });

    // Advance only after the bridge confirms a real live capture. Previously
    // the wizard advanced on click even when the sensor was absent, leaving an
    // old/partial endpoint in force with no chance to retry that step.
    cleanups.push(store.onAck((a) => {
      if (!opened || !waiting) return;
      if (a.event === "error") {
        waiting = false;
        actionBtn.disabled = false;
        actionBtn.textContent = STEPS[step].btn;
        result.textContent = a.error || "Capture failed; hold the pose and retry.";
        return;
      }
      if (a.event === "calibrated") {
        waiting = false;
        const t = a.travel, parts = [];
        if (t && t["8"] != null) parts.push("MCP " + Math.round(t["8"]) + "°");
        if (t && t["9"] != null) parts.push("PIP " + Math.round(t["9"]) + "°");
        step++;
        render();
        if (parts.length && step < STEPS.length) result.textContent = "captured  " + parts.join("   ");
      }
    }));
    // live finger feedback so the user sees it being read as they pose
    cleanups.push(store.onSnap((s) => {
      if (!opened) return;
      const by = {};
      for (const j of s.joints || []) by[j.id] = j;
      for (const key of ["index_pip", "index_dip"]) {
        const j = by[key];
        const v = clamp((((j && j.ok ? j.deg : 8) - 8) / 52), 0, 1);
        jbars[key].style.transform = `scaleX(${0.05 + v * 0.95})`;
      }
    }));

    const esc = (e) => { if (e.key === "Escape") close(); };
    function open() { opened = true; step = 0; waiting = false; render(); node.classList.add("open"); document.addEventListener("keydown", esc); }
    function close() { opened = false; waiting = false; node.classList.remove("open"); document.removeEventListener("keydown", esc); }
    closeBtn.addEventListener("click", close);
    scrim.addEventListener("click", close);
    cleanups.push(() => document.removeEventListener("keydown", esc));
    return { node, open, isOpen: () => opened };
  }

  // ----------------------------------------------------------------- demo --
  function buildDemo(cleanups) {
    let open = false;
    const stageD = el("div", { class: "demo-stage" });
    const rCurl = el("div", { class: "demo-read num" }, "0");
    const rEff = el("div", { class: "demo-read num amber" }, "0.00");
    const rRate = el("div", { class: "demo-read num" }, "50");
    const clock = el("div", { class: "demo-clock mono" }, "00:00");
    const node = el("div", { class: "op-demo" },
      stageD,
      el("div", { class: "demo-top" },
        el("div", { class: "wordmark" }, el("span", { class: "wordmark-dot" }), "TAKTO"),
        el("div", { class: "pill" }, el("span", { class: "dot live" }), "LIVE"),
        el("button", { class: "surf-back demo-close", onclick: () => api.close() }, "✕")),
      el("div", { class: "demo-reads" },
        el("div", { class: "demo-read-block" }, rCurl, el("div", { class: "kicker" }, "Curl %")),
        el("div", { class: "demo-read-block" }, rEff, el("div", { class: "kicker" }, "Effort")),
        el("div", { class: "demo-read-block" }, rRate, el("div", { class: "kicker" }, "Hz"))),
      clock);
    // the shared twin walks over to the demo stage and back
    let t0 = 0;
    const esc = (e) => { if (e.key === "Escape") api.close(); };
    const api = {
      node,
      isOpen: () => open,
      open() {
        open = true; t0 = performance.now();
        node.classList.add("open");
        document.addEventListener("keydown", esc);
        Twin.acquire(stageD, { orbit: true, idle: true, idleSpin: true, yaw: -0.8, pitch: 0.3, dist: 7.6, targetY: -0.2, targetZ: 0.3 });
      },
      close() {
        open = false;
        node.classList.remove("open");
        document.removeEventListener("keydown", esc);
        Twin.acquire(stage, COCKPIT_FRAMING);
      },
      frame(sm, snap) {
        rCurl.textContent = Math.round(sm.curl * 100);
        rEff.textContent = sm.activation.level.toFixed(2);
        const linkH = (snap.health || []).find((x) => x.stream === "encoders");
        if (linkH) rRate.textContent = String(linkH.rate_hz);
        clock.textContent = fmtClock(performance.now() - t0);
      },
    };
    cleanups.push(() => document.removeEventListener("keydown", esc));
    return api;
  }

  return () => { cleanups.forEach((fn) => fn()); root.remove(); };
}
