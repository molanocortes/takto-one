// atelier.js - the hub. A calm still moment over the real desk: three bespoke
// luminous objects at rest above staged pools of darkness, breathing gently,
// one warm bone stone as an anchor. The modes are objects you reach toward,
// not buttons: an aperture (capture), a rising chord (rhythm), a yielding
// drop (touch). Reaching toward one wakes it (glow, hum, one quiet word) and
// grabbing it carries you in.

import * as THREE from "../../vendor/three.module.js";
import { Mode, makeWord, tagRoot, keyOf } from "./common.js";
import { makeCaptureHero, makeRhythmHero, makeTouchHero, makeTwinHero } from "../world/heroes.js";
import { makeGlow, makeShadowPool, makeStageDisc, makeFlatRing, MoteField, BurstPool, glowTexture, rng } from "../world/materials.js";
import { AQUA, AQUA_DEEP, AQUA_HALO, AMBER, PROGRESS } from "../design/palette.js";
import { clamp, lerp, easeOut, Breath } from "../design/motion.js";

const ANCHOR = new THREE.Vector3(0, 0.75, -0.55);   // the desk point (world)

// the four reachable objects: bespoke builders, where, which mode they open
const HEROES = [
  { key: "capture", make: makeCaptureHero, size: 0.105, pos: [-0.37, 0.165, 0.07], word: "capture" },
  { key: "touch",   make: makeTouchHero,   size: 0.115, pos: [-0.12, 0.215, -0.08], word: "touch"  },
  { key: "rhythm",  make: makeRhythmHero,  size: 0.105, pos: [0.13, 0.165, -0.04], word: "rhythm"  },
  { key: "twin",    make: makeTwinHero,    size: 0.105, pos: [0.37, 0.170, 0.07],  word: "twin"    },
];

export class Atelier extends Mode {
  constructor(ctx) {
    super(ctx);
    this.group.position.copy(ANCHOR);
    this._built = false;
    this._heroes = {};          // key -> { hero, pivot, glow, word, pool, wake, ... }
    this._hover = null;
    this._t = 0;
    this._beatOff = null;
    this._build();
  }

  async _build() {
    const g = this.group;

    // a faint resting ring on the desk, holding the composition
    const ring = makeFlatRing(0.46, AQUA_DEEP, 0.06);
    ring.position.y = 0.002;
    ring.material.opacity = 0.16;
    g.add(ring);
    this._ring = ring;

    // drifting motes: the room's quiet life
    this._motes = new MoteField({
      count: 80, radius: 0.62, center: new THREE.Vector3(0, 0.30, 0),
      size: 0.024, seed: 11, ySpan: [0.04, 0.62],
    });
    this._motes.opacity = 1.0;
    g.add(this._motes.points);

    this._bursts = new BurstPool({ max: 240, seed: 5 });
    g.add(this._bursts.points);

    // the three bespoke heroes, each on a staged pool of darkness
    for (let i = 0; i < HEROES.length; i++) {
      const spec = HEROES[i];
      const hero = spec.make({ size: spec.size });
      const pivot = new THREE.Group();
      pivot.position.set(...spec.pos);
      pivot.add(hero.group);
      tagRoot(pivot, spec.key);

      // a soft aura bloom behind the object (wake swells it)
      const glow = makeGlow(AQUA, spec.size * 2.4, 0.0);
      pivot.add(glow);

      // the stage: local darkness first, then the grounding pool
      const stage = makeStageDisc(spec.size * 2.6);
      stage.position.set(spec.pos[0], 0.001, spec.pos[2]);
      g.add(stage);
      const pool = makeShadowPool(spec.size * 1.35);
      pool.position.set(spec.pos[0], 0.0022, spec.pos[2]);
      g.add(pool);

      const word = makeWord(spec.word, { size: 0.27 });
      word.position.set(spec.pos[0], spec.pos[1] + spec.size * 0.8 + 0.05, spec.pos[2]);
      g.add(word);

      g.add(pivot);
      this._heroes[spec.key] = {
        spec, pivot, hero, glow, word, pool, stage,
        wake: 0, baseY: spec.pos[1],
        breath: new Breath(0.13, i * 0.31),
        hum: null,
      };
      this.interactives.push(pivot);
    }

    // ---- the overture: a galaxy of light that condenses into the four
    // modes. This is the arrival - the workspace assembling itself.
    const ON = this._ovN = 240;
    this._ovPos = new Float32Array(ON * 3);
    this._ovFrom = new Float32Array(ON * 3);
    this._ovTo = new Float32Array(ON * 3);
    this._ovDelay = new Float32Array(ON);
    this._ovHero = new Uint8Array(ON);
    const ovGeo = new THREE.BufferGeometry();
    ovGeo.setAttribute("position", new THREE.BufferAttribute(this._ovPos, 3));
    this._ovMat = new THREE.PointsMaterial({
      map: glowTexture(128, 0, 0.16), color: AQUA_HALO, size: 0.018,
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, sizeAttenuation: true, toneMapped: false,
    });
    this._overture = new THREE.Points(ovGeo, this._ovMat);
    this._overture.frustumCulled = false;
    this._overture.renderOrder = 7;
    this._overture.visible = false;
    g.add(this._overture);

    this._built = true;
    if (this.active) this._reveal();
  }

