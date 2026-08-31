// rhythm.js - the motion game, now a real game. Notes of light glide in along
// luminous lanes in time with the generative bed; the hand meets them; a
// living halo around the hand IS the effort meter. A score accumulates with a
// streak multiplier and a perfect-timing bonus; levels escalate the tempo,
// the density and the asked effort; the constellation overhead is the level's
// earned light. A miss is never punished, it only rests the streak.

import * as THREE from "../../vendor/three.module.js";
import { Mode, makeWord } from "./common.js";
import { Countdown } from "../design/countdown.js";
import { makeGlow, makeRingSprite, makeFlatRing, glowTexture, BurstPool, rng } from "../world/materials.js";
import { AQUA, AQUA_DEEP, AQUA_HALO, AMBER, PROGRESS, CANDLE } from "../design/palette.js";
import { clamp, lerp, smoothstep, Breath, Damped } from "../design/motion.js";

const ANCHOR = new THREE.Vector3(0, 0.75, -0.55);
const LANES = [-0.16, 0, 0.16];
const SPAWN = new THREE.Vector3(0, 0.34, -0.95);     // far end (local)
const ZONE = new THREE.Vector3(0, 0.06, 0.24);       // strike zone (local)
const MAX_NOTES = 12;

const FINGERS = ["index", "middle", "ring", "pinky"];

// level design: a gentle, widening staircase
function levelSpec(n) {
  return {
    bpm: Math.min(72 + (n - 1) * 5, 116),
    goal: 10 + n * 2,                                  // hits to finish the level
    travelBeats: n >= 7 ? 3 : n >= 4 ? 3.5 : 4,
    strong: Math.min(0.22 + n * 0.05, 0.55),           // amber (firm) note ratio
    pinch: Math.min(0.06 + n * 0.04, 0.30),
    offbeat: n >= 5 ? 0.5 : n >= 3 ? 0.35 : 0,         // extra half-beat notes
  };
}
const WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const levelWord = (n) => `level ${WORDS[n - 1] || n}`;

// a thin, quiet numeral readout: solid ink on smoked glass so it reads over
// a bright real room (canvas sprite, redrawn only on change)
export function makeCounter({ px = 66, weight = 420, color = "rgba(255,255,255,0.99)",
  size = 0.16, backing = true, glow = "rgba(217,237,255,0.9)" } = {}) {
  const cv = document.createElement("canvas");
  cv.width = 512; cv.height = 128;
  const g = cv.getContext("2d");
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, opacity: 0,
    depthWrite: false, depthTest: false, toneMapped: false,
  });
  const spr = new THREE.Sprite(mat);
  spr.renderOrder = 8;
  spr.scale.set(size, size / 4, 1);
  let last = null;
  return {
    spr,
    set(text) {
      if (text === last) return;
      last = text;
      g.clearRect(0, 0, 512, 128);
      g.textBaseline = "middle";
      const chars = [...text];
      // FIT TO THE CANVAS (2026-07-30). The canvas is a fixed 512 px and the
      // line is drawn CENTRED, so anything wider was clipped at BOTH ends: the
      // SEA rows lost "mcp" off the left and "rigid" off the right and read as
      // a meaningless fragment. Shrink the face (backing pill included) until
      // the line fits, floored at 12 px so a long string still says something.
      // Short lines (the rhythm counters) never enter the loop.
      let fpx = px, gap = 0, w = 0;
      for (;;) {
        g.font = `${weight} ${fpx}px system-ui, -apple-system, sans-serif`;
        gap = fpx * 0.24;
        w = 0;
        for (const ch of chars) w += g.measureText(ch).width + gap;
        w -= gap;
        const total = w + 2 * (fpx * 0.55);
        if (total <= 504 || fpx <= 12) break;
        fpx = Math.max(12, Math.floor(fpx * Math.min(0.94, 504 / total)));
      }
      if (backing && w > 0) {
        const padX = fpx * 0.55, padY = fpx * 0.66;
        const x0 = (512 - w) / 2 - padX, y0 = 64 - padY;
        const bw = w + padX * 2, bh = padY * 2, r = Math.min(bh / 2, 30);
        g.fillStyle = "rgba(3,7,14,0.93)";
        g.beginPath();
        g.moveTo(x0 + r, y0);
        g.arcTo(x0 + bw, y0, x0 + bw, y0 + bh, r);
        g.arcTo(x0 + bw, y0 + bh, x0, y0 + bh, r);
        g.arcTo(x0, y0 + bh, x0, y0, r);
        g.arcTo(x0, y0, x0 + bw, y0, r);
        g.fill();
      }
      g.shadowColor = glow; g.shadowBlur = fpx * 0.3;
      g.fillStyle = color;
      let x = (512 - w) / 2;
      for (const ch of chars) { g.fillText(ch, x, 66); x += g.measureText(ch).width + gap; }
      g.shadowBlur = 0;
      tex.needsUpdate = true;
    },
  };
}

