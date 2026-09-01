// handLink.js - the hand of light. In passthrough the REAL hand is the hero;
// this layer only dresses it: fingertip glows, a breathing palm halo (the
// effort meter), and a quality aura. In XR the light attaches to the headset's
// XRHand joints. On desktop (no headset) a kinematic light-rig posed by the
// device telemetry stands in, so every visual can be verified in the preview.
//
// The rig is 4 finger chains x 3 segments at real scale, posed from
// joints[].deg. It renders as points and threads of light, never as a mesh
// hand (AESTHETIC.md Section 2).

import * as THREE from "../../vendor/three.module.js";
import { AQUA, AQUA_DEEP, AQUA_HALO, AMBER, CANDLE } from "../design/palette.js";
import { clamp, lerp, Damped, Spring, Breath } from "../design/motion.js";
import { makeGlow, makeRingSprite, glowTexture, rng } from "./materials.js";
import { SensorHand, FINGERS } from "./sensorHand.js";

const _c1 = new THREE.Color(), _c2 = new THREE.Color();
const _fq = new THREE.Quaternion();
// (the old ?src=headset override is gone: since 2026-07-19 the tracked bare
// hand ALWAYS owns the pose when present - no forcing needed)

export class HandLight {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    // --- desktop rig state -------------------------------------------------
    this.restPos = new THREE.Vector3(0.13, 0.88, -0.22);
    this._pos = this.restPos.clone();
    this._target = this.restPos.clone();
    this._vel = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._quatT = new THREE.Quaternion();
    // base pose: palm pitched down so the fingers arc naturally toward the desk
    this._qBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.82, 0, 0));
    this._qEff = new THREE.Quaternion();

    // --- computed world-space keypoints (both XR and desktop paths fill these)
    this.tips = { index: new THREE.Vector3(), middle: new THREE.Vector3(),
                  ring: new THREE.Vector3(), pinky: new THREE.Vector3() };
    this.palm = new THREE.Vector3();
    this.tipVel = new THREE.Vector3();       // index tip velocity [m/s]
    this._lastTip = new THREE.Vector3();

    // --- visuals -------------------------------------------------------------
    // fingertip glows: index is the hero
    this._tipGlow = {};
    for (const f of FINGERS) {
      const hero = f === "index";
      const g = makeGlow(AQUA, hero ? 0.055 : 0.034, hero ? 0.85 : 0.5);
      this._tipGlow[f] = g;
      this.group.add(g);
    }
    // joint motes: bright points at each knuckle (XR: dress the real hand)
    this._jointGlow = [];
    for (let i = 0; i < 8; i++) {            // mcp + pip per finger (dip = tip)
      const g = makeGlow(AQUA_HALO, 0.014, 0.8);
      g.material.map = glowTexture(128, 0, 0.16);
      this._jointGlow.push(g);
      this.group.add(g);
    }
    // desktop: the coherent sensor-hand armature (forearm + palm + fingers)
    this._arm = new SensorHand(this.group, { scale: 1 });

    // palm halo: THE effort meter, and a favourite. A bracelet of star-points
    // rigidly attached to the hand's full pose (position AND orientation), so
    // it turns with the hand. Two pure-hue point sets crossfade (aqua gentle,
    // amber strong) so the blend stays luminous and never grays out.
    this.handQuat = new THREE.Quaternion();
    this._haloQuat = new THREE.Quaternion();
    this._haloFrame = new THREE.Group();
    this.group.add(this._haloFrame);
    const HN = this._haloN = 26;
    this._haloBase = [];                     // seeded local ring positions
    const hr = rng(53);
    for (let i = 0; i < HN; i++) {
      const a = (i / HN) * Math.PI * 2;
      this._haloBase.push([a, 0.96 + hr() * 0.08, (hr() - 0.5) * 0.008]);
    }
    const mkHaloPts = (color, size) => {
      const pos = new Float32Array(HN * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        map: glowTexture(64), color, size, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
        toneMapped: false,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.renderOrder = 6;
      this._haloFrame.add(pts);
      return { pts, mat, pos, geo };
    };
    this._haloAqua = mkHaloPts(AQUA, 0.013);
    this._haloAmber = mkHaloPts(AMBER, 0.011);
    this._haloSpin = 0;
    this._haloRipple = 0;
    this._haloInner = makeGlow(AQUA, 0.10, 0.0);
    this.group.add(this._haloInner);
    this._haloLevel = new Damped(0, 0.12);
    this._haloWarm = new Damped(0, 0.20);
    this._haloPulse = new Spring(0, 140, 16);
    this._haloOn = false;
    this._breath = new Breath(0.16);
    this._vitality = new Damped(1, 1.2);     // eases down with fatigue

    // quality aura: a fine orbit of light around the hand (CAPTURE)
    const N = this._auraN = 42;
    this._auraPos = new Float32Array(N * 3);
    this._auraPhase = new Float32Array(N);
    this._auraR = new Float32Array(N);
    this._auraY = new Float32Array(N);
    const r = rng(31);
    for (let i = 0; i < N; i++) {
      this._auraPhase[i] = r() * Math.PI * 2;
      this._auraR[i] = 0.085 + r() * 0.045;
      this._auraY[i] = (r() - 0.35) * 0.06;
    }
    const auraGeo = new THREE.BufferGeometry();
    auraGeo.setAttribute("position", new THREE.BufferAttribute(this._auraPos, 3));
    this._auraMat = new THREE.PointsMaterial({
      map: makeGlow().material.map, color: AQUA, size: 0.011,
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, sizeAttenuation: true,
    });
    this._aura = new THREE.Points(auraGeo, this._auraMat);
    this._aura.frustumCulled = false;
    this.group.add(this._aura);
    this._auraOn = false;
    this._auraCalm = new Damped(1, 0.5);     // 1 clean, 0 unsettled
    this._auraNoise = rng(77);

    this._t = 0;
  }

  // ---- mode-facing API ------------------------------------------------------

  // desktop: ease the hand root toward a point (springy, alive)
  moveTo(p, snappiness = 6) { this._target.copy(p); this._snap = snappiness; }
  rest() { this._target.copy(this.restPos); this._snap = 3; }

  // effort halo (RHYTHM): level 0..1, warm 0..1 (amber), fatigue 0..1
  setHalo(on) { this._haloOn = on; }
  halo(level, warm, fatigue = 0) {
    this._haloLevelT = clamp(level, 0, 1);
    this._haloWarmT = clamp(warm, 0, 1);
    this._vitalityT = 1 - clamp(fatigue, 0, 1) * 0.55;
  }
  pulseHalo() { this._haloPulse.x = 1; }

  // quality aura (CAPTURE): calm 0..1 (1 = clean take)
  setAura(on) { this._auraOn = on; }
  aura(calm) { this._auraCalmT = clamp(calm, 0, 1); }

  // fingertip contact bloom (TOUCH drives color + heat externally)
  tipBloom(finger, heat) {                   // heat 0..1: aqua -> candle
    const g = this._tipGlow[finger];
    if (!g) return;
    _c1.setHex(AQUA); _c2.setHex(CANDLE);
    g.material.color.copy(_c1.lerp(_c2, clamp(heat, 0, 1)));
    const hero = finger === "index";
    g.scale.setScalar((hero ? 0.055 : 0.034) * (1 + heat * 1.6));
    g.material.opacity = (hero ? 0.85 : 0.5) + heat * 0.15;
  }

  // ---- per-frame ------------------------------------------------------------
  update(dt, snap, xr) {
    this._t += dt;
    const t = this._t;

    // pose policy (2026-07-19, owner-directed): the REAL hand always wins.
    // When the headset tracks a bare hand, the light dresses IT - presence
    // and reach-interaction belong to the wearer, whatever the device is
    // streaming. The constellation stand-in poses from telemetry (or the
    // controller overlay) only when no bare hand is tracked: desktop, or
    // controllers in hand. deviceDriven stays a pure DATA flag for the
    // modes (is the device stream up), independent of who owns the pose.
    this.deviceDriven = !!(snap && snap.link && snap.link.device);
    let posed = false;
    if (xr && xr.hand && xr.hand.joints) {
      posed = this._poseFromXR(xr.hand);
      if (posed && xr.handedness) this.bareHandedness = xr.handedness;
    }
    if (!posed) this._poseFromTelemetry(dt, snap);
    this._deviceSignals(snap);

    // index tip velocity (for contact + vigor proxy)
    if (dt > 0) {
      this.tipVel.copy(this.tips.index).sub(this._lastTip).divideScalar(dt);
      this._lastTip.copy(this.tips.index);
    }

    this._placeVisuals(t, dt);
  }

  _poseFromXR(hand) {
    // dress the real hand: read tip + knuckle joints if the headset has them
    const j = hand.joints;
    const need = j["index-finger-tip"];
    if (!need || !need.position) return false;
    const get = (n, out) => { const jt = j[n]; if (jt) out.copy(jt.position); return !!jt; };
    get("index-finger-tip", this.tips.index);
    get("middle-finger-tip", this.tips.middle);
    get("ring-finger-tip", this.tips.ring);
    get("pinky-finger-tip", this.tips.pinky);
    get("wrist", this.palm);
    this.thumbTip = this.thumbTip || new THREE.Vector3();
    const hasThumb = get("thumb-tip", this.thumbTip);
    // knuckles for the joint motes
    this._xrKnuckles = this._xrKnuckles || [];
    const names = ["index-finger-phalanx-proximal", "index-finger-phalanx-intermediate",
      "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate",
      "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate",
      "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate"];
    this._xrKnuckles.length = 0;
    for (const n of names) { const jt = j[n]; if (jt) this._xrKnuckles.push(jt.position); }

    // ---- bare-hand flexion: no rig worn, the headset IS the joint sensor.
    // Tip-to-wrist distance per finger, normalized by an adaptive range, so
    // RHYTHM and TOUCH stay playable with nothing on the hand.
    this._bareRange = this._bareRange || {};
    this.bareFlexOf = this.bareFlexOf || {};
    let sum = 0, nf = 0;
    for (const f of FINGERS) {
      const d = this.tips[f].distanceTo(this.palm);
      const r = this._bareRange[f] || (this._bareRange[f] = { lo: d, hi: d });
      r.lo = Math.min(r.lo, d); r.hi = Math.max(r.hi, d);
      const span = r.hi - r.lo;
      // before the user has opened and closed once, read as mid
      const flex = span > 0.035 ? clamp(1 - (d - r.lo) / span, 0, 1) : 0.4;
      this.bareFlexOf[f] = flex;
      sum += flex; nf++;
    }
    this.bareFlex = nf ? sum / nf : null;
    this.barePinch = hasThumb ? this.thumbTip.distanceTo(this.tips.index) : null;
    this.bareActive = true;

    // ---- TRUE per-joint angles for the digital twin: measured from the
    // headset's actual joint positions, per finger, per joint - no adaptive
    // range, no crosstalk between fingers.
    this.bareAngles = this.bareAngles || {};
    this._bA = this._bA || [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const jointAngleDeg = (a, b, c) => {
      // the bend AT b between bones a->b and b->c
      this._bA[0].copy(b.position).sub(a.position).normalize();
      this._bA[1].copy(c.position).sub(b.position).normalize();
      const d = clamp(this._bA[0].dot(this._bA[1]), -1, 1);
      return Math.acos(d) * 180 / Math.PI;
    };
    // palm normal (dorsal) for the per-finger frames: forward = the middle
    // metacarpal bone, lateral = pinky knuckle -> index knuckle (toward the
    // thumb side), normal completes the right-handed set
    this._bF = this._bF || [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
      new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const [fwd, lat, nrm, zf, yf, xf] = this._bF;
    let palmFrame = false;
    {
      const mm = j["middle-finger-metacarpal"], mp = j["middle-finger-phalanx-proximal"];
      const ip = j["index-finger-phalanx-proximal"], kp = j["pinky-finger-phalanx-proximal"];
      if (mm && mp && ip && kp) {
        fwd.copy(mp.position).sub(mm.position).normalize();
        lat.copy(ip.position).sub(kp.position).normalize();
        nrm.crossVectors(fwd, lat).normalize();
        palmFrame = true;
      }
    }
    // The device's MCP is a two-hinge chain: abduction about the palm normal,
    // then flexion about the lateral axle. Measure the SAME decomposition on
    // the real hand: express the proximal phalanx in its own metacarpal frame
    // (z = metacarpal bone, y = dorsal normal, x = y×z toward the thumb) and
    // split p = Ry(abd)·Rx(flex)·z into the two signed angles. No crosstalk:
    // pure spread reads as abduction only, pure curl as flexion only.
    const p = this._bA[2];
    const mcpTwoDof = (meta, prox, mid) => {
      zf.copy(prox.position).sub(meta.position).normalize();
      yf.copy(nrm).addScaledVector(zf, -nrm.dot(zf)).normalize();
      xf.crossVectors(yf, zf);
      p.copy(mid.position).sub(prox.position).normalize();
      const px = p.dot(xf), py = p.dot(yf), pz = p.dot(zf);
      const flex = Math.atan2(-py, Math.hypot(px, pz)) * 180 / Math.PI;
      // abduction ROM (and the measurement's conditioning) collapses as the
      // finger curls; fade it with cos(flex) instead of letting it jitter
      const abd = Math.atan2(px, pz) * 180 / Math.PI * Math.max(0, Math.cos(flex * Math.PI / 180));
      return [flex, abd];
    };
    for (const f of FINGERS) {
      const meta = j[`${f}-finger-metacarpal`];
      const prox = j[`${f}-finger-phalanx-proximal`];
      const mid = j[`${f}-finger-phalanx-intermediate`];
      const dist = j[`${f}-finger-phalanx-distal`];
      const tip = j[`${f}-finger-tip`];
      if (meta && prox && mid && dist && tip && palmFrame) {
        const [flex, abd] = mcpTwoDof(meta, prox, mid);
        this.bareAngles[`${f}_mcp`] = flex;                        // signed MCP flexion
        this.bareAngles[`${f}_abd`] = abd;                         // signed MCP abduction
        this.bareAngles[`${f}_pip`] = jointAngleDeg(prox, mid, dist);
        this.bareAngles[`${f}_dip`] = jointAngleDeg(mid, dist, tip);
      } else {
        delete this.bareAngles[`${f}_mcp`];
        delete this.bareAngles[`${f}_abd`];
      }
    }
    // the thumb (metacarpal, proximal, distal, tip -> two measured bends)
    {
      const meta = j["thumb-metacarpal"];
      const prox = j["thumb-phalanx-proximal"];
      const dist = j["thumb-phalanx-distal"];
      const tip = j["thumb-tip"];
      if (meta && prox && dist && tip) {
        this.bareAngles.thumb_mcp = jointAngleDeg(meta, prox, dist);
        this.bareAngles.thumb_ip = jointAngleDeg(prox, dist, tip);
      }
    }

    // the hand's full pose: the wrist orientation carries the halo
    const wrist = j["wrist"];
    if (wrist && wrist.quaternion) this.handQuat.copy(wrist.quaternion);

    this._xrPosed = true;
    return true;
  }

  _poseFromTelemetry(dt, snap) {
    this._xrPosed = false;
    this.bareActive = false;
    this.bareFlex = null;
    // root eases toward the mode's target
    const k = 1 - Math.exp(-dt * (this._snap || 4));
    this._pos.lerp(this._target, k);

    // orientation from the hand IMU, damped and kept subtle, over the base pose
    if (snap && snap.hand && snap.hand.quat) {
      const q = snap.hand.quat;
      this._quatT.set(q[1], q[2], q[3], q[0]);   // wire is [w,x,y,z]
      this._quat.slerp(this._quatT, 1 - Math.exp(-dt * 6));
    }
    this._qEff.copy(this._quat).multiply(this._qBase);
    this.handQuat.copy(this._qEff);

    // the coherent sensor-hand: forearm sensor + hand sensor + joint encoders
    const byId = {};
    if (snap && snap.joints) for (const jj of snap.joints) byId[jj.id] = jj.deg;
    if (snap && snap.forearm && snap.forearm.quat) {
      const q = snap.forearm.quat;
      _fq.set(q[1], q[2], q[3], q[0]);       // its own sensor, its own frame
    } else _fq.identity();
    this._arm.setVisible(true);
    this._arm.pose(this._pos, this._qEff, _fq, byId, dt);
    this.palm.copy(this._arm.palm);
    for (const f of FINGERS) this.tips[f].copy(this._arm.tips[f]);
  }

  // device-derived flexion in [0,1] for the modes (single source of truth):
  // middle_pip is the live MCP-flexion channel, deg 8 -> 0 .. 62 -> 1.
  // Fallback: mean of any ok flexion (*_pip) channel. Computed EVERY frame
  // from the stream (not only on the telemetry pose path), so capture's
  // grip ritual keeps working while a bare hand owns the pose.
  _deviceSignals(snap) {
    let flexDeg = null;
    if (snap && snap.joints) {
      let sum = 0, n = 0;
      for (const jj of snap.joints) {
        if (jj.id === "middle_pip" && jj.ok) { flexDeg = jj.deg; break; }
        if (jj.ok && jj.id.endsWith("_pip")) { sum += jj.deg; n++; }
      }
      if (flexDeg === null && n) flexDeg = sum / n;
    }
    this.deviceFlex = flexDeg === null ? 0 : clamp((flexDeg - 8) / (62 - 8), 0, 1);
    this.deviceGrip = this.deviceFlex > 0.6;
  }

  _placeVisuals(t, dt) {
    // fingertip lights follow the keypoints (contact bloom language)
    for (const f of FINGERS) this._tipGlow[f].position.copy(this.tips[f]);
    // knuckle motes dress the REAL hand in XR; on desktop the armature
    // carries its own joints
    if (this._xrPosed) {
      this._arm.setVisible(false);
      const kn = this._xrKnuckles;
      for (let i = 0; i < this._jointGlow.length; i++) {
        const g = this._jointGlow[i];
        if (kn && kn[i]) { g.visible = true; g.position.copy(kn[i]); }
        else g.visible = false;
      }
    } else {
      for (const g of this._jointGlow) g.visible = false;
      this._arm.update(t);
    }

    // ---- halo: a bracelet of stars carried by the hand's full pose --------
    const lv = this._haloLevel.step(this._haloLevelT || 0, dt);
    const warm = this._haloWarm.step(this._haloWarmT || 0, dt);
    const vit = this._vitality.step(this._vitalityT ?? 1, dt);
    this._haloPulse.step(dt); this._haloPulse.to(0);
    const pulse = clamp(this._haloPulse.x, 0, 1.4);
    const breathe = this._breath.at(t * vit) * 0.05 * vit;
    const on = this._haloOn ? 1 : 0;

    // rigid attachment: position AND orientation follow the hand
    this._haloFrame.position.copy(this.palm);
    this._haloQuat.slerp(this.handQuat, 1 - Math.exp(-dt * 14));
    this._haloFrame.quaternion.copy(this._haloQuat);

    // life: a slow spin about the palm normal, quickened by effort; a ripple
    // that runs around the bracelet at each pulse
    this._haloSpin += dt * (0.35 + lv * 1.2) * vit;
    this._haloRipple += dt * 7;
    const R = (0.062 + lv * 0.035 + pulse * 0.02 + breathe);
    const aq = this._haloAqua.pos, am = this._haloAmber.pos;
    for (let i = 0; i < this._haloN; i++) {
      const [a0, rj, yj] = this._haloBase[i];
      const a = a0 + this._haloSpin;
      const ripple = 1 + pulse * 0.22 * Math.sin(a0 * 3 + this._haloRipple)
        + 0.05 * Math.sin(t * 1.7 + a0 * 2);
      const r = R * rj * ripple;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y = yj + Math.sin(t * 2.1 + a0 * 4) * 0.004;
      aq[i * 3] = x; aq[i * 3 + 1] = y; aq[i * 3 + 2] = z;
      am[i * 3] = x * 1.04; am[i * 3 + 1] = y - 0.003; am[i * 3 + 2] = z * 1.04;
    }
    this._haloAqua.geo.attributes.position.needsUpdate = true;
    this._haloAmber.geo.attributes.position.needsUpdate = true;
    const base = on * (0.6 + lv * 0.4 + pulse * 0.3) * (0.55 + 0.45 * vit);
    this._haloAqua.mat.opacity = base * (1 - warm * 0.85);
    this._haloAmber.mat.opacity = base * warm;
    this._haloAqua.mat.size = 0.015 + pulse * 0.005;
    this._haloAmber.mat.size = 0.013 + pulse * 0.005;

    this._haloInner.position.copy(this.palm);
    this._haloInner.scale.setScalar((0.07 + lv * 0.04 + pulse * 0.025 + breathe) * 0.75);
    _c1.setHex(AQUA); _c2.setHex(CANDLE);
    this._haloInner.material.color.copy(_c1.lerp(_c2, warm));
    this._haloInner.material.opacity = on * (0.07 + lv * 0.24 + pulse * 0.18) * vit;

    // ---- aura -------------------------------------------------------------
    const calm = this._auraCalm.step(this._auraCalmT ?? 1, dt);
    const targetOp = this._auraOn ? (0.30 + 0.35 * calm) : 0;
    this._auraMat.opacity += (targetOp - this._auraMat.opacity) * (1 - Math.exp(-dt * 4));
    if (this._auraMat.opacity > 0.01) {
      const unrest = 1 - calm;
      const speed = 0.55 + unrest * 2.4;
      for (let i = 0; i < this._auraN; i++) {
        const ph = this._auraPhase[i] + t * speed * (0.5 + (i % 5) * 0.18);
        const jitter = unrest * 0.016;
        const rr = this._auraR[i] + Math.sin(t * 7 + i * 2.3) * jitter;
        this._auraPos[i * 3] = this.palm.x + Math.cos(ph) * rr + (this._auraNoise() - 0.5) * jitter;
        this._auraPos[i * 3 + 1] = this.palm.y + this._auraY[i] + Math.sin(t * 0.9 + i) * 0.012
          + (this._auraNoise() - 0.5) * jitter;
        this._auraPos[i * 3 + 2] = this.palm.z + Math.sin(ph) * rr + (this._auraNoise() - 0.5) * jitter;
      }
      this._aura.geometry.attributes.position.needsUpdate = true;
      _c1.setHex(AQUA); _c2.setHex(0x4d7a90);       // cooled, dimmed when unsettled
      this._auraMat.color.copy(_c1.lerp(_c2, 1 - calm));
      this._aura.visible = true;
    } else this._aura.visible = false;
  }
}