  // the arrival: a galaxy of light spirals in and condenses, stream by
  // stream, into the four mode objects; each blooms as its stream lands
  _reveal() {
    const keys = Object.keys(this._heroes);
    let i = 0;
    for (const key of keys) {
      const h = this._heroes[key];
      h.pivot.scale.setScalar(0.001);
      h._revealAt = 0.85 + i * 0.42;      // when its stream lands
      h._revealed = false;
      i++;
    }
    this._revealT = 0;

    // seed the streams
    const r = rng(2077);
    for (let n = 0; n < this._ovN; n++) {
      const heroIx = n % keys.length;
      const h = this._heroes[keys[heroIx]];
      this._ovHero[n] = heroIx;
      const a = r() * Math.PI * 2;
      const rad = 0.65 + r() * 0.45;
      this._ovFrom[n * 3] = Math.cos(a) * rad;
      this._ovFrom[n * 3 + 1] = 0.06 + r() * 0.6;
      this._ovFrom[n * 3 + 2] = Math.sin(a) * rad * 0.8;
      const spread = 0.05;
      this._ovTo[n * 3] = h.spec.pos[0] + (r() - 0.5) * spread;
      this._ovTo[n * 3 + 1] = h.spec.pos[1] + (r() - 0.5) * spread;
      this._ovTo[n * 3 + 2] = h.spec.pos[2] + (r() - 0.5) * spread;
      this._ovDelay[n] = 0.1 + heroIx * 0.42 + r() * 0.5;
      this._ovPos[n * 3] = this._ovFrom[n * 3];
      this._ovPos[n * 3 + 1] = this._ovFrom[n * 3 + 1];
      this._ovPos[n * 3 + 2] = this._ovFrom[n * 3 + 2];
    }
    this._overture.visible = true;
    this._ovMat.opacity = 0;
  }

  enter() {
    super.enter();
    this.ctx.audio.setBedLevel(1.0, 3.0);
    this.ctx.hand.setHalo(false);
    this.ctx.hand.setAura(false);
    if (this._built) this._reveal();
    // the rhythm hero pulses on the live beat while the hub is open
    this._beatOff = this.ctx.audio.onBeat((count) => {
      const h = this._heroes.rhythm;
      if (h && h.hero.onBeat) h.hero.onBeat(count);
    });
  }

  exit() {
    super.exit();
    if (this._beatOff) { this._beatOff(); this._beatOff = null; }
    for (const k of Object.keys(this._heroes)) {
      const h = this._heroes[k];
      if (h.hum) { h.hum.stop(); h.hum = null; }
      h.wake = 0;
    }
    this._hover = null;
  }

  onHover(obj) { this._hover = keyOf(obj); }

  onSelect(obj) {
    // the arrival plays out before anything can be grabbed
    if (this._revealT !== undefined && this._revealT < 2.4) return;
    const key = keyOf(obj);
    if (!key || !this._heroes[key]) return;
    const h = this._heroes[key];
    // gather -> bloom -> ease into the mode
    const p = new THREE.Vector3();
    h.pivot.getWorldPosition(p);
    this._bursts.burst(p.clone().sub(ANCHOR), 46, { speed: [0.2, 0.7], life: [0.5, 1.1], up: 0.45 });
    this.ctx.audio.resolve(p, { gain: 0.22 });
    h.glow.material.opacity = 1.0;
    h.glow.scale.setScalar(h.spec.size * 5);
    this.ctx.switchTo(key);
  }

