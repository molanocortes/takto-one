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
tele.onSnapshot((s) => {
  if (s.kind === "snap") { s._rx = performance.now(); latest = s; }
  else if (s.kind === "takes" && Array.isArray(s.takes)) takesLib = s.takes;
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
// home glyph: the one shared affordance inside modes (a small resting ring
// near the desk edge; waking it and reaching it returns to the Atelier)
// ---------------------------------------------------------------------------
const home = new THREE.Group();
const homeRing = makeRingSprite(AQUA, 0.07, 0.16);
const homeCore = makeGlow(AQUA, 0.032, 0.2);
home.add(homeRing, homeCore);
home.position.set(-0.42, 0.78, -0.30);
home.visible = false;
world.scene.add(home);
const homeWord = makeWord("exit", { size: 0.16 });
homeWord.position.set(0, 0.075, 0);
home.add(homeWord);
let homeWake = 0;

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
    // in XR the glyph stays up at the hub too: there it exits AR itself
    home.visible = name !== "atelier" || world.renderer.xr.isPresenting;
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
// desktop pointer: hover = the hand's curiosity, click = the reach
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hovered = null;

function pickHit(ev) {
  pointer.x = (ev.clientX / innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, world.camera);
  const list = [];
  if (current && current.interactives) list.push(...current.interactives);
  if (home.visible) list.push(homeRing);
  if (calib.visible) list.push(calibRing);
  const hits = raycaster.intersectObjects(list, true);
  return hits.length ? hits[0] : null;
}
function pick(ev) { const h = pickHit(ev); return h ? h.object : null; }

addEventListener("pointermove", (ev) => {
  if (world.renderer.xr.isPresenting) return;
  const obj = pick(ev);
  if (obj !== hovered) {
    hovered = obj;
    if (current && current.onHover) current.onHover(homeOwns(obj) ? null : obj);
  }
});
addEventListener("click", (ev) => {
  if (world.renderer.xr.isPresenting) return;
  const hit = pickHit(ev);
  const obj = hit ? hit.object : null;
  if (obj) press(obj);            // the desktop path answers identically
  if (homeOwns(obj)) { switchTo("atelier"); return; }
  if (calibOwns(obj)) { requestNeutral(); return; }
  if (obj && current && current.onSelect) current.onSelect(obj, hit.point);
});
addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") switchTo("atelier");
  const k = { 1: "atelier", 2: "capture", 3: "rhythm", 4: "touch", 5: "twin", 6: "replay" }[ev.key];
  if (k) switchTo(k);
  if (ev.key === "c" && calib.visible) requestNeutral();
});
function homeOwns(obj) {
  return obj && (obj === homeRing || obj === homeCore || obj.parent === home || obj === home);
}

// ---------------------------------------------------------------------------
// NEUTRAL CALIBRATION (MOTION_PIPELINE.md section 3): a glyph beside the exit
// ring, shown whenever the bridge streams the body model. Reaching it sends
// {cmd:"calibrate", what:"neutral"}; the bridge (or the device button) runs a
// 3-2-1 countdown + 2 s hold and broadcasts
// {kind:"ack", event:"neutral", phase:"countdown"|"hold"|"done"|"abort", t}.
// Every phase is shown here in the headset, and a provisional neutral asks
// for a real one ("hold your hand flat").
// ---------------------------------------------------------------------------
const calib = new THREE.Group();
const calibRing = makeRingSprite(AMBER, 0.06, 0.5);
const calibCore = makeGlow(AMBER, 0.026, 0.4);
calib.add(calibRing, calibCore);
calib.position.set(-0.58, 0.98, -0.60);   // left of and above the hub heroes, clear of their reach zones
calib.visible = false;
world.scene.add(calib);
const calibWord = makeWord("calibrate", { size: 0.14 });
calibWord.position.set(0, 0.07, 0);
calib.add(calibWord);
const calibMsg = makeCounter({ px: 34, size: 0.26, color: "rgba(231,180,90,0.98)" });
calibMsg.spr.position.set(0.06, 0.115, 0);
calib.add(calibMsg.spr);
let calibWake = 0;
const neutral = { phase: null, t: 0, at: 0, sentAt: -1e9 };
function calibOwns(obj) {
  return obj && (obj === calibRing || obj === calibCore || obj.parent === calib || obj === calib);
}
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
    if (m.phase === "done") audio.resolve(null, { gain: 0.18 });
  } else if (m.event === "error" && neutral.phase === "sent" && /calibrat/i.test(String(m.error || m.cmd || ""))) {
    neutral.phase = "error"; neutral.at = performance.now(); neutral.err = String(m.error);
  }
});
function calibText(snap) {
  const age = (performance.now() - neutral.at) / 1000;
  const b = snap && snap.body;
  const dev = snap && snap.device;
  switch (neutral.phase) {
    case "sent": if (age < 4) return "starting…"; break;
    case "countdown": return `${Math.max(1, Math.round(neutral.t || 0))} · palm down, fingers straight`;
    case "hold": return "hold still…";
    case "done": if (age < 4) return "calibrated ✓"; break;
    case "abort": if (age < 5) return "calibration aborted"; break;
    case "error": if (age < 6) return "calibrate failed: " + (neutral.err || ""); break;
    default: break;
  }
  if (dev && dev.neutral_running) return "calibrating on the device…";
  if (!b) return "";
  if (b.provisional) return "calibrate: hold your hand flat";
  if (!b.calibrated) return "no neutral yet: hold still";
  const q = b.quality || {};
  if (q.since_neutral_s > 1800) return "neutral is old: recalibrate";
  return "";
}
function updateCalib(dt, t, snap) {
  // shown whenever the bridge speaks the body model (a real or mock rig)
  calib.visible = !!(snap && (snap.body || (snap.device && snap.device.fw >= 16)));
  if (!calib.visible) return;
  const want = hovered && calibOwns(hovered) ? 1 : 0;
  calibWake += (want - calibWake) * (1 - Math.exp(-dt * 8));
  const txt = calibText(snap);
  const urgent = !!(snap.body && snap.body.provisional) || neutral.phase === "countdown" || neutral.phase === "hold";
  const b = 0.5 + 0.5 * Math.sin(t * (urgent ? 3.2 : 1.1));
  calibRing.material.opacity = 0.45 + calibWake * 0.4 + b * (urgent ? 0.35 : 0.1);
  calibRing.scale.setScalar(0.06 * (1 + calibWake * 0.35 + (urgent ? b * 0.15 : 0)));
  calibCore.material.opacity = 0.35 + calibWake * 0.5;
  calibWord.material.opacity = 0.9;
  calibMsg.set(txt);
  calibMsg.spr.material.opacity += ((txt ? 0.98 : 0) - calibMsg.spr.material.opacity) * (1 - Math.exp(-dt * 6));
}

