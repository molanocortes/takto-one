// sensorHand.js - the hand the SENSORS see, drawn as a CONSTELLATION.
//
// 2026-07-19 redesign (owner-directed): the wire armature is gone. No lines,
// no tubes, no smoked plate - they read as a debug rig against the Atelier.
// What we are actually trying to say with this object:
//   "the instrument sees your hand, and what it sees is made of light."
// So the hand is now stars and flowing stardust: a bright glint at every
// joint (the constellation), comet-dust streaming continuously from the palm
// out through each finger to the tip (the tendons of light - implied, never
// drawn), a soft nucleus at the palm carrying a fine instrument ring (the
// same ring language as the home/crown glyphs). Structure is completed by
// the eye; the motion makes it alive.
//
// The FK solver and every keypoint (palm, tips, knuckles) are unchanged -
// interaction and the modes ride on those, not on the visuals.

import * as THREE from "../../vendor/three.module.js";
import { AQUA, AQUA_DEEP, AQUA_HALO, OBSIDIAN } from "../design/palette.js";
import { clamp, Damped } from "../design/motion.js";
import { makeGlow, makeRingSprite, glowTexture, rng } from "./materials.js";

export const FINGERS = ["index", "middle", "ring", "pinky"];
export const SEGMENTS = ["mcp", "pip", "dip"];

// real-scale segment lengths [m] per finger
export const LENGTHS = {
  index:  [0.045, 0.028, 0.022],
  middle: [0.048, 0.030, 0.023],
  ring:   [0.044, 0.028, 0.021],
  pinky:  [0.036, 0.022, 0.018],
};
// metacarpal base offsets from the palm point [m] (x across, z toward fingers)
export const BASES = {
  index:  [-0.028, 0, -0.045],
  middle: [-0.009, 0, -0.048],
  ring:   [ 0.010, 0, -0.046],
  pinky:  [ 0.028, 0, -0.040],
};
const WRIST = [0, 0, 0.035];              // wrist point behind the palm centre
const D2R = Math.PI / 180;

// segment layout inside the keypoint buffer (see pose()):
//   0..4   palm loop (wrist -> 4 bases -> wrist)
//   5..16  fingers (3 segments each, base -> tip, in FINGERS order)
//   17..18 forearm (wrist -> mid -> elbow)
const N_SEG = 5 + FINGERS.length * 3 + 2;

// stardust budgets (single Points draw per family; trivial on Quest 3S)
const DUST_PER_FINGER = 18;               // flows along the whole 3-seg chain
const DUST_PALM = 16;                     // drifts around the palm loop
const DUST_FOREARM = 10;                  // fades down the forearm

