// touch.js - kinesthetic rendering, the jewel. Two luminous objects rest on
// the real desk: a soft orb that yields and a hard crystal key that stops the
// finger. The app never sends force: on contact it latches a wall descriptor
// (x_wall_deg, K, B) and streams it at ~55 Hz; the passivity-guarded loop
// below the network renders the feel. The look is computed from the SAME
// telemetry the wall produces, so what the eye sees and the finger feels is
// one surface.
//
// S4 physics pass: contact is found by sweeping the fingertip's path against
// a signed-distance surface (exact point, exact moment); the soft orb is a
// deformable body with a pressed dimple, a volume-preserving bulge, a lagging
// contact drag, and two damped wobble modes that ring on release; the hard
// key answers with a rigid shimmer that never yields by a single millimetre.

import * as THREE from "../../vendor/three.module.js";
import { Mode, tagRoot, keyOf } from "./common.js";
import { loadObject, glassSkin } from "../world/objects.js";
import { makeGlow, makeRingSprite, makeShadowPool, makeStageDisc, fresnelShell, glowTexture, MoteField, BurstPool } from "../world/materials.js";
import { AQUA, AQUA_DEEP, AQUA_HALO, AMBER, CANDLE } from "../design/palette.js";
import { clamp, lerp, smoothstep, Breath, Damped } from "../design/motion.js";

const ANCHOR = new THREE.Vector3(0, 0.75, -0.55);

// stiffness palette [N m/rad] (MODE_3_TOUCH.md); B in N m s/rad
const SOFT = { K: 0.08, B: 0.015 };
const HARD = { K: 2.5, B: 0.02 };
const F_MAX_MA = 80;

// visual scales
const DIMPLE_M_PER_DEG = 0.00042;    // soft surface yield per degree of penetration
const WALL_SEND_MS = 18;             // ~55 Hz descriptor stream

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

// a damped oscillator mode for the soft body's ring-down
class Wobble {
  constructor(hz, decay) { this.w = hz * Math.PI * 2; this.decay = decay; this.amp = 0; this.ph = 0; }
  kick(a) { this.amp = Math.min(0.02, this.amp + a); this.ph = 0; }
  step(dt) { this.ph += this.w * dt; this.amp *= Math.exp(-this.decay * dt); return this.amp * Math.sin(this.ph); }
  get live() { return this.amp > 1e-5; }
}

export class Touch extends Mode {
  constructor(ctx) {
    super(ctx);
    this.group.position.copy(ANCHOR);
    this._objects = [];
    this._active = null;                // the object being approached (desktop)
    this._contact = null;               // { obj, xWallDeg, point (local), normal (local) }
    this._wallTimer = null;
    this._breath = new Breath(0.12);
    this._dimpleDepth = new Damped(0, 0.05);
    this._dragPt = new THREE.Vector3(); // lagging contact point (local, on surface)
    this._prevTip = new THREE.Vector3();
    this._tipLocal = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._built = false;
    this._build();
  }

