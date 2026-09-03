// imu.js - the IMU bench. Two jobs, one page:
//
//   1. PROGRAM THE MOUNTING ORIENTATION. Every correction the bridge applies
//      (axis remap, rest-pose offset, rotation sense, gain, solved alignment)
//      is editable here, takes effect on the NEXT FRAME, and persists without a
//      restart. This exists because those values used to be constants in
//      teensy_bridge.py: one bench observation cost a source edit, a restart and
//      a re-tare, so a wrong guess was expensive and the sensors stayed
//      misaligned through several rounds of back and forth. Making the config
//      data instead of code is the actual fix; this page is its face.
//
//   2. SHOW THE WHOLE SENSOR. Firmware v7 streams every report the BNO085
//      fuses - linear acceleration, accelerometer, gyroscope, magnetometer,
//      gravity, the magnetometer-immune game rotation vector, and the
//      per-family calibration accuracies - and the bridge integrates linear
//      acceleration into position. The relative hand-vs-forearm displacement is
//      plotted over time here.
//
// HONESTY RULES THIS PAGE FOLLOWS (see DATA_CONTRACT.md and the bridge's
// InertialTracker comment):
//   - Integrated position is DEAD RECKONING and is labelled as such, always.
//     It is not a position measurement; it drifts, and the page shows the
//     confidence and the time since the last zero-velocity update next to every
//     number so a reader can see how stale the reference is.
//   - On pre-v7 firmware the acceleration panels say "not streamed by this
//     firmware" rather than rendering zeros, because a zero that means "absent"
//     is the single most misleading thing a console can draw.
//   - The mock feed carries a MOCK badge, as every other surface does.

import { el, clamp } from "../ui.js";
import { store } from "../store.js";
import { StripChart } from "../charts.js";
import { AttitudeGizmo, TraceGizmo, qMul, qConj, qAngleDeg } from "../imu_gizmo.js";

const IMUS = [
  { key: "hand",    label: "Hand",    note: "flat on the dorsal plate - the reference frame" },
  { key: "forearm", label: "Forearm", note: "vertical on a standoff" },
  { key: "thumb",   label: "Thumb",   note: "tip mount (post-thesis addition)" },
];
const AXES = ["x", "y", "z"];
// The 24 axis remaps, as (sign, source-axis) triples.
//
// There are 48 signed permutations of three axes, but only HALF of them are
// rotations. The other half have determinant -1: they are reflections, and a
// reflection is not a mounting - no way of bolting a sensor to a bracket can
// mirror it. Feeding one in produces a frame that tracks backwards about one
// axis, which is indistinguishable from the "real clockwise showed
// counterclockwise" handedness symptom this rig has chased more than once. So
// the picker offers the 24 proper rotations only, and the bridge refuses the
// rest server-side. (This also matches the existing bench notes, which number
// the proven values #8/24 and #13/24.)
const PERMS = [
  { p: ["x","y","z"], even:  true },   // identity
  { p: ["x","z","y"], even: false },   // swap y,z
  { p: ["y","x","z"], even: false },   // swap x,y
  { p: ["y","z","x"], even:  true },   // 3-cycle
  { p: ["z","x","y"], even:  true },   // 3-cycle
  { p: ["z","y","x"], even: false },   // swap x,z
];
const SIGN_SETS = [[1,1,1],[1,1,-1],[1,-1,1],[1,-1,-1],[-1,1,1],[-1,1,-1],[-1,-1,1],[-1,-1,-1]];
function allRemaps() {
  const out = [];
  for (const { p, even } of PERMS) {
    for (const s of SIGN_SETS) {
      // det = (product of signs) x (permutation parity); keep proper rotations
      const det = s[0] * s[1] * s[2] * (even ? 1 : -1);
      if (det === 1) out.push(p.map((a, i) => [s[i], a]));
    }
  }
  return out;
}
const remapLabel = (r) => r.map(([s, a]) => (s < 0 ? "-" : "+") + a).join(" ");
const remapEq = (a, b) => a && b && a.length === 3 && b.length === 3 &&
  a.every((e, i) => e[0] === b[i][0] && e[1] === b[i][1]);

