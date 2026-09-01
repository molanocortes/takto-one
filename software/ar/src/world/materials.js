// materials.js - luminous glass, additive glow, shadow pools, motes,
// particle bursts, rings, trails. Everything here is built as LIGHT,
// never as flat paint, and stays inside the Quest triangle budget.

import * as THREE from "../../vendor/three.module.js";
import { AQUA, AQUA_DEEP, AQUA_HALO, OBSIDIAN, VOID } from "../design/palette.js";
import { clamp } from "../design/motion.js";

// ---- seeded RNG (mulberry32) so every field of motes is reproducible -------
export function rng(seed = 7) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- cached canvas textures -------------------------------------------------
const _texCache = new Map();

// radial glow: bright core, long soft falloff. The workhorse of additive light.
export function glowTexture(size = 128, inner = 0.0, mid = 0.25) {
  const key = `glow_${size}_${inner}_${mid}`;
  if (_texCache.has(key)) return _texCache.get(key);
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, size * inner, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, "rgba(255,255,255,1)");
  grad.addColorStop(mid, "rgba(255,255,255,0.45)");
  grad.addColorStop(0.62, "rgba(255,255,255,0.12)");
  grad.addColorStop(1.0, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  _texCache.set(key, tex);
  return tex;
}

// soft dark pool that grounds a floating object on the real desk
export function shadowTexture(size = 128) {
  const key = `shadow_${size}`;
  if (_texCache.has(key)) return _texCache.get(key);
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, "rgba(3,6,10,0.55)");
  grad.addColorStop(0.5, "rgba(3,6,10,0.28)");
  grad.addColorStop(1.0, "rgba(3,6,10,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  _texCache.set(key, tex);
  return tex;
}

// a thin luminous ring (annulus with soft edges), for halos and target rings
export function ringTexture(size = 256, rInner = 0.62, rOuter = 0.86) {
  const key = `ring_${size}_${rInner}_${rOuter}`;
  if (_texCache.has(key)) return _texCache.get(key);
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d");
  const mid = (rInner + rOuter) / 2, half = (rOuter - rInner) / 2;
  const grad = g.createRadialGradient(size / 2, size / 2, size / 2 * Math.max(0, rInner - half),
    size / 2, size / 2, size / 2 * Math.min(1, rOuter + half));
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(clamp((mid - half * 0.9), 0, 1), "rgba(255,255,255,0)");
  grad.addColorStop(mid, "rgba(255,255,255,1)");
  grad.addColorStop(clamp((mid + half * 0.9), 0, 1), "rgba(255,255,255,0)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  _texCache.set(key, tex);
  return tex;
}

// ---- sprites ---------------------------------------------------------------
export function makeGlow(color = AQUA, size = 0.2, opacity = 1, { depthTest = true } = {}) {
  const m = new THREE.SpriteMaterial({
    map: glowTexture(), color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest,
    toneMapped: false,      // emitted light ships at full brightness
  });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  return s;
}

// a fresnel rim shell: the same geometry, slightly inflated, glowing at
// grazing angles. This is what makes an object read as a hologram of light
// over a real room, without any post pass.
// two-tone: deep aqua at the shoulder of the falloff, near-white halo at the
// very edge, so the silhouette stays crisp over any real-room exposure.
export function fresnelShell(sourceMesh, { color = AQUA, edge = AQUA_HALO, intensity = 0.9, power = 2.6, scale = 1.03 } = {}) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uEdge: { value: new THREE.Color(edge) },
      uIntensity: { value: intensity },
      uPower: { value: power },
    },
    vertexShader: `
      varying vec3 vN; varying vec3 vV;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform vec3 uEdge; uniform float uIntensity; uniform float uPower;
      varying vec3 vN; varying vec3 vV;
      void main(){
        float nv = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float f = pow(nv, uPower);
        vec3 col = mix(uColor, uEdge, pow(nv, 5.0));
        gl_FragColor = vec4(col * f * uIntensity, f * uIntensity);
      }`,
  });
  const shell = new THREE.Mesh(sourceMesh.geometry, mat);
  shell.scale.setScalar(scale);
  shell.renderOrder = 5;
  return { shell, mat };
}

// a deeper staging disc: the local darkness that lets an object's light earn
// its contrast over a lit real room (AESTHETIC.md Section 2). Layered under
// the shadow pool, wider and darker toward the centre.
export function makeStageDisc(radius = 0.2) {
  const key = "stage_192";
  let tex = _texCache.get(key);
  if (!tex) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 192;
    const g = cv.getContext("2d");
    const grad = g.createRadialGradient(96, 96, 0, 96, 96, 96);
    grad.addColorStop(0.0, "rgba(3,6,10,0.86)");
    grad.addColorStop(0.45, "rgba(3,6,10,0.55)");
    grad.addColorStop(0.8, "rgba(3,6,10,0.14)");
    grad.addColorStop(1.0, "rgba(3,6,10,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 192, 192);
    tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    _texCache.set(key, tex);
  }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  return mesh;
}