  async _build() {
    const g = this.group;

    // ---- the soft orb: a deformable luminous body --------------------------
    const R = 0.052;
    const softGeo = new THREE.SphereGeometry(R, 48, 34);
    const softBody = glassSkin({ emissiveIntensity: 0.03 });
    const soft = new THREE.Mesh(softGeo, softBody);
    const softBase = Float32Array.from(softGeo.attributes.position.array);
    const { shell: softShell, mat: softShellMat } = fresnelShell(soft, { intensity: 1.2 });
    soft.add(softShell);
    const softCore = makeGlow(AQUA, R * 1.35, 0.55, { depthTest: false });
    softCore.material.map = glowTexture(128, 0, 0.13);
    softCore.renderOrder = 6;
    const softGlint = makeGlow(AQUA_HALO, 0.006, 0.85, { depthTest: false });
    softGlint.renderOrder = 7;
    softGlint.position.set(R * 0.45, R * 0.6, R * 0.5);
    const softPivot = new THREE.Group();
    softPivot.position.set(-0.17, R + 0.012, 0.10);
    softPivot.add(soft, softCore, softGlint);
    g.add(softPivot);
    const softStage = makeStageDisc(R * 3.4);
    softStage.position.set(softPivot.position.x, 0.001, softPivot.position.z);
    g.add(softStage);
    const softPool = makeShadowPool(R * 2.0);
    softPool.position.set(softPivot.position.x, 0.0022, softPivot.position.z);
    g.add(softPool);

    this._objects.push({
      kind: "soft", pivot: softPivot, mesh: soft, base: softBase,
      body: softBody, shell: softShellMat, core: softCore,
      radius: R, wall: SOFT, wake: 0, breath: new Breath(0.14, 0.2),
      baseY: softPivot.position.y,
      // physics state
      wob1: new Wobble(8.2, 4.2),        // radial breathing ring-down
      wob2: new Wobble(5.4, 3.0),        // slosh along the press axis
      deformed: false,
      // sphere signed distance
      sdf(p, out) {
        const len = p.length();
        out.copy(p).multiplyScalar(len > 1e-6 ? 1 / len : 0);
        return len - this.radius;
      },
    });

    // ---- the hard crystal key: rigid, adamant ------------------------------
    const hard = await loadObject("glass_key", { size: 0.105, sit: "base" });
    const hardPivot = new THREE.Group();
    hardPivot.position.set(0.17, 0.012, 0.06);
    hardPivot.add(hard.group);
    g.add(hardPivot);
    const hardStage = makeStageDisc(0.17);
    hardStage.position.set(hardPivot.position.x, 0.001, hardPivot.position.z);
    g.add(hardStage);
    const hardPool = makeShadowPool(0.10);
    hardPool.position.set(hardPivot.position.x, 0.0022, hardPivot.position.z);
    g.add(hardPool);
    // crisp highlight ring for hard contact
    const hardRing = makeRingSprite(AQUA_HALO, 0.03, 0);
    hardRing.material.depthTest = false;
    hardRing.renderOrder = 7;
    g.add(hardRing);

    this._objects.push({
      kind: "hard", pivot: hardPivot, meshRoot: hard.group,
      body: hard.body, shells: hard.shells, accents: hard.accents,
      contactRing: hardRing,
      wall: HARD, wake: 0, breath: new Breath(0.14, 0.6),
      baseY: hardPivot.position.y,
      shimmer: new Wobble(14, 9),        // the rigid answer: light, not motion
      // rounded-cap SDF: the key cap is a rounded vertical cylinder
      capR: 0.036, capTop: 0.052, edgeR: 0.010,
      radius: 0.05,                       // coarse wake radius only
      sdf(p, out) {
        // local: y up from the key base; cap occupies y in [0, capTop]
        const rxz = Math.hypot(p.x, p.z);
        const qx = rxz - (this.capR - this.edgeR);
        const qy = p.y - (this.capTop - this.edgeR);
        const qx2 = Math.max(qx, 0), qy2 = Math.max(qy, 0);
        const d = Math.hypot(qx2, qy2) + Math.min(Math.max(qx, qy), 0) - this.edgeR;
        // gradient (numeric in the rz-plane, exact enough for the normal)
        const nx = rxz > 1e-6 ? p.x / rxz : 0, nz = rxz > 1e-6 ? p.z / rxz : 0;
        if (qx2 > 0 && qy2 > 0) {
          const inv = 1 / Math.max(1e-6, Math.hypot(qx2, qy2));
          out.set(nx * qx2 * inv, qy2 * inv, nz * qx2 * inv);
        } else if (qx > qy) out.set(nx, 0, nz);
        else out.set(0, 1, 0);
        return d;
      },
    });

    // fingertip contact light (world-space, follows the tip at contact)
    this._tipFlare = makeGlow(CANDLE, 0.05, 0, { depthTest: false });
    this._tipFlare.renderOrder = 8;
    this.ctx.world.scene.add(this._tipFlare);

    // the stopped-tip light: where the surface holds the finger (bare hands
    // pass through physically; this light stays pinned at the surface, so the
    // stop is seen exactly where it is felt)
    this._stopGlint = makeGlow(AQUA_HALO, 0.014, 0, { depthTest: false });
    this._stopGlint.renderOrder = 8;
    g.add(this._stopGlint);

    this._bursts = new BurstPool({ max: 200, seed: 13 });
    g.add(this._bursts.points);

    this._motes = new MoteField({ count: 34, radius: 0.45, center: new THREE.Vector3(0, 0.2, 0.05), size: 0.020, seed: 29, ySpan: [0.04, 0.4] });
    this._motes.opacity = 0.9;
    g.add(this._motes.points);

    tagRoot(softPivot, "obj:0");
    tagRoot(hardPivot, "obj:1");
    this.interactives.push(softPivot, hardPivot);

    this._built = true;
    this._active = this._objects[0];
  }