// ---------------------------------------------------------------------------
// SIMULATED badge: whenever the in-page mock feeds the app, say so - on the
// page (DOM) and, in the headset, as a word riding beside the exit ring. A
// websocket that is not connected says "bridge offline" with its URL.
// ---------------------------------------------------------------------------
const simBadge = document.getElementById("simbadge");
const simWord = makeWord("simulated", { size: 0.16, color: "#E7B45A" });
simWord.position.set(0, -0.075, 0);
home.add(simWord);
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
  simWord.material.opacity = d.simulated ? 0.95 : 0;
  simWord.visible = !!d.simulated;
}

// ---------------------------------------------------------------------------
// XR reach interaction: in passthrough there is no pointer; the hand IS the
// cursor. Nearing an interactive wakes it (hover); reaching into it selects.
// A hysteresis re-arm keeps one reach from selecting twice.
// ---------------------------------------------------------------------------
const _xrV = new THREE.Vector3();
let xrHover = null, xrArmed = true, xrCooldown = 0;

// ---------------------------------------------------------------------------
// press acknowledgement (2026-07-30): ONE answer to the hand, shared by the XR
// reach and the desktop pointer, so no control can be pressed without replying
// inside a frame - a flare of light exactly where contact happened, a quiet
// tick, and a controller pulse. Audio and haptics alone left the reach looking
// unanswered in passthrough (the sound reads as ambience, and there is no
// haptic at all with bare hands). The mode's own onSelect layers its richer
// response on top; THIS is the part that must never be missing.
// ---------------------------------------------------------------------------
const FLARE_S = 0.22;                  // well inside the 100 ms answer budget
const pressFlare = makeGlow(0xd9edff, 0.07, 0, { depthTest: false });
pressFlare.renderOrder = 9;
pressFlare.visible = false;
world.scene.add(pressFlare);
let flareLife = 0;