function styleOnce() {
  if (document.getElementById("imu-style")) return;
  const s = el("style", { id: "imu-style" });
  s.textContent = `
  .imu { max-width:1180px; margin:0 auto; padding:22px 20px 60px; }
  .imu-head { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; }
  .imu-back { text-decoration:none; color:var(--text-2); font-size:13px; letter-spacing:.04em;
    padding:4px 10px; border:1px solid var(--line,#DFDAD0); border-radius:999px;
    transition:color .15s ease, border-color .15s ease; }
  .imu-back:hover { color:var(--text-0); border-color:var(--text-2); }
  .imu-kicker { font:600 11px/1 ui-monospace,monospace; letter-spacing:.14em;
    text-transform:uppercase; color:#C9401B; }
  .imu-h1 { font:600 26px/1.15 var(--font-display,inherit); margin:2px 0 4px; }
  .imu-sub { color:var(--text-2); font-size:13.5px; max-width:70ch; margin:0 0 18px; }
  .imu-badge { font:600 10px/1 ui-monospace,monospace; letter-spacing:.1em; padding:4px 7px;
    border-radius:5px; border:1px solid currentColor; text-transform:uppercase; }
  .imu-badge.mock { color:#B0821F; }
  .imu-badge.stale { color:#8A8A8A; }
  .imu-badge.live { color:#2E7D53; }
  .imu-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); gap:14px; }
  .imu-card { border:1px solid var(--line,#DFDAD0); border-radius:12px; padding:14px 15px;
    background:var(--card,#FBF9F5); min-width:0; }
  .imu-card h3 { font:600 14px/1.2 inherit; margin:0 0 2px; display:flex; gap:8px;
    align-items:center; justify-content:space-between; }
  .imu-note { color:var(--text-2); font-size:11.5px; margin:0 0 10px; }
  .imu-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:9px 0 0; }
  .imu-lbl { font:600 10px/1 ui-monospace,monospace; letter-spacing:.1em; text-transform:uppercase;
    color:var(--text-2); min-width:74px; flex:0 0 74px; }
  /* the option buttons are one unit: they must wrap as a group, not leave a
     single orphan button on its own line under the label */
  .imu-opts { display:flex; gap:6px; flex:1; min-width:0; }
  .imu-opts .imu-btn { flex:1; min-width:0; text-align:center; }
  .imu-val { font:13px/1.5 ui-monospace,Menlo,monospace; color:var(--text-0); }
  .imu-dim { color:var(--text-2); }
  .imu-btn { font:12px/1 inherit; padding:5px 9px; border-radius:7px; cursor:pointer;
    border:1px solid var(--line,#DFDAD0); background:transparent; color:inherit; }
  .imu-btn:hover { background:rgba(0,0,0,.05); }
  .imu-btn.on { border-color:#C9401B; color:#C9401B; font-weight:600; }
  .imu-btn.danger { color:#B0342A; }
  select.imu-sel, input.imu-num { font:12px/1 ui-monospace,monospace; padding:5px 7px;
    border-radius:7px; border:1px solid var(--line,#DFDAD0); background:transparent; color:inherit; }
  input[type=range].imu-rng { flex:1; min-width:110px; }
  .imu-vec { display:grid; grid-template-columns:auto repeat(3,1fr); gap:3px 9px; align-items:baseline;
    font:12px/1.55 ui-monospace,Menlo,monospace; margin-top:3px; }
  .imu-vec .k { color:var(--text-2); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; }
  .imu-vec .n { text-align:right; }
  .imu-acc { display:inline-block; width:7px; height:7px; border-radius:50%; margin-left:5px; }
  .imu-plot { width:100%; height:150px; display:block; }
  /* the attitude gizmo sits directly under the card title: the picture is the
     primary readout on this page and the numbers annotate it, not the reverse */
  .imu-gizmo { width:100%; height:132px; display:block; margin:2px 0 4px;
    border-radius:9px; background:rgba(60,52,42,0.035); }
  .imu-gizmo.absent { opacity:0.35; }
  .imu-trace { width:100%; height:230px; display:block; border-radius:9px;
    background:rgba(60,52,42,0.035); }
  .imu-viz { display:grid; grid-template-columns:1.15fr 1fr; gap:14px; align-items:start; }
  @media (max-width:820px) { .imu-viz { grid-template-columns:1fr; } }
  .imu-big { font:600 21px/1.1 ui-monospace,Menlo,monospace; }
  .imu-verdict { font-size:12.5px; margin-top:6px; color:var(--text-2); }
  .imu-verdict.good { color:#2E7D53; } .imu-verdict.bad { color:#B0342A; }
  .imu-warn { border-left:2px solid #B0821F; padding:8px 11px; margin:10px 0 0; font-size:12.5px;
    color:var(--text-1); background:rgba(176,130,31,.06); border-radius:0 7px 7px 0; }
  .imu-absent { color:var(--text-2); font-size:12.5px; font-style:italic; padding:10px 0; }
  .imu-steps { display:flex; gap:6px; flex-wrap:wrap; margin-top:7px; }
  .imu-status { font:12px/1.5 ui-monospace,monospace; margin-top:7px; min-height:1.5em; }
  .imu-status.ok { color:#2E7D53; } .imu-status.err { color:#B0342A; }
  .imu-legend { display:flex; gap:14px; flex-wrap:wrap; font-size:11.5px; color:var(--text-2);
    margin-top:6px; }
  .imu-legend i { display:inline-block; width:9px; height:2px; margin-right:5px; vertical-align:middle; }
  `;
  document.head.append(s);
}