  enter() {
    super.enter();
    this.ctx.audio.setBedLevel(0.65, 3.0);
    this.ctx.tele.send({ cmd: "feedback", on: true });
    this._wallTimer = setInterval(() => this._streamWall(), WALL_SEND_MS);
  }

  exit() {
    super.exit();
    if (this._wallTimer) { clearInterval(this._wallTimer); this._wallTimer = null; }
    this._releaseContact(true);
    this.ctx.tele.send({ cmd: "walls", walls: [] });
    this.ctx.tele.send({ cmd: "feedback", on: false });
    this.ctx.hand.setHalo(false);
    if (this._tipFlare) this._tipFlare.material.opacity = 0;
    this._stopGlint.material.opacity = 0;
  }

  _streamWall() {
    if (!this._contact) return;
    this.ctx.tele.send({
      cmd: "walls",
      walls: [{
        joint: "index_drive",
        x_wall_deg: +this._contact.xWallDeg.toFixed(2),
        K: this._contact.obj.wall.K,
        B: this._contact.obj.wall.B,
        f_max_ma: F_MAX_MA,
      }],
    });
  }

  _indexDeg(snap) {
    if (!snap || !snap.joints) return 10;
    const j = snap.joints.find(x => x.id === "index_pip");   // MCP flexion channel
    if (j && j.ok) return j.deg;
    // bench: only the middle finger is instrumented; use its flexion channel
    // TODO(device-XR): in immersive AR with the device driving, reach is still
    // desktop-style (flex presses through the wall); spatial reach from the
    // anchored rig could replace it later.
    const m = snap.joints.find(x => x.id === "middle_pip");
    if (m && m.ok) return m.deg;
    return j ? j.deg : 10;
  }

  // tip position in an object's local frame
  _toLocal(worldPt, obj, out) {
    return out.copy(worldPt).sub(ANCHOR).sub(obj.pivot.position);
  }

  // swept contact: walk the tip's path this frame against the SDF and refine
  // by bisection, so the touch moment and point are exact, not "close enough"
  _sweep(obj, prevTip, tip) {
    const a = this._toLocal(prevTip, obj, _v1);
    const b = this._toLocal(tip, obj, _v2);
    const n = _v3;
    if (obj.sdf(a, n) <= 0) return { point: a.clone(), t: 0 };      // started inside
    const STEPS = 6;
    let lo = 0, hi = -1;
    for (let i = 1; i <= STEPS; i++) {
      const u = i / STEPS;
      _v3.lerpVectors(a, b, u);
      if (obj.sdf(_v3, this._tmp2) <= 0) { hi = u; lo = (i - 1) / STEPS; break; }
    }
    if (hi < 0) return null;
    for (let k = 0; k < 5; k++) {                                    // bisection
      const mid = (lo + hi) / 2;
      _v3.lerpVectors(a, b, mid);
      if (obj.sdf(_v3, this._tmp2) <= 0) hi = mid; else lo = mid;
    }
    _v3.lerpVectors(a, b, hi);
    return { point: _v3.clone(), t: hi };
  }

