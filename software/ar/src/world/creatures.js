// creatures.js - the living sky. Small lives of light that inhabit the space
// in every mode: butterflies that wander, flutter, land on the desk's edge to
// rest their wings, and lift off again; and rare comets that streak across
// the upper air with a fading trail and a whispered chime. Everything is
// seeded, gentle, and far enough from the work to never compete with it.

import * as THREE from "../../vendor/three.module.js";
import { AQUA, AQUA_HALO, CANDLE } from "../design/palette.js";
import { clamp, lerp, easeOut } from "../design/motion.js";
import { makeGlow, glowTexture, rng, MoteField } from "./materials.js";

const DESK = new THREE.Vector3(0, 0.75, -0.55);

// a soft wing: teardrop gradient on canvas, cached
let _wingTex = null;
function wingTexture() {
  if (_wingTex) return _wingTex;
  const cv = document.createElement("canvas");
  cv.width = 128; cv.height = 128;
  const g = cv.getContext("2d");
  const grad = g.createRadialGradient(20, 64, 4, 20, 64, 108);
  grad.addColorStop(0, "rgba(255,255,255,0.95)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grad.addColorStop(0.8, "rgba(255,255,255,0.10)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(58, 64, 54, 34, 0, 0, Math.PI * 2);
  g.fill();
  _wingTex = new THREE.CanvasTexture(cv);
  _wingTex.colorSpace = THREE.SRGBColorSpace;
  return _wingTex;
}

class Butterfly {
  constructor(scene, seed, color) {
    this._r = rng(seed);
    this.group = new THREE.Group();
    scene.add(this.group);

    const mat = () => new THREE.MeshBasicMaterial({
      map: wingTexture(), color, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      side: THREE.DoubleSide,
    });
    const wingGeo = new THREE.PlaneGeometry(0.030, 0.020);
    wingGeo.translate(0.016, 0, 0);          // hinge at the body
    this.wingL = new THREE.Mesh(wingGeo, mat());
    this.wingR = new THREE.Mesh(wingGeo, mat());
    this.wingR.scale.x = -1;
    this.wingL.rotation.z = 0;
    this.group.add(this.wingL, this.wingR);
    this.body = makeGlow(AQUA_HALO, 0.014, 0.95, { depthTest: true });
    this.body.material.map = glowTexture(128, 0, 0.16);
    this.group.add(this.body);

    // seeded flight personality: slow, grand, unhurried
    this.omega = (0.10 + this._r() * 0.08) * (this._r() < 0.5 ? 1 : -1);  // orbit speed [rad/s]
    this.f1 = 0.016 + this._r() * 0.012;     // slow radius breathing
    this.f2 = 0.02 + this._r() * 0.014;
    this.f3 = 0.014 + this._r() * 0.014;
    this.ph = this._r() * 20;
    this.R1 = 0.5 + this._r() * 0.45;
    this.R2 = 0.4 + this._r() * 0.4;
    this.hBase = 0.28 + this._r() * 0.5;
    this.flapHz = 3.2 + this._r() * 1.4;     // tender wingbeats
    this.glidePh = this._r() * 10;           // flap-flap-glide rhythm
    this._heading = 0;
    this._bank = 0;
    // perch cycle
    this.state = "fly";
    this.stateT = 4 + this._r() * 10;
    const pa = this._r() * Math.PI * 2;
    this.perch = new THREE.Vector3(
      DESK.x + Math.cos(pa) * (0.55 + this._r() * 0.25),
      DESK.y + 0.004,
      DESK.z + Math.sin(pa) * (0.42 + this._r() * 0.2)
    );
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this._flyAt(0);
    this.prev.copy(this.pos);
    this.blend = 0;                           // 0 = free flight, 1 = perched
  }

  _flyAt(t) {
    // one slow monotonic orbit with a breathing radius and a drifting height:
    // the heading can never reverse, so the flight is always calm
    const th = this.ph + t * this.omega;
    const r1 = this.R1 * (1 + 0.18 * Math.sin(t * this.f1 * Math.PI * 2 + this.ph * 2));
    const r2 = this.R2 * (1 + 0.18 * Math.sin(t * this.f2 * Math.PI * 2 + this.ph * 3));
    this.pos.set(
      DESK.x + Math.sin(th) * r1,
      DESK.y + this.hBase + Math.sin(t * this.f3 * Math.PI * 2 + this.ph * 2) * 0.12,
      DESK.z + Math.cos(th) * r2
    );
  }

  update(dt, t) {
    // ---- the life cycle: fly a while, come down to rest, lift off again ---
    this.stateT -= dt;
    if (this.stateT <= 0) {
      if (this.state === "fly") { this.state = "land"; this.stateT = 3.0; }
      else if (this.state === "land") { this.state = "rest"; this.stateT = 4 + this._r() * 5; }
      else if (this.state === "rest") { this.state = "rise"; this.stateT = 2.2; }
      else { this.state = "fly"; this.stateT = 10 + this._r() * 12; }
    }
    const k = 1 - Math.exp(-dt * 1.6);
    if (this.state === "land") this.blend = Math.min(1, this.blend + dt / 3.0);
    else if (this.state === "rise") this.blend = Math.max(0, this.blend - dt / 2.2);
    else if (this.state === "rest") this.blend = 1;
    else this.blend = Math.max(0, this.blend - dt * 0.6);

    // the flap-flap-glide rhythm of a real butterfly: a slow envelope opens
    // and closes the wingbeat; between beats it sails with wings held high
    const glide = Math.pow(0.5 + 0.5 * Math.sin(t * 0.23 + this.glidePh), 1.6); // 0 = beating, 1 = gliding

    this._flyAt(t);
    // gliding lets it sink a little; each beat lifts it: a gentle swim
    this.pos.y += (1 - glide) * Math.sin(t * this.flapHz * Math.PI * 2 + this.ph) * 0.006
      - glide * 0.015;
    const eb = easeOut(this.blend);
    this.pos.lerpVectors(this.pos, this.perch, eb);
    this.group.position.copy(this.pos);

    // face the direction of travel with a damped, unhurried turn and a soft bank
    if (this.blend < 0.9) {
      const vx = this.pos.x - this.prev.x, vz = this.pos.z - this.prev.z;
      if (Math.abs(vx) + Math.abs(vz) > 1e-6) {
        const want = Math.atan2(vx, vz);
        let d = want - this._heading;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this._heading += d * (1 - Math.exp(-dt * 2.2));
        this._bank += (clamp(d * 2.4, -0.35, 0.35) - this._bank) * (1 - Math.exp(-dt * 2.5));
        this.group.rotation.y = this._heading;
        this.group.rotation.z = this._bank;
      }
    }
    this.prev.copy(this.pos);

    // wings: tender beats that ease into a held glide; slow fans at rest
    const restFlap = 0.25 + 0.5 * Math.pow(0.5 + 0.5 * Math.sin(t * 0.8 + this.ph), 2);
    const beat = Math.sin(t * this.flapHz * Math.PI * 2 + this.ph);
    const flyFlap = lerp(beat * 0.9, 0.55, glide);        // glide = wings in a high V
    const flap = lerp(flyFlap, restFlap, eb);
    this.wingL.rotation.y = -0.35 - flap * 0.85;
    this.wingR.rotation.y = 0.35 + flap * 0.85;
    const glowK = lerp(1, 0.6, eb);
    this.wingL.material.opacity = 0.75 * glowK;
    this.wingR.material.opacity = 0.75 * glowK;
    this.body.material.opacity = 0.85 * glowK + 0.1;
  }
}

class Comet {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.head = makeGlow(AQUA_HALO, 0.024, 1.0, { depthTest: true });
    this.head.material.map = glowTexture(128, 0, 0.16);
    this.group.add(this.head);
    const N = this.N = 16;
    this.trail = [];
    for (let i = 0; i < N; i++) {
      const p = makeGlow(AQUA, 0.016 - i * 0.0007, 0, { depthTest: true });
      p.material.map = glowTexture(128, 0, 0.16);
      this.group.add(p);
      this.trail.push(p);
    }
    this.hist = [];
    this.active = false;
    this.from = new THREE.Vector3();
    this.to = new THREE.Vector3();
    this.t = 0;
    this.dur = 1;
  }

  launch(r) {
    const side = r() < 0.5 ? -1 : 1;
    this.from.set(
      side * (1.4 + r() * 0.8),
      DESK.y + 0.7 + r() * 0.6,
      DESK.z - 1.2 - r() * 0.8
    );
    this.to.set(
      -side * (1.2 + r() * 0.8),
      DESK.y + 0.35 + r() * 0.4,
      DESK.z - 0.9 - r() * 0.6
    );
    this.t = 0;
    this.dur = 1.1 + r() * 0.6;
    this.hist.length = 0;
    this.active = true;
    this.group.visible = true;
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const u = this.t / this.dur;
    if (u > 1.4) { this.active = false; this.group.visible = false; return; }
    const uu = Math.min(1, u);
    // a shallow arc: rises a touch, then falls away
    const x = lerp(this.from.x, this.to.x, uu);
    const y = lerp(this.from.y, this.to.y, uu) + Math.sin(uu * Math.PI) * 0.22;
    const z = lerp(this.from.z, this.to.z, uu);
    this.head.position.set(x, y, z);
    this.head.material.opacity = u < 1 ? 0.95 : Math.max(0, 0.95 - (u - 1) * 2.4);
    this.hist.unshift([x, y, z]);
    if (this.hist.length > this.N * 2) this.hist.pop();
    for (let i = 0; i < this.N; i++) {
      const h = this.hist[Math.min(this.hist.length - 1, (i + 1) * 2)];
      if (h) this.trail[i].position.set(h[0], h[1], h[2]);
      this.trail[i].material.opacity = Math.max(0, (0.65 - i * 0.04) * (u < 1 ? 1 : 1 - (u - 1) * 2.4));
    }
  }
}

