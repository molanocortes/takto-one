// main.js - session bootstrap, render loop, mode switching.
// One coherent app: Atelier -> Capture / Rhythm / Touch and back.
// Telemetry is a sampled stream: keep the latest snapshot, interpolate in the
// visual layer, never block a frame on the socket.

import * as THREE from "../vendor/three.module.js";
import { makeTelemetry } from "./telemetry.js";
import { World } from "./world/passthrough.js";
import { HandLight } from "./world/handLink.js";
import { LivingSky } from "./world/creatures.js";
import { AudioEngine } from "./design/audio.js";
import { AQUA, AMBER, CSS } from "./design/palette.js";
import { makeGlow, makeRingSprite } from "./world/materials.js";
import { makeWord } from "./modes/common.js";
import { makeCounter } from "./modes/rhythm.js";
import { Atelier } from "./modes/atelier.js";
import { Capture } from "./modes/capture.js";
import { Rhythm } from "./modes/rhythm.js";
import { Touch } from "./modes/touch.js";
import { Twin } from "./modes/twin.js";
import { Replay } from "./modes/replay.js";
import { updateEnvCapture, resetEnvScan, envDiag, setGpuDepthReader,
         sceneObjects, roomAnchor, relocAnchor, relocateLastRoom,
         msSinceOwnPose, worldToRoom,
         DEPTH_GRID_COLS, DEPTH_GRID_ROWS } from "./world/envScan.js";
import { XRHandReader } from "./input/xrHands.js";
import { ContactTracker } from "./world/contact.js";
import { GpuDepthReader } from "./world/depthGpu.js";
import { CloudMotes } from "./world/cloudMotes.js";
import { DiagHud } from "./world/diagHud.js";
import { ScanFeedback } from "./world/scanFeedback.js";
import { sendDiag } from "./diagBeacon.js";
import { ControllerInput } from "./input/controllers.js";
import { applyStageDelta, scanState } from "./world/envScan.js";
import { solveStage, pickTableY, stageDelta, stageFromMatrix, lerpStage, stageNear,
         stageInAnchor, stageFromAnchor, anchorToBase, loadRoomStage, saveRoomStage,
         rotY, applyMat, stageMatrix, invertMat, IDENTITY_STAGE, CANON_DESK } from "./ui/stage.js";
import { PoseLane, RateMeter, mergePose } from "./ui/poseLane.js";
import { statusView, Guide } from "./ui/status.js";
import { StatusHud } from "./ui/hud.js";
import { Dock } from "./ui/dock.js";
import { XRPointer } from "./ui/pointer.js";
import { PinchHold, HoldButton, Debounce } from "./ui/gestures.js";

const canvas = document.getElementById("gl");
const veil = document.getElementById("veil");
const flash = document.getElementById("flash");

const world = new World(canvas);
const audio = new AudioEngine();
const tele = makeTelemetry();
const hand = new HandLight(world.scene);
const sky = new LivingSky(world.scene, audio);   // butterflies + comets, always
// Quest controllers as a seamless TEST telemetry source: while a controller
// is actively used it overlays the live stream (trigger = curl, squeeze =
// effort, pose = hand frame); idle ~2 s hands it back. See input/controllers.js.
const pads = new ControllerInput(world);
// the room being drawn: live rendering of the depth cloud a scan accumulates
// (envScan.js owns the data; this is pure view). Cheap no-op while idle.
const cloudMotes = new CloudMotes(world.scene);
// THE FUSION (2026-07-30): fingertips (hand.tips, local-floor metres) crossed
// with the labelled room (envScan's SceneObjectRegistry, same metres) produce
// per-object contact events. This is what turns a wrist trajectory into
// "the index finger touched the TABLE 14 times". See world/contact.js.
const contacts = new ContactTracker();
// on-headset diagnostics: what was granted, what depth is doing, transport
// state, live counts + guidance. The instrument that made the invisible scan
// failures visible (2026-07-20). Read-only dom-overlay layer.
const diagHud = new DiagHud();
// world-space capture feedback: LOUD, dom-overlay-independent status in front
// of the user (connection banner -> scan progress -> SAVED / ERROR). The
// dom-overlay HUD above is now the bonus layer; this one must always render.
const scanFeedback = new ScanFeedback(world.scene);
// GPU depth readback: on the Quest browser depth-sensing is granted
// gpu-optimized ONLY (owner diag log 2026-07-20), so the CPU depth call
// throws and the room cloud starves. envScan falls back to this reader.
setGpuDepthReader(new GpuDepthReader(world.renderer, DEPTH_GRID_COLS, DEPTH_GRID_ROWS));
// which WebXR features the session actually granted (the smoking-gun line)
let xrFeatures = { list: [], features: {}, depthUsage: "", depthFormat: "" };
function readXrFeatures(session) {
  const ef = (session && session.enabledFeatures) || [];
  const has = (n) => ef.indexOf(n) >= 0;
  return {
    list: Array.from(ef),
    features: { depth: has("depth-sensing"), mesh: has("mesh-detection"),
                plane: has("plane-detection"), hand: has("hand-tracking"),
                anchors: has("anchors") },
    depthUsage: (session && session.depthUsage) || "",
    depthFormat: (session && session.depthDataFormat) || "",
  };
}

let latest = null;                 // newest telemetry snapshot
let takesLib = [];                 // the bridge's take library ({kind:"takes"})
// the fast pose lane (MOTION_PIPELINE.md section 8, ui/poseLane.js): 100 Hz
// body + joints, merged over the newest snap for the device hand and the twin
const lane = new PoseLane({ staleMs: 250 });
const snapRate = new RateMeter();
let _wasRec = false, recordedTake = false;     // first-run guide: a take happened
tele.onSnapshot((s) => {
  if (s.kind === "snap") {
    s._rx = performance.now(); latest = s; snapRate.note(s._rx);
    const r = !!(s.session && s.session.recording);
    if (_wasRec && !r) recordedTake = true;
    _wasRec = r;
  } else if (s.kind === "pose") lane.push(s, Date.now(), performance.now());
  else if (s.kind === "takes" && Array.isArray(s.takes)) takesLib = s.takes;
  else if (s.kind === "ack" && s.event === "rec_stopped") recordedTake = true;
});
// the headset's hands, read straight from each XRFrame (stale-joint and
// handedness-race fixes: see input/xrHands.js)
const xrHands = new XRHandReader({ graceMs: 150 });