  _beginContact(obj, contactLocal, snap) {
    const xw = this._indexDeg(snap);
    const normal = new THREE.Vector3();
    obj.sdf(contactLocal, normal);
    this._contact = { obj, xWallDeg: xw, point: contactLocal.clone(), normal };
    this._dragPt.copy(contactLocal);
    this._streamWall();
    // the sound of the material, from where it was touched
    const pos = this._tmp2.copy(contactLocal).add(obj.pivot.position).add(ANCHOR);
    if (obj.kind === "hard") {
      this.ctx.audio.tak(pos);
      obj.shimmer.kick(1.0);
      if (obj.contactRing) {
        obj.contactRing.position.copy(contactLocal).add(obj.pivot.position);
        obj.contactRing.material.opacity = 0.95;
        obj.contactRing.scale.setScalar(0.010);
      }
    } else {
      this.ctx.audio.thum(pos, 0.25);
      obj.wob1.kick(0.0016); obj.wob2.kick(0.0022);
    }
    // the stop light pins to the surface at the exact point
    this._stopGlint.position.copy(contactLocal).add(obj.pivot.position);
    this._stopGlint.material.opacity = 0.9;
  }

  _releaseContact(silent = false) {
    if (!this._contact) return;
    const obj = this._contact.obj;
    if (obj.kind === "soft" && !silent) {
      // the body rings down from however deep it was pressed
      obj.wob1.kick(this._dimpleDepth.x * 0.55);
      obj.wob2.kick(this._dimpleDepth.x * 0.85);
    }
    this._contact = null;
    this.ctx.tele.send({ cmd: "walls", walls: [] });
    if (!silent) this.ctx.audio.bell(3, 0, { gain: 0.10 });
  }