export class LivingSky {
  constructor(scene, audio) {
    this.audio = audio;
    this._r = rng(90210);
    // the room itself breathes: a wide field of sparkles surrounds the user,
    // floor to ceiling, in every mode
    this.roomMotes = new MoteField({
      count: 120, radius: 2.1, center: DESK.clone().setY(0),
      size: 0.030, seed: 4711, ySpan: [0.15, 2.3],
    });
    this.roomMotes.opacity = 0.85;
    scene.add(this.roomMotes.points);
    this.butterflies = [];
    const colors = [AQUA, AQUA, AQUA_HALO, CANDLE, AQUA, 0x9ed2ff];
    for (let i = 0; i < 6; i++) {
      this.butterflies.push(new Butterfly(scene, 100 + i * 37, colors[i]));
    }
    this.comets = [new Comet(scene), new Comet(scene)];
    this._nextComet = 5 + this._r() * 6;
  }

  update(dt, t) {
    this.roomMotes.update(t);
    for (const b of this.butterflies) b.update(dt, t);
    this._nextComet -= dt;
    if (this._nextComet <= 0) {
      this._nextComet = 7 + this._r() * 9;
      const c = this.comets.find(c => !c.active);
      if (c) {
        c.launch(this._r);
        // a whisper of a chime rides the brighter comets
        if (this.audio && this.audio.ready && this._r() < 0.7) {
          this.audio.bell(4, 2, { gain: 0.028, rev: 0.95, dry: 0.2, pan: c.from.x > 0 ? 0.7 : -0.7 });
        }
      }
    }
    for (const c of this.comets) c.update(dt);
  }
}