export class Rhythm extends Mode {
  constructor(ctx) {
    super(ctx);
    this.group.position.copy(ANCHOR);
    this._r = rng(2026);
    this._notes = [];
    this._pool = [];
    this._running = false;
    this._hits = 0;
    this._streak = 0;
    this._melody = 0;
    // the game
    this._level = 1;
    this._spec = levelSpec(1);
    this._levelHits = 0;
    this._score = 0;
    this._scoreShown = 0;
    this._best = 0;
    try { this._best = parseInt(localStorage.getItem("ar_rhythm_best") || "0", 10) || 0; } catch (_) {}
    this._interludeT = -1;              // >=0 while resting between levels
    this._breath = new Breath(0.13);
    this._flex = new Damped(0, 0.05);
    this._flexPrev = 0;
    this._flexVel = 0;
    this._peakVel = 0;
    this._wasClosed = false;
    this._range = {};              // per-joint running min/max for normalization
    this._events = [];             // pending motion events { kind, effort, t }
    this._t = 0;
    this._finaleAt = -1;
    this._tmp = new THREE.Vector3();
    this._build();
  }

  _build() {
    const g = this.group;

    // ---- lanes: three threads of light converging on the strike zone ------
    this._laneMats = [];
    for (const lx of LANES) {
      const pts = [];
      for (let i = 0; i <= 24; i++) {
        const u = i / 24;
        pts.push(new THREE.Vector3(
          lerp(SPAWN.x + lx, ZONE.x + lx * 0.45, u),
          lerp(SPAWN.y, ZONE.y, Math.pow(u, 1.35)),
          lerp(SPAWN.z, ZONE.z, u)
        ));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: AQUA_DEEP, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      g.add(new THREE.Line(geo, mat));
      this._laneMats.push(mat);
    }

    // strike zone: a breathing ring of light lying on the desk, where the
    // notes land and the hand waits
    this._zone = makeFlatRing(0.11, AQUA, 0.14);
    this._zone.position.set(ZONE.x, 0.006, ZONE.z);
    this._zone.material.opacity = 0.3;
    g.add(this._zone);

    // ---- note pool ---------------------------------------------------------
    for (let i = 0; i < MAX_NOTES; i++) {
      const orb = new THREE.Group();
      const glow = makeGlow(AQUA, 0.052, 0);
      const core = makeGlow(AQUA_HALO, 0.02, 0);
      const ring = makeRingSprite(AQUA, 0.05, 0);
      orb.add(glow, core, ring);
      orb.visible = false;
      this.group.add(orb);
      this._pool.push({ orb, glow, core, ring, live: false });
    }

    this._bursts = new BurstPool({ max: 500, seed: 77, size: 0.016 });
    this.group.add(this._bursts.points);

    // ---- constellation: one star per good repetition, on a high dome ------
    this._starMax = 48;
    this._starN = 0;
    this._starPos = new Float32Array(this._starMax * 3);
    this._starGeo = new THREE.BufferGeometry();
    this._starGeo.setAttribute("position", new THREE.BufferAttribute(this._starPos, 3));
    this._starGeo.setDrawRange(0, 0);
    this._starMat = new THREE.PointsMaterial({
      map: glowTexture(64), color: PROGRESS, size: 0.030,
      transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
      depthWrite: false, sizeAttenuation: true,
    });
    this._stars = new THREE.Points(this._starGeo, this._starMat);
    this._stars.frustumCulled = false;
    this.group.add(this._stars);
    const rs = rng(9);
    this._starSeeds = [];
    for (let i = 0; i < this._starMax; i++) {
      // a slow spiral overhead, so the constellation has a shape
      const a = i * 0.62, rr = 0.35 + 0.5 * (i / this._starMax) + rs() * 0.06;
      this._starSeeds.push([Math.sin(a) * rr, 0.78 + rs() * 0.34, -0.25 - Math.cos(a) * rr * 0.5]);
    }

    // the lighter 3-2-1
    this._count = new Countdown(this.group, this.ctx.audio,
      { center: new THREE.Vector3(0, 0.34, 0.05), size: 0.12 });

    // ---- the tasteful score: thin numerals floating over the far lanes ----
    this._scoreUI = makeCounter({ size: 0.20 });
    this._scoreUI.spr.position.set(0, 0.52, -0.78);
    this.group.add(this._scoreUI.spr);
    this._bestUI = makeCounter({ px: 40, color: "rgba(168,212,245,0.8)", size: 0.115 });
    this._bestUI.spr.position.set(0, 0.455, -0.78);
    this.group.add(this._bestUI.spr);
    this._multUI = makeCounter({ px: 52, color: "rgba(255,177,85,0.95)", size: 0.10, glow: "rgba(255,177,85,0.8)" });
    this._multUI.spr.position.set(0.20, 0.52, -0.76);
    this.group.add(this._multUI.spr);
    // the level whisper
    this._levelWordUI = makeWord(levelWord(1), { size: 0.30 });
    this._levelWordUI.position.set(0, 0.30, -0.30);
    this.group.add(this._levelWordUI);
    this._levelWordT = -1;
  }

  // streak multiplier: warm, simple, capped
  get _mult() { return Math.min(4, 1 + Math.floor(this._streak / 4) * 0.5); }

  _showLevelWord(n) {
    // rebuild the word texture for the new level
    this.group.remove(this._levelWordUI);
    this._levelWordUI = makeWord(levelWord(n), { size: 0.30 });
    this._levelWordUI.position.set(0, 0.30, -0.30);
    this.group.add(this._levelWordUI);
    this._levelWordT = 0;
  }

  enter() {
    super.enter();
    const audio = this.ctx.audio;
    audio.setBedLevel(1.15, 1.6);           // the room comes alive, gently
    this.ctx.hand.setHalo(true);
    this._hits = 0; this._streak = 0; this._starN = 0;
    this._starGeo.setDrawRange(0, 0);
    this._running = false;
    this._finaleAt = -1;
    this._interludeT = -1;
    this._score = 0; this._scoreShown = 0;
    this._startLevel(1);
    this._count.start(() => { this._running = true; this._showLevelWord(1); });
    this._beatOff = audio.onBeat((count) => {
      if (!this._running || this._finaleAt >= 0 || this._interludeT >= 0) return;
      if (count % 2 === 0) this._spawn();
      else if (this._spec.offbeat > 0 && this._r() < this._spec.offbeat) this._spawn();
    });
  }

  _startLevel(n) {
    this._level = n;
    this._spec = levelSpec(n);
    this._levelHits = 0;
    this.ctx.audio.setBpm(this._spec.bpm);
    this.ctx.tele.send({ cmd: "goal", value: this._spec.goal });
  }

  exit() {
    super.exit();
    if (this._beatOff) { this._beatOff(); this._beatOff = null; }
    for (const n of this._pool) { n.live = false; n.orb.visible = false; }
    this._notes.length = 0;
    this.ctx.hand.setHalo(false);
    this.ctx.audio.setBpm(72);              // the hub keeps its calm pulse
    this._saveBest();
  }

  _saveBest() {
    if (this._score > this._best) {
      this._best = this._score;
      try { localStorage.setItem("ar_rhythm_best", String(this._best)); } catch (_) {}
    }
  }

  // ---- notes ---------------------------------------------------------------
  _spawn() {
    const slot = this._pool.find(p => !p.live);
    if (!slot) return;
    const lane = Math.floor(this._r() * 3);
    const kindRoll = this._r();
    const pinchP = this._spec.pinch;
    const kind = kindRoll < pinchP ? "pinch" : kindRoll < pinchP + (1 - pinchP) * 0.55 ? "close" : "open";
    const strong = this._r() < this._spec.strong;
    slot.live = true;
    slot.kind = kind;
    slot.strong = strong;
    slot.lane = lane;
    slot.progress = 0;
    slot.missed = false;
    slot.orb.visible = true;
    const col = strong ? AMBER : AQUA;
    slot.glow.material.color.setHex(col);
    slot.ring.material.color.setHex(col);
    slot.core.material.color.setHex(strong ? CANDLE : AQUA_HALO);
    this._notes.push(slot);
  }

  _notePos(slot, out) {
    const u = slot.progress;
    const lx = LANES[slot.lane];
    out.set(
      lerp(SPAWN.x + lx, ZONE.x + lx * 0.45, u),
      lerp(SPAWN.y, ZONE.y, Math.pow(u, 1.35)),
      lerp(SPAWN.z, ZONE.z, u)
    );
    return out;
  }

  // ---- motion detection: rig joints when worn, the headset's own hand
  // tracking when bare (so the mode is playable with nothing on the hand) ----
  _detect(snap, dt) {
    const hand = this.ctx.hand;
    const bare = hand.bareActive && hand.bareFlex !== null;

    // per-finger normalized flexion with a running range (adapts to the user)
    const flexOf = {};
    if (bare) {
      Object.assign(flexOf, hand.bareFlexOf);
    } else if (hand.deviceDriven) {
      // live device: the shared HandLight flex signal is the single source of
      // truth (middle_pip is the calibrated flexion channel; the per-finger
      // mean below would fold the abduction channel into it)
      flexOf.middle = hand.deviceFlex ?? 0;
    } else {
      if (!snap || !snap.joints || !snap.joints.length) return;
      for (const f of FINGERS) {
        const js = snap.joints.filter(j => j.id.startsWith(f) && j.ok);
        if (!js.length) continue;
        const mean = js.reduce((a, j) => a + j.deg, 0) / js.length;
        const r = this._range[f] || (this._range[f] = { lo: mean, hi: mean + 1 });
        r.lo = Math.min(r.lo, mean); r.hi = Math.max(r.hi, mean);
        flexOf[f] = (mean - r.lo) / Math.max(8, r.hi - r.lo);
      }
    }
    const vals = Object.values(flexOf);
    if (!vals.length) return;
    const flex = this._flex.step(vals.reduce((a, b) => a + b, 0) / vals.length, dt);
    this._flexVel = (flex - this._flexPrev) / Math.max(dt, 1e-3);
    this._flexPrev = flex;
    this._peakVel = Math.max(this._peakVel * (1 - dt * 0.6), Math.abs(this._flexVel));

    // effort: the activation channel when the rig is worn, else the honest
    // kinematic proxy (bare hands have no electrode module by definition)
    let effort;
    if (!bare && snap && snap.activation && snap.activation.present) effort = snap.activation.level;
    else effort = clamp(this._peakVel / 2.4, 0, 1);
    this._effort = effort;
    this._fatigue = !bare && snap && snap.activation ? snap.activation.fatigue : 0;

    // events with hysteresis: a rep is close-then-open. On the live device an
    // activation onset also opens a rep, so a firm grip counts even when the
    // finger barely travels.
    const onset = !bare && hand.deviceDriven && snap && snap.activation
      && snap.activation.present && snap.activation.onset;
    if (!this._wasClosed && (flex > 0.52 || onset)) {
      this._wasClosed = true;
      // pinch: thumb-to-index when bare; index leading while others rest, worn
      let isPinch;
      if (bare && hand.barePinch !== null) {
        isPinch = hand.barePinch < 0.028;
      } else {
        const others = FINGERS.slice(1).map(f => flexOf[f]).filter(v => v !== undefined);
        isPinch = flexOf.index > 0.6 && others.length && Math.max(...others) < 0.35;
      }
      this._events.push({ kind: isPinch ? "pinch" : "close", effort, t: this._t });
      this._lastGraspT = this._t;
      this._lastGraspEffort = effort;
      this.ctx.hand.pulseHalo();
    } else if (this._wasClosed && flex < 0.42) {
      this._wasClosed = false;
      this._events.push({ kind: "open", effort, t: this._t });
      this._peakVel = 0;
    }
  }

  _tryHit(ev) {
    // pass 1: the earliest note that wants exactly this motion
    for (const n of this._notes) {
      if (!n.live || n.missed) continue;
      if (n.progress < 0.75 || n.progress > 1.18) continue;
      const want = n.kind === "pinch" ? (ev.kind === "pinch" || ev.kind === "close") : n.kind === ev.kind;
      if (!want) continue;
      this._hit(n, ev);
      return true;
    }
    // pass 2: the reach was honest - any note in the window takes it, so a
    // real repetition never reads as "not detected"
    for (const n of this._notes) {
      if (!n.live || n.missed) continue;
      if (n.progress < 0.80 || n.progress > 1.15) continue;
      this._hit(n, ev);
      return true;
    }
    return false;
  }

  _hit(n, ev) {
    n.live = false; n.orb.visible = false;
    this._notes.splice(this._notes.indexOf(n), 1);
    const p = this._notePos(n, this._tmp);

    // effort matched to the note's color = a richer burst, a warmer note;
    // timing near the zone's heart = the perfect strike
    const wantStrong = n.strong;
    const gaveStrong = ev.effort > 0.55;
    const matched = wantStrong === gaveStrong;
    const perfect = Math.abs(n.progress - 0.97) < 0.06;
    const burstN = perfect ? 62 : matched ? 46 : 26;
    this._bursts.burst(p, burstN, { speed: [0.25, matched ? 0.9 : 0.6], life: [0.4, 1.0], up: 0.35 });

    // the score: base, timing, matched effort, streak multiplier
    this._streak++;
    const pts = Math.round(100 * (perfect ? 1.5 : 1) * (matched ? 1.25 : 1) * this._mult);
    this._score += pts;
    this._levelHits++;
    this._hits++;

    // hits compose a little pentatonic melody; matched effort warms the timbre
    const walk = [0, 2, 3, 4, 3, 2, 1, 2];
    const pos = this._tmp.clone().add(ANCHOR);
    this.ctx.audio.bell(walk[this._melody % walk.length], 1,
      { gain: 0.22, warmth: matched && wantStrong ? 0.7 : perfect ? 0.4 : 0.15, pos });
    this._melody++;

    // the world literally brightens; a star joins the constellation
    this.ctx.world.brighten(perfect ? 0.14 : matched ? 0.10 : 0.06);
    if (this._streak % 5 === 0) this.ctx.world.brighten(0.15);
    if (this._starN < this._starMax) {
      const s = this._starSeeds[this._starN];
      this._starPos[this._starN * 3] = s[0];
      this._starPos[this._starN * 3 + 1] = s[1];
      this._starPos[this._starN * 3 + 2] = s[2];
      this._starN++;
      this._starGeo.setDrawRange(0, this._starN);
      this._starGeo.attributes.position.needsUpdate = true;
    }
    // level complete: the constellation blooms, then the next stair
    if (this._levelHits >= this._spec.goal && this._finaleAt < 0) this._finaleAt = this._t;
  }

  update(dt, snap, t) {
    this._t = t;
    const audio = this.ctx.audio;
    if (this._count.active) this._count.update(dt, this.ctx.world.camera);

    // ---- telemetry: detection + the effort halo ----------------------------
    this._detect(snap, dt);
    const effort = this._effort || 0;
    const warm = smoothstep(0.35, 0.8, effort);
    this.ctx.hand.halo(effort, warm, this._fatigue || 0);

    // the catch: reach the ball AND close the hand on it. Proximity alone is
    // not a grasp; a grasp far from the ball is not a catch. The effort
    // channel grades how strong and clean the grab was.
    const bareNow = this.ctx.hand.bareActive;
    if (bareNow) {
      const tipW = this.ctx.hand.tips.index;
      const palmW = this.ctx.hand.palm;
      const freshGrasp = this._lastGraspT !== undefined && (this._t - this._lastGraspT) < 0.45;
      for (let i = this._notes.length - 1; i >= 0; i--) {
        const n = this._notes[i];
        if (!n.live || n.missed) continue;
        if (n.progress < 0.68 || n.progress > 1.18) continue;
        this._notePos(n, this._tmp).add(ANCHOR);
        const near = this._tmp.distanceTo(tipW) < 0.11 || this._tmp.distanceTo(palmW) < 0.13;
        if (near && freshGrasp) {
          this._hit(n, { kind: n.kind, effort: this._lastGraspEffort ?? this._effort ?? 0.4, t: this._t });
          this._lastGraspT = -1e9;          // one grasp takes one ball
          break;
        }
      }
      this._events.length = 0;              // bare hands: the grasp-at-ball is the only path
    } else {
      // worn rig / preview: motion events in the timing window (the original
      // mechanic, driven by the joint encoders and the activation channel)
      for (const ev of this._events) this._tryHit(ev);
      this._events.length = 0;
    }

    // ---- notes travel on the beat ------------------------------------------
    const travelS = audio.beatSeconds * this._spec.travelBeats;
    for (let i = this._notes.length - 1; i >= 0; i--) {
      const n = this._notes[i];
      n.progress += dt / travelS;
      const p = this._notePos(n, this._tmp);
      n.orb.position.copy(p);
      const near = smoothstep(0.5, 0.95, n.progress);
      const b = 0.5 + 0.5 * Math.sin(t * 5 + n.lane);
      n.glow.material.opacity = 0.5 + near * 0.5;
      n.glow.scale.setScalar(0.045 + near * 0.03);
      n.core.material.opacity = 0.7 + near * 0.3;
      // the motion cue: close = ring contracts onto the orb; open = ring
      // expands away; pinch = twin cores instead of a ring
      if (n.kind === "close") {
        n.ring.material.opacity = 0.55 + near * 0.4;
        n.ring.scale.setScalar(lerp(0.085, 0.032, (t * 0.9 + n.lane * 0.3) % 1));
      } else if (n.kind === "open") {
        n.ring.material.opacity = 0.55 + near * 0.4;
        n.ring.scale.setScalar(lerp(0.032, 0.085, (t * 0.9 + n.lane * 0.3) % 1));
      } else {
        n.ring.material.opacity = 0.5 + 0.3 * b;
        n.ring.scale.setScalar(0.02);
        n.ring.position.x = Math.sin(t * 6) * 0.014;
      }
      // past the zone: it simply passes and dims; no punishment
      if (n.progress > 1.14 && !n.missed) { n.missed = true; this._streak = 0; }
      if (n.missed) {
        n.glow.material.opacity *= (1 - dt * 3);
        n.core.material.opacity *= (1 - dt * 3);
        n.ring.material.opacity *= (1 - dt * 3);
        if (n.progress > 1.5) { n.live = false; n.orb.visible = false; this._notes.splice(i, 1); }
      }
    }

    // ---- ambient life -------------------------------------------------------
    const zb = this._breath.at(t * 1.3);
    this._zone.material.opacity = 0.4 + zb * 0.18 + (this._streak > 0 ? 0.12 : 0);
    this._zone.scale.setScalar(1 + zb * 0.05);
    for (let i = 0; i < this._laneMats.length; i++) {
      this._laneMats[i].opacity = 0.3 + 0.15 * (0.5 + 0.5 * Math.sin(t * 0.8 + i * 2.1));
    }
    this._starMat.opacity = 0.6 + 0.3 * Math.sin(t * 0.7);
    this._bursts.update(dt);

    // ---- the score, counting up smoothly, with its quiet best beneath ------
    this._scoreShown += (this._score - this._scoreShown) * (1 - Math.exp(-dt * 6));
    if (this._score - this._scoreShown < 0.5) this._scoreShown = this._score;
    this._scoreUI.set(String(Math.round(this._scoreShown)));
    this._scoreUI.spr.material.opacity = this._running ? 1.0 : 0;
    const bestNow = Math.max(this._best, this._score);
    this._bestUI.set("best " + bestNow);
    this._bestUI.spr.material.opacity = this._running && bestNow > 0 ? 0.85 : 0;
    const m = this._mult;
    this._multUI.set(m > 1 ? "x" + (m % 1 ? m.toFixed(1) : m) : "");
    this._multUI.spr.material.opacity = this._running && m > 1 ? 1.0 : 0;

    // the level whisper breathes in, then lets go
    if (this._levelWordT >= 0) {
      this._levelWordT += dt;
      const wt = this._levelWordT;
      this._levelWordUI.material.opacity = wt < 0.6 ? wt / 0.6 * 1.0
        : wt < 2.4 ? 1.0 : Math.max(0, 1.0 - (wt - 2.4) * 1.4);
      if (wt > 3.2) this._levelWordT = -1;
    }

    // ---- level finale: the constellation blooms, then the next stair -------
    if (this._finaleAt >= 0) {
      const ft = t - this._finaleAt;
      if (ft < 0.05) {
        this.ctx.audio.resolve(null, { gain: 0.26 });
        this.ctx.world.brighten(0.4);
        this._saveBest();
      }
      this._starMat.size = 0.030 * (1 + Math.sin(Math.min(ft, 1.5) * Math.PI) * 1.2);
      if (ft > 3.2) {
        this._finaleAt = -1;
        this._interludeT = 0;
        this._starN = 0; this._starGeo.setDrawRange(0, 0);   // a fresh sky to earn
        this._startLevel(this._level + 1);
        this._showLevelWord(this._level);
      }
    }
    // the breath between levels: lanes rest, then the notes return
    if (this._interludeT >= 0) {
      this._interludeT += dt;
      if (this._interludeT > 2.0) this._interludeT = -1;
    }

    // ---- desktop hand: waits at the strike zone, meets the notes -----------
    if (!this.ctx.world.renderer.xr.isPresenting) {
      this._tmp.copy(ZONE).add(ANCHOR).add(new THREE.Vector3(0, 0.10, 0.04));
      this.ctx.hand.moveTo(this._tmp, 3);
    }
  }
}
