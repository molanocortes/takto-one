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
import { AQUA, CSS } from "./design/palette.js";
import { makeGlow, makeRingSprite } from "./world/materials.js";
import { makeWord } from "./modes/common.js";
import { Atelier } from "./modes/atelier.js";
import { Capture } from "./modes/capture.js";
import { Rhythm } from "./modes/rhythm.js";
import { Touch } from "./modes/touch.js";
import { Twin } from "./modes/twin.js";
import { updateEnvCapture, resetEnvScan, envDiag, setGpuDepthReader,
         sceneObjects, roomAnchor, relocateLastRoom,
         DEPTH_GRID_COLS, DEPTH_GRID_ROWS } from "./world/envScan.js";
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
tele.onSnapshot((s) => { if (s.kind === "snap") latest = s; });

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
let _relocTried = false;           // one relocation attempt per XR session
let _contactSrc = "mock";

function updateContacts(snap) {
  const reg = sceneObjects();
  if (reg.count === 0) return;
  _contactSrc = hand.deviceDriven ? "device"
              : (hand.bareActive ? "quest-hand" : "mock");
  // two clocks: performance.now() is the headset's, snap.t_ms is the Teensy's.
  // Both are stamped on every event so the host can align contacts with the
  // joint columns without anyone inventing an offset. See ROOM-FUSION.md.
  const devMs = (snap && typeof snap.t_ms === "number") ? snap.t_ms : null;
  const sealed = contacts.update(hand.tips, reg, performance.now(), _contactSrc, devMs);
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
const ctx = { world, hand, audio, tele, switchTo, snap: () => latest };
const modes = {
  atelier: new Atelier(ctx),
  capture: new Capture(ctx),
  rhythm: new Rhythm(ctx),
  touch: new Touch(ctx),
  twin: new Twin(ctx),
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

function pick(ev) {
  pointer.x = (ev.clientX / innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, world.camera);
  const list = [];
  if (current && current.interactives) list.push(...current.interactives);
  if (home.visible) list.push(homeRing);
  const hits = raycaster.intersectObjects(list, true);
  return hits.length ? hits[0].object : null;
}

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
  const obj = pick(ev);
  if (obj) press(obj);            // the desktop path answers identically
  if (homeOwns(obj)) { switchTo("atelier"); return; }
  if (obj && current && current.onSelect) current.onSelect(obj);
});
addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") switchTo("atelier");
  const k = { 1: "atelier", 2: "capture", 3: "rhythm", 4: "touch", 5: "twin" }[ev.key];
  if (k) switchTo(k);
});
function homeOwns(obj) {
  return obj && (obj === homeRing || obj === homeCore || obj.parent === home || obj === home);
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
function xrInteract(dt) {
  const tip = hand.tips.index;
  const list = [];
  if (current && current.interactives) list.push(...current.interactives);
  if (home.visible) list.push(home);
  let best = null, bestD = HOVER_R;
  for (const o of list) {
    o.getWorldPosition(_xrV);
    const d = _xrV.distanceTo(tip);
    if (d < bestD) { bestD = d; best = o; }
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
    } else if (current && current.onSelect) current.onSelect(best);
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
  xrBlocked = "AR needs a secure origin.\nOpen this page over https (run Fable/ar/serve_https.py, then https://<PC-IP>:8443) or via adb reverse + http://localhost.";
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
      _relocTried = false;
      world.exitXR();
      home.visible = currentName !== "atelier";
    });
    await world.enterXR(session);
    audio.start();
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

  // XR hands: dress whichever real hand the headset sees (remember which side)
  let xr = null;
  if (world.renderer.xr.isPresenting) {
    const h0 = world.renderer.xr.getHand(0), h1 = world.renderer.xr.getHand(1);
    for (const h of [h0, h1]) {
      if (h && !h.userData.arHooked) {
        h.userData.arHooked = true;
        h.addEventListener("connected", (e) => {
          h.userData.handedness = e.data && e.data.handedness;
        });
      }
    }
    const has = (h) => h && h.joints && h.joints["index-finger-tip"];
    // the rig is worn on the right hand: always prefer the right when tracked
    let pick = null;
    for (const h of [h0, h1]) if (has(h) && h.userData.handedness === "right") pick = h;
    if (!pick) pick = has(h0) ? h0 : (has(h1) ? h1 : null);
    xr = { hand: pick, handedness: pick ? pick.userData.handedness : undefined };
  }
  // controller overlay: while a controller is in use, its synthesized
  // snapshot replaces the live one for EVERYTHING downstream (one chokepoint)
  pads.update(dt);
  const eff = pads.apply(latest);
  if (pads.active && pads.tracked) hand.moveTo(pads.gripPos, 12);   // ride the grip

  hand.update(dt, eff, xr);
  if (world.renderer.xr.isPresenting) {
    xrInteract(dt);
    // 4D replay: depth-cloud + scene-mesh harvest, wrist 6-DoF + finger stream
    const _s0 = performance.now();
    const refSpace = world.renderer.xr.getReferenceSpace();
    updateEnvCapture(xrFrame, refSpace, xrSession, tele, eff);
    // once per session, try to put the last scanned room back where it was
    if (!_relocTried && xrFrame && refSpace && xrSession) {
      _relocTried = true;
      relocateLastRoom(xrFrame, refSpace, xrSession)
        .then((m) => sendDiag(tele, m ? "room_relocated" : "room_reloc_failed", fullDiag()))
        .catch(() => {});
    }
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