  update(dt, snap, t) {
    if (!this._built) return;
    this._t = t;

    // the overture: streams spiral home, heroes bloom as they land
    if (this._revealT !== undefined) {
      this._revealT += dt;
      const rt = this._revealT;
      for (const k of Object.keys(this._heroes)) {
        const h = this._heroes[k];
        if (!h._revealed && rt > h._revealAt) {
          h._revealed = true;
          const p = new THREE.Vector3();
          h.pivot.getWorldPosition(p);
          this.ctx.audio.bell([2, 0, 3, 4][Object.keys(this._heroes).indexOf(k)] || 0, 0,
            { gain: 0.12, pos: p });
          this._bursts.burst(new THREE.Vector3(...h.spec.pos), 24,
            { speed: [0.1, 0.4], life: [0.4, 0.9], up: 0.3 });
        }
        if (h._revealed) {
          const s = h.pivot.scale.x + (1 - h.pivot.scale.x) * (1 - Math.exp(-dt * 5.5));
          h.pivot.scale.setScalar(s);
        }
      }
      if (this._overture.visible) {
        this._ovMat.opacity = rt < 0.4 ? rt / 0.4 * 0.95
          : rt > 2.6 ? Math.max(0, 0.95 - (rt - 2.6) * 2.2) : 0.95;
        for (let n = 0; n < this._ovN; n++) {
          const p = clamp((rt - this._ovDelay[n]) / 1.1, 0, 1);
          const e = easeOut(p);
          // a gentle spiral on the way in: rotate the remaining offset
          const fx = this._ovFrom[n * 3], fy = this._ovFrom[n * 3 + 1], fz = this._ovFrom[n * 3 + 2];
          const tx = this._ovTo[n * 3], ty = this._ovTo[n * 3 + 1], tz = this._ovTo[n * 3 + 2];
          const ang = (1 - e) * 2.2;
          const ox = (fx - tx) * (1 - e), oz = (fz - tz) * (1 - e);
          const ca = Math.cos(ang), sa = Math.sin(ang);
          this._ovPos[n * 3] = tx + ox * ca - oz * sa;
          this._ovPos[n * 3 + 1] = ty + (fy - ty) * (1 - e);
          this._ovPos[n * 3 + 2] = tz + ox * sa + oz * ca;
        }
        this._overture.geometry.attributes.position.needsUpdate = true;
        if (rt > 3.1) this._overture.visible = false;
      }
    }

    // per-hero life: breath, bob, wake toward hover; the hero lights itself
    for (const k of Object.keys(this._heroes)) {
      const h = this._heroes[k];
      const want = this._hover === k ? 1 : 0;
      h.wake += (want - h.wake) * (1 - Math.exp(-dt * 6));
      const w = h.wake;

      const br = h.breath.at(t);
      h.pivot.position.y = h.baseY + br * 0.012 + w * 0.014;

      h.hero.update(dt, t, w);

      h.glow.material.opacity += ((0.07 + br * 0.03 + w * 0.45) - h.glow.material.opacity) * (1 - Math.exp(-dt * 7));
      h.glow.scale.setScalar(h.spec.size * (2.3 + w * 1.1 + br * 0.1));

      // the one word: a faint constant whisper, full on wake
      h.word.material.opacity += ((0.6 + (w > 0.35 ? 0.4 * w : 0)) - h.word.material.opacity) * (1 - Math.exp(-dt * 5));

      // a soft hum that rises with the approach
      if (w > 0.1 && !h.hum) {
        const p = new THREE.Vector3(); h.pivot.getWorldPosition(p);
        h.hum = this.ctx.audio.hum(p, [3, 0, 2, 4][["capture", "touch", "rhythm", "twin"].indexOf(k)] || 0, 0);
      }
      if (h.hum) h.hum.set(w);
      if (w < 0.04 && h.hum) { h.hum.stop(); h.hum = null; }

      // the stage deepens under a woken object
      h.pool.material.opacity = 0.75 + w * 0.25;
      h.stage.material.opacity = 0.85 + w * 0.15;
    }

    // desktop: the hand of light drifts toward what it is curious about
    if (!this.ctx.world.renderer.xr.isPresenting) {
      if (this._hover && this._heroes[this._hover]) {
        const h = this._heroes[this._hover];
        const p = new THREE.Vector3();
        h.pivot.getWorldPosition(p);
        p.add(new THREE.Vector3(0, -0.02, 0.16));       // reach toward, not through
        this.ctx.hand.moveTo(p, 3.2);
      } else this.ctx.hand.rest();
    }

    // quiet life
    this._motes.update(t);
    this._bursts.update(dt);
    this._ring.material.opacity = 0.26 + 0.08 * (0.5 + 0.5 * Math.sin(t * 0.4));
  }
}