export function makeShadowPool(radius = 0.14) {
  const m = new THREE.MeshBasicMaterial({
    map: shadowTexture(), transparent: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), m);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  return mesh;
}

export function makeRingSprite(color = AQUA, size = 0.2, opacity = 1) {
  const m = new THREE.SpriteMaterial({
    map: ringTexture(), color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
    toneMapped: false,
  });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  return s;
}

// flat luminous ring lying on the desk (a mesh, not a sprite, so it sits in space)
export function makeFlatRing(radius = 0.22, color = AQUA, width = 0.35) {
  const m = new THREE.MeshBasicMaterial({
    map: ringTexture(256, 1 - width, 1), color, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), m);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2;
  return mesh;
}

// ---- materials ---------------------------------------------------------------
// luminous obsidian glass: transmission body with an emissive tint that modes
// ramp up as the hand approaches (the "wake" pillar).
// polished obsidian: near-black, deep clearcoat reflections, light lives at
// the rim (fresnel shell) and in the cores. No transmission: it is the wrong
// look over a dark scene and the wrong cost on Quest.
export function luminousGlass({
  color = 0x0d141f, emissive = AQUA, emissiveIntensity = 0.04,
  roughness = 0.05, clearcoat = 1.0,
} = {}) {
  return new THREE.MeshPhysicalMaterial({
    color, roughness, metalness: 0.12,
    clearcoat, clearcoatRoughness: 0.06,
    specularIntensity: 1.2,
    envMapIntensity: 2.3,
    iridescence: 0.35, iridescenceIOR: 1.32,   // the faint soap-film magic
    iridescenceThicknessRange: [120, 480],
    emissive, emissiveIntensity,
    transparent: true, opacity: 0.97, side: THREE.FrontSide,
  });
}

export function boneStone() {
  return new THREE.MeshStandardMaterial({
    color: 0xb3a68e, roughness: 0.78, metalness: 0.02,
    emissive: 0x1c1710, emissiveIntensity: 0.35,
    envMapIntensity: 0.85,
  });
}

export function titanium() {
  return new THREE.MeshStandardMaterial({
    color: 0x9aa3ae, roughness: 0.28, metalness: 0.9,
    envMapIntensity: 2.2,
  });
}

// ---- mote field: slow drifting points of light ------------------------------
export class MoteField {
  constructor({ count = 90, radius = 1.4, center = new THREE.Vector3(), color = AQUA_HALO,
    size = 0.012, seed = 11, ySpan = [0.02, 0.9], fireflies = true } = {}) {
    const r = rng(seed);
    this.count = count; this.radius = radius; this.center = center.clone();
    this._pos = new Float32Array(count * 3);
    this._phase = new Float32Array(count);
    this._rad = new Float32Array(count);
    this._yBase = new Float32Array(count);
    this._speed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = r() * Math.PI * 2, rr = radius * (0.25 + 0.75 * Math.sqrt(r()));
      this._phase[i] = a; this._rad[i] = rr;
      this._yBase[i] = ySpan[0] + (ySpan[1] - ySpan[0]) * r();
      this._speed[i] = 0.02 + 0.05 * r();
      this._pos[i * 3] = center.x + Math.cos(a) * rr;
      this._pos[i * 3 + 1] = center.y + this._yBase[i];
      this._pos[i * 3 + 2] = center.z + Math.sin(a) * rr;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this._pos, 3));
    const mat = new THREE.PointsMaterial({
      map: glowTexture(128, 0, 0.12), color, size, transparent: true, opacity: 1.0,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
      toneMapped: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.renderOrder = 3;
    this._baseOpacity = 1.0;
    this._twinkleSeed = seed * 0.37;

    // a few warm fireflies wander among the azure motes, each with its own
    // slow blink; they make the field feel inhabited rather than printed
    this._flies = [];
    if (fireflies) {
      const n = Math.max(3, Math.round(count / 10));
      for (let i = 0; i < n; i++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTexture(128, 0, 0.16), color: 0xffd9a0, transparent: true,
          opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
          toneMapped: false,
        }));
        s.scale.setScalar(size * 2.9);
        s.renderOrder = 3;
        this.points.add(s);
        this._flies.push({
          s, a: r() * Math.PI * 2, rr: radius * (0.3 + 0.6 * r()),
          y: ySpan[0] + (ySpan[1] - ySpan[0]) * r(),
          sp: 0.05 + 0.06 * r(), blink: 0.25 + r() * 0.3, ph: r() * 20,
        });
      }
    }
  }
  update(t) {
    // the stars HOLD STILL - drifting star fields read as self-motion in a
    // headset and make people dizzy. Life comes from twinkle, not travel.
    if (!this._placed) {
      this._placed = true;
      const p = this._pos, c = this.center;
      for (let i = 0; i < this.count; i++) {
        p[i * 3] = c.x + Math.cos(this._phase[i]) * this._rad[i];
        p[i * 3 + 1] = c.y + this._yBase[i];
        p[i * 3 + 2] = c.z + Math.sin(this._phase[i]) * this._rad[i];
      }
      this.points.geometry.attributes.position.needsUpdate = true;
      for (const f of this._flies) {
        f.s.position.set(
          c.x + Math.cos(f.a) * f.rr,
          c.y + f.y,
          c.z + Math.sin(f.a) * f.rr
        );
      }
    }
    // the field breathes; the fireflies blink on their own time
    this.points.material.opacity = this._baseOpacity * (0.85 + 0.15 * Math.sin(t * 0.45 + this._twinkleSeed));
    for (const f of this._flies) {
      const tw = Math.pow(0.5 + 0.5 * Math.sin(t * f.blink * Math.PI * 2 + f.ph), 3);
      f.s.material.opacity = 0.3 + tw * 0.7;
    }
  }
  set opacity(v) { this._baseOpacity = v; this.points.material.opacity = v; }
  get opacity() { return this._baseOpacity; }
}

