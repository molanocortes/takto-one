// mirror.js - Rehabilitation biofeedback: camera mirror therapy.
//
// The laptop camera tracks the patient's HEALTHY hand; its per-finger flexion
// becomes the target trajectory q*(t). The device twin (the impaired hand)
// follows that target under the assist-as-needed law of the thesis
// (eq:assist): help only past a deadband, in proportion to the error. The
// result is classical mirror therapy made active and instrumented: the good
// hand leads, the impaired hand follows and is helped exactly as much as it
// needs, and every repetition is scored.
//
// Self-contained and graceful: if the camera or the hand-tracking library is
// unavailable, the view explains why and never breaks the console. When a real
// device is attached it receives the per-finger targets over the same socket.

import { el, clamp } from "../ui.js";
import { store } from "../store.js";
import { Twin } from "../twin.js";
import { MCP_MAX_DEG, PIP_MAX_DEG } from "../kinematics.js";

// The present wearable has two independently driven DOFs on the index finger.
// Keep this surface deliberately single-finger rather than displaying a fake
// four-finger therapy session that its physical controller cannot reproduce.
const FINGERS = ["index"];
// MediaPipe Hands landmark indices: [mcp, pip, dip] per finger (wrist = 0).
// The DEVICE has no DIP joint - its DOFs are MCP abduction, MCP flexion, and
// PIP flexion - so the camera reading must isolate the healthy hand's MCP and
// PIP angles and NOTHING distal of the PIP. The dip landmark is used only as
// the distal REFERENCE POINT for the PIP angle (vertex at pip); the fingertip
// never enters the measurement, so the anatomical DIP cannot leak in. (The
// old reading used the tip, which folded the DIP bend into one curl and then
// synthesized both device joints from it - wrong on both counts.)
const LM = { index: [5, 6, 7], middle: [9, 10, 11], ring: [13, 14, 15], pinky: [17, 18, 19] };
const DEADBAND = 0.08;                       // e_db: inside this the patient is unaided
const HANDLANDMARKER_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

