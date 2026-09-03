// capture.js - the recording console. A practical, beautiful instrument for a
// person doing a repetitive real-world job of generating data: name the take,
// start (a 3-2-1 gives time to get into position), watch elapsed time,
// storage and sensor health at a glance, and finish when done. Takes stack up
// in a quiet list so start/stop/start is effortless. The rite stays
// (countdown, earned-light ring, quality aura); the console makes it useful.
//
// NO TAIL TRIM (2026-07-30): this console used to send trim_tail_s:3 with the
// stop and subtract 3 s from the duration it listed, on the assumption that
// the host dropped the finish-reach motion. No backend ever implemented it
// (teensy_bridge.py record_stop takes no arguments), so the AR list disagreed
// with the take library on every take. The stop is now plain and the duration
// listed is the duration stored. Re-introduce the field only together with a
// host-side implementation + a DATA_CONTRACT.md entry.

import * as THREE from "../../vendor/three.module.js";
import { Mode, makeWord, tagRoot, keyOf } from "./common.js";
import { Countdown } from "../design/countdown.js";
import { makeCounter } from "./rhythm.js";
import { makeGlow, makeRingSprite, makeFlatRing, makeStageDisc, BurstPool, MoteField } from "../world/materials.js";
import { AQUA, AQUA_DEEP, AQUA_HALO, AMBER, CANDLE, PROGRESS, OK, OBSIDIAN } from "../design/palette.js";
import { clamp, lerp, Breath } from "../design/motion.js";
import { beginScan, finishScan, scanState, simScanTick, scanCoverage } from "../world/envScan.js";

const ANCHOR = new THREE.Vector3(0, 0.75, -0.55);
const RING_R = 0.23;
const RING_C = new THREE.Vector3(0, 0.002, 0.05);

const BYTES_PER_SAMPLE = 64;          // [DESIGN] 12 joints + 2 IMU + activation, packed
const PRESETS = ["plate", "cup", "reach", "open-close", "pinch"];

function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + " GB";
  if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
  return Math.max(0, Math.round(b / 1e3)) + " kB";
}

// the earned-light ring: a flat shader ring whose arc fills lap by lap
function fillRing(radius) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uFill: { value: 0 },
      uBase: { value: new THREE.Color(AQUA_DEEP) },
      uLit: { value: new THREE.Color(PROGRESS) },
      uPulse: { value: 0 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform float uFill; uniform float uPulse;
      uniform vec3 uBase; uniform vec3 uLit;
      varying vec2 vUv;
      void main(){
        vec2 c = vUv - 0.5;
        float r = length(c) * 2.0;
        float band = smoothstep(0.74, 0.86, r) * (1.0 - smoothstep(0.90, 0.99, r));
        float ang = fract((atan(c.x, c.y)) / 6.2831853 + 1.0);
        float lit = 1.0 - smoothstep(uFill - 0.006, uFill + 0.006, ang);
        vec3 col = uBase * band * 0.35 + uLit * band * lit * (0.85 + uPulse);
        float a = band * (0.30 + 0.7 * lit);
        gl_FragColor = vec4(col, a);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2.3, radius * 2.3), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 3;
  return { mesh, mat };
}

export class Capture extends Mode {
  constructor(ctx) {
    super(ctx);
    this.group.position.copy(ANCHOR);
    this._state = "choose";            // choose | count | recording | seal
    this._label = "";                  // the user's take name ("" = auto)
    this._presetIx = -1;
    this._takeN = 0;
    this._takes = [];                  // { name, seconds }
    this._laps = 0;
    this._lapBoost = 0;
    this._imuPrev = new THREE.Quaternion();
    this._imuStab = 1;
    this._calm = 1;
    this._repsAtStart = 0;
    this._recStartT = 0;
    this._lastElapsedS = 0;            // last elapsed seen while the host recorded
    this._breath = new Breath(0.12);
    this._free = null;                 // browser-reported free storage [bytes]
    this._tmp = new THREE.Vector3();
    this._gripHold = 0;                // hold-to-press: seconds the fist is held
    this._gripFired = false;
    this._gripSeenOpen = false;        // rising-edge arm: open hand seen first
    this._gripEnabled = new URLSearchParams(location.search).get("grip") !== "0";
    this._hostRec = false;             // host recording seen (remote-stop reconcile)
    this._scanSettleT = 0;             // dwell after a scan resolves, before choose
    this._build();
    this._bindTyping();
  }