export class SensorHand {
  constructor(parent, { scale = 1, tone = 1 } = {}) {
    this.scale = scale;
    this.tone = tone;                     // overall light multiplier
    this.group = new THREE.Group();
    parent.add(this.group);

    this.palm = new THREE.Vector3();      // world palm centre
    this.tips = { index: new THREE.Vector3(), middle: new THREE.Vector3(),
                  ring: new THREE.Vector3(), pinky: new THREE.Vector3() };
    this.knuckles = [];                   // world Vector3 list (mcp+pip per finger)
    for (let i = 0; i < 8; i++) this.knuckles.push(new THREE.Vector3());

    const s = scale;

    // ---- keypoint buffer: segment endpoints, data only (nothing renders it)
    this._segs = new Float32Array(N_SEG * 2 * 3);

    // ---- the constellation: a bright glint at every joint -----------------
    const mk = (size, color, op) => {
      const g = makeGlow(color, size, op, { depthTest: true });
      g.material.map = glowTexture(128, 0, 0.16);
      g.renderOrder = 6;
      this.group.add(g);
      return g;
    };
    this._tipGlints = {};
    for (const f of FINGERS) this._tipGlints[f] = mk(f === "index" ? 0.028 * s : 0.020 * s, AQUA_HALO, 1.0);
    this._kGlints = [];
    for (let i = 0; i < 8; i++) this._kGlints.push(mk(0.013 * s, AQUA_HALO, 0.9));
    this._baseGlints = [];
    for (let i = 0; i < 4; i++) this._baseGlints.push(mk(0.010 * s, AQUA, 0.75));
    this._wristGlint = mk(0.017 * s, AQUA_HALO, 0.9);
    this._elbowGlint = mk(0.011 * s, AQUA, 0.55);

    // ---- the nucleus: a soft palm glow + a fine instrument ring -----------
    // (the ring speaks the same language as the home / crown glyphs)
    this._palmGlow = mk(0.055 * s, AQUA, 0.5);
    this._ringFrame = new THREE.Group();
    this.group.add(this._ringFrame);
    this._palmRing = makeRingSprite(AQUA, 0.052 * s, 0.0);
    this._palmRing.rotation.x = -Math.PI / 2;
    this._ringFrame.add(this._palmRing);

    // ---- stardust: comet-dust flowing through the constellation -----------
    // one Points object per family so each keeps its own size and breath
    const dust = (n, color, size, opacity) => {
      const pos = new Float32Array(n * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        map: glowTexture(64), color, size: size * s, transparent: true,
        opacity, blending: THREE.AdditiveBlending, depthWrite: false,
        sizeAttenuation: true, toneMapped: false,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.renderOrder = 5;
      this.group.add(pts);
      return { pts, geo, mat, pos, n };
    };
    this._dustF = dust(DUST_PER_FINGER * FINGERS.length, AQUA_HALO, 0.0085, 0.9);
    this._dustP = dust(DUST_PALM, AQUA, 0.007, 0.5);
    this._dustA = dust(DUST_FOREARM, AQUA_DEEP, 0.0075, 0.38);
    // per-particle seeds: phase (where along the stream), rate, shimmer
    const seed = rng(97);
    const mkSeeds = (n) => {
      const ph = new Float32Array(n), rt = new Float32Array(n),
            sh = new Float32Array(n), so = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        ph[i] = seed();
        rt[i] = 0.55 + seed() * 0.7;      // flow speed multiplier
        sh[i] = 0.0016 + seed() * 0.0035; // shimmer amplitude [m]
        so[i] = seed() * Math.PI * 2;     // shimmer phase
      }
      return { ph, rt, sh, so };
    };
    this._seedF = mkSeeds(this._dustF.n);
    this._seedP = mkSeeds(this._dustP.n);
    this._seedA = mkSeeds(this._dustA.n);

    // damped joint angles [deg]
    this._angles = {};
    for (const f of FINGERS) for (const seg of SEGMENTS) {
      this._angles[`${f}_${seg}`] = new Damped(10, 0.075);
    }
    this._fq = new THREE.Quaternion();    // damped forearm orientation

    this._v = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._perp = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0.017);   // shimmer reference, never parallel
  }

  setVisible(v) { this.group.visible = v; }

  /**
   * Pose the armature.
   *  pos: world palm position (Vector3)
   *  quat: palm orientation (hand sensor)
   *  forearmQuat: forearm orientation (second sensor); optional
   *  anglesById: { index_mcp: deg, ... }; missing joints ease to a rest curl
   */
  pose(pos, quat, forearmQuat, anglesById, dt) {
    const s = this.scale;
    let li = 0;
    const L = this._segs;
    const put = (ax, ay, az, bx, by, bz) => {
      L[li++] = ax; L[li++] = ay; L[li++] = az;
      L[li++] = bx; L[li++] = by; L[li++] = bz;
    };

    this.palm.copy(pos);
    this._palmGlow.position.copy(pos);
    this._ringFrame.position.copy(pos);
    this._ringFrame.quaternion.copy(quat);

    // wrist + bases (palm loop)
    const wrist = this._v.set(WRIST[0] * s, WRIST[1] * s, WRIST[2] * s)
      .applyQuaternion(quat).add(pos);
    const wx = wrist.x, wy = wrist.y, wz = wrist.z;
    this._wristGlint.position.set(wx, wy, wz);
    const bx = [], by = [], bz = [];
    for (let i = 0; i < FINGERS.length; i++) {
      const b = BASES[FINGERS[i]];
      this._v.set(b[0] * s, b[1] * s, b[2] * s).applyQuaternion(quat).add(pos);
      bx.push(this._v.x); by.push(this._v.y); bz.push(this._v.z);
      this._baseGlints[i].position.copy(this._v);
    }
    put(wx, wy, wz, bx[0], by[0], bz[0]);
    for (let i = 0; i < 3; i++) put(bx[i], by[i], bz[i], bx[i + 1], by[i + 1], bz[i + 1]);
    put(bx[3], by[3], bz[3], wx, wy, wz);

    // fingers: FK from the damped joint angles
    let ki = 0;
    for (const f of FINGERS) {
      const fi = FINGERS.indexOf(f);
      let cum = 0;
      let px = bx[fi], py = by[fi], pz = bz[fi];
      for (let seg = 0; seg < 3; seg++) {
        const id = `${f}_${SEGMENTS[seg]}`;
        const target = anglesById && anglesById[id] !== undefined ? anglesById[id] : 12;
        const deg = this._angles[id].step(target, dt);
        cum += deg * D2R;
        this._dir.set(0, -Math.sin(cum), -Math.cos(cum)).applyQuaternion(quat);
        const len = LENGTHS[f][seg] * s;
        const nx = px + this._dir.x * len, ny = py + this._dir.y * len, nz = pz + this._dir.z * len;
        put(px, py, pz, nx, ny, nz);
        if (seg < 2) { this.knuckles[ki].set(nx, ny, nz); this._kGlints[ki].position.set(nx, ny, nz); ki++; }
        px = nx; py = ny; pz = nz;
      }
      this.tips[f].set(px, py, pz);
      this._tipGlints[f].position.set(px, py, pz);
    }

    // forearm: posed by ITS OWN sensor, sloping down and back from the wrist
    // (a giant keeps a modest forearm, or it becomes a pillar)
    if (forearmQuat) this._fq.slerp(forearmQuat, dt ? 1 - Math.exp(-dt * 6) : 1);
    const fl = 0.24 * Math.min(s, 1.3);
    this._dir.set(0, -0.38, 1).normalize().applyQuaternion(this._fq);
    const ex = wx + this._dir.x * fl, ey = wy + this._dir.y * fl, ez = wz + this._dir.z * fl;
    const mx = wx + this._dir.x * fl * 0.5, my = wy + this._dir.y * fl * 0.5, mz = wz + this._dir.z * fl * 0.5;
    put(wx, wy, wz, mx, my, mz);
    put(mx, my, mz, ex, ey, ez);
    this._elbowGlint.position.set(ex, ey, ez);
  }

  // place one dust particle at fraction f along the segment chain [i0..i1],
  // with a small shimmer offset perpendicular to the local direction
  _dustAt(out, o, i0, i1, f, shimmer, shPhase, t) {
    const L = this._segs;
    const nSeg = i1 - i0 + 1;
    const g = clamp(f, 0, 0.9999) * nSeg;
    const si = i0 + Math.floor(g);
    const fr = g - Math.floor(g);
    const a = si * 6;
    const ax = L[a], ay = L[a + 1], az = L[a + 2];
    const dx = L[a + 3] - ax, dy = L[a + 4] - ay, dz = L[a + 5] - az;
    this._dir.set(dx, dy, dz);
    this._perp.crossVectors(this._dir, this._up).normalize();
    const w = Math.sin(t * 2.1 + shPhase) * shimmer;
    out[o]     = ax + dx * fr + this._perp.x * w;
    out[o + 1] = ay + dy * fr + this._perp.y * w;
    out[o + 2] = az + dz * fr + this._perp.z * w;
  }

  // gentle whole-armature life: breathing light + the stardust streams.
  // Call each frame (the dust animates even when the pose holds still).
  update(t) {
    const br = 0.5 + 0.5 * Math.sin(t * 0.7);
    const k = this.tone;
    this._palmGlow.material.opacity = (0.4 + br * 0.15) * k;
    this._palmRing.material.opacity = (0.16 + br * 0.08) * k;
    this._ringFrame.rotation.y = t * 0.3;         // the instrument ring turns

    // fingers: dust flows base -> tip, reborn at the palm (comet stream)
    const F = this._dustF, sf = this._seedF;
    for (let fi = 0; fi < FINGERS.length; fi++) {
      const i0 = 5 + fi * 3;
      for (let i = 0; i < DUST_PER_FINGER; i++) {
        const pi = fi * DUST_PER_FINGER + i;
        const f = (sf.ph[pi] + t * 0.22 * sf.rt[pi]) % 1;
        this._dustAt(F.pos, pi * 3, i0, i0 + 2, f, sf.sh[pi], sf.so[pi], t);
      }
    }
    F.geo.attributes.position.needsUpdate = true;
    F.mat.opacity = (0.75 + br * 0.2) * k;

    // palm loop: slow drift around the ring of bases
    const P = this._dustP, sp = this._seedP;
    for (let i = 0; i < DUST_PALM; i++) {
      const f = (sp.ph[i] + t * 0.05 * sp.rt[i]) % 1;
      this._dustAt(P.pos, i * 3, 0, 4, f, sp.sh[i], sp.so[i], t);
    }
    P.geo.attributes.position.needsUpdate = true;
    P.mat.opacity = (0.4 + br * 0.12) * k;

    // forearm: sparse dust falling away toward the elbow
    const A = this._dustA, sa = this._seedA;
    for (let i = 0; i < DUST_FOREARM; i++) {
      const f = (sa.ph[i] + t * 0.10 * sa.rt[i]) % 1;
      this._dustAt(A.pos, i * 3, 17, 18, f, sa.sh[i], sa.so[i], t);
    }
    A.geo.attributes.position.needsUpdate = true;
    A.mat.opacity = (0.30 + br * 0.10) * k;
  }
}