function styleOnce() {
  if (document.getElementById("mirror-style")) return;
  const s = el("style", { id: "mirror-style" });
  s.textContent = `
  .mir { position:fixed; inset:0; overflow:hidden; }
  .mir-stage { position:absolute; inset:0; }
  .mir-exit { position:absolute; top:18px; right:20px; z-index:6; color:var(--sub,#8B8474);
    text-decoration:none; font-size:20px; opacity:.7; }
  .mir-exit:hover { opacity:1; }
  .mir-cam { position:absolute; bottom:20px; right:20px; width:210px; z-index:5;
    border-radius:14px; overflow:hidden; background:#0b0f14;
    box-shadow:0 10px 30px rgba(35,30,22,.25); border:1px solid rgba(35,30,22,.2); }
  .mir-cam video { display:block; width:100%; transform:scaleX(-1); }
  .mir-cam canvas { position:absolute; inset:0; width:100%; height:100%; transform:scaleX(-1); }
  .mir-cam-tag { position:absolute; top:8px; left:10px; font:600 10px/1 ui-monospace,monospace;
    letter-spacing:.08em; color:#C9401B; text-transform:uppercase; }
  .mir-hud { position:absolute; left:24px; top:22px; z-index:5; max-width:340px; }
  .mir-kicker { font:600 11px/1 ui-monospace,monospace; letter-spacing:.14em; text-transform:uppercase;
    color:#C9401B; margin-bottom:8px; }
  .mir-title { font:600 26px/1.15 var(--font,system-ui); color:var(--ink,#23201A); margin:0 0 6px; }
  .mir-sub { font:400 13px/1.5 var(--font,system-ui); color:var(--sub,#8B8474); margin:0; }
  .mir-bars { position:absolute; left:24px; bottom:24px; z-index:5; width:300px; }
  .mir-bar { margin-bottom:11px; }
  .mir-bar-k { display:flex; justify-content:space-between; font:600 10px/1 ui-monospace,monospace;
    letter-spacing:.06em; text-transform:uppercase; color:var(--sub,#8B8474); margin-bottom:4px; }
  .mir-bar-t { position:relative; height:7px; border-radius:4px; background:rgba(35,30,22,.10); overflow:hidden; }
  .mir-bar-target { position:absolute; top:0; bottom:0; left:0; border-radius:4px;
    background:rgba(201,64,27,.22); }
  .mir-bar-fill { position:absolute; top:0; bottom:0; left:0; border-radius:4px;
    background:linear-gradient(90deg,#C9401B,#5F8A5C); transition:width .05s linear; }
  .mir-assist { position:absolute; top:0; bottom:0; border-radius:4px; background:rgba(192,131,39,.55); }
  .mir-state { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    z-index:7; background:rgba(242,238,229,.78); backdrop-filter:blur(4px); }
  .mir-state-card { max-width:430px; text-align:center; padding:26px 30px; }
  .mir-state-card h3 { font:600 20px/1.2 var(--font,system-ui); color:var(--ink,#23201A); margin:0 0 10px; }
  .mir-state-card p { font:400 13px/1.55 var(--font,system-ui); color:var(--sub,#8B8474); margin:0 0 16px; }
  .mir-btn { appearance:none; border:1px solid rgba(201,64,27,.5); background:rgba(201,64,27,.08);
    color:#A23214; font:600 13px/1 var(--font,system-ui); padding:11px 20px; border-radius:9px; cursor:pointer; }
  .mir-btn:hover { background:rgba(201,64,27,.15); }
  .mir-reps { position:absolute; top:22px; left:50%; transform:translateX(-50%); z-index:5;
    display:flex; gap:7px; }
  .mir-rep { width:9px; height:9px; border-radius:50%; background:rgba(35,30,22,.16); }
  .mir-rep.lit { background:#5F8A5C; box-shadow:0 0 0 3px rgba(95,138,92,.18); }
  .mir-hud .mock-badge { margin-top:12px; }
  .mir-follow { position:absolute; right:20px; top:20px; z-index:6; width:260px; padding:14px;
    border:1px solid rgba(91,168,245,.34); border-radius:14px; background:rgba(8,14,24,.88);
    color:#EAF3FF; box-shadow:0 10px 30px rgba(0,0,0,.22); }
  .mir-follow h3 { margin:0 0 6px; font:600 12px/1.2 ui-monospace,monospace; letter-spacing:.08em; text-transform:uppercase; }
  .mir-follow p { margin:0 0 10px; color:#AABCCC; font:400 12px/1.45 var(--font,system-ui); }
  .mir-follow-row { display:flex; gap:7px; align-items:center; margin-top:8px; }
  .mir-follow select { flex:1; background:#101C2B; color:#EAF3FF; border:1px solid #314966; border-radius:7px; padding:7px; }
  .mir-follow button { background:#17426F; color:#F4FAFF; border:1px solid #5BA8F5; border-radius:7px; padding:8px 10px; cursor:pointer; font:600 11px/1 var(--font,system-ui); }
  .mir-follow button.stop { color:#FFD9D5; background:#54231F; border-color:#B55D54; }
  .mir-follow-status { font:600 10px/1.4 ui-monospace,monospace; color:#8BC7FF; min-height:28px; }
  .mir-follow-check { color:#C5D4E2; font:400 11px/1.35 var(--font,system-ui); }
  .mir-follow details { margin-top:9px; border-top:1px solid rgba(139,199,255,.18); padding-top:8px; }
  .mir-follow summary { cursor:pointer; color:#AABCCC; font:600 10px/1 ui-monospace,monospace; letter-spacing:.06em; text-transform:uppercase; }
  /* guided sequence: every step shows its own state, and only the step you can
     actually act on is live. "Nothing happens" must never be a possible reading. */
  .mir-steps { list-style:none; margin:10px 0 0; padding:0; }
  .mir-step { display:flex; gap:9px; align-items:flex-start; padding:7px 0;
    border-top:1px solid rgba(139,199,255,.12); }
  .mir-step:first-child { border-top:0; }
  .mir-step-dot { flex:0 0 18px; height:18px; border-radius:50%; margin-top:1px;
    display:flex; align-items:center; justify-content:center;
    font:700 10px/1 ui-monospace,monospace; background:rgba(139,199,255,.12); color:#6E8299; }
  .mir-step.done .mir-step-dot { background:#2E5E43; color:#CFF3DE; }
  .mir-step.now  .mir-step-dot { background:#17426F; color:#EAF3FF; box-shadow:0 0 0 3px rgba(91,168,245,.20); }
  .mir-step.busy .mir-step-dot { background:#6A4B12; color:#FFE4AE; }
  .mir-step-body { flex:1; min-width:0; }
  .mir-step-t { font:600 11px/1.3 var(--font,system-ui); color:#8195A8; }
  .mir-step.now .mir-step-t, .mir-step.done .mir-step-t { color:#EAF3FF; }
  .mir-step-d { font:400 10px/1.4 var(--font,system-ui); color:#8195A8; margin-top:2px; }
  .mir-step.now .mir-step-d { color:#AECBE8; }
  .mir-step button { margin-top:6px; width:100%; }
  .mir-next { margin-top:10px; padding:8px 10px; border-radius:8px;
    background:rgba(91,168,245,.10); border:1px solid rgba(91,168,245,.28);
    font:600 11px/1.4 var(--font,system-ui); color:#DCEBFA; }
  .mir-next.warn { background:rgba(201,64,27,.12); border-color:rgba(201,64,27,.45); color:#FFD9D5; }
  `;
  document.head.append(s);
}

function angleDeg(a, b, c) {
  const v1 = [a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)];
  const v2 = [c.x - b.x, c.y - b.y, (c.z || 0) - (b.z || 0)];
  const d = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  const n = (Math.hypot(...v1) * Math.hypot(...v2)) || 1;
  return Math.acos(clamp(d / n, -1, 1)) * 180 / Math.PI;
}

// Per-joint flexion 0..1, matching the device's two driven DOFs.
// MCP: interior angle at the knuckle between wrist->mcp and mcp->pip
// (straight ~170 deg -> 0, fully flexed ~95 deg -> 1 = the device's 90 deg).
// PIP: interior angle at the pip between mcp->pip and pip->dip
// (straight ~172 deg -> 0, fully flexed ~72 deg -> 1 = the device's 110 deg).
function fingerJoints(lms, f) {
  const [mcp, pip, dip] = LM[f];
  const mcpAng = angleDeg(lms[0], lms[mcp], lms[pip]);
  const pipAng = angleDeg(lms[mcp], lms[pip], lms[dip]);
  return {
    m: clamp((170 - mcpAng) / (170 - 95), 0, 1),
    p: clamp((172 - pipAng) / (172 - 72), 0, 1),
  };
}