// ---- pooled particle bursts (hits, blooms, seals) ----------------------------
export class BurstPool {
  constructor({ max = 400, color = AQUA, size = 0.02, seed = 23 } = {}) {
    this.max = max;
    this._r = rng(seed);
    this._pos = new Float32Array(max * 3);
    this._vel = new Float32Array(max * 3);
    this._life = new Float32Array(max);      // remaining [s]
    this._span = new Float32Array(max);      // total [s]
    this._alive = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this._pos, 3));
    this._mat = new THREE.PointsMaterial({
      map: glowTexture(64), color, size, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
          toneMapped: false,
});
    this.points = new THREE.Points(geo, this._mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    geo.setDrawRange(0, 0);
  }
  // emit n particles from p, speed range [s0,s1] m/s, upward bias 0..1
  burst(p, n = 24, { speed = [0.15, 0.5], life = [0.4, 0.9], up = 0.3 } = {}) {
    for (let k = 0; k < n; k++) {
      if (this._alive >= this.max) break;
      const i = this._alive++;
      const th = this._r() * Math.PI * 2, ph = Math.acos(2 * this._r() - 1);
      const sp = life ? speed[0] + (speed[1] - speed[0]) * this._r() : 0.3;
      this._pos[i * 3] = p.x; this._pos[i * 3 + 1] = p.y; this._pos[i * 3 + 2] = p.z;
      this._vel[i * 3] = Math.sin(ph) * Math.cos(th) * sp;
      this._vel[i * 3 + 1] = (Math.cos(ph) * (1 - up) + up) * sp;
      this._vel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
      const L = life[0] + (life[1] - life[0]) * this._r();
      this._life[i] = L; this._span[i] = L;
    }
  }
  update(dt) {
    let i = 0;
    while (i < this._alive) {
      this._life[i] -= dt;
      if (this._life[i] <= 0) {
        // swap with last alive
        const j = --this._alive;
        for (let k = 0; k < 3; k++) {
          this._pos[i * 3 + k] = this._pos[j * 3 + k];
          this._vel[i * 3 + k] = this._vel[j * 3 + k];
        }
        this._life[i] = this._life[j]; this._span[i] = this._span[j];
        continue;
      }
      this._vel[i * 3 + 1] -= 0.25 * dt;                     // gentle gravity
      this._vel[i * 3] *= (1 - 0.8 * dt); this._vel[i * 3 + 2] *= (1 - 0.8 * dt);
      this._pos[i * 3] += this._vel[i * 3] * dt;
      this._pos[i * 3 + 1] += this._vel[i * 3 + 1] * dt;
      this._pos[i * 3 + 2] += this._vel[i * 3 + 2] * dt;
      i++;
    }
    this.points.geometry.setDrawRange(0, this._alive);
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// ---- luminous trail: a chain of fading additive sprites (ghost motion) ------
export class Trail {
  constructor({ count = 36, color = AQUA, size = 0.02, headSize = 0.045 } = {}) {
    this.count = count;
    this.group = new THREE.Group();
    this._sprites = [];
    for (let i = 0; i < count; i++) {
      const s = makeGlow(color, size, 0);
      this.group.add(s);
      this._sprites.push(s);
    }
    this._head = makeGlow(AQUA_HALO, headSize, 0);
    this.group.add(this._head);
    this._pts = [];
    this.size = size; this.headSize = headSize;
    this.maxOpacity = 0.7;
  }
  // push the current head position; older points fade
  push(p) {
    this._pts.unshift(p.clone());
    if (this._pts.length > this.count) this._pts.pop();
    for (let i = 0; i < this.count; i++) {
      const s = this._sprites[i];
      if (i < this._pts.length) {
        s.position.copy(this._pts[i]);
        const a = 1 - i / this.count;
        s.material.opacity = this.maxOpacity * a * a;
        s.scale.setScalar(this.size * (0.5 + 0.8 * a));
      } else s.material.opacity = 0;
    }
    this._head.position.copy(p);
    this._head.material.opacity = this.maxOpacity;
  }
  fade(f) {
    for (const s of this._sprites) s.material.opacity *= f;
    this._head.material.opacity *= f;
  }
  set visible(v) { this.group.visible = v; }
}