function press(obj) {
  if (obj) {
    obj.getWorldPosition(_xrV);
    pressFlare.position.copy(_xrV);
    pressFlare.scale.setScalar(0.07);
    pressFlare.material.opacity = 0.85;
    pressFlare.visible = true;
    flareLife = FLARE_S;
    audio.bell(1, 1, { gain: 0.07, pos: _xrV });
  }
  pads.pulse(0.35, 40);
}
// Reach tuning (2026-07-30): selecting used to demand the fingertip within
// 0.06 m of a glyph's CENTER - inside the geometry of every hero - and users
// repeatedly "pressed" without selecting. SELECT_R 0.09 selects at the
// object's surface; REARM_R keeps the hysteresis gap so one reach still
// cannot double-fire; HOVER_R unchanged (wake stays a gentle early signal).
const HOVER_R = 0.17, SELECT_R = 0.09, REARM_R = 0.13;
const _uiTip = new THREE.Vector3();
function xrInteract(dt, extraTip) {
  // the dressed hand's index tip, plus the OTHER tracked hand's (the rig hand
  // may be placed by the body model while the free hand works the UI)
  const tips = extraTip ? [hand.tips.index, extraTip] : [hand.tips.index];
  const list = [];
  if (current && current.interactives) list.push(...current.interactives);
  if (home.visible) list.push(home);
  if (calib.visible) list.push(calib);
  let best = null, bestD = HOVER_R;
  for (const o of list) {
    o.getWorldPosition(_xrV);
    for (const tip of tips) {
      const d = _xrV.distanceTo(tip);
      if (d < bestD) { bestD = d; best = o; }
    }
  }
  if (best !== xrHover) {
    xrHover = best;
    hovered = best;                       // the home glyph shares the wake path
    if (current && current.onHover) current.onHover(homeOwns(best) ? null : best);
  }
  xrCooldown = Math.max(0, xrCooldown - dt);
  // select: reach INTO the glyph with the hand, or trigger-click while the
  // controller-ridden hand of light hovers near it
  const clicked = pads.justPressed && best && bestD < HOVER_R;
  if (best && (bestD < SELECT_R || clicked) && xrArmed && xrCooldown === 0) {
    xrArmed = false; xrCooldown = 1.2;
    press(best);          // flare + tick + haptic, before any mode handler
    if (homeOwns(best)) {
      // in a mode: back to the hub; at the hub: leave AR cleanly
      if (currentName === "atelier") endXR();
      else switchTo("atelier");
    } else if (calibOwns(best)) requestNeutral();
    else if (current && current.onSelect) current.onSelect(best, null);
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
    // first thing the owner sees in AR: whether the bridge link is live
    scanFeedback.noteSessionStart();
    sendDiag(tele, "xr_start", fullDiag());
    session.addEventListener("end", () => {
      xrSession = null;
      xrFeatures = { list: [], features: {}, depthUsage: "", depthFormat: "" };
      resetEnvScan();               // next session re-scans its own room
      contacts.reset();
      xrHands.reset();
      hand.bodyAnchor.reset();      // desktop re-seeds its own default
      world.exitXR();
      home.visible = currentName !== "atelier";
    });
    await world.enterXR(session);
    audio.start();
    // put the last scanned room back: restore its persisted anchor now (no
    // frame needed); envScan reads its pose in the following XR frames and
    // only adopts the old env once the anchor actually localizes
    relocateLastRoom(session)
      .then((okR) => sendDiag(tele, okR ? "room_reloc_restoring" : "room_reloc_skipped", fullDiag()))
      .catch(() => {});
    // in the room, the exit glyph is ALWAYS reachable: at the hub it is the
    // clean way back to the browser (see endXR below)
    home.visible = true;
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
  pads.update(dt);
  let eff = pads.apply(latest);
  if (pads.active && pads.tracked) hand.moveTo(pads.gripPos, 12);   // ride the grip
  // the bridge echoes our poses in `world`; undo the env frame they were
  // streamed in (a relocated room) before placing anything with it
  if (eff && eff.world) {
    const w = worldToRoom(eff.world);
    if (w !== eff.world) eff = Object.assign({}, eff, { world: w });
  }

  const headFwd = world.camera.getWorldDirection(_headFwd);
  hand.update(dt, eff, xr, {
    presenting: presentingNow, nowMs,
    msSinceOwnPose: msSinceOwnPose(),
    headPos: [world.camera.position.x, world.camera.position.y, world.camera.position.z],
    headFwd: [headFwd.x, headFwd.y, headFwd.z],
    controllerTracked: pads.active && pads.tracked,
  });
  if (presentingNow) {
    xrInteract(dt, uiTip);
    // 4D replay: depth-cloud + scene-mesh harvest, wrist 6-DoF + finger stream
    const _s0 = performance.now();
    const refSpace = world.renderer.xr.getReferenceSpace();
    updateEnvCapture(xrFrame, refSpace, xrSession, tele, eff);
    perf.scanMs += (performance.now() - _s0 - perf.scanMs) * 0.1;
  }
  updateContacts(eff);
  cloudMotes.update(dt);   // live "room being drawn" motes (desktop sim scan too)

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
  updateCalib(dt, t, eff);
  updateBadge();

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

  // home glyph breathes, wakes on hover
  if (home.visible) {
    const want = hovered && homeOwns(hovered) ? 1 : 0;
    homeWake += (want - homeWake) * (1 - Math.exp(-dt * 8));
    const b = 0.5 + 0.5 * Math.sin(t * 1.1);
    homeRing.material.opacity = 0.6 + homeWake * 0.4 + b * 0.1;
    homeCore.material.opacity = 0.5 + homeWake * 0.5;
    homeWord.material.opacity = 0.9 + homeWake * 0.1;
    homeRing.scale.setScalar(0.07 * (1 + homeWake * 0.35));
    document.body.style.cursor = hovered ? "pointer" : "default";
  } else {
    document.body.style.cursor = hovered ? "pointer" : "default";
  }

  // the press flare blooms outward and dies in FLARE_S
  if (flareLife > 0) {
    flareLife = Math.max(0, flareLife - dt);
    const k = flareLife / FLARE_S;                    // 1 -> 0
    pressFlare.material.opacity = k * 0.85;
    pressFlare.scale.setScalar(0.07 + (1 - k) * 0.10);
    if (flareLife === 0) pressFlare.visible = false;
  }

  world.renderer.render(world.scene, world.camera);
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
};