export function mountMirror(rootHost) {
  localStorage.setItem("zero.role", "mirror");
  styleOnce();
  const cleanups = [];
  const root = el("div", { class: "mir" });

  const stage = el("div", { class: "mir-stage" });
  const exit = el("a", { href: "#/", class: "mir-exit", title: "Home" }, "✕");

  // HONESTY: this surface streams mirror targets to a device. With no bridge
  // (the default when the page is opened without ?ws=) nothing receives them and
  // the twin is a local simulation, so say which of the two the therapist is
  // looking at instead of implying a device is following.
  const mockBadge = el("button", { class: "mock-badge",
    title: "No bridge: the twin is a local simulation and no device is receiving these targets. Click to connect to the live bridge (ws://localhost:8765/ws)." },
    "MOCK · NO DEVICE");
  mockBadge.addEventListener("click", () => {
    const u = new URL(location.href);
    u.searchParams.set("ws", "ws://localhost:8765/ws");
    location.href = u.toString();
  });
  if (store.live) mockBadge.style.display = "none";
  const linkBadge = el("button", { class: "mock-badge",
    title: "The live bridge is not answering: mirror targets are being dropped. Reconnecting automatically; click to reload now." }, "LINK DOWN");
  linkBadge.addEventListener("click", () => location.reload());
  linkBadge.style.display = "none";
  if (store.live) {
    const updLink = (up) => { linkBadge.style.display = up ? "none" : ""; };
    updLink(store.connected);
    cleanups.push(store.onLink(updLink));
  }

  const hud = el("div", { class: "mir-hud" },
    el("div", { class: "mir-kicker" }, "Rehabilitation · Mirror therapy"),
    el("h2", { class: "mir-title" }, "Your good hand leads."),
    el("p", { class: "mir-sub" },
      "The camera reads the healthy index finger. Tracking is visual until you complete the explicit, safety-gated physical follow setup."),
    mockBadge, linkBadge);

  const video = el("video", { autoplay: true, playsinline: true, muted: true });
  const camCanvas = el("canvas");
  const cam = el("div", { class: "mir-cam" }, video, camCanvas, el("div", { class: "mir-cam-tag" }, "Healthy hand"));

  // per-finger biofeedback bars (target ghost + actual fill + amber assist share)
  const bars = {};
  const barRow = el("div", { class: "mir-bars" });
  for (const f of FINGERS) {
    const target = el("div", { class: "mir-bar-target" });
    const assist = el("div", { class: "mir-assist" });
    const fill = el("div", { class: "mir-bar-fill" });
    const track = el("div", { class: "mir-bar-t" }, target, assist, fill);
    // keep a DIRECT reference to the percentage span: track.previousSibling is
    // the whole .mir-bar-k label row, and writing textContent into it wiped the
    // finger name on the first frame.
    const pct = el("span", { class: "mir-bar-pct" }, "–");
    barRow.append(el("div", { class: "mir-bar" },
      el("div", { class: "mir-bar-k" }, el("span", null, f), pct),
      track));
    bars[f] = { target, assist, fill, pct };
  }

  const GOAL = 8;
  const reps = Array.from({ length: GOAL }, () => el("span", { class: "mir-rep" }));
  const repRow = el("div", { class: "mir-reps" }, ...reps);

  const stateHost = el("div");   // holds the overlay card while loading / on error
  // The camera never arms a wearable simply because it sees a hand.  The
  // controls below expose the firmware's prerequisite sequence: relaxed
  // neutral, measured directions, then an explicit arm.  The browser only
  // streams the healthy INDEX MCP/PIP target after all three are true.
  const followStatus = el("div", { class: "mir-follow-status" }, "Visual tracking only · torque off");
  // DIRECTIONS ARE MEASURED, NEVER TYPED. The previous panel offered two
  // dropdowns and a checkbox reading "I confirmed both directions with a
  // low-current bench test" - while giving the wearer no way to run that test.
  // The only honest options were to guess a sign or to lie to the checkbox, and
  // a wrong sign means the first armed motion pulls the opposing cable, caught
  // only by the 28-degree-for-2-seconds supervisor. The bridge already owned a
  // real probe (12 mA for 150 ms, watching the encoder, refusing to classify
  // below 0.7 degrees of response); it simply had no button. It does now.
  // Encoder-range calibration, the same two-pose method the Control panel uses
  // ({calibrate, what:"neutral"} then {what:"joint_closed", channel}). It has to
  // live here too, and BEFORE the follow steps: the follow's own MCP/PIP targets
  // are produced by calibrated_joint(), so an uncalibrated range does not just
  // freeze the twin, it feeds the controller a bad angle.
  const rangeOpenBtn = el("button", { type: "button" }, "Open");
  const rangeMcpBtn = el("button", { type: "button" }, "MCP end");
  const rangePipBtn = el("button", { type: "button" }, "PIP end");
  const neutralBtn = el("button", { type: "button" }, "Set neutral");
  const mcpTestBtn = el("button", { type: "button" }, "Test MCP direction");
  const pipTestBtn = el("button", { type: "button" }, "Test PIP direction");
  const armBtn = el("button", { type: "button" }, "Arm follow");
  const stopBtn = el("button", { type: "button", class: "stop" }, "Stop");
  const nextLine = el("div", { class: "mir-next" }, "Connecting …");

  // The sequence, declared once. Each step owns its own "am I satisfied" and
  // "why not" so the panel can always answer the only question that matters
  // while nothing is moving: which step am I on, and what do I do about it.
  const STEPS = [
    { id: "link", title: "Device connected",
      hint: "Bridge and Teensy on the same link.",
      done: (s) => s.link, why: () => "Start teensy_bridge.py, then reload." },
    { id: "range", title: "Encoder range", btns: [rangeOpenBtn, rangeMcpBtn, rangePipBtn],
      hint: "Straight hand → Open. Then bend each joint fully and capture its end.",
      done: (s) => s.rc.mcp && s.rc.pip,
      why: (s) => !s.rc.open ? "Hold the hand straight and press Open."
        : !s.rc.mcp ? "Bend the knuckle (MCP) fully, hold, press MCP end."
        : "Bend the middle joint (PIP) fully, hold, press PIP end." },
    { id: "neutral", title: "Neutral captured", btn: neutralBtn,
      hint: "Relax the worn hand, then press.",
      done: (s) => s.zeroed, why: () => "Relax the hand and press Set neutral." },
    { id: "mcp", title: "MCP direction measured", btn: mcpTestBtn,
      hint: "Ramps motor 1 to 30 mA and reads the encoder.",
      done: (s) => s.dv.mcp === 1 || s.dv.mcp === -1,
      why: () => "Press Test MCP direction and keep the hand relaxed." },
    { id: "pip", title: "PIP direction measured", btn: pipTestBtn,
      hint: "Ramps motor 2 to 30 mA and reads the encoder.",
      done: (s) => s.dv.pip === 1 || s.dv.pip === -1,
      why: () => "Press Test PIP direction and keep the hand relaxed." },
    // The camera is checked LAST of the prerequisites, not first: measuring
    // which way a motor pulls is bench work that has nothing to do with vision,
    // and gating it behind hand tracking blocked the setup for no reason.
    { id: "camera", title: "Camera sees your index",
      hint: "Show the HEALTHY hand, palm to the camera.",
      done: () => trackingFrames >= 15 && performance.now() - lastTrackedAt < 250,
      why: () => "Hold your healthy hand steady in frame until the dots appear." },
    { id: "arm", title: "Follow armed", btn: armBtn,
      hint: "The device confirms before this turns green.",
      done: (s) => s.armed, why: () => "Press Arm follow." },
  ];
  const stepEls = {};
  const stepList = el("ol", { class: "mir-steps" });
  for (const st of STEPS) {
    const dot = el("span", { class: "mir-step-dot" }, String(STEPS.indexOf(st) + 1));
    const title = el("div", { class: "mir-step-t" }, st.title);
    const detail = el("div", { class: "mir-step-d" }, st.hint);
    const body = el("div", { class: "mir-step-body" }, title, detail);
    // Keep a handle on whatever this step's controls are, so a finished step can
    // put them away. A checked step does not need its buttons any more, and six
    // rows of dead controls is most of what makes this panel hard to read.
    let ctrl = null;
    if (st.btn) { ctrl = st.btn; body.append(st.btn); }
    if (st.btns) { ctrl = el("div", { class: "mir-follow-row" }, ...st.btns); body.append(ctrl); }
    const li = el("li", { class: "mir-step" }, dot, body);
    stepEls[st.id] = { li, dot, detail, ctrl };
    stepList.append(li);
  }
  const followPanel = el("aside", { class: "mir-follow" },
    el("h3", {}, "Camera → hand"),
    el("p", {}, "Index MCP and PIP only. A camera loss releases torque within 250 ms."),
    stepList, nextLine, followStatus,
    el("div", { class: "mir-follow-row" }, stopBtn));
  root.append(stage, exit, cam, hud, barRow, repRow, followPanel, stateHost);
  rootHost.append(root);

  const twin = Twin.acquire(stage, { orbit: false, idle: false, idleSpin: false,
    yaw: -0.9, pitch: 0.32, dist: 7.0, targetY: -0.5, targetZ: 0.6 });
  cleanups.push(() => twin.dispose());

  // synthesized twin state (the impaired hand): joints in deg, actual follows
  // target. Quats are WIRE order [w,x,y,z] (store convention) - identity is
  // [1,0,0,0]; the old [0,0,0,1] was three.js (x,y,z,w) identity, which the
  // wire order reads as a 180 deg roll and rendered the device upside down.
  const sm = { joints: {}, curl: 0, fingers: {}, activation: { level: 0, fatigue: 0, direction: 0 },
    handQuat: [1, 0, 0, 0], forearmQuat: [1, 0, 0, 0] };
  // per-finger, per-JOINT normalized flexion: {m: MCP 0..1, p: PIP 0..1}.
  // Two independent channels because the device drives MCP and PIP flexion
  // independently (and has no DIP at all).
  const target = {}, actual = {};
  for (const f of FINGERS) { target[f] = { m: 0, p: 0 }; actual[f] = { m: 0, p: 0 }; }

  let disposed = false;
  let landmarker = null;
  let repsDone = 0, wasClosed = false;
  let trackingFrames = 0;
  let lastTrackedAt = 0;
  let physicalFollow = false;
  let followSetup = { zeroed: false, directions: false };
  let noticeUntil = 0;

  function notifyFollow(text, duration = 3000) {
    followStatus.textContent = text;
    noticeUntil = performance.now() + duration;
  }

  function sendFollow(action, extra = {}) {
    // `store.send` reports a genuine socket result; it does not imply the
    // firmware accepted motion.  The snapshot below remains the authority for
    // displayed arm state.
    if (!store.live || !store.connected) {
      notifyFollow("Bridge offline · torque remains off");
      return false;
    }
    return store.send({ cmd: "camera_follow", action, ...extra });
  }

  neutralBtn.addEventListener("click", () => {
    physicalFollow = false;
    sendFollow("neutral");
    notifyFollow("Neutral requested · keep both joints relaxed");
  });
  // Same backend the Control panel's wizard uses, so one calibration serves both.
  rangeOpenBtn.addEventListener("click", () => {
    if (!store.live || !store.connected) { notifyFollow("Bridge offline"); return; }
    store.send({ cmd: "calibrate", what: "neutral" });
    notifyFollow("Open reference captured · now bend one joint fully");
  });
  rangeMcpBtn.addEventListener("click", () => {
    if (!store.live || !store.connected) { notifyFollow("Bridge offline"); return; }
    store.send({ cmd: "calibrate", what: "joint_closed", channel: 8 });
    notifyFollow("MCP endpoint captured");
  });
  rangePipBtn.addEventListener("click", () => {
    if (!store.live || !store.connected) { notifyFollow("Bridge offline"); return; }
    store.send({ cmd: "calibrate", what: "joint_closed", channel: 9 });
    notifyFollow("PIP endpoint captured");
  });

  function runDirectionTest(axis) {
    if (!followSetup.zeroed) {
      notifyFollow("Set the relaxed neutral first");
      return;
    }
    sendFollow("identify", { axis });
    notifyFollow(`Testing ${axis.toUpperCase()} · brief 12 mA pulse, keep the hand relaxed`, 2500);
  }
  mcpTestBtn.addEventListener("click", () => runDirectionTest("mcp"));
  pipTestBtn.addEventListener("click", () => runDirectionTest("pip"));
  armBtn.addEventListener("click", () => {
    if (!followSetup.zeroed) {
      notifyFollow("Safety setup: set the relaxed neutral first");
      return;
    }
    if (!followSetup.directions) {
      notifyFollow("Safety setup: measure both MCP and PIP directions");
      return;
    }
    if (trackingFrames < 15 || performance.now() - lastTrackedAt > 250) {
      notifyFollow("Camera not tracking yet · hold the healthy index in view");
      return;
    }
    sendFollow("arm");
    notifyFollow("Arming only if firmware prerequisites pass");
  });
  stopBtn.addEventListener("click", () => {
    physicalFollow = false;
    sendFollow("stop");
    notifyFollow("Stopped · torque off");
  });
  // One place decides what is done, what is next, and what every control may do.
  // Previously each control carried its own ad-hoc disabled logic and the panel
  // could sit silent with nothing enabled and no explanation.
  function renderSteps(cf) {
    const rcRaw = cf.range_cal || {};
    const state = {
      link: !!(store.live && store.connected),
      zeroed: !!cf.zeroed,
      armed: !!cf.armed && !cf.arming,
      dv: cf.direction_values || {},
      rc: {
        open: !!(rcRaw.index_pip && rcRaw.index_pip.open),
        mcp: !!(rcRaw.index_pip && rcRaw.index_pip.closed),
        pip: !!(rcRaw.index_dip && rcRaw.index_dip.closed),
        mcpSpan: rcRaw.index_pip && rcRaw.index_pip.span_deg,
        pipSpan: rcRaw.index_dip && rcRaw.index_dip.span_deg,
      },
    };
    const busy = state.armed || !!cf.probing || !!cf.arming;
    let current = null;
    for (const st of STEPS) {
      const ok = st.done(state);
      const isCurrent = !ok && current === null;
      if (isCurrent) current = st;
      const probing = cf.probing === st.id;
      const e = stepEls[st.id];
      e.li.className = "mir-step" + (ok ? " done" : probing ? " busy" : isCurrent ? " now" : "");
      e.dot.textContent = ok ? "✓" : probing ? "…" : String(STEPS.indexOf(st) + 1);
      if (st.id === "range") {
        // Report the span actually measured between the captured marks. No
        // assumed anatomical ROM appears here.
        const parts = [];
        parts.push(state.rc.open ? "open ✓" : "open —");
        parts.push(state.rc.mcp ? `MCP ${state.rc.mcpSpan}° travel` : "MCP —");
        parts.push(state.rc.pip ? `PIP ${state.rc.pipSpan}° travel` : "PIP —");
        e.detail.textContent = (state.rc.open || state.rc.mcp || state.rc.pip)
          ? "Measured: " + parts.join(" · ") : st.hint;
        rangeMcpBtn.disabled = busy || !state.rc.open;
        rangePipBtn.disabled = busy || !state.rc.open;
        rangeOpenBtn.disabled = busy;
      }
      if (st.id === "mcp" || st.id === "pip") {
        const v = state.dv[st.id];
        e.detail.textContent = probing ? "Ramping to 30 mA, watching the encoder …"
          : v === 1 ? "Measured: this motor pulls +"
          : v === -1 ? "Measured: this motor pulls −" : st.hint;
      }
      // Only the step you are actually on is actionable, and never while the
      // device is mid-probe or already driving.
      if (st.btn) st.btn.disabled = busy || !isCurrent;
      // The range row owns its own three buttons (set just above); do not let
      // the generic rule re-enable them out of order.
      if (st.btns && !isCurrent) st.btns.forEach((b) => { b.disabled = true; });
      // A satisfied step collapses to its result: controls away, instructional
      // hint away, and only a MEASURED value kept as the evidence it happened.
      if (e.ctrl) e.ctrl.style.display = ok ? "none" : "";
      const measured = ok && /^(Measured|MCP|PIP|open)/.test(e.detail.textContent);
      e.detail.style.display = (ok && !measured) ? "none" : "";
    }
    if (state.armed) {
      nextLine.className = "mir-next";
      nextLine.textContent = "Armed. Move your healthy index finger slowly.";
    } else if (cf.probing) {
      nextLine.className = "mir-next";
      nextLine.textContent = `Testing ${cf.probing.toUpperCase()} · keep the worn hand relaxed.`;
    } else if (current) {
      // A device-reported failure explains the CURRENT step better than the
      // generic instruction does, so it wins when there is one.
      const failed = cf.reason && cf.reason !== "disarmed"
        && /no |could not|refused|unavailable|stale/i.test(cf.reason);
      nextLine.className = "mir-next" + (failed ? " warn" : "");
      nextLine.textContent = failed ? cf.reason : "Next: " + current.why();
    } else {
      nextLine.className = "mir-next";
      nextLine.textContent = "Ready.";
    }
  }

  cleanups.push(store.onSnap((s) => {
    const cf = s && s.camera_follow;
    if (!cf) return;
    // `cf.armed` is the DEVICE's answer from firmware v14 on (cf.confirmed),
    // and only the bridge's own request on older builds. Never treat a pending
    // arm as armed: the twin below renders cf.actual as physical truth.
    physicalFollow = !!cf.armed && !cf.arming;
    followSetup = { zeroed: !!cf.zeroed, directions: !!cf.directions };
    // The learned signs come from the DEVICE's own probe result, so an axis
    // reads "—" until it has actually been measured. A probe in flight is shown
    // as "testing", never as a result.
    renderSteps(cf);
    if (performance.now() < noticeUntil) return;
    if (!cf.armed && trackingFrames === 0) {
      followStatus.textContent = cf.probing
        ? `Testing ${cf.probing.toUpperCase()} direction · keep the hand relaxed`
        : (cf.reason && cf.reason !== "disarmed" ? cf.reason
           : "Camera not tracking · show one healthy index finger");
      return;
    }
    const target = cf.target;
    const live = cf.armed && cf.fresh;
    if (cf.arming) {
      // The bridge has sent the arm sequence but the device has not confirmed
      // it yet. Saying "following" here is what used to hide a refused arm.
      followStatus.textContent = "Arming · waiting for the device to confirm";
    } else if (live && target) {
      followStatus.textContent = `Following index · ${target.mcp_deg.toFixed(0)}° / ${target.pip_deg.toFixed(0)}°`
        + (cf.confirmed ? "" : " (unconfirmed: flash firmware v14)");
    } else if (cf.armed || (cf.reason && cf.reason !== "disarmed")) {
      // Do not erase a local camera-tracking diagnostic with the bridge's
      // ordinary idle word on every 60 Hz snapshot.
      followStatus.textContent = cf.reason || "Visual tracking only · torque off";
    }
  }));

  // The camera step's state lives in the render loop, not in a snapshot, and
  // with no bridge there are no snapshots at all. Tick the panel independently
  // so it can never sit frozen on a stale instruction.
  const stepTimer = setInterval(() => {
    if (disposed) return;
    renderSteps((store.snap && store.snap.camera_follow) || {
      zeroed: false, armed: false, direction_values: {},
      reason: store.live ? "waiting for the bridge" : "no bridge connected",
    });
  }, 250);
  cleanups.push(() => clearInterval(stepTimer));

  function showState(title, body, action) {
    stateHost.innerHTML = "";
    const card = el("div", { class: "mir-state-card" }, el("h3", null, title), el("p", null, body));
    if (action) { const b = el("button", { class: "mir-btn" }, action.label); b.addEventListener("click", action.fn); card.append(b); }
    stateHost.append(el("div", { class: "mir-state" }, card));
  }
  function clearState() { stateHost.innerHTML = ""; }

  // ---- render loop: visual preview, or measured physical feedback ----------
  const ASSIST_K = 0.16;      // K_a: fraction of the beyond-deadband error corrected per frame
  const PATIENT_K = 0.05;     // how fast the (simulated) impaired hand moves on its own
  let assistShare = 0;
  // real frame time for the twin: its easings are exp(-dt/tau), so a hardcoded
  // 16 ms made the camera settle at double speed on a 120 Hz panel and freeze
  // for the duration of any long frame. (The assist constants above stay
  // per-frame on purpose - they model the loop, not the look.)
  let lastFrameT = 0;
  function frame(now = performance.now()) {
    if (disposed) return;
    const dtMs = lastFrameT ? Math.min(64, now - lastFrameT) : 16;
    lastFrameT = now;
    const cf = store.snap && store.snap.camera_follow;
    // During a real follow, the bridge supplies the encoder-derived MCP/PIP
    // displacement from the neutral captured on the wearable.  This replaces
    // the former pretend "patient" animation: the twin shows the device that
    // is actually on the hand, including any lag or tracking error.
    const physical = physicalFollow && cf && cf.actual
      && Number.isFinite(cf.actual.mcp_deg) && Number.isFinite(cf.actual.pip_deg);
    // LIVE DEVICE POSE, EVEN WHEN NOT ARMED. The twin used to consult the
    // encoders only while a follow was armed, so during the whole setup - which
    // is most of the time you are actually looking at this screen - moving the
    // worn finger did nothing and the twin read as broken. The device is always
    // the truth about the device; the simulated patient is only for when there
    // is no device at all.
    // IMU ORIENTATION. handQuat/forearmQuat were initialised to identity and then
    // never written again, so the twin's wrist and forearm were frozen for the
    // whole life of this view no matter what the sensors did. Feed the live
    // quaternions through, in the store's wire order [w,x,y,z], and only while
    // the sensor is actually live so a dropout freezes rather than snaps.
    const snapNow = store.snap;
    if (snapNow) {
      if (snapNow.hand && snapNow.hand.live && Array.isArray(snapNow.hand.quat)) {
        sm.handQuat = snapNow.hand.quat;
      }
      if (snapNow.forearm && snapNow.forearm.live && Array.isArray(snapNow.forearm.quat)) {
        sm.forearmQuat = snapNow.forearm.quat;
      }
    }
    const jl = (store.snap && store.snap.joints) || [];
    const jget = (id) => jl.find((j) => j.id === id);
    const jMcp = jget("index_pip"), jPip = jget("index_dip");   // historic wire names
    const liveJoints = !physical && jMcp && jPip && jMcp.ok && jPip.ok
      && jMcp.calibrated && jPip.calibrated;
    let totalCurl = 0;
    for (const f of FINGERS) {
      if (physical) {
        const lim = cf.limit || { mcp_deg: 35, pip_deg: 45 };
        actual[f].m = clamp(cf.actual.mcp_deg / lim.mcp_deg, 0, 1);
        actual[f].p = clamp(cf.actual.pip_deg / lim.pip_deg, 0, 1);
      } else if (liveJoints) {
        // Normalize against the joint's own calibrated range, not a guessed one.
        actual[f].m = clamp(jMcp.deg / MCP_MAX_DEG, 0, 1);
        actual[f].p = clamp(jPip.deg / PIP_MAX_DEG, 0, 1);
      } else {
        // Local preview only: it lets camera framing and hand tracking be
        // checked without ever implying physical motion.
        for (const j of ["m", "p"]) {
          const e = target[f][j] - actual[f][j];
          const mag = Math.abs(e);
          const own = PATIENT_K * e;
          const assist = mag > DEADBAND ? ASSIST_K * Math.sign(e) * (mag - DEADBAND) : 0;
          actual[f][j] = clamp(actual[f][j] + own + assist, 0, 1);
        }
      }
      // device joints, named by the WIRE channels (historic names: {f}_pip is
      // the MCP-flexion channel, {f}_dip is the PIP-flexion channel - the
      // device has NO DIP joint, these are its only two driven DOFs)
      sm.joints[`${f}_pip`] = physical ? cf.actual.mcp_deg
        : liveJoints ? jMcp.deg : MCP_MAX_DEG * actual[f].m;
      sm.joints[`${f}_dip`] = physical ? cf.actual.pip_deg
        : liveJoints ? jPip.deg : PIP_MAX_DEG * actual[f].p;
      sm.joints[`${f}_mcp`] = 0;        // abduction neutral
      const curlA = (actual[f].m + actual[f].p) / 2;
      const curlT = (target[f].m + target[f].p) / 2;
      const eC = curlT - curlA, magC = Math.abs(eC);
      sm.fingers[f] = curlA;
      totalCurl += curlA;
      // biofeedback bars (combined curl of the two driven joints)
      const b = bars[f];
      b.target.style.width = (curlT * 100).toFixed(0) + "%";
      b.fill.style.width = (curlA * 100).toFixed(0) + "%";
      const aStart = Math.min(curlA, curlT);
      b.assist.style.left = (aStart * 100).toFixed(0) + "%";
      b.assist.style.width = (Math.max(0, magC - DEADBAND) * 100 * (magC > DEADBAND ? 1 : 0)).toFixed(0) + "%";
      b.pct.textContent = Math.round(curlA * 100) + "%";
    }
    sm.curl = totalCurl / FINGERS.length;
    twin.render(sm, dtMs);

    // rep scoring: a full mirrored close-then-open counts once
    if (sm.curl > 0.7) wasClosed = true;
    if (wasClosed && sm.curl < 0.28) {
      wasClosed = false;
      if (repsDone < GOAL) { reps[repsDone].classList.add("lit"); repsDone++; }
    }

    // The legacy mirror message still drives the SIM/twin surface.  The
    // physical wearable receives a separate, throttled and safety-gated
    // two-joint message below; no raw motor current comes from the browser.
    const nowTx = performance.now();
    if (nowTx - lastMirrorTx > 16) {   // ~60 Hz, matched to the bridge tick (was 30 Hz)
      lastMirrorTx = nowTx;
      // wire contract unchanged: per-finger 0..1 curl (the bridge drives one
      // motor target per finger from it); the per-joint split stays local
      const tx = {};
      for (const f of FINGERS) tx[f] = (target[f].m + target[f].p) / 2;
      store.send({ cmd: "mirror", targets: tx, assist: assistShare });
    }
    // 10 Hz deliberately favours steady, readable rehabilitation motion over
    // video-rate chasing.  The bridge drops torque after 250 ms without a
    // fresh target, so this needs a continuous confident track.
    if (physicalFollow && trackingFrames >= 15 && nowTx - lastTrackedAt <= 250
        && nowTx - lastCameraFollowTx > 100) {
      lastCameraFollowTx = nowTx;
      const lim = (store.snap && store.snap.camera_follow && store.snap.camera_follow.limit)
        || { mcp_deg: 35, pip_deg: 45 };
      sendFollow("target", { target: {
        mcp_deg: target.index.m * lim.mcp_deg,
        pip_deg: target.index.p * lim.pip_deg,
      } });
    }
    requestAnimationFrame(frame);
  }
  let lastMirrorTx = 0;
  let lastCameraFollowTx = 0;
  requestAnimationFrame(frame);

  // ---- camera + hand tracking ------------------------------------------------
  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showState("Camera unavailable", "This browser did not expose a camera. Mirror therapy needs a webcam to read the healthy hand.");
      return;
    }
    showState("Starting the camera", "Allow camera access when your browser asks. Nothing is recorded or uploaded; the video stays on this machine.");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
    } catch (err) {
      showState("Camera blocked", "Camera permission was declined. Enable it for this page and reload to use mirror therapy.",
        { label: "Try again", fn: () => start() });
      return;
    }
    if (disposed) { stream.getTracks().forEach((t) => t.stop()); return; }
    video.srcObject = stream;
    cleanups.push(() => stream.getTracks().forEach((t) => t.stop()));
    await video.play().catch(() => {});

    // load the hand-tracking model (graceful if the CDN is unreachable offline)
    if (!(await loadModel())) return;
    if (disposed) return;
    clearState();
    loop();
  }

  // The model load is its own retryable step: "Retry" used to call loop(), which
  // returns immediately while landmarker is still null, so it only wiped the
  // error card and left the twin unfollowed with nothing on screen to say so.
  let modelTry = 0;
  async function loadModel() {
    // A failed dynamic import is remembered by the module map, so re-importing
    // the SAME url resolves to the same failure without touching the network.
    // Retries therefore need a fresh specifier, or "Retry" can never succeed.
    const bust = modelTry++ ? `?retry=${modelTry}` : "";
    try {
      const vision = await import(/* @vite-ignore */ `${HANDLANDMARKER_CDN}/vision_bundle.mjs${bust}`);
      const files = await vision.FilesetResolver.forVisionTasks(`${HANDLANDMARKER_CDN}/wasm`);
      landmarker = await vision.HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task" },
        numHands: 1, runningMode: "VIDEO",
      });
      return true;
    } catch (err) {
      showState("Hand tracking needs the network (first run)", "The hand-tracking model could not be loaded. Connect once to fetch it, or run the bundled offline copy noted in the setup guide, then reopen this mode.",
        { label: "Retry", fn: () => {
          showState("Loading hand tracking", "Fetching the hand-tracking model ...");
          loadModel().then((ok) => { if (ok && !disposed) { clearState(); loop(); } });
        } });
      return false;
    }
  }

  const octx = camCanvas.getContext("2d");
  function drawOverlay(lms) {
    const w = camCanvas.width = video.videoWidth || 640;
    const h = camCanvas.height = video.videoHeight || 480;
    octx.clearRect(0, 0, w, h);
    if (!lms) return;
    octx.fillStyle = "#C9401B";
    for (const p of lms) { octx.beginPath(); octx.arc(p.x * w, p.y * h, 4, 0, 7); octx.fill(); }
  }

  function loop() {
    if (disposed || !landmarker) return;
    if (video.readyState >= 2) {
      let res = null;
      try { res = landmarker.detectForVideo(video, performance.now()); } catch (e) { /* frame skipped */ }
      const lms = res && res.landmarks && res.landmarks[0];
      drawOverlay(lms);
      if (lms) {
        trackingFrames = Math.min(60, trackingFrames + 1);
        lastTrackedAt = performance.now();
        let a = 0;
        for (const f of FINGERS) {
          const j = fingerJoints(lms, f);         // per-joint, no DIP anywhere
          target[f].m = target[f].m * 0.4 + j.m * 0.6;   // light smoothing
          target[f].p = target[f].p * 0.4 + j.p * 0.6;
          a += Math.max(0, Math.abs(target[f].m - actual[f].m) - DEADBAND)
             + Math.max(0, Math.abs(target[f].p - actual[f].p) - DEADBAND);
        }
        assistShare = clamp(a / (FINGERS.length * 2), 0, 1);
      } else {
        trackingFrames = 0;
        if (!physicalFollow && performance.now() >= noticeUntil) {
          followStatus.textContent = "Camera not tracking · show one healthy index finger";
        }
      }
    }
    requestAnimationFrame(loop);
  }

  start();

  return () => {
    disposed = true;
    try { landmarker && landmarker.close && landmarker.close(); } catch (e) {}
    cleanups.forEach((fn) => { try { fn(); } catch (e) {} });
    root.remove();
  };
}