// colour by calibration accuracy: the BNO085 reports 0..3 per sensor family and
// a drifting rig is almost always a 0 or 1 here, so it is worth seeing at a glance.
const ACC_COL = ["#B0342A", "#B0821F", "#7A9A3A", "#2E7D53"];
const ACC_TXT = ["unreliable", "low", "medium", "high"];

export function mountImu(rootHost) {
  styleOnce();
  const cleanups = [];
  // The router's unmount contract is "the view removes its OWN node" (see
  // bench.js / operator.js). This used to clear the host's innerHTML on mount
  // and never remove anything on unmount, so navigating away left the whole
  // bench in the DOM underneath the next surface - two live views, two sets of
  // snapshot subscribers, one visible.
  const root = rootHost;

  const mockBadge = el("span", { class: "imu-badge mock" }, "Mock data");
  const fwBadge = el("span", { class: "imu-badge stale" }, "firmware ?");
  const head = el("div", { class: "imu" },
    el("div", { class: "imu-head" },
      // This surface replaces the console rather than overlaying it, so without
      // an explicit way out the only exit is the browser's own back button -
      // which is not obvious on a page that fills the window.
      el("a", { class: "imu-back", href: "#/operator", title: "Back to the console" },
        "← Console"),
      el("span", { class: "imu-kicker" }, "TAKTO · IMU bench"),
      mockBadge, fwBadge),
    el("h1", { class: "imu-h1" }, "Orientation and motion"),
    el("p", { class: "imu-sub" },
      "Everything the bridge does to an IMU signal, editable live and saved to disk. " +
      "Changes apply on the next frame - no restart, no re-flash."));

  // The same one-click fix as the operator stage. Home is what makes the live
  // twin sit where the disconnected one does, so it belongs at the top of the
  // page you land on when the pose is wrong.
  const homeBtn = el("button", { class: "imu-btn on" }, "Correct the twin");
  const homeNote = el("span", { class: "imu-dim", style: "font-size:12px" },
    "captures the pose the device is held in RIGHT NOW as home");
  homeBtn.addEventListener("click", () => {
    store.send({ cmd: "calibrate", what: "imu" });
    homeBtn.textContent = "Capturing…";
    setTimeout(() => { homeBtn.textContent = "Correct the twin"; }, 1200);
  });
  head.append(el("div", { class: "imu-row", style: "margin:0 0 16px" }, homeBtn, homeNote));
  root.append(head);

  let cfg = null;             // the bridge's per-IMU mounting config
  let presets = {};
  const cards = {};

  // ---- one configuration card per IMU ---------------------------------------
  const grid = el("div", { class: "imu-grid" });
  head.append(grid);
  for (const imu of IMUS) grid.append(buildCard(imu));

  // ---- rigid-body agreement panel ------------------------------------------
  const rigCanvas = el("canvas", { class: "imu-gizmo", style: "height:190px" });
  const rigGiz = new AttitudeGizmo(rigCanvas);
  const rigVal = el("span", { class: "imu-big" }, "--");
  const rigVerdict = el("p", { class: "imu-verdict" }, "Waiting for both IMUs.");
  head.append(el("div", { class: "imu-card", style: "margin-top:14px" },
    el("h3", {}, el("span", {}, "Do the two frames agree?")),
    el("p", { class: "imu-note" },
      "Hand (dim) drawn on top of forearm (bright). Hold your wrist stiff and move the whole " +
      "arm: a rigid body cannot change its own internal rotation, so whatever wander you see " +
      "here IS the mounting misalignment."),
    el("div", { class: "imu-viz" },
      rigCanvas,
      el("div", {},
        el("div", { class: "imu-row" },
          el("span", { class: "imu-lbl" }, "Wander"), rigVal,
          el("span", { class: "imu-dim", style: "font-size:12px" }, "over 6 s")),
        rigVerdict))));

  head.append(buildMotion());

  function send(patch, imuKey) {
    store.send({ cmd: "imu_cfg", action: "set", imu: imuKey, patch });
  }

  function buildCard({ key, label, note }) {
    const status = el("div", { class: "imu-status" });
    const rpy = el("span", { class: "imu-val imu-dim" }, "--");
    const liveDot = el("span", { class: "imu-badge stale" }, "no data");

    // -- axis remap: the signed permutation, as a single picker -------------
    // A dropdown of all 24 rather than six sign toggles: the previous rounds of
    // this were lost swapping individual signs, which is exactly how you land on
    // a non-permutation and see nothing change.
    const remapSel = el("select", { class: "imu-sel" });
    for (const r of allRemaps()) {
      remapSel.append(el("option", { value: JSON.stringify(r) }, remapLabel(r)));
    }
    remapSel.addEventListener("change", () => {
      send({ remap: JSON.parse(remapSel.value) }, key);
    });

    // -- rest-pose offset: the four candidates that actually matter ---------
    const offBtns = {};
    const offOpts = el("div", { class: "imu-opts" });
    for (const p of ["identity", "180x", "180y", "180z"]) {
      const b = el("button", { class: "imu-btn" }, p === "identity" ? "none" : p.toUpperCase());
      b.addEventListener("click", () => send({ offset: presets[p] || [1, 0, 0, 0] }, key));
      offBtns[p] = b; offOpts.append(b);
    }
    const offRow = el("div", { class: "imu-row" },
      el("span", { class: "imu-lbl" }, "Rest offset"), offOpts);

    // -- rotation sense --------------------------------------------------
    const flipBtns = {};
    const flipOpts = el("div", { class: "imu-opts" });
    for (const f of [null, "x", "y", "z"]) {
      const b = el("button", { class: "imu-btn" }, f === null ? "none" : f.toUpperCase());
      b.addEventListener("click", () => send({ flip: f }, key));
      flipBtns[String(f)] = b; flipOpts.append(b);
    }
    const flipRow = el("div", { class: "imu-row" },
      el("span", { class: "imu-lbl" }, "Flip sense"), flipOpts);

    // -- gain ------------------------------------------------------------
    const gainOut = el("span", { class: "imu-val" }, "1.00");
    const gain = el("input", { class: "imu-rng", type: "range", min: "0", max: "2", step: "0.05" });
    gain.addEventListener("input", () => { gainOut.textContent = (+gain.value).toFixed(2); });
    gain.addEventListener("change", () => send({ gain: +gain.value }, key));

    // -- the 4-tap functional alignment ----------------------------------
    const alignState = el("span", { class: "imu-val imu-dim" }, "not solved");
    const steps = el("div", { class: "imu-steps" });
    const stepDefs = key === "hand"
      ? []
      : [["base", "1 · Neutral"], ["pitch", "2 · Pitch up"], ["yaw", "3 · Yaw across"],
         ["home", "4 · Re-zero"], ["reset", "Clear"]];
    for (const [step, txt] of stepDefs) {
      const b = el("button", { class: "imu-btn" + (step === "reset" ? " danger" : "") }, txt);
      b.addEventListener("click", () =>
        store.send({ cmd: "calibrate", what: "imu_align", imu: key, step }));
      steps.append(b);
    }

    // The picture, first. Watching the triad while clicking through remaps is
    // the entire point of this page: a wrong permutation is obvious in one
    // glance and invisible in three columns of degrees.
    const gizCanvas = el("canvas", { class: "imu-gizmo" });
    const giz = new AttitudeGizmo(gizCanvas);

    const body = el("div", { class: "imu-card" },
      el("h3", {}, el("span", {}, label), liveDot),
      el("p", { class: "imu-note" }, note),
      gizCanvas,
      el("div", { class: "imu-row" }, el("span", { class: "imu-lbl" }, "Displayed"), rpy),
      el("div", { class: "imu-row" }, el("span", { class: "imu-lbl" }, "Axis remap"), remapSel),
      offRow, flipRow,
      el("div", { class: "imu-row" }, el("span", { class: "imu-lbl" }, "Gain"), gain, gainOut),
      key === "hand"
        ? el("p", { class: "imu-note" },
            "The hand is the reference frame the other two are solved against, so it has no alignment run of its own.")
        : el("div", {},
            el("div", { class: "imu-row" }, el("span", { class: "imu-lbl" }, "Alignment"), alignState),
            el("p", { class: "imu-note" },
              "Hold the wrist stiff so hand and " + label.toLowerCase() +
              " move as one body, then work through the four taps. This MEASURES the mounting rotation " +
              "instead of guessing a permutation, and it overrides the remap above."),
            steps),
      status);

    cards[key] = { remapSel, offBtns, flipBtns, gain, gainOut, alignState, status, rpy,
                   liveDot, giz, gizCanvas };
    return body;
  }

  // ---- render the config whenever the bridge publishes it -------------------
  function paintCfg() {
    if (!cfg) return;
    for (const { key } of IMUS) {
      const c = cfg[key]; const ui = cards[key];
      if (!c || !ui) continue;
      const solved = c.align != null;
      // find the matching option; a solved alignment overrides the remap, so the
      // picker is disabled rather than showing a value that is not in effect.
      for (const opt of ui.remapSel.options) {
        if (remapEq(JSON.parse(opt.value), c.remap)) { ui.remapSel.value = opt.value; break; }
      }
      ui.remapSel.disabled = solved;
      ui.remapSel.title = solved
        ? "A solved alignment is in effect and overrides the remap. Clear it to pick a permutation by hand."
        : "Signed permutation of the sensor's axes";
      const offKey = Object.keys(presets).find((k) =>
        presets[k] && c.offset && presets[k].every((v, i) => Math.abs(v - c.offset[i]) < 1e-6));
      for (const [k, b] of Object.entries(ui.offBtns)) b.classList.toggle("on", k === offKey);
      for (const [k, b] of Object.entries(ui.flipBtns)) b.classList.toggle("on", k === String(c.flip));
      ui.gain.value = c.gain; ui.gainOut.textContent = (+c.gain).toFixed(2);
      ui.alignState.textContent = solved ? "solved - overriding the remap" : "not solved";
      ui.alignState.className = "imu-val" + (solved ? "" : " imu-dim");
    }
  }

  cleanups.push(store.onKind("imu_cfg", (f) => {
    cfg = f.cfg || cfg;
    if (f.presets) presets = f.presets;
    paintCfg();
  }));
  // acks have their own channel in the store - onKind("ack") is never called
  cleanups.push(store.onAck((a) => {
    if (a.event === "imu_cfg") {
      if (a.cfg) { cfg = a.cfg; paintCfg(); }
      if (a.ok === false) {
        // scope the complaint to the card that caused it; a rejection shouted
        // on all three reads as though the whole rig were broken
        const ui = cards[a.imu];
        if (ui) { ui.status.className = "imu-status err"; ui.status.textContent = a.error || "rejected"; }
        else flashAll("err", a.error || "rejected");
      } else if (a.ok && cards[a.imu]) {
        cards[a.imu].status.className = "imu-status ok";
        cards[a.imu].status.textContent = "saved";
      }
    }
    if (a.event === "imu_align") {
      const ui = cards[a.imu || "forearm"];
      if (!ui) return;
      ui.status.className = "imu-status " + (a.ok ? "ok" : "err");
      ui.status.textContent = a.ok
        ? (a.residual_deg != null
            ? `solved, residual ${a.residual_deg} deg`
            : `${a.step} captured`)
        : (a.err || "failed");
    }
  }));
  function flashAll(cls, msg) {
    for (const { key } of IMUS) {
      cards[key].status.className = "imu-status " + cls;
      cards[key].status.textContent = msg;
    }
  }
  store.send({ cmd: "imu_cfg", action: "get" });

  // ---- motion: the full sensor set and the integrated relative position ----
  function buildMotion() {
    const wrap = el("div", { style: "margin-top:22px" });
    const absent = el("p", { class: "imu-absent" },
      "This firmware does not stream acceleration. Flash v7 or newer and the panels below fill in.");
    const relVal = el("span", { class: "imu-val" }, "--");
    const conf = el("span", { class: "imu-val imu-dim" }, "");
    const drift = el("span", { class: "imu-val imu-dim" }, "");
    const btnZero = el("button", { class: "imu-btn" }, "Zero here");
    btnZero.addEventListener("click", () => store.send({ cmd: "imu_zero" }));
    const canvas = el("canvas", { class: "imu-plot" });
    const chart = new StripChart(canvas, { min: -300, max: 300, windowMs: 20000, fill: false });
    const traceCanvas = el("canvas", { class: "imu-trace" });
    const trace = new TraceGizmo(traceCanvas);
    const vecs = {};
    const vgrid = el("div", { class: "imu-grid" });
    for (const { key, label } of IMUS) {
      const rows = {};
      const g = el("div", { class: "imu-vec" });
      for (const [k, unit] of [["lin", "m/s2"], ["acc", "m/s2"], ["gyr", "rad/s"],
                               ["mag", "uT"], ["grv", "m/s2"], ["pos", "mm"]]) {
        const cells = [el("span", {}, 0), el("span", {}, 0), el("span", {}, 0)]
          .map(() => el("span", { class: "n" }, "--"));
        rows[k] = cells;
        g.append(el("span", { class: "k" }, k === "lin" ? "lin acc" : k === "gyr" ? "gyro" :
                                            k === "grv" ? "gravity" : k === "pos" ? "position" : k),
                 ...cells);
      }
      const accDots = el("span", {});
      const still = el("span", { class: "imu-badge stale" }, "--");
      vecs[key] = { rows, accDots, still };
      vgrid.append(el("div", { class: "imu-card" },
        el("h3", {}, el("span", {}, label), still),
        el("p", { class: "imu-note" }, "calibration ", accDots),
        g));
    }
    wrap.append(
      el("h2", { class: "imu-h1", style: "font-size:20px;margin-top:4px" }, "Motion"),
      el("p", { class: "imu-sub" },
        "Linear acceleration has gravity removed by the sensor's own fusion, so it can be " +
        "rotated into the world frame and integrated. Position below is DEAD RECKONING between " +
        "standstills, not a position measurement."),
      absent,
      el("div", { class: "imu-card" },
        el("h3", {}, el("span", {}, "Hand relative to forearm"), conf),
        el("p", { class: "imu-note" }, "integrated displacement, x/y/z in mm"),
        el("div", { class: "imu-row" }, el("span", { class: "imu-lbl" }, "Offset"), relVal),
        el("div", { class: "imu-row" }, el("span", { class: "imu-lbl" }, "Integrating"),
           drift, btnZero),
        el("div", { class: "imu-viz" },
          traceCanvas,
          el("div", {},
            el("p", { class: "imu-note" },
              "Where the hand has been, relative to the forearm, since the last zero. " +
              "The amber arrow is live acceleration - the cause of whatever the path is doing."),
            canvas,
            el("div", { class: "imu-legend" },
              el("span", {}, el("i", { style: "background:#C9401B" }), "x"),
              el("span", {}, el("i", { style: "background:#2E7D53" }), "y"),
              el("span", {}, el("i", { style: "background:#2B6CB0" }), "z")))),
        el("div", { class: "imu-legend" },
          el("span", {}, el("i", { style: "background:#C9401B" }), "x"),
          el("span", {}, el("i", { style: "background:#2E7D53" }), "y"),
          el("span", {}, el("i", { style: "background:#2B6CB0" }), "z")),
        el("p", { class: "imu-warn" },
          "Double integration drifts: any residual bias grows as t squared. The bridge zeroes " +
          "velocity whenever the sensor is demonstrably still, so this reads well across brisk " +
          "motions between pauses and badly across slow ones. Confidence falls to zero about " +
          "three seconds after the last standstill - treat a low-confidence number as a shape, " +
          "not a distance.")),
      vgrid);

    const hist = { t: [], x: [], y: [], z: [] };
    const fmt = (v, d = 2) => (v == null ? "--" : (+v).toFixed(d));

    cleanups.push(store.onSnap((s) => {
      const full = s.imu_full, iner = s.inertial;
      const have = !!full;
      absent.style.display = have ? "none" : "";
      fwBadge.textContent = have ? "firmware v7+" : "firmware pre-v7";
      fwBadge.className = "imu-badge " + (have ? "live" : "stale");
      if (!have) return;

      for (const { key } of IMUS) {
        const d = full[key]; const v = vecs[key];
        if (!d || !v) continue;
        const per = iner && iner.per_imu ? iner.per_imu[key] : null;
        // The firmware emits a block for all three sensors whether or not they
        // exist, so an unfitted one arrives as a full row of zeros. Show it as
        // ABSENT: rendering 0.000 everywhere and a "moving" badge (which is what
        // this did on the first bench run) states a measurement that was never
        // taken.
        const live = d.live !== undefined ? d.live : (per ? per.live : true);
        if (!live) {
          for (const k of ["lin", "acc", "gyr", "mag", "grv", "pos"]) {
            v.rows[k].forEach((cell) => { cell.textContent = "--"; });
          }
          v.accDots.textContent = " not fitted";
          v.still.textContent = "not fitted";
          v.still.className = "imu-badge stale";
          continue;
        }
        const put = (k, arr, dec) => arr.forEach((n, i) => { v.rows[k][i].textContent = fmt(n, dec); });
        put("lin", d.lin, 3); put("acc", d.acc, 2); put("gyr", d.gyr, 3);
        put("mag", d.mag, 1); put("grv", d.grv, 2);
        if (per) put("pos", per.pos_mm, 1);
        v.accDots.innerHTML = "";
        for (const [nm, a] of [["acc", d.accuracy.acc], ["gyr", d.accuracy.gyr], ["mag", d.accuracy.mag]]) {
          v.accDots.append(el("span", { title: `${nm}: ${ACC_TXT[a] || "?"}` },
            " " + nm, el("span", { class: "imu-acc", style: `background:${ACC_COL[a] || "#888"}` })));
        }
        if (per) {
          v.still.textContent = per.still ? "at rest" : "moving";
          v.still.className = "imu-badge " + (per.still ? "live" : "stale");
        }
      }

      if (iner) {
        const p = iner.rel_pos_mm;
        relVal.textContent = `${fmt(p[0], 1)}, ${fmt(p[1], 1)}, ${fmt(p[2], 1)} mm   |${fmt(iner.rel_dist_mm, 1)}|`;
        const c = iner.confidence;
        conf.textContent = `confidence ${fmt(c, 2)}` + (iner.frames_aligned ? "" : " · frames NOT aligned");
        conf.className = "imu-val " + (c > 0.5 && iner.frames_aligned ? "" : "imu-dim");
        // Confidence measures time since the last STANDSTILL, which says nothing
        // about error already banked into the position. Elapsed integration time
        // is the number that bounds that, so show it next to the offset and warn
        // once it is long enough for the accumulation to dominate.
        const z = iner.since_zero_s;
        if (z != null) {
          drift.textContent = `${z < 90 ? z.toFixed(0) + " s" : (z / 60).toFixed(1) + " min"}` +
            (z > 60 ? " — re-zero for a meaningful number" : "");
          drift.className = "imu-val" + (z > 60 ? "" : " imu-dim");
        }
        const now = performance.now();
        hist.t.push(now); hist.x.push(p[0]); hist.y.push(p[1]); hist.z.push(p[2]);
        while (hist.t.length && now - hist.t[0] > 20000) {
          hist.t.shift(); hist.x.shift(); hist.y.shift(); hist.z.shift();
        }
        // autoscale to what is actually happening, with a floor so a still
        // sensor does not render its own noise as a dramatic waveform
        let m = 50;
        for (const k of ["x", "y", "z"]) for (const v2 of hist[k]) m = Math.max(m, Math.abs(v2));
        chart.o.min = -m * 1.15; chart.o.max = m * 1.15;
        chart.draw([
          { t: hist.t, v: hist.x, color: "#C9401B" },
          { t: hist.t, v: hist.y, color: "#2E7D53" },
          { t: hist.t, v: hist.z, color: "#2B6CB0" },
        ], now);
        // the same history as a path through space. The strip chart answers
        // "when", this answers "where" - and a reach reads as a reach here
        // while it reads as three unrelated wiggles there.
        const pts = hist.t.map((_, k) => [hist.x[k], hist.y[k], hist.z[k]]);
        const ha = full.hand && full.hand.live ? full.hand.lin : null;
        trace.draw(pts, ha, { minSpanMm: 40 });
      }
    }));
    return wrap;
  }

  // ---- live orientation readout, gizmos, rigid-body check -------------------
  // Rolling window of the hand->forearm relative rotation. For a RIGID body the
  // relative rotation is constant by definition, so any wander in it while the
  // arm is moved as one piece is exactly the frame misalignment - a direct
  // measurement rather than a judgement about whether the twin "looks right".
  const relHist = [];
  cleanups.push(store.onSnap((s) => {
    mockBadge.style.display = store.tele && store.tele.kind === "ws" ? "none" : "";
    const map = { hand: s.hand, forearm: s.forearm, thumb: s.thumb };
    const grav = s.imu_full || {};
    for (const { key } of IMUS) {
      const ui = cards[key]; const f = map[key];
      if (!ui) continue;
      const gq = grav[key];
      if (f && f.live !== false && f.rpy_deg) {
        ui.rpy.textContent = f.rpy_deg.map((v) => v.toFixed(1)).join(", ") + "  (r,p,y)";
        ui.rpy.className = "imu-val";
        ui.liveDot.textContent = "live"; ui.liveDot.className = "imu-badge live";
        ui.gizCanvas.classList.remove("absent");
        ui.giz.draw(f.quat, { gravity: gq && gq.live ? gq.grv : null });
      } else {
        ui.rpy.textContent = "--"; ui.rpy.className = "imu-val imu-dim";
        ui.liveDot.textContent = key === "thumb" ? "not fitted" : "no data";
        ui.liveDot.className = "imu-badge stale";
        ui.gizCanvas.classList.add("absent");
        ui.giz.draw([1, 0, 0, 0]);
      }
    }

    // --- rigid-body agreement -------------------------------------------
    if (s.hand?.live !== false && s.forearm?.live !== false &&
        s.hand?.quat && s.forearm?.quat && s.rel?.live !== false) {
      const rel = qMul(qConj(s.hand.quat), s.forearm.quat);
      const now = performance.now();
      relHist.push({ t: now, q: rel, h: s.hand.quat });
      while (relHist.length && now - relHist[0].t > 6000) relHist.shift();
      // how far the relative rotation has wandered across the window
      let wander = 0;
      for (const e of relHist) wander = Math.max(wander, qAngleDeg(qMul(qConj(e.q), rel)));
      // ...and how much the ARM itself actually turned over the same window.
      // This is the gate, and it has to be the arm's motion rather than the
      // wander: a stationary rig produced 0.6 deg of pure noise, which sailed
      // past a wander-based threshold and declared the frames good while nothing
      // had been tested at all. You cannot detect a frame mismatch without
      // rotating the body - so demand a real rotation before saying anything.
      let armMoved = 0;
      for (const e of relHist) armMoved = Math.max(armMoved, qAngleDeg(qMul(qConj(e.h), s.hand.quat)));
      rigGiz.draw(s.forearm.quat, { compare: s.hand.quat });
      rigVal.textContent = wander.toFixed(1) + "°";
      const moved = relHist.length > 20 && armMoved > 25;
      let verdict, cls;
      if (!moved) {
        verdict = `Move the whole arm as one rigid piece (wrist stiff) to test this. ` +
                  `Rotation so far: ${armMoved.toFixed(0)}° of the 25° needed.`;
        cls = "";
      } else if (wander < 6) {
        verdict = `Frames track together across ${armMoved.toFixed(0)}° of arm rotation: ` +
                  `the mounting config agrees with the hardware.`;
        cls = "good";
      } else if (wander < 15) {
        verdict = `Some disagreement over ${armMoved.toFixed(0)}° of arm rotation. ` +
                  `Worth running the alignment.`;
        cls = "";
      } else {
        verdict = `Frames disagree badly over ${armMoved.toFixed(0)}° of arm rotation - ` +
                  `run the 4-tap alignment on the forearm.`;
        cls = "bad";
      }
      rigVerdict.textContent = verdict;
      rigVerdict.className = "imu-verdict " + cls;
    } else {
      relHist.length = 0;              // recovery starts from a clean baseline
      rigVal.textContent = "--";
      rigVerdict.textContent = "Hand and forearm IMUs must both be live for the rigid-body check.";
      rigVerdict.className = "imu-verdict bad";
    }
  }));

  return () => {
    for (const c of cleanups) { try { c(); } catch (_) {} }
    head.remove();                       // the router's unmount contract
  };
}