  // ---------------------------------------------------------------------------
  _build() {
    const g = this.group;

    // the workspace ring: laps of earned light while recording
    const fr = fillRing(RING_R);
    fr.mesh.position.copy(RING_C).add(new THREE.Vector3(0, 0.004, 0));
    g.add(fr.mesh);
    this._fill = fr.mat;
    const base = makeFlatRing(RING_R, AQUA_DEEP, 0.05);
    base.position.copy(RING_C);
    base.material.opacity = 0.22;
    g.add(base);
    this._base = base;
    const stage = makeStageDisc(0.42);
    stage.position.set(0, 0.0008, RING_C.z);
    g.add(stage);

    // ---- the console: a smoked glass slab, tilted toward the user ---------
    const panel = new THREE.Group();
    panel.position.set(0, 0.20, -0.10);
    panel.rotation.x = -0.30;
    g.add(panel);
    this._panel = panel;

    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.235, 0.008),
      new THREE.MeshPhysicalMaterial({
        color: OBSIDIAN, roughness: 0.16, metalness: 0.1,
        clearcoat: 1, clearcoatRoughness: 0.1,
        transparent: true, opacity: 0.90,
        emissive: AQUA, emissiveIntensity: 0.02,
      })
    );
    panel.add(slab);
    this._slab = slab;
    // a thin azure edge holds the slab's silhouette in any light
    const w = 0.42 / 2, h = 0.235 / 2;
    const edgeGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-w, -h, 0.005), new THREE.Vector3(w, -h, 0.005),
      new THREE.Vector3(w, -h, 0.005), new THREE.Vector3(w, h, 0.005),
      new THREE.Vector3(w, h, 0.005), new THREE.Vector3(-w, h, 0.005),
      new THREE.Vector3(-w, h, 0.005), new THREE.Vector3(-w, -h, 0.005),
    ]);
    this._edge = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({
      color: AQUA, transparent: true, opacity: 0.6,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    panel.add(this._edge);

    // ---- console readouts (solid ink, always legible) ---------------------
    const Z = 0.012;
    // the take name (reach it to cycle presets; type on a keyboard)
    this._nameUI = makeCounter({ px: 46, size: 0.20, backing: false });
    this._nameUI.spr.position.set(0, 0.082, Z);
    panel.add(this._nameUI.spr);
    tagRoot(this._nameUI.spr, "name");
    this.interactives.push(this._nameUI.spr);

    // room-scan status chip (top of the panel): the one visible signal that the
    // room mesh is being captured and sent to the host for 4D replay
    this._roomUI = makeCounter({ px: 30, size: 0.155, backing: false, color: "rgba(150,232,220,0.92)" });
    this._roomUI.spr.position.set(0, 0.112, Z);
    panel.add(this._roomUI.spr);

    // the active scan instruction: a warm pill floating just above the console,
    // legible at arm's length in passthrough. Only lit while a scan is live.
    this._guideUI = makeCounter({ px: 26, size: 0.30, backing: true, color: "rgba(231,180,90,0.98)", glow: "rgba(231,180,90,0.6)" });
    this._guideUI.spr.position.set(0, 0.175, 0.02);
    this._guideUI.spr.renderOrder = 9;
    panel.add(this._guideUI.spr);

    // elapsed time, the heart of the console
    this._timeUI = makeCounter({ px: 84, weight: 200, size: 0.30, backing: false });
    this._timeUI.spr.position.set(0, 0.018, Z);
    panel.add(this._timeUI.spr);

    // storage: what this take weighs, what the recorder has left
    this._storeUI = makeCounter({ px: 34, size: 0.20, backing: false, color: "rgba(196,216,236,0.85)" });
    this._storeUI.spr.position.set(0, -0.040, Z);
    panel.add(this._storeUI.spr);

    // sensor health: three lamps that must be green for a clean take
    this._lamps = [];
    const lampDefs = [
      { key: "joints", x: -0.115 },
      { key: "motion", x: 0 },
      { key: "signal", x: 0.115 },
    ];
    for (const d of lampDefs) {
      const dot = makeGlow(OK, 0.016, 0.9, { depthTest: false });
      dot.renderOrder = 8;
      dot.position.set(d.x, -0.078, Z);
      panel.add(dot);
      const word = makeWord(d.key, { size: 0.085, backing: false });
      word.position.set(d.x, -0.101, Z);
      word.material.opacity = 0.55;
      panel.add(word);
      this._lamps.push({ key: d.key, dot, word, level: 1 });
    }

    // recent takes: a quiet list beside the console
    this._takesUI = [];
    for (let i = 0; i < 4; i++) {
      const row = makeCounter({ px: 34, size: 0.17, color: "rgba(196,216,236,0.9)" });
      row.spr.position.set(0.335, 0.10 - i * 0.05, -0.04);
      g.add(row.spr);
      this._takesUI.push(row);
    }

    // ---- the begin / seal light (start the rite, close the take) ----------
    this._begin = new THREE.Group();
    const bCore = makeGlow(CANDLE, 0.030, 0);
    const bRing = makeRingSprite(AMBER, 0.045, 0);
    bRing.material.depthTest = false; bRing.renderOrder = 7;
    this._begin.add(bCore, bRing);
    this._begin.position.set(0, 0.045, RING_C.z + RING_R * 0.82);
    tagRoot(this._begin, "begin");
    g.add(this._begin);
    this._beginCore = bCore; this._beginRing = bRing;
    this.interactives.push(this._begin);
    this._beginWord = makeWord("begin", { size: 0.11 });
    this._beginWord.position.copy(this._begin.position).add(new THREE.Vector3(0, 0.055, 0));
    g.add(this._beginWord);
    this._sealWord = makeWord("finish", { size: 0.11 });
    this._sealWord.position.copy(this._beginWord.position);
    g.add(this._sealWord);

    // ---- the scan-room light (left of begin): harvest the room mesh ----------
    // A separate, optional rite: "look around your room" while the headset's
    // scene mesh streams up to the host. Feeds the 4D replay environment.
    this._scanBtn = new THREE.Group();
    const sCore = makeGlow(AQUA, 0.026, 0);
    const sRing = makeRingSprite(AQUA_HALO, 0.040, 0);
    sRing.material.depthTest = false; sRing.renderOrder = 7;
    this._scanBtn.add(sCore, sRing);
    this._scanBtn.position.set(-0.165, 0.045, RING_C.z + RING_R * 0.5);
    tagRoot(this._scanBtn, "scan");
    g.add(this._scanBtn);
    this._scanCore = sCore; this._scanRing = sRing;
    this.interactives.push(this._scanBtn);
    this._scanWord = makeWord("scan room", { size: 0.092 });
    this._scanWord.position.copy(this._scanBtn.position).add(new THREE.Vector3(0, 0.052, 0));
    g.add(this._scanWord);
    // state truth (2026-07-30): while a scan is live the same light FINISHES
    // it (onSelect's second tap), so the label must say so - "scan room" over
    // a running scan promised the wrong action
    this._sendWord = makeWord("send now", { size: 0.092 });
    this._sendWord.position.copy(this._scanWord.position);
    g.add(this._sendWord);

    // countdown set piece above the ring
    this._count = new Countdown(this.group, this.ctx.audio,
      { center: new THREE.Vector3(0, 0.30, RING_C.z + 0.10), size: 0.16 });

    this._bursts = new BurstPool({ max: 300, seed: 9 });
    g.add(this._bursts.points);

    this._motes = new MoteField({ count: 40, radius: 0.55, center: new THREE.Vector3(0, 0.48, 0.05), size: 0.021, seed: 17, ySpan: [0.42, 0.85] });
    this._motes.opacity = 0.95;
    g.add(this._motes.points);
  }

  // desktop keyboards name takes directly; the harness never demands it
  _bindTyping() {
    addEventListener("keydown", (ev) => {
      if (!this.active || this._state !== "choose") return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === "Backspace") { this._label = this._label.slice(0, -1); ev.stopImmediatePropagation(); }
      else if (ev.key.length === 1 && /[a-zA-Z0-9 _-]/.test(ev.key) && this._label.length < 14) {
        this._label += ev.key.toLowerCase();
        ev.stopImmediatePropagation();
      }
    }, { capture: true });
  }

  get _takeName() {
    return this._label.trim() || `take-${String(this._takeN + 1).padStart(2, "0")}`;
  }

  enter() {
    super.enter();
    this.ctx.audio.setBedLevel(0.5, 3.0);
    this.ctx.hand.setHalo(false);
    this._setState("choose");
    // the recorder's remaining space, when the platform reports it honestly
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((e) => {
        if (e && e.quota) this._free = Math.max(0, e.quota - (e.usage || 0));
      }).catch(() => {});
    }
  }

  exit() {
    super.exit();
    this.ctx.hand.setAura(false);
    if (this._state === "recording") this.ctx.tele.send({ cmd: "record", action: "stop" });
    this._setState("choose");
    // leaving the mode ends this take's bookkeeping: a stale elapsed time must
    // not survive to be listed as the duration of a LATER take the host never
    // actually started (that take's real duration is 0)
    this._lastElapsedS = 0;
  }

  _setState(s) {
    this._state = s;
    if (s === "recording") {
      this.ctx.hand.setAura(true);
      this._lastElapsedS = 0;          // fresh take, no inherited duration

      const snap = this.ctx.snap();
      this._repsAtStart = snap && snap.reps ? snap.reps.done : 0;
      this._laps = 0;
      this._lapBoost = 0;
    } else if (s === "choose") {
      this.ctx.hand.setAura(false);
    }
  }

  onHover(obj) { this._hover = keyOf(obj); }

  onSelect(obj) {
    const key = keyOf(obj);
    if (!key) return;
    if (key === "scan") {
      // start a room scan from the console, or finish one early on a second tap
      if (this._state === "choose") {
        beginScan();
        this._scanSettleT = 0;
        this._setState("scan");
        this.ctx.audio.bell(4, 0, { gain: 0.12 });
      } else if (this._state === "scan") {
        finishScan(this.ctx.tele);
      }
      return;
    }
    if (key === "name" && this._state === "choose") {
      // reach the name to cycle the presets (typing always wins)
      this._presetIx = (this._presetIx + 1) % (PRESETS.length + 1);
      this._label = this._presetIx === PRESETS.length ? "" : PRESETS[this._presetIx];
      this.ctx.audio.bell(4, 0, { gain: 0.10 });
    } else if (key === "begin" && this._state === "recording") {
      this._seal();
    } else if (key === "begin" && this._state === "choose") {
      this._setState("count");
      this._count.start(() => {
        this._takeN += 1;
        const d = new Date();
        const day = `${String(d.getFullYear() % 100).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
        this.ctx.tele.send({ cmd: "goal", value: 6 });
        this.ctx.tele.send({
          cmd: "record", action: "start",
          profile: { name: "operator", note: this._takeName },
          session: `${this._takeName}-${day}-${String(this._takeN).padStart(2, "0")}`,
        });
        this._recStartT = performance.now() / 1000;
        this._setState("recording");
      });
    }
  }

  // data quality from the stream itself: sensor flags, motion, signal
  _quality(snap, dt) {
    let joints = 1, motion = 1, signal = 1;
    if (snap) {
      if (snap.joints && snap.joints.length) {
        const ok = snap.joints.filter(j => j.ok).length;
        joints = ok === snap.joints.length ? 1 : ok / snap.joints.length * 0.5;
      }
      if (snap.hand && snap.hand.quat) {
        const q = snap.hand.quat;
        const cur = new THREE.Quaternion(q[1], q[2], q[3], q[0]);
        const d = 1 - Math.min(1, Math.abs(cur.dot(this._imuPrev)));
        this._imuPrev.copy(cur);
        const spike = clamp(1 - d * 900, 0, 1);
        this._imuStab += (spike - this._imuStab) * (1 - Math.exp(-dt * 3));
        motion = this._imuStab;
      }
      if (snap.activation && snap.activation.present) {
        signal = snap.activation.quality === "good" ? 1 : snap.activation.quality === "noisy" ? 0.4 : 0.75;
      }
    }
    this._lamps[0].level += (joints - this._lamps[0].level) * (1 - Math.exp(-dt * 4));
    this._lamps[1].level += (motion - this._lamps[1].level) * (1 - Math.exp(-dt * 4));
    this._lamps[2].level += (signal - this._lamps[2].level) * (1 - Math.exp(-dt * 4));
    const target = Math.min(joints, motion, signal);
    this._calm += (target - this._calm) * (1 - Math.exp(-dt * 2.5));
    return this._calm;
  }

  update(dt, snap, t) {
    const hover = this._hover || "";
    // live device: a closed-hand gesture presses the begin/finish light, so
    // the operator never needs the headset's hand. A deliberate press is a
    // HELD fist (~1.2 s), not a rising edge: recorded exercises close the hand
    // on every rep, and an edge trigger would seal the take on the first one.
    // ?grip=0 disables the gesture for scripted demos.
    const hand = this.ctx.hand;
    const presenting = this.ctx.world.renderer.xr.isPresenting;
    // The grip gesture is a BENCH affordance only (headset-less operator with
    // the physical rig and no pointer). It is DISABLED while presenting in XR:
    // there the owner has tracked hands and reaches the begin light directly -
    // and the diag log (2026-07-20, takes 0088-0091) proved the telemetry's
    // cycling fist (sim bridge, or any flexed natural pose) was auto-starting
    // takes in the owner's headset every few seconds.
    if (!presenting && hand.deviceDriven && this._gripEnabled) {
      const grip = !!hand.deviceGrip;
      this._gripHold = grip ? (this._gripHold || 0) + dt : 0;
      // The grip gesture may only START a take. It must NEVER stop one: a
      // recorded exercise (grasp, hold, open-close) keeps the hand closed for
      // seconds at a time, and an auto-seal on a held fist ended real takes
      // after 1-2 s (owner bug report 2026-07-19). To STOP: stop from the
      // web/phone console (the recording session is shared); on the bench a
      // very long, deliberate hold is still allowed as the only way out.
      // RISING-EDGE ARM (2026-07-20): the gesture must see an OPEN hand first
      // - a flex channel stuck above the grip threshold (miscalibration, sim
      // waveform mid-cycle) can never fire it. Hold raised 1.2 -> 2.5 s so a
      // start is deliberate.
      const startHold = this._gripHold > 2.5 && this._state === "choose" && this._gripSeenOpen;
      const benchStopHold = this._gripHold > 3.0 && this._state === "recording";
      if ((startHold || benchStopHold) && !this._gripFired) {
        this._gripFired = true;                 // re-arm only after a release
        this._gripSeenOpen = false;             // next start needs open -> close again
        this.onSelect(this._begin);
      }
      if (!grip) { this._gripFired = false; this._gripSeenOpen = true; }
    } else { this._gripHold = 0; this._gripFired = false; this._gripSeenOpen = false; }
    // shared-host reconciliation: the host owns the ONE recording session. If
    // another client (web console, phone) stopped this take, follow the host
    // instead of showing a recording that is already over.
    if (this._state === "recording" && snap && snap.session) {
      if (snap.session.recording) this._hostRec = true;
      else if (this._hostRec) { this._hostRec = false; this._finishTake(); }
    } else if (this._state !== "recording") this._hostRec = false;

    const recording = this._state === "recording";
    const bb = this._breath.at(t * (recording ? 0.9 : 1.6));

    // the console holds its breath while the 3-2-1 takes the stage
    this._panel.visible = this._state !== "count";

    // ---- console readouts --------------------------------------------------
    this._nameUI.set(this._takeName + (this._state === "choose" && this._label ? "" : ""));
    this._nameUI.spr.material.opacity = 0.9 + (hover === "name" ? 0.1 : 0);
    this._nameUI.spr.scale.setScalar(1 + (hover === "name" ? 0.06 : 0));
    this._nameUI.spr.scale.set(0.20 * (1 + (hover === "name" ? 0.05 : 0)), 0.05 * (1 + (hover === "name" ? 0.05 : 0)), 1);

    const elapsed = recording && snap && snap.session
      ? snap.session.elapsed_ms / 1000
      : recording ? performance.now() / 1000 - this._recStartT : 0;
    // remember the last elapsed time seen WHILE the host was still recording:
    // both producers zero elapsed_ms the instant the recording stops, so a take
    // stopped from another client (web/phone console) would otherwise be listed
    // as 0:00 - the post-stop snapshot is the one _finishTake sees.
    if (recording && snap && snap.session && snap.session.recording) this._lastElapsedS = elapsed;
    this._timeUI.set(recording ? fmtTime(elapsed) : "0:00");
    this._timeUI.spr.material.opacity = recording ? 1 : 0.8;

    const samples = recording && snap && snap.session ? snap.session.samples : 0;
    const used = samples * BYTES_PER_SAMPLE;
    const freeStr = this._free !== null ? fmtBytes(this._free - used) + " free" : "free unknown";
    this._storeUI.set(`${fmtBytes(used)} · ${freeStr}`);
    this._storeUI.spr.material.opacity = 1.0;

    // sensor lamps: green is a clean take, amber asks for attention
    this._quality(snap, dt);
    for (const lamp of this._lamps) {
      const lv = lamp.level;
      lamp.dot.material.color.setHex(lv > 0.8 ? OK : lv > 0.45 ? AMBER : 0x8a94a2);
      lamp.dot.material.opacity = 0.55 + lv * 0.35 + bb * 0.1;
      lamp.dot.scale.setScalar(0.015 + lv * 0.004 + bb * 0.0015);
      lamp.word.material.opacity = 0.9;
    }
    this.ctx.hand.aura(this._calm);

    // takes list
    for (let i = 0; i < this._takesUI.length; i++) {
      const take = this._takes[this._takes.length - 1 - i];
      this._takesUI[i].set(take ? `${take.name}  ·  ${fmtTime(take.seconds)}` : "");
      this._takesUI[i].spr.material.opacity = take ? 1.0 - i * 0.12 : 0;
    }

    // slab presence: recording warms the edge amber
    this._edge.material.color.setHex(recording ? AMBER : AQUA);
    this._edge.material.opacity = recording ? 0.6 + bb * 0.3 : 0.45 + bb * 0.15;
    this._slab.material.emissiveIntensity = 0.015 + bb * 0.01;

    // ---- begin / finish light ----------------------------------------------
    const beginOn = this._state === "choose" || recording ? 1 : 0;
    this._beginCore.material.opacity += ((beginOn * (0.5 + bb * 0.3)) - this._beginCore.material.opacity) * (1 - Math.exp(-dt * 4));
    this._beginRing.material.opacity += ((beginOn * (0.35 + bb * 0.2)) - this._beginRing.material.opacity) * (1 - Math.exp(-dt * 4));
    this._beginRing.scale.setScalar(0.045 * (1 + bb * 0.15 + (hover === "begin" ? 0.3 : 0)));
    const wordK = 1 - Math.exp(-dt * 5);
    this._beginWord.material.opacity += (((beginOn && !recording) ? 0.9 + (hover === "begin" ? 0.1 : 0) : 0) - this._beginWord.material.opacity) * wordK;
    this._sealWord.material.opacity += ((recording ? 0.9 + (hover === "begin" ? 0.1 : 0) : 0) - this._sealWord.material.opacity) * wordK;

    // ---- room scan: light, progress ring, and the "sent" status chip -------
    if (!presenting && this._state === "scan") simScanTick(dt, this.ctx.tele);
    const scan = scanState();
    // once the upload settles, drift back to choose so the take can begin
    if (this._state === "scan") {
      if (scan.phase === "done" || scan.phase === "empty" || scan.phase === "error") {
        this._scanSettleT = this._scanSettleT || t;
        if (t - this._scanSettleT > 1.1) { this._scanSettleT = 0; this._setState("choose"); }
      } else this._scanSettleT = 0;
    }
    // status chip (top) + a short glanceable instruction on its own line. Both
    // read the SAME real signals as the dom-overlay HUD (which carries the full
    // sentences), so the owner still gets coverage + guidance if dom-overlay was
    // not granted. Kept short: the console text canvas clips long strings.
    const cov = scanCoverage();
    // locale-independent grouping: toLocaleString renders "4.000" in some
    // locales, which reads as four points on the console
    const nPts = String(scan.pts || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const noGeom = scan.pts === 0 && scan.meshes === 0 && scan.planes === 0;
    let chip = "", guide = "";
    if (scan.phase === "scanning") {
      chip = `scanning · ${Math.round(cov * 100)}% · ${nPts} pts`;
      if (noGeom && scan.secs > 2.5) guide = scan.depthFrames === 0 ? "run Space Setup" : "face surfaces 0.3-4 m";
      else if (cov < 0.35) guide = "turn left & right";
      else if (cov < 0.75) guide = "keep turning + tilt";
      else guide = "hold still to send";
    }
    else if (scan.phase === "uploading") { chip = "sending room to host…"; guide = "storing + sending…"; }
    else if (scan.phase === "done") { chip = `captured ${nPts} pts · sent ✓`; guide = "room ready for replay"; }
    else if (scan.phase === "empty") { chip = "no room captured"; guide = scan.depthFrames === 0 ? "run Space Setup" : "sweep slower · face walls"; }
    else if (scan.phase === "error") { chip = "upload failed · tap scan to retry"; guide = "check bridge link"; }
    else if (scan.envId) { chip = "room ready ✓"; }
    this._roomUI.set(chip);
    this._roomUI.spr.material.opacity += ((chip ? 0.95 : 0) - this._roomUI.spr.material.opacity) * (1 - Math.exp(-dt * 6));
    // the active instruction rides its own line above the console, only while a
    // scan is live or just resolved, so it reads as a clear call to action
    // (rotate / move / run Space Setup ...) without touching the name/time state
    const showGuide = this._state === "scan" && !!guide;
    if (showGuide) this._guideUI.set(guide);
    this._guideUI.spr.material.opacity += ((showGuide ? 0.98 : 0) - this._guideUI.spr.material.opacity) * (1 - Math.exp(-dt * 6));

    const scanVisible = this._state === "choose" || this._state === "scan";
    const scanning = this._state === "scan" && (scan.phase === "scanning" || scan.phase === "uploading");
    const scanDone = scan.phase === "done" || (this._state === "choose" && !!scan.envId);
    this._scanCore.material.color.setHex(scanDone ? OK : AQUA);
    this._scanRing.material.color.setHex(scanDone ? OK : AQUA_HALO);
    this._scanCore.material.opacity += ((scanVisible ? 0.4 + (scanning ? 0.4 : 0) + bb * 0.2 : 0) - this._scanCore.material.opacity) * (1 - Math.exp(-dt * 5));
    this._scanRing.material.opacity += ((scanVisible ? 0.3 + (scanning ? 0.35 : 0) + (hover === "scan" ? 0.25 : 0) : 0) - this._scanRing.material.opacity) * (1 - Math.exp(-dt * 5));
    const scanR = scanning ? 0.04 * (1 + scan.pct * 0.6 + 0.12 * Math.sin(t * 6))
                           : 0.04 * (1 + (hover === "scan" ? 0.25 : 0));
    this._scanRing.scale.setScalar(scanR);
    // the label tells the truth about what the next tap does: "scan room"
    // when idle, "send now" while the sweep is live (a second tap finishes)
    const showSend = this._state === "scan" && scan.phase === "scanning";
    this._scanWord.material.opacity += (((scanVisible && !showSend) ? 0.75 + (hover === "scan" ? 0.15 : 0) : 0) - this._scanWord.material.opacity) * (1 - Math.exp(-dt * 5));
    this._sendWord.material.opacity += ((showSend ? 1 + (hover === "scan" ? 0.1 : 0) : 0) - this._sendWord.material.opacity) * (1 - Math.exp(-dt * 5));

    // ---- countdown ----------------------------------------------------------
    if (this._count.active) this._count.update(dt, this.ctx.world.camera);

    // ---- recording: laps of earned light -----------------------------------
    if (recording && snap) {
      const done = Math.max(0, snap.reps ? snap.reps.done - this._repsAtStart : 0);
      const laps = Math.floor(done / 6);
      if (laps > this._laps) {
        this._laps = laps;
        this._lapBoost = Math.min(laps * 0.06, 0.3);
        this._fill.uniforms.uFill.value = 0;
        this.ctx.audio.bell(4, 1, { gain: 0.12 });
        this.ctx.world.brighten(0.08);
      }
      const fill = (done % 6) / 6;
      this._fill.uniforms.uFill.value += (fill - this._fill.uniforms.uFill.value) * (1 - Math.exp(-dt * 3));
      this._fill.uniforms.uPulse.value = 0.25 * Math.sin(t * 2.4) * this._calm;
    } else {
      this._fill.uniforms.uFill.value *= (1 - dt * 1.5);
    }

    // ---- desktop hand: rests near the ring, reaches with the operator ------
    if (!this.ctx.world.renderer.xr.isPresenting) {
      if (recording) {
        this._tmp.copy(RING_C).add(ANCHOR).add(new THREE.Vector3(0, 0.09, 0.10));
        this.ctx.hand.moveTo(this._tmp, 2.5);
      } else this.ctx.hand.rest();
    }

    this._bursts.update(dt);
    this._motes.update(t);
    this._base.material.opacity = 0.18 + 0.06 * this._breath.at(t) + (this._lapBoost || 0);
  }

  _seal() {
    this.ctx.tele.send({ cmd: "record", action: "stop" });
    this._finishTake();
  }

  // the local celebration + bookkeeping, shared by a local finish (_seal sent
  // the stop) and a remote finish (another client already stopped the host)
  _finishTake() {
    this._setState("seal");
    const snap = this.ctx.snap();
    // the post-stop snapshot already reads elapsed_ms 0 (both the mock and the
    // bridge zero it the moment recording ends), so prefer the last value seen
    // while the host was recording. No trim is subtracted: see the file header.
    const fresh = snap && snap.session ? snap.session.elapsed_ms / 1000 : 0;
    const secs = Math.max(0, this._lastElapsedS || 0, fresh);
    this._lastElapsedS = 0;
    this._takes.push({ name: this._takeName, seconds: secs });
    const c = this._tmp.copy(RING_C).add(new THREE.Vector3(0, 0.10, 0));
    this._bursts.burst(c, 90, { speed: [0.15, 0.6], life: [0.6, 1.4], up: 0.55 });
    this.ctx.audio.resolve(null, { gain: 0.24 });
    this.ctx.hand.setAura(false);
    setTimeout(() => this._setState("choose"), 1200);
  }
}