  // deform the soft orb: dimple at the (lagging) contact point, a volume
  // bulge around it, and the wobble modes' ring-down
  _deformSoft(obj, contactLocal, depth, dt) {
    const pos = obj.mesh.geometry.attributes.position;
    const base = obj.base;
    const R = obj.radius;
    const w1 = obj.wob1.step(dt);
    const w2 = obj.wob2.step(dt);
    const active = depth > 1e-5 || obj.wob1.live || obj.wob2.live;
    if (!active) {
      if (obj.deformed) {                       // settle exactly back to rest
        pos.array.set(base);
        pos.needsUpdate = true;
        obj.mesh.geometry.computeVertexNormals();
        obj.deformed = false;
      }
      return;
    }

    const n = _v1.copy(contactLocal).normalize();
    const falloff = R * 1.12;
    for (let i = 0; i < pos.count; i++) {
      const bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2];
      const bl = Math.hypot(bx, by, bz);
      const rx = bx / bl, ry = by / bl, rz = bz / bl;          // radial dir
      const d = Math.hypot(bx - contactLocal.x, by - contactLocal.y, bz - contactLocal.z);
      const w = d < falloff ? Math.pow(1 - d / falloff, 2) : 0;
      // volume bulge: a raised ring just outside the dimple
      const ring = Math.exp(-Math.pow((d - falloff * 0.6) / (falloff * 0.20), 2));
      const cosT = rx * n.x + ry * n.y + rz * n.z;             // slosh weight
      const off = -depth * w                                    // pressed in
        + depth * 0.5 * ring                                    // pushed out
        + w1                                                    // breathing mode
        + w2 * cosT;                                            // slosh mode
      pos.array[i * 3] = bx + rx * off;
      pos.array[i * 3 + 1] = by + ry * off;
      pos.array[i * 3 + 2] = bz + rz * off;
    }
    pos.needsUpdate = true;
    obj.mesh.geometry.computeVertexNormals();
    obj.deformed = active;
  }

  update(dt, snap, t) {
    if (!this._built) return;
    const hand = this.ctx.hand;
    const deg = this._indexDeg(snap);
    const act = snap && snap.actuators && snap.actuators[0] ? snap.actuators[0] : null;
    const currentMa = act ? act.current_ma : 0;
    const wallLive = act && act.feedback_mode === "wall";
    const bare = hand.bareActive;

    // ---- desktop: the hand approaches the active object, driven by the
    // sensed joint angle, so when the mock pins the finger the hand stops ----
    if (!this.ctx.world.renderer.xr.isPresenting && this._active) {
      const obj = this._active;
      const surface = this._tmp.copy(obj.pivot.position).add(ANCHOR);
      surface.y += obj.kind === "soft" ? obj.radius * 0.4 : 0.055;
      const start = this._tmp2.set(surface.x * 0.35, surface.y + 0.16, surface.z + 0.24);
      const degClamped = this._contact ? Math.min(deg, this._contact.xWallDeg) : deg;
      const travel = clamp((degClamped - 8) / 22, 0, 1);
      const p = start.lerp(surface, travel);
      if (this._contact && this._contact.obj.kind === "soft") {
        p.y -= this._dimpleDepth.x * 0.5;
      }
      p.add(this._tmp.copy(hand.palm).sub(hand.tips.index).multiplyScalar(0.92));
      hand.moveTo(p, 8);
    }

    const tip = hand.tips.index;

    // ---- per-object: wake with proximity, glow, breathe -------------------
    let newContact = null;
    for (const obj of this._objects) {
      this._toLocal(tip, obj, this._tipLocal);
      const dist = obj.sdf(this._tipLocal, this._tmp2);
      obj._dist = dist;

      const wake = smoothstep(0.10, 0.012, dist);
      obj.wake += (wake - obj.wake) * (1 - Math.exp(-dt * 8));
      const br = obj.breath.at(t);

      if (obj.kind === "soft") {
        obj.body.emissiveIntensity = 0.02 + br * 0.02 + obj.wake * 0.16;
        obj.shell.uniforms.uIntensity.value = 1.1 + br * 0.25 + obj.wake * 1.0;
        obj.core.material.opacity = 0.45 + br * 0.12 + obj.wake * 0.4;
        obj.core.scale.setScalar(obj.radius * (1.25 + br * 0.1 + obj.wake * 0.45));
        obj.pivot.position.y = obj.baseY + br * 0.004;
      } else {
        const sh = obj.shimmer.step(dt);                 // the rigid answer
        const flick = Math.abs(sh) * 40;
        obj.body.emissiveIntensity = 0.02 + br * 0.02 + obj.wake * 0.18 + flick;
        if (obj.shells) for (const s of obj.shells) s.uniforms.uIntensity.value = 1.1 + br * 0.2 + obj.wake * 1.0 + flick * 1.6;
        if (obj.accents) for (const a of obj.accents) a.opacity = 0.45 + br * 0.15 + obj.wake * 0.45 + flick * 1.2;
      }

      // swept, exact contact (only when free; a teleporting tip is not a touch)
      if (!this._contact && !newContact && this._prevTip.distanceToSquared(tip) < 0.04) {
        const hit = this._sweep(obj, this._prevTip, tip);
        if (hit) newContact = { obj, point: hit.point };
      }
    }

    // ---- contact lifecycle -------------------------------------------------
    if (newContact) this._beginContact(newContact.obj, newContact.point, snap);
    if (this._contact) {
      const obj = this._contact.obj;
      const released = bare ? (obj._dist > 0.012) : (deg < this._contact.xWallDeg - 2.5);
      if (released) {
        this._releaseContact();
      } else {
        // penetration: joint past the latched wall (worn) or the real
        // fingertip past the surface (bare)
        const penDeg = Math.max(0, deg - this._contact.xWallDeg);
        const geomPen = Math.max(0, -obj._dist);
        const depth = obj.kind === "soft"
          ? (bare ? Math.min(geomPen * 0.85, 0.026) : penDeg * DIMPLE_M_PER_DEG)
          : 0;
        this._dimpleDepth.step(depth, dt);

        const heat = bare ? clamp(geomPen / 0.02, 0, 1) : clamp(currentMa / F_MAX_MA, 0, 1);
        hand.tipBloom("index", 0.3 + heat * 0.7);
        this._tipFlare.position.copy(tip);
        this._tipFlare.material.opacity = 0.35 + heat * 0.55;
        this._tipFlare.scale.setScalar(0.035 + heat * 0.045);

        if (obj.kind === "soft") {
          // the contact point drags toward the fingertip with a soft lag,
          // so pushing sideways smears the dimple like real material
          this._toLocal(tip, obj, this._tipLocal);
          this._tmp.copy(this._tipLocal).normalize().multiplyScalar(obj.radius);
          this._dragPt.lerp(this._tmp, 1 - Math.exp(-dt * 14));
          this._contact.point.copy(this._dragPt);
          // the core gathers, small and hot, toward the pressed point, so the
          // dimple's silhouette stays the storyteller
          obj.core.material.opacity = 0.55 + heat * 0.35;
          obj.core.scale.setScalar(obj.radius * (0.55 + heat * 0.25));
          obj.core.position.copy(this._dragPt).multiplyScalar(0.55);
          // deeper press feeds the slosh a little (alive under the finger)
          if (depth > 0.004) obj.wob2.kick(dt * depth * 0.4);
        } else if (obj.contactRing) {
          obj.contactRing.material.opacity = Math.max(0, obj.contactRing.material.opacity - dt * 0.5);
          obj.contactRing.scale.setScalar(Math.min(0.05, obj.contactRing.scale.x + dt * 0.05));
        }

        // the stop light holds the exact surface point while the finger is held
        const sp = this._tmp.copy(this._contact.point).add(obj.pivot.position);
        this._stopGlint.position.copy(sp);
        this._stopGlint.material.opacity = obj.kind === "hard"
          ? 0.55 + heat * 0.4
          : 0.0;                                          // soft: the dimple speaks
      }
    } else {
      this._dimpleDepth.step(0, dt);
      hand.tipBloom("index", 0);
      if (this._tipFlare) this._tipFlare.material.opacity = Math.max(0, this._tipFlare.material.opacity - dt * 3);
      this._stopGlint.material.opacity = Math.max(0, this._stopGlint.material.opacity - dt * 2.5);
    }

    // ---- soft body: deform every frame it is pressed or still ringing ------
    const soft = this._objects[0];
    if (soft && soft.base) {
      const at = this._contact && this._contact.obj === soft ? this._contact.point : this._dragPt;
      this._deformSoft(soft, at.lengthSq() > 1e-8 ? at : _v1.set(0, soft.radius, 0), this._dimpleDepth.x, dt);
    }

    // ---- the truthful force cue --------------------------------------------
    if (bare) {
      const pressing = !!this._contact;
      const geomPen = pressing ? Math.max(0, -this._contact.obj._dist) : 0;
      hand.setHalo(pressing);
      hand.halo(pressing ? 0.2 + clamp(geomPen / 0.02, 0, 1) * 0.6 : 0, 0.75, 0);
    } else {
      hand.setHalo(!!wallLive);
      hand.halo(wallLive ? 0.25 + (currentMa / F_MAX_MA) * 0.6 : 0.0, wallLive ? 0.75 : 0.1, 0);
    }

    this._prevTip.copy(tip);
    this._bursts.update(dt);
    this._motes.update(t);
  }

  onHover(obj) {
    // choosing which object to reach for (desktop curiosity); never mid-press
    const key = keyOf(obj);
    if (key && key.startsWith("obj:") && !this._contact) {
      this._active = this._objects[parseInt(key.slice(4), 10)] || this._active;
    }
  }
}