// ---------------------------------------------------------------------------
// perf meter (2026-07-30): MEASURED frame health, shipped inside every diag
// payload so on-device numbers land in ~/.sensoryhand_diag.log with the next
// owner attempt. fps = smoothed rAF interval; ms = smoothed main-thread work
// per frame; p95 over the last 120 frames; scanMs = the envScan harvest's
// share. Desktop numbers are a proxy; the Quest numbers in the diag log are
// the truth (72 Hz target on the 3S).
// ---------------------------------------------------------------------------
const perf = { fps: 0, ms: 0, p95: 0, scanMs: 0, _win: new Float32Array(120), _n: 0, _iv: 0, _rafs: 0 };
function perfNote(intervalMs, workMs) {
  if (intervalMs > 0 && intervalMs < 1000) {
    perf._rafs++;
    perf.fps += (1000 / intervalMs - perf.fps) * 0.05;
  }
  perf.ms += (workMs - perf.ms) * 0.05;
  perf._win[perf._n++ % 120] = workMs;
  if (perf._n % 30 === 0) {          // p95 re-ranked twice a second, not per frame
    const w = Array.from(perf._win.subarray(0, Math.min(perf._n, 120))).sort((a, b) => a - b);
    perf.p95 = w[Math.floor(w.length * 0.95)] || 0;
  }
}
function perfSnap() {
  // fps is NULL, never 0, until a real rAF interval has been timed. Frames can
  // also arrive from the throttle watchdog at a fixed dt (hidden tab, headless
  // preview), and a fixed dt is not a frame RATE - reporting 0 there would read
  // in the diag log as "the app is dead" when it only means "not measured".
  // ms/p95 are always real: they time the work, not the cadence.
  return { fps: perf._rafs >= 8 ? Math.round(perf.fps) : null,
           ms: +perf.ms.toFixed(2), p95: +perf.p95.toFixed(2),
           scanMs: +perf.scanMs.toFixed(2), frames: perf._rafs };
}

// ---------------------------------------------------------------------------
// hand x room fusion. Runs every frame, costs one distance test per fingertip
// per object (4 x N, N is single digits in a real room). Sealed events go to
// the bridge, which folds them into the take being recorded.
//
// PROVENANCE is decided here and nowhere else, because here is the only place
// that knows all three facts: whether the physical rig is streaming, whether
// the headset sees a hand, and whether we are on a desktop mock. A contact
// event is only as trustworthy as this word.
// ---------------------------------------------------------------------------
let _contactSrc = "mock";

// The provenance word for the FINGERTIPS this frame (the bridge accepts
// device | quest-hand | mock). It used to say "device" whenever the rig was
// linked, even while the fingertips came from the headset's vision, and the
// controller overlay forced the link on. Now it names who actually placed the
// tips; null = nothing measured them (the eased stand-in), so no contact.
function contactSource(snap) {
  if (hand.poseSource === "vision") return "quest-hand";
  if (hand.poseSource === "controller" || (snap && snap.source === "controller")) return "mock";
  if (tele.describe().simulated) return hand.measured || !world.renderer.xr.isPresenting ? "mock" : null;
  if ((hand.poseSource === "world" || hand.poseSource === "body") && hand.deviceLinked) {
    // a body pose under a GUESSED anchor is not registered to the room
    if (hand.poseSource === "body" && hand.bodyAnchor.source !== "vision") return null;
    return "device";
  }
  return null;
}

function updateContacts(snap) {
  const reg = sceneObjects();
  if (reg.count === 0) return;
  const src = contactSource(snap);
  _contactSrc = src || "none";
  // two clocks: performance.now() is the headset's, snap.t_ms is the Teensy's.
  // Both are stamped on every event so the host can align contacts with the
  // joint columns without anyone inventing an offset. See ROOM-FUSION.md.
  const devMs = (snap && typeof snap.t_ms === "number") ? snap.t_ms : null;
  // unmeasured tips close any open contact instead of inventing one
  const sealed = contacts.update(src ? hand.tips : null, reg, performance.now(), src, devMs);
  if (sealed.length && snap && snap.session && snap.session.recording) {
    // only while recording: contacts outside a take have no session to join
    tele.send({ cmd: "contact", events: sealed, env: envDiag().envId || null });
  }
}

// one merged diagnostic snapshot: envScan's view + granted XR features +
// live transport state. Read by the HUD, the world-space feedback panel,
// window.AR.diag, and the off-device diag log.
function fullDiag() {
  return Object.assign(envDiag(), {
    features: xrFeatures.features, depthUsage: xrFeatures.depthUsage,
    depthFormat: xrFeatures.depthFormat, featureList: xrFeatures.list,
    transport: tele.describe(),
    presenting: world.renderer.xr.isPresenting,
    perf: perfSnap(),
    pose: { src: hand.poseSource, anchor: hand.bodyAnchor.source,
            occluded: !!hand.fallbackOccluded,
            ownPoseMs: Number.isFinite(msSinceOwnPose()) ? Math.round(msSinceOwnPose()) : null },
    contacts: { n: contacts.events.length, src: _contactSrc,
                labels: contacts.labelCounts(), live: contacts.live().length },
    // the UI layer: where the stage sits, how the device pose arrives
    ui: { stage: { yaw: +world.stage.yaw.toFixed(3), pos: world.stage.pos.map((v) => +v.toFixed(3)),
                   last: stageCtl.last ? stageCtl.last.source + "/" + stageCtl.last.reason : null },
          lane: lane.stats(performance.now()), snapHz: snapRate.hz(performance.now()) },
  });
}

// observability loop (2026-07-20): ship the merged diag OFF the device at
// every meaningful transition (connect / disconnect / each scan terminal
// state / every bridge ack). The bridge and the serving origin both append to
// ~/.sensoryhand_diag.log, so a failed attempt is reconstructed from a file -
// never from the owner transcribing a HUD.
let _dwPhase = "idle", _dwConn = null, _dwAck = null;
let _diagCache = null, _diagAt = 0;    // ~15 Hz composition cache (see frame())
function diagWatch() {
  const d = fullDiag();
  const t = d.transport || {};
  const conn = t.kind === "ws" ? !!t.connected : "mock";
  if (conn !== _dwConn) {
    _dwConn = conn;
    sendDiag(tele, conn === true ? "connected" : conn === "mock" ? "transport_mock" : "disconnected", d);
  }
  if (d.phase !== _dwPhase) {
    _dwPhase = d.phase;
    if (["scanning", "uploading", "done", "empty", "error"].indexOf(d.phase) >= 0) {
      sendDiag(tele, "scan_" + d.phase, d);
    }
  }
  const ackKey = d.lastAck ? JSON.stringify(d.lastAck) : null;
  if (ackKey !== _dwAck) { _dwAck = ackKey; if (d.lastAck) sendDiag(tele, "bridge_ack", d); }
  return d;
}

// ---------------------------------------------------------------------------
// crown dial: the device's transparency crown (pot), Vision-Pro style. A ghost
// ring at the opposite desk edge whose core condenses as assist rises: barely
// there when fully transparent, a solid luminous core when fully assisted. It
// appears while the crown is turning and breathes away after ~2 s idle, so it
// never competes with the modes.
// ---------------------------------------------------------------------------
const crown = new THREE.Group();
const crownRing = makeRingSprite(AQUA, 0.075, 0.16);
const crownCore = makeGlow(AQUA, 0.02, 0.3);
const crownWord = makeWord("assist", { size: 0.13 });
crownWord.position.set(0, 0.075, 0);
crown.add(crownRing, crownCore, crownWord);
crown.position.set(0.42, 0.78, -0.30);
crown.visible = false;
world.scene.add(crown);
let crownShown = 0, crownVal = 0.35, crownPrev = null;

// ---------------------------------------------------------------------------
// mode manager
// ---------------------------------------------------------------------------
const ctx = { world, hand, audio, tele, switchTo, snap: () => latest, takes: () => takesLib };
const modes = {
  atelier: new Atelier(ctx),
  capture: new Capture(ctx),
  rhythm: new Rhythm(ctx),
  touch: new Touch(ctx),
  twin: new Twin(ctx),
  replay: new Replay(ctx),
};
let current = null;
let currentName = "";
let switching = false;

