// cloudMotes.js - the room being drawn, live. While a scan runs, the depth
// cloud accumulating in envScan.js is rendered over passthrough as a field of
// additive aqua motes: each new point lands with a brief warm-white flash and
// settles into a quiet breathing glint, so the operator can SEE the room
// remembering itself as their gaze sweeps it. Pure view layer: it only reads
// scanCloud() / scanState(); the accumulation logic stays three-free so the
// node spec (tools/envscan_check.mjs) can drive it headless.
//
// LUMEN language: aqua #5FE6C4 base, candle-white birth flash, additive,
// never a solid surface (AESTHETIC.md - light, not matter).

import * as THREE from "../../vendor/three.module.js";
import { scanCloud, scanState, MAX_POINTS } from "./envScan.js";
import { glowTexture } from "./materials.js";

export class CloudMotes {
  constructor(scene) {
    this._geo = new THREE.BufferGeometry();
    this._pos = new Float32Array(MAX_POINTS * 3);
    this._birth = new Float32Array(MAX_POINTS);
    this._geo.setAttribute("position", new THREE.BufferAttribute(this._pos, 3));
    this._geo.setAttribute("aBirth", new THREE.BufferAttribute(this._birth, 1));
    this._geo.setDrawRange(0, 0);
    // huge static bounds: points span the whole room; never let three cull it
    this._geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 30);

    this._mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uT: { value: 0 },
        uFade: { value: 0 },
        uMap: { value: glowTexture(64, 0, 0.5) },
      },
      vertexShader: `
        attribute float aBirth;
        uniform float uT;
        varying float vAge;
        void main() {
          vAge = uT - aBirth;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float flash = exp(-vAge * 2.5);
          gl_PointSize = (5.0 + 9.0 * flash) * (1.6 / max(0.4, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uFade;
        uniform sampler2D uMap;
        varying float vAge;
        void main() {
          float m = texture2D(uMap, gl_PointCoord).a;
          float flash = exp(-vAge * 2.5);
          vec3 aqua = vec3(0.373, 0.902, 0.769);      // #5FE6C4
          vec3 candle = vec3(1.0, 0.94, 0.82);
          vec3 col = mix(aqua, candle, flash);
          gl_FragColor = vec4(col, m * uFade * (0.28 + 0.72 * flash));
        }`,
    });
    this.points = new THREE.Points(this._geo, this._mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.points.visible = false;
    scene.add(this.points);
    this._seen = 0;       // points already stamped with a birth time
    this._gen = -1;
    this._t = 0;
  }

  update(dt) {
    this._t += dt;
    this._mat.uniforms.uT.value = this._t;
    const st = scanState();
    // visible while scanning/uploading; breathe away once the room is sent
    const want = (st.phase === "scanning" || st.phase === "uploading") ? 1
               : (st.phase === "done" ? 0 : 0);
    const f = this._mat.uniforms.uFade;
    f.value += (want - f.value) * (1 - Math.exp(-dt * (want ? 6 : 1.2)));
    this.points.visible = f.value > 0.01;
    if (!this.points.visible) { if (st.phase === "idle") this._reset(); return; }

    const cloud = scanCloud();
    if (cloud.gen !== this._gen) {
      this._gen = cloud.gen;
      const n = cloud.n;
      if (n < this._seen) this._seen = 0;            // a re-scan restarted the buffer
      // ranged upload (2026-07-30 perf pass): a scanning frame used to copy +
      // re-upload the WHOLE 60k-point buffer on every new point. Now only the
      // new tail ships each frame; a full refresh every 30th generation keeps
      // the running-mean refinement of older points honest (they drift by
      // less than one 2.5 cm voxel between refreshes).
      const start = this._seen;
      const posAttr = this._geo.attributes.position;
      const birthAttr = this._geo.attributes.aBirth;
      const full = start === 0 || this._gen % 30 === 0;
      if (full) this._pos.set(cloud.pos.subarray(0, n * 3));
      else this._pos.set(cloud.pos.subarray(start * 3, n * 3), start * 3);
      for (let i = start; i < n; i++) this._birth[i] = this._t;
      this._seen = n;
      posAttr.clearUpdateRanges();
      posAttr.addUpdateRange(full ? 0 : start * 3, (full ? n : n - start) * 3);
      posAttr.needsUpdate = true;
      birthAttr.clearUpdateRanges();
      birthAttr.addUpdateRange(full ? 0 : start, full ? n : n - start);
      birthAttr.needsUpdate = true;
      this._geo.setDrawRange(0, n);
    }
  }

  _reset() { this._seen = 0; this._gen = -1; this._geo.setDrawRange(0, 0); }

  dispose(scene) {
    scene.remove(this.points);
    this._geo.dispose();
    this._mat.dispose();
  }
}