function switchTo(name) {
  if (switching || currentName === name || !modes[name]) return;
  switching = true;
  const doSwitch = () => {
    if (current) current.exit();
    currentName = name;
    current = modes[name];
    tele.send({ cmd: "mode", mode: name });
    current.enter();
    setTimeout(() => { switching = false; }, 400);
  };
  if (current) {
    // a soft veil of light covers the cut
    flash.animate(
      [{ opacity: 0 }, { opacity: 0.85, offset: 0.4 }, { opacity: 0 }],
      { duration: 1100, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
    audio.swell(0.5);
    setTimeout(doSwitch, 420);
  } else doSwitch();
}

// ---------------------------------------------------------------------------
// NEUTRAL CALIBRATION (MOTION_PIPELINE.md section 3). The dock's calibrate
// button (or C) sends {cmd:"calibrate", what:"neutral"}; the bridge (or the
// device button) runs a 3-2-1 countdown + 2 s hold and broadcasts
// {kind:"ack", event:"neutral", phase:"countdown"|"hold"|"done"|"abort", t}.
// Every phase is shown in the headset: the guide card counts down with the
// bridge's own numbers, the dock button reads the phase.
// ---------------------------------------------------------------------------
const neutral = { phase: null, t: 0, at: 0, sentAt: -1e9, err: "" };
function calibAvailable(snap) { return !!(snap && (snap.body || (snap.device && snap.device.fw >= 16))); }
function requestNeutral() {
  const now = performance.now();
  if (now - neutral.sentAt < 1500) return;          // one reach, one request
  if (neutral.phase === "countdown" || neutral.phase === "hold") return;
  neutral.sentAt = now;
  neutral.phase = "sent"; neutral.at = now;
  tele.send({ cmd: "calibrate", what: "neutral" });
  audio.bell(4, 0, { gain: 0.1 });
}
tele.onSnapshot((m) => {
  if (m.kind !== "ack") return;
  if (m.event === "neutral") {
    neutral.phase = m.phase; neutral.t = m.t; neutral.at = performance.now();
    if (m.phase === "countdown") audio.bell(4, 1, { gain: 0.06 });
    if (m.phase === "done") { audio.resolve(null, { gain: 0.18 }); pads.pulse(0.5, 80); }
  } else if (m.event === "error" && neutral.phase === "sent" && /calibrat/i.test(String(m.error || m.cmd || ""))) {
    neutral.phase = "error"; neutral.at = performance.now(); neutral.err = String(m.error);
  }
});
/** The neutral phase still worth showing (stale ones read null). */
function neutralNow() {
  const age = (performance.now() - neutral.at) / 1000;
  let phase = neutral.phase;
  if (phase === "sent" && age > 4) phase = null;
  if ((phase === "done" || phase === "abort" || phase === "error") && age > 6) phase = null;
  return { phase, t: neutral.t, ageS: age, err: neutral.err };
}

// ---------------------------------------------------------------------------
// SIMULATED badge (DOM): whenever the in-page mock feeds the app, say so on
// the page. A websocket that is not connected says "bridge offline". In the
// headset the status HUD carries the same word (ui/hud.js).
// ---------------------------------------------------------------------------
const simBadge = document.getElementById("simbadge");
let _badgeKey = "";
function updateBadge() {
  const d = tele.describe();
  let text = "", cls = "";
  if (d.simulated) { text = "SIMULATED · no bridge (" + (d.reason || "mock") + ") · ?ws=wss://<PC-IP>:8765/ws"; cls = "sim"; }
  else if (d.kind === "ws" && !d.connected) { text = "bridge offline · " + d.url; cls = "off"; }
  const key = text + cls;
  if (simBadge && key !== _badgeKey) {
    _badgeKey = key;
    simBadge.textContent = text;
    simBadge.className = text ? "show " + cls : "";
  }
}

// ---------------------------------------------------------------------------
// press acknowledgement (2026-07-30): ONE answer to the hand, shared by the XR
// reach, the pointer ray, the dock and the desktop mouse, so no control can be
// pressed without replying inside a frame - a flare of light exactly where
// contact happened, a quiet tick, and a controller pulse.
// ---------------------------------------------------------------------------
const _xrV = new THREE.Vector3();
let xrHover = null, xrArmed = true, xrCooldown = 0;
let hovered = null;
const FLARE_S = 0.22;                  // well inside the 100 ms answer budget
const pressFlare = makeGlow(0xd9edff, 0.07, 0, { depthTest: false });
pressFlare.renderOrder = 9;
pressFlare.visible = false;
world.scene.add(pressFlare);
let flareLife = 0;

function press(obj, point) {
  if (obj) {
    if (point) _xrV.copy(point); else obj.getWorldPosition(_xrV);
    pressFlare.position.copy(_xrV);
    pressFlare.scale.setScalar(0.07);
    pressFlare.material.opacity = 0.85;
    pressFlare.visible = true;
    flareLife = FLARE_S;
    audio.bell(1, 1, { gain: 0.07, pos: _xrV });
  }
  pads.pulse(0.35, 40);
}

// ---------------------------------------------------------------------------
// THE UI LAYER (2026-09, thesis defense): an action dock you can press with a
// bare hand, a controller or the mouse; a lazy-follow status HUD with the
// first-run guide; a pointer ray; recenter.
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const dock = new Dock(world.scene, [
  { id: "hub", icon: "hub", text: "hub" },             { id: "twin", icon: "twin", text: "twin" },
  { id: "calibrate", icon: "calibrate", text: "calibrate" }, { id: "record", icon: "record", text: "record" },
  { id: "replay", icon: "replay", text: "replay" },    { id: "recenter", icon: "recenter", text: "recenter" },
]);
const hud = new StatusHud(world.scene);
hud.enabled = params.get("hud") !== "0";
// placement band: in the headset ~24 deg above the gaze, never below eye
// level (the scene is at/below it); the desktop's 52 deg camera shows less
// above the gaze, so the panel rides lower there (swapped on XR entry / exit)
const HUD_XR = { elevAboveGaze: 0.42, minElev: 0.0, maxElev: 0.30 };
const HUD_DESK = { elevAboveGaze: 0.36, minElev: -0.12, maxElev: 0.30 };
Object.assign(hud.follow, HUD_DESK);
const guide = new Guide();
guide.hidden = params.get("guide") === "0";
const debounce = new Debounce(350);
const pinchHold = new PinchHold({ holdS: 1.0 });
const recenterHold = new HoldButton(0.6);
// WHO may press: the rig is worn on the RIGHT hand. While it is linked, the
// right hand's pokes and pinches are the device's data, never UI input: only
// the left hand and the controllers work the dock, the rays and the gestures.
function rightHandIsRig() { return !!(latest && latest.link && latest.link.device); }
const pointer = new XRPointer(world, {
  allow: (src) => !src.hand || src.handedness === "left" || !rightHandIsRig(),
  onSelect: (obj, point) => activate(obj, point, "ray"),
});

function isRecordingNow() {
  return modes.capture.isRecording || !!(latest && latest.session && latest.session.recording);
}
function canRecord() {
  const d = tele.describe();
  return d.simulated || (d.kind === "ws" && d.connected && !!(latest && latest.link && latest.link.device));
}
function toggleRecord() {
  if (isRecordingNow()) {
    if (modes.capture.isRecording) modes.capture.stopTake();
    else tele.send({ cmd: "record", action: "stop" });    // started elsewhere (console / phone)
    return;
  }
  if (!canRecord()) { stageSay("record needs the device link"); return; }
  if (currentName === "capture") modes.capture.startTake();
  else { switchTo("capture"); setTimeout(() => modes.capture.startTake(), 750); }
}

/** One action, whatever pressed it (poke / ray / mouse / key). */
function doAction(id, via = "dock") {
  switch (id) {
    case "hub":
      if (currentName !== "atelier") switchTo("atelier");
      else if (world.renderer.xr.isPresenting) endXR();       // at the hub: the clean way out of AR
      break;
    case "twin": switchTo("twin"); break;
    case "calibrate":
      if (!calibAvailable(latest)) stageSay("calibrate: no body model on this link");
      else if (!tele.describe().simulated && !(latest && latest.link && latest.link.device)) stageSay("calibrate: the device is not streaming");
      else requestNeutral();
      break;
    case "record": toggleRecord(); break;
    case "replay":
      if (currentName === "replay") modes.replay.nextTake(); else switchTo("replay");
      break;
    case "recenter": requestRecenter(via); break;
    default: break;
  }
}

/** Activate a picked object: a dock button or a mode interactive. */
function activate(obj, point, via) {
  if (!obj) return;
  const id = dock.idOf(obj);
  const now = performance.now();
  if (id) {
    const b = dock.byId[id];
    if (b && !b.state.enabled) { stageSay(`${b.state.text}: not available now`); return; }
  }
  if (!debounce.ok(id || obj.uuid, now)) return;
  press(obj, point);
  if (id) {
    dock.flash(id);
    doAction(id, via === "poke" || via === "ray" || via === "mouse" ? "dock" : via);
    xrCooldown = Math.max(xrCooldown, 0.6);      // the reach system stays quiet
    return;
  }
  if (current && current.onSelect) current.onSelect(obj, point || null);
}

// the dock's labels follow the state (redrawn only when a label changes)
function updateDockState(snap) {
  const presenting = world.renderer.xr.isPresenting;
  const atHub = currentName === "atelier";
  dock.set("hub", { icon: atHub && presenting ? "exit" : "hub", text: atHub && presenting ? "exit AR" : "hub" });
  dock.set("twin", { active: false, tone: currentName === "twin" ? "ok" : "idle" });
  const nn = neutralNow();
  const calTxt = nn.phase === "countdown" ? `${Math.max(1, Math.round(nn.t || 0))}…`
    : nn.phase === "hold" ? "hold still" : nn.phase === "sent" ? "starting" : nn.phase === "done" ? "calibrated" : "calibrate";
  const b = snap && snap.body;
  const devUp = tele.describe().simulated || !!(snap && snap.link && snap.link.device);
  dock.set("calibrate", { text: devUp || !calibAvailable(snap) ? calTxt : "calibrate ·off", enabled: calibAvailable(snap) && devUp,
    tone: nn.phase === "done" ? "ok" : (b && b.provisional) || nn.phase === "countdown" || nn.phase === "hold" ? "warn" : "idle" });
  const rec = isRecordingNow();
  const el = rec && snap && snap.session ? Math.floor((snap.session.elapsed_ms || 0) / 1000) : 0;
  dock.set("record", rec
    ? { icon: "stop", text: `stop ${Math.floor(el / 60)}:${String(el % 60).padStart(2, "0")}`, tone: "rec", active: true, enabled: true }
    : { icon: "record", text: canRecord() ? "record" : "record ·off", tone: "idle", active: false, enabled: canRecord() || modes.capture.busy });
  dock.set("replay", currentName === "replay" ? { icon: "next", text: "next take" } : { icon: "replay", text: "replay" });
  const blocked = recenterBlocked();
  dock.set("recenter", { text: blocked ? "recenter ·busy" : "recenter", enabled: !blocked });
}

// ---------------------------------------------------------------------------
// RECENTER (ui/stage.js). The scene is placed relative to the user: at XR
// entry automatically, and again on demand (dock, R, controller A/X held,
// both hands pinched for 1 s = "here", or the headset's own recenter, which
// fires `reset` on local-floor). Blocked while a take or a room scan runs:
// both are recorded in the stage frame and must not jump mid-way.
// ---------------------------------------------------------------------------
const stageCtl = {
  pending: null,          // { reason, hand:[x,y,z] canonical | null, force }
  from: null, to: null, t: 0, dur: 0.45, glideReason: "",
  manual: false,          // the user recentered this session (a room restore then never overrides it)
  refineAt: 0,            // one height refinement after the entry recenter (planes arrive late)
  restoredFor: null, savedFor: null, dirty: false,
  note: "", noteAt: -1e9,
  last: null,             // last solve, for AR.stage
};
let worldHoldUntil = 0;   // the bridge's world echo is in the old frame for a moment
function stageSay(text) { stageCtl.note = text; stageCtl.noteAt = performance.now(); }
function recenterBlocked() {
  const ph = scanState().phase;
  return isRecordingNow() || ph === "scanning" || ph === "uploading";
}
function requestRecenter(reason, { hand = null, force = false } = {}) {
  if (!force && recenterBlocked()) {
    stageSay(isRecordingNow() ? "recenter: stop the take first" : "recenter: wait for the room scan");
    return false;
  }
  stageCtl.pending = { reason, hand, force };
  return true;
}

// head pose in ROOM (base) coordinates: XR reads the viewer against
// local-floor; the desktop carries its canonical camera through the stage
const _hf = new THREE.Vector3();
function headInBase(xrFrame) {
  if (world.renderer.xr.isPresenting) {
    const base = world.baseRef;
    if (!xrFrame || !base) return null;
    let vp = null;
    try { vp = xrFrame.getViewerPose(base); } catch (_) { vp = null; }
    if (!vp) return null;
    const p = vp.transform.position, o = vp.transform.orientation;
    _hf.set(0, 0, -1).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w));
    return { pos: [p.x, p.y, p.z], fwd: [_hf.x, _hf.y, _hf.z] };
  }
  world.camera.getWorldDirection(_hf);
  const st = world.stage, P = world.camera.position;
  const r = rotY(st.yaw, [P.x, P.y, P.z]);
  return { pos: [r[0] + st.pos[0], r[1] + st.pos[1], r[2] + st.pos[2]], fwd: rotY(st.yaw, [_hf.x, _hf.y, _hf.z]) };
}
// horizontal planes in ROOM coordinates (XR plane-detection; desktop: the stand-in desk)
function planesInBase(xrFrame) {
  if (!world.renderer.xr.isPresenting) return [world.simTablePlane];
  const out = [];
  const base = world.baseRef;
  const set = xrFrame && xrFrame.detectedPlanes;
  if (!set || !base) return out;
  for (const pl of set) {
    try {
      if (pl.orientation && pl.orientation !== "horizontal") continue;
      const pose = xrFrame.getPose(pl.planeSpace, base);
      if (!pose) continue;
      const m = pose.transform.matrix;
      const poly = (pl.polygon || []).map((q) => {
        const w = applyMat(m, [q.x, q.y || 0, q.z]);
        return [w[0], w[2]];
      });
      out.push({ y: m[13], poly, label: pl.semanticLabel || "" });
    } catch (_) { /* a plane that vanished mid-frame */ }
  }
  return out;
}
function canonToBase(p) { return applyMat(stageMatrix(world.stage), p); }

/** Move everything that caches canonical coordinates, then the frame itself. */
function applyStage(s) {
  const old = world.stage;
  if (stageNear(old, s, 1e-5)) return;
  const newFromOld = stageDelta(old, s);
  world.setStage(s);
  applyStageDelta(newFromOld, invertMat(newFromOld));
  const d = stageFromMatrix(newFromOld);
  hand.bodyAnchor.applyYawTranslate(d.yaw, d.pos);
  worldHoldUntil = performance.now() + 600;
}

function stageTick(dt, xrFrame) {
  const now = performance.now();
  // ---- a request: solve against the head (+ table plane, + offered hand) ---
  if (stageCtl.pending) {
    const head = headInBase(xrFrame);
    if (head) {
      const req = stageCtl.pending;
      stageCtl.pending = null;
      const handB = req.hand ? canonToBase(req.hand) : null;
      // first pass without a table, to know where the desk point would land
      const pre = solveStage({ head, hand: handB, prevYaw: world.stage.yaw });
      const tableY = pickTableY(planesInBase(xrFrame), [pre.desk[0], pre.desk[2]], head.pos[1]);
      const sol = solveStage({ head, hand: handB, tableY, prevYaw: world.stage.yaw });
      stageCtl.last = Object.assign({ reason: req.reason, tableY }, sol);
      stageCtl.from = world.stage; stageCtl.to = { yaw: sol.yaw, pos: sol.pos };
      stageCtl.t = req.reason === "start" ? stageCtl.dur : 0;          // entry: snap, no glide
      stageCtl.glideReason = req.reason;
      if (req.reason !== "start" && req.reason !== "reset" && req.reason !== "room") stageCtl.manual = true;
      if (req.reason === "start") stageCtl.refineAt = now + 2500;
      stageSay(`recentered · ${sol.source === "table" || sol.source === "hand+table" ? `on the table (${tableY.toFixed(2)} m)`
        : sol.source === "hand" ? "at your hands" : `${Math.round(sol.reach * 100)} cm ahead`}`);
      audio.bell(2, 1, { gain: 0.08 });
      pads.pulse(0.4, 60);
    }
  }
  // ---- one late height refinement after entry (plane detection is slow) ---
  if (stageCtl.refineAt && now > stageCtl.refineAt && !stageCtl.to) {
    stageCtl.refineAt = 0;
    const head = headInBase(xrFrame);
    if (head && !stageCtl.manual && world.renderer.xr.isPresenting) {
      const desk = canonToBase(CANON_DESK);
      const ty = pickTableY(planesInBase(xrFrame), [desk[0], desk[2]], head.pos[1]);
      if (ty !== null && Math.abs(ty - desk[1]) > 0.04) {
        stageCtl.from = world.stage;
        stageCtl.to = { yaw: world.stage.yaw, pos: [world.stage.pos[0], world.stage.pos[1] + (ty - desk[1]), world.stage.pos[2]] };
        stageCtl.t = 0; stageCtl.glideReason = "table";
        stageSay(`on the table (${ty.toFixed(2)} m)`);
      }
    }
  }
  // ---- glide (0.45 s, eased) ------------------------------------------------
  if (stageCtl.to) {
    stageCtl.t += dt;
    const k = Math.min(1, stageCtl.t / stageCtl.dur);
    const e = 1 - Math.pow(1 - k, 3);
    applyStage(k >= 1 ? stageCtl.to : lerpStage(stageCtl.from, stageCtl.to, e));
    if (k >= 1) {
      stageCtl.to = null; stageCtl.from = null; stageCtl.dirty = true;
      if (current && current.onStageChange) current.onStageChange();
      if (modes.replay.onStageChange && current !== modes.replay) modes.replay.onStageChange();
    }
  }
  // ---- per-room persistence: the stage in a persisted anchor's frame -------
  if (world.renderer.xr.isPresenting && xrFrame && !stageCtl.to && !stageCtl.pending) {
    const reloc = relocAnchor(), own = roomAnchor();
    const anc = reloc.state === "restored" && reloc.handle ? reloc
      : own && own.state === "live" && own.handle ? own : null;
    if (anc) {
      let anchorCanon = null;
      try { anchorCanon = anc.poseNow(xrFrame, world.renderer.xr.getReferenceSpace()); } catch (_) { anchorCanon = null; }
      if (anchorCanon) {
        const anchorBase = anchorToBase(world.stage, anchorCanon);
        if (anc === reloc && stageCtl.restoredFor !== anc.handle) {
          stageCtl.restoredFor = anc.handle;
          const G = loadRoomStage(anc.handle);
          if (G && !stageCtl.manual) {
            const T = stageFromAnchor(G, anchorBase);
            stageCtl.from = world.stage; stageCtl.to = T; stageCtl.t = 0; stageCtl.glideReason = "room";
            stageCtl.refineAt = 0;
            stageSay("placement restored for this room");
          }
        } else if ((stageCtl.dirty || stageCtl.savedFor !== anc.handle) &&
                   (anc !== reloc || stageCtl.restoredFor === anc.handle)) {
          saveRoomStage(anc.handle, stageInAnchor(world.stage, anchorBase));
          stageCtl.dirty = false; stageCtl.savedFor = anc.handle;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// desktop pointer: hover = the hand's curiosity, click = the reach
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
// three's default Points/Line thresholds are 1 WORLD UNIT (a metre here): any
// mote field or arc line within a metre of the ray "won" every pick, so the
// dock (and small objects) could not be clicked. Centimetres, like a finger.
raycaster.params.Points.threshold = 0.012;
raycaster.params.Line.threshold = 0.012;
const pointerNdc = new THREE.Vector2();

function pickTargets() {
  const list = [];
  if (dock.visible) list.push(...dock.hitMeshes);
  if (current && current.interactives) list.push(...current.interactives);
  return list;
}
function pickHit(ev) {
  pointerNdc.x = (ev.clientX / innerWidth) * 2 - 1;
  pointerNdc.y = -(ev.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, world.camera);
  const hits = raycaster.intersectObjects(pickTargets(), true);
  return hits.length ? hits[0] : null;
}
function pick(ev) { const h = pickHit(ev); return h ? h.object : null; }
let mouseDockHover = null;
addEventListener("pointermove", (ev) => {
  if (world.renderer.xr.isPresenting) return;
  const obj = pick(ev);
  const id = dock.idOf(obj);
  mouseDockHover = id;
  if (obj !== hovered) {
    hovered = obj;
    if (current && current.onHover) current.onHover(id ? null : obj);
  }
});
addEventListener("click", (ev) => {
  if (world.renderer.xr.isPresenting || !started) return;
  const hit = pickHit(ev);
  if (hit) activate(hit.object, hit.point, "mouse");
});

// keyboard (desktop). In the capture console plain letters name the take,
// so every letter shortcut also works with Shift held.
const keysPanel = document.getElementById("keys");
addEventListener("keydown", (ev) => {
  if (!started || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === "Escape") { switchTo("atelier"); return; }
  const k = { 1: "atelier", 2: "capture", 3: "rhythm", 4: "touch", 5: "twin", 6: "replay" }[ev.key];
  if (k) { switchTo(k); return; }
  if (ev.repeat) return;
  const sh = world.simHead;
  switch (ev.key.toLowerCase()) {
    case "c": dock.flash("calibrate"); doAction("calibrate", "key"); break;
    case "r": dock.flash("recenter"); doAction("recenter", "key"); break;
    case "t": dock.flash("record"); doAction("record", "key"); break;
    case "p": dock.flash("replay"); doAction("replay", "key"); break;
    case "h": dock.flash("hub"); doAction("hub", "key"); break;
    case "g": guide.hidden = !guide.hidden; break;
    case "[": sh.yaw += Math.PI / 6; break;            // desktop head simulation:
    case "]": sh.yaw -= Math.PI / 6; break;            //   turn 30 deg
    case "u": sh.stand = sh.stand ? 0 : 1; break;      //   stand up / sit down
    case "?": case "/": if (keysPanel) keysPanel.classList.toggle("show"); break;
    default: break;
  }
});

// ---------------------------------------------------------------------------
// XR reach interaction: in passthrough the hand IS the cursor for the mode
// objects. Nearing an interactive wakes it (hover); reaching into it selects.
// A hysteresis re-arm keeps one reach from selecting twice. Tips that are
// working the dock are excluded (the dock is pressed by its own poke).
// ---------------------------------------------------------------------------
// Reach tuning (2026-07-30): SELECT_R 0.09 selects at the object's surface;
// REARM_R keeps the hysteresis gap so one reach still cannot double-fire.
const HOVER_R = 0.17, SELECT_R = 0.09, REARM_R = 0.13;
const _uiTip = new THREE.Vector3();
const _tipsBuf = [];
function xrInteract(dt, extraTip, rayHover) {
  _tipsBuf.length = 0;
  if (!dock.near(hand.tips.index)) _tipsBuf.push(hand.tips.index);
  if (extraTip && !dock.near(extraTip)) _tipsBuf.push(extraTip);
  const list = current && current.interactives ? current.interactives : [];
  let best = null, bestD = HOVER_R;
  for (const o of list) {
    o.getWorldPosition(_xrV);
    for (const tip of _tipsBuf) {
      const d = _xrV.distanceTo(tip);
      if (d < bestD) { bestD = d; best = o; }
    }
  }
  // a pointer ray on a mode object hovers it too (the ray wins the word)
  const rayObj = rayHover && !dock.idOf(rayHover) ? rayHover : null;
  const hov = rayObj || best;
  if (hov !== xrHover) {
    xrHover = hov;
    hovered = hov;
    if (current && current.onHover) current.onHover(hov);
  }
  xrCooldown = Math.max(0, xrCooldown - dt);
  // select: reach INTO the object with the hand, or trigger-click while the
  // controller-ridden hand of light hovers near it (the ray has its own select)
  const clicked = pads.justPressed && best && bestD < HOVER_R && !rayHover;
  if (best && (bestD < SELECT_R || clicked) && xrArmed && xrCooldown === 0) {
    xrArmed = false; xrCooldown = 1.2;
    activate(best, null, "reach");
  }
  if (!best || bestD > REARM_R) xrArmed = true;
}

// ---------------------------------------------------------------------------
// XR entry (Quest browser): passthrough session with hand tracking
// ---------------------------------------------------------------------------
const xrGlyph = document.getElementById("xr");
let xrBlocked = null;   // non-null = why AR cannot start (shown on tap)
if (navigator.xr && navigator.xr.isSessionSupported) {
  navigator.xr.isSessionSupported("immersive-ar").then((ok) => {
    if (ok) xrGlyph.classList.add("show");
    else { xrBlocked = "This browser reports no immersive-ar support."; xrGlyph.classList.add("show", "blocked"); }
  }).catch(() => {});
} else if (!window.isSecureContext) {
  // WebXR only exists on secure origins: over plain http://<LAN-IP> the Quest
  // hides navigator.xr entirely, which used to hide this button silently.
  xrBlocked = "AR needs a secure origin.\nServe this page over https (any static server with a self-signed certificate, and the bridge with --ssl-cert/--ssl-key for wss://) or via adb reverse + http://localhost.";
  xrGlyph.classList.add("show", "blocked");
}
let xrSession = null;
xrGlyph.addEventListener("click", async () => {
  if (xrBlocked) { alert(xrBlocked); return; }
  try {
    const session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["local-floor"],
      // mesh-detection: the headset's scene reconstruction (Space Setup room
      // mesh), harvested by the "scan room" step for the 4D replay environment.
      // plane-detection: coarse fallback (walls/floor/tables) when no room mesh
      // exists, so the scan still captures something.
      // anchors (2026-07-30): the room's persistent anchor, so a scanned room
      // relocates across sessions instead of drifting with local-floor's
      // per-session origin. See world/roomAnchor.js and ROOMSCAN-EVALUATION.md.
      optionalFeatures: ["hand-tracking", "depth-sensing", "dom-overlay",
                         "mesh-detection", "plane-detection", "anchors"],
      depthSensing: { usagePreference: ["cpu-optimized"], dataFormatPreference: ["luminance-alpha"] },
      domOverlay: { root: document.body },
    });
    xrSession = session;
    // a new session is a new local-floor: forget hands + the body placement
    xrHands.reset();
    hand.bodyAnchor.reset();
    // record exactly what the headset granted, so the HUD can show whether
    // depth-sensing / mesh / plane are actually available (an ungranted depth
    // feature is the #1 cause of an empty scan, and it was invisible before).
    xrFeatures = readXrFeatures(session);
    console.log("[xr] enabledFeatures:", xrFeatures.list, "depthUsage:", xrFeatures.depthUsage || "(none)");
    // first thing the owner sees in AR: whether the bridge link is live (the
    // status HUD's first word)
    scanFeedback.noteSessionStart();
    sendDiag(tele, "xr_start", fullDiag());
    // the scene is placed around the user, not at fixed floor coordinates:
    // start from the identity stage, recenter on the first viewer pose
    world.setStage(IDENTITY_STAGE);
    Object.assign(stageCtl, { pending: { reason: "start", hand: null, force: true }, to: null, from: null,
                              manual: false, refineAt: 0, restoredFor: null, savedFor: null, dirty: false });
    hud.follow.reset();
    Object.assign(hud.follow, HUD_XR);
    session.addEventListener("end", () => {
      xrSession = null;
      xrFeatures = { list: [], features: {}, depthUsage: "", depthFormat: "" };
      resetEnvScan();               // next session re-scans its own room
      contacts.reset();
      xrHands.reset();
      hand.bodyAnchor.reset();      // desktop re-seeds its own default
      world.exitXR();
      world.setStage(IDENTITY_STAGE);   // the desktop preview is tuned in the canonical frame
      stageCtl.pending = null; stageCtl.to = null;
      pointer.hideAll();
      hud.follow.reset();
      Object.assign(hud.follow, HUD_DESK);
    });
    await world.enterXR(session);
    // the headset's own recenter (hold the Meta button / palm-up pinch hold)
    // moves local-floor's origin and fires `reset`: put the scene back in
    // front of the user (even mid-take: the old placement is gone anyway)
    try {
      const base = world.baseRef;
      if (base && base.addEventListener) {
        base.addEventListener("reset", () => requestRecenter("reset", { force: true }));
      }
    } catch (_) { /* optional */ }
    audio.start();
    // put the last scanned room back: restore its persisted anchor now (no
    // frame needed); envScan reads its pose in the following XR frames and
    // only adopts the old env once the anchor actually localizes
    relocateLastRoom(session)
      .then((okR) => sendDiag(tele, okR ? "room_reloc_restoring" : "room_reloc_skipped", fullDiag()))
      .catch(() => {});
    // in the room, the dock's hub button is ALWAYS reachable: at the hub it
    // reads "exit AR", the clean way back to the browser (see endXR below)
    // arriving in the room replays the overture, and nothing can be grabbed
    // until it has finished condensing
    xrCooldown = 4.0;
    if (currentName === "atelier" && current) { current.exit(); current.enter(); }
    else switchTo("atelier");
  } catch (e) { console.warn("XR session failed", e); }
});

// Deliberate XR shutdown on EVERY way out of the page. An immersive
// hand-tracking session that dies with the tab wedges the headset's
// hand-tracking service until the device restarts, so the session is ended
// synchronously before the page can go away.
function endXR() {
  if (!xrSession) return;
  try { xrSession.end(); } catch (e) { /* already ending */ }
  xrSession = null;
}
// NOTE deliberately no visibilitychange hook: on the headset the 2D page
// reads "hidden" while the immersive session runs, which would end it at
// entry. pagehide/beforeunload cover closing and navigating away.
window.addEventListener("pagehide", endXR);
window.addEventListener("beforeunload", endXR);

// ---------------------------------------------------------------------------
// render loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const _headFwd = new THREE.Vector3();
let started = false;
let frozen = false;                 // verification: freeze real-time stepping
let timeScale = 1;                  // verification: near-zero holds a moment
                                    // while frames keep presenting
let simT = 0;                       // simulation time (also advanced by AR.step)
let lastRaf = 0;
let _merged = null, _mergeSnap = null, _mergePose = null;   // pose-lane merge cache
const _dockTips = [], _tipL = new THREE.Vector3(), _tipR = new THREE.Vector3();
let _hudAt = -1e9, _hudView = null, _guideCard = null, _cursor = "";

function frame(fixedDt, xrFrame) {
  const _w0 = performance.now();
  let dt = fixedDt !== undefined ? fixedDt : Math.min(clock.getDelta(), 0.05);
  if (fixedDt === undefined) { perf._iv = lastRaf ? _w0 - lastRaf : 0; lastRaf = _w0; }
  dt *= timeScale;
  simT += dt;
  const t = simT;

  world.updateDesktopCamera(t, dt);
  world.update(dt);
  sky.update(dt, t);

  // XR hands, read from THIS frame (input/xrHands.js): a hand the headset
  // lost is null after a 150 ms grace, never a frozen copy. The rig is worn on
  // the right hand: the right always wins. The left is dressed only when
  // nothing can place the rig hand (no world/body data); otherwise it stays a
  // free UI pointer while the device hand is placed from the fallback.
  const presentingNow = world.renderer.xr.isPresenting;
  const nowMs = performance.now();
  let xr = null, uiTip = null;
  if (presentingNow) {
    const refSpace0 = world.renderer.xr.getReferenceSpace();
    xrHands.update(xrFrame, refSpace0, xrSession, nowMs);
    const r = xrHands.get("right"), l = xrHands.get("left");
    const lb = latest && latest.body, lw = latest && latest.world;
    const rigPlaceable = !!(latest && latest.link && latest.link.device &&
      ((lb && (lb.calibrated || lb.provisional)) || (lw && lw.source && lw.source !== "none")));
    if (r) xr = r;
    else if (l && !rigPlaceable) xr = l;
    if (l && xr !== l && l.hand.joints["index-finger-tip"]) {
      uiTip = _uiTip.copy(l.hand.joints["index-finger-tip"].position);
    }
  }
  // controller overlay: while a controller is in use, its synthesized
  // snapshot replaces the live one for EVERYTHING downstream (one chokepoint)
  if (latest) latest._ageMs = nowMs - latest._rx;
  // the pose lane (100 Hz) over the newest snap: body + joints from the
  // freshest device frame; merged at most once per new message
  let src = latest;
  if (latest && lane.active(nowMs)) {
    if (_mergeSnap !== latest || _mergePose !== lane.latest) {
      _merged = mergePose(latest, lane.latest); _mergeSnap = latest; _mergePose = lane.latest;
    }
    _merged._ageMs = nowMs - lane.lastAt;
    src = _merged;
  }
  pads.update(dt);
  let eff = pads.apply(src);
  if (pads.active && pads.tracked) hand.moveTo(pads.gripPos, 12);   // ride the grip
  // the bridge echoes our poses in `world`; undo the env frame they were
  // streamed in (a relocated room) before placing anything with it
  if (eff && eff.world) {
    const w = worldToRoom(eff.world);
    if (w !== eff.world) eff = Object.assign({}, eff, { world: w });
    // right after a recenter the echo still carries poses from the old frame
    if (nowMs < worldHoldUntil) eff = Object.assign({}, eff, { world: null });
  }

  const headFwd = world.camera.getWorldDirection(_headFwd);
  hand.update(dt, eff, xr, {
    presenting: presentingNow, nowMs,
    msSinceOwnPose: msSinceOwnPose(),
    headPos: [world.camera.position.x, world.camera.position.y, world.camera.position.z],
    headFwd: [headFwd.x, headFwd.y, headFwd.z],
    controllerTracked: pads.active && pads.tracked,
  });
  let rayHover = null;
  if (presentingNow) {
    rayHover = pointer.update(pickTargets(), world.camera);
    xrInteract(dt, uiTip, rayHover);
    // 4D replay: depth-cloud + scene-mesh harvest, wrist 6-DoF + finger stream
    const _s0 = performance.now();
    const refSpace = world.renderer.xr.getReferenceSpace();
    updateEnvCapture(xrFrame, refSpace, xrSession, tele, eff);
    perf.scanMs += (performance.now() - _s0 - perf.scanMs) * 0.1;
  }
  updateContacts(eff);
  cloudMotes.update(dt);   // live "room being drawn" motes (desktop sim scan too)

  // ---- the dock: pokes by the FREE hands' index tips (never the rig hand
  // while the device is linked), ray hover, mouse hover ----------------------
  _dockTips.length = 0;
  let pinchL = null, pinchR = null;
  if (presentingNow) {
    const L = xrHands.get("left"), R = xrHands.get("right");
    const jl = L && L.hand.joints, jr = R && R.hand.joints;
    if (jl && jl["index-finger-tip"]) _dockTips.push(_tipL.copy(jl["index-finger-tip"].position));
    if (jr && jr["index-finger-tip"] && !rightHandIsRig()) _dockTips.push(_tipR.copy(jr["index-finger-tip"].position));
    const pd = (j) => (j && j["thumb-tip"] && j["index-finger-tip"]
      ? Math.hypot(j["thumb-tip"].position.x - j["index-finger-tip"].position.x,
                   j["thumb-tip"].position.y - j["index-finger-tip"].position.y,
                   j["thumb-tip"].position.z - j["index-finger-tip"].position.z) : null);
    pinchL = pd(jl); pinchR = pd(jr);
    // both hands pinched for 1 s: recenter with the desk reach at the pinches
    if (pinchHold.update(dt, pinchL, pinchR)) {
      const a = jl["index-finger-tip"].position, b = jr["index-finger-tip"].position;
      requestRecenter("pinch", { hand: [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2] });
    } else if (pinchHold.active && pinchHold.progress > 0.2) {
      stageSay(`recenter here: keep pinching… ${Math.round(pinchHold.progress * 4) * 25}%`);
    }
    // controller A / X held 0.6 s: recenter
    if (recenterHold.update(dt, !!pads.recenterDown)) requestRecenter("button");
  }
  updateDockState(eff);
  const pokes = dock.update(dt, _dockTips, presentingNow ? dock.idOf(rayHover) : mouseDockHover);
  for (const id of pokes) activate(dock.byId[id].face, null, "poke");
  if (dock.hoverStarts.length) { audio.bell(5, 2, { gain: 0.025 }); pads.pulse(0.12, 15); }

  // diagnostic HUD: merge envScan's view of the scan with the session's granted
  // features and the live transport state. Cheap; hidden unless presenting (or
  // ?hud=1 on desktop). This is what the owner reads back during on-Quest tests.
  const presenting = world.renderer.xr.isPresenting;
  // diag composition throttled to ~15 Hz: envDiag() + the guidance strings
  // are the render loop's main allocation churn, and neither the HUD nor the
  // transition watcher needs them per-frame (transitions are still caught -
  // they persist until the next tick reads them)
  if (!_diagCache || _w0 - _diagAt > 66) { _diagAt = _w0; _diagCache = diagWatch(); }
  const dnow = _diagCache;
  diagHud.update(dnow, presenting);
  // the loud, dom-overlay-independent layer: world-space status panel
  scanFeedback.update(dt, dnow, presenting, world.camera);

  // spatial audio follows the head
  audio.setListener(world.camera);

  if (current) current.update(dt, eff, t);
  updateBadge();

  // ---- status HUD + first-run guide (composed at 5 Hz, drawn on change) ---
  if (nowMs - _hudAt > 200) {
    const gdt = Math.min(1, (nowMs - _hudAt) / 1000);
    _hudAt = nowMs;
    const tr = tele.describe();
    _hudView = statusView({
      transport: tr, snap: eff, lane: lane.stats(nowMs), snapHz: snapRate.hz(nowMs),
      fps: perfSnap().fps, stageNote: nowMs - stageCtl.noteAt < 3000 ? stageCtl.note : "",
    });
    _guideCard = guide.update(gdt, {
      transport: tr, snap: eff, neutral: neutralNow(), mode: currentName,
      deviceDriven: hand.deviceDriven, recordedTake,
      replayLoaded: currentName === "replay" && modes.replay.loaded,
    });
  }
  const scanPh = dnow.phase;
  hud.update(dt, world.camera, _hudView,
             scanPh === "scanning" || scanPh === "uploading" ? null : _guideCard, started);

  // crown dial: glide toward the blend, wake on change, fade when idle
  const bl = eff && eff.blend;
  if (bl && bl.present) {
    if (crownPrev !== null && Math.abs(bl.assist - crownPrev) > 0.003) crownShown = 2.2;
    crownPrev = bl.assist;
    crownVal += (bl.assist - crownVal) * (1 - Math.exp(-dt * 10));
  }
  crownShown = Math.max(0, crownShown - dt);
  const cw = Math.min(1, crownShown);
  crown.visible = cw > 0.01;
  if (crown.visible) {
    crownCore.scale.setScalar(0.012 + crownVal * 0.055);
    crownCore.material.opacity = cw * (0.25 + 0.65 * crownVal);
    crownRing.material.opacity = cw * (0.35 + 0.4 * crownVal);
    crownRing.scale.setScalar(0.075 * (1 + 0.1 * Math.sin(t * 1.3)));
    crownWord.material.opacity = cw * 0.85;
  }

  // desktop cursor (written only when it changes: no per-frame DOM work)
  const cur = hovered ? "pointer" : "default";
  if (cur !== _cursor) { _cursor = cur; document.body.style.cursor = cur; }

  // the press flare blooms outward and dies in FLARE_S
  if (flareLife > 0) {
    flareLife = Math.max(0, flareLife - dt);
    const k = flareLife / FLARE_S;                    // 1 -> 0
    pressFlare.material.opacity = k * 0.85;
    pressFlare.scale.setScalar(0.07 + (1 - k) * 0.10);
    if (flareLife === 0) pressFlare.visible = false;
  }

  world.renderer.render(world.scene, world.camera);
  // the stage moves AFTER the render, so the next frame reads the camera,
  // the hands and the room in one consistent frame
  stageTick(dt, xrFrame);
  perfNote(perf._iv, performance.now() - _w0);
  perf._iv = 0;
}

function begin() {
  if (started) return;
  started = true;
  audio.start();
  tele.start();
  world.renderer.setAnimationLoop((_t, xrFrame) => { if (!frozen) frame(undefined, xrFrame); });
  // keep the world alive when the tab is throttled (RAF stalls in hidden or
  // headless tabs); the fallback never runs while RAF is healthy
  setInterval(() => {
    if (!frozen && !world.renderer.xr.isPresenting && performance.now() - lastRaf > 250) frame(1 / 30);
  }, 33);

  // arrive in the Atelier (or jump straight to a mode for verification)
  const p = new URLSearchParams(location.search);
  switchTo(p.get("mode") || "atelier");

  veil.classList.add("gone");
  setTimeout(() => veil.remove(), 2600);
}

veil.addEventListener("click", begin);
addEventListener("keydown", (ev) => { if (ev.key === "Enter") begin(); }, { once: false });

// debug + verification hooks (preview_eval drives these; not user-facing)
window.AR = {
  begin, switchTo, world, hand, audio, tele, modes, sky, pads, cloudMotes,
  // hand x room fusion, for headless verification
  contacts, get objects() { return sceneObjects(); }, get anchor() { return roomAnchor(); },
  get reloc() { return relocAnchor(); }, xrHands, requestNeutral, get takes() { return takesLib; },
  // deterministic stepper: advance n frames of dt seconds (verification)
  step(n = 1, dt = 1 / 60) {
    const ts = timeScale; timeScale = 1;
    for (let i = 0; i < n; i++) frame(dt);
    timeScale = ts;
  },
  // hold a moment (time crawls, frames keep presenting so stills capture)
  freeze(v = true) { timeScale = v ? 0.0001 : 1; clock.getDelta(); },
  get snap() { return latest; },
  get mode() { return currentName; },
  // full capture diagnostics (what the HUD shows) for headless verification
  get diag() { return fullDiag(); },
  // measured frame health (fps / work ms / p95 / scan cost) - same numbers
  // the diag beacon ships to ~/.sensoryhand_diag.log
  get perf() { return perfSnap(); },
  // the UI layer (2026-09): recenter, dock, HUD, guide, pose lane
  recenter(reason = "script", opts) { return requestRecenter(reason, opts || {}); },
  get stage() { return { current: world.stage, last: stageCtl.last, note: stageCtl.note, manual: stageCtl.manual }; },
  simHead: world.simHead, dock, hud, guide, doAction,
  get status() { return _hudView; }, get guideCard() { return _guideCard; },
  get lane() { return lane.stats(performance.now()); },
  pickAt(x, y) {
    const h = pickHit({ clientX: x, clientY: y });
    return h ? { dock: dock.idOf(h.object), key: h.object.userData.arKey || null, d: +h.distance.toFixed(3) } : null;
  },
};
