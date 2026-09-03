// countdown.js - the 3-2-1 set piece, rebuilt crisp. A large, high-resolution
// numeral on a disc of smoked glass, a bright arc sweeping one full turn per
// second, a fine orbit of stars for the magic, each number breathing in on a
// bell (D, F#, A), then a bloom of light and a downbeat on "go".
//
// Usage: const cd = new Countdown(group, audio, { center });
//        cd.start(onGo);   cd.update(dt, camera) each frame.

import * as THREE from "../../vendor/three.module.js";
import { AQUA, AQUA_HALO, AMBER, CANDLE } from "../design/palette.js";
import { clamp, lerp, easeOut } from "./motion.js";
import { glowTexture, makeRingSprite, makeGlow, rng } from "../world/materials.js";

const CV = 768;                         // canvas resolution: crisp at arm's length
const R_DISC = 0.42;                    // disc radius as a fraction of the canvas
const R_ARC = 0.475;                    // sweep arc radius

export class Countdown {
  constructor(parent, audio, { center = new THREE.Vector3(0, 0.30, 0), size = 0.20 } = {}) {
    this.audio = audio;
    this.center = center.clone();
    this.size = size;
    this.group = new THREE.Group();
    this.group.position.copy(center);
    this.group.visible = false;
    parent.add(this.group);

    // ---- the crisp face: numeral + disc + sweep arc, drawn each frame ----
    this._cv = document.createElement("canvas");
    this._cv.width = this._cv.height = CV;
    this._g = this._cv.getContext("2d");
    this._tex = new THREE.CanvasTexture(this._cv);
    this._tex.colorSpace = THREE.SRGBColorSpace;
    this._tex.anisotropy = 8;
    this._faceMat = new THREE.SpriteMaterial({
      map: this._tex, transparent: true, opacity: 0,
      depthWrite: false, depthTest: false, toneMapped: false,
    });
    this.face = new THREE.Sprite(this._faceMat);
    this.face.renderOrder = 8;
    this.face.scale.setScalar(size * 2.4);
    this.group.add(this.face);

    // ---- a fine orbit of stars keeps the magic around the crisp face ------
    const ON = this._orbitN = 22;
    this._orbitPos = new Float32Array(ON * 3);
    this._orbitSeed = [];
    const r = rng(41);
    for (let i = 0; i < ON; i++) {
      this._orbitSeed.push([
        (i / ON) * Math.PI * 2,          // base angle
        0.95 + r() * 0.25,               // radius jitter
        (r() - 0.5) * 0.05,              // z jitter
        0.5 + r() * 0.9,                 // speed
      ]);
    }
    const orbitGeo = new THREE.BufferGeometry();
    orbitGeo.setAttribute("position", new THREE.BufferAttribute(this._orbitPos, 3));
    this._orbitMat = new THREE.PointsMaterial({
      map: glowTexture(128, 0, 0.16), color: AQUA_HALO, size: 0.02,
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, sizeAttenuation: true, toneMapped: false,
    });
    this.orbit = new THREE.Points(orbitGeo, this._orbitMat);
    this.orbit.frustumCulled = false;
    this.orbit.renderOrder = 7;
    this.group.add(this.orbit);

    // ---- the go-bloom -------------------------------------------------------
    this.bloom = makeGlow(CANDLE, size * 2.2, 0, { depthTest: false });
    this.bloom.renderOrder = 9;
    this.group.add(this.bloom);
    this.goRing = makeRingSprite(AQUA_HALO, size * 1.2, 0);
    this.goRing.material.depthTest = false;
    this.goRing.renderOrder = 9;
    this.group.add(this.goRing);

    this.active = false;
    this._t = 0;
    this._stage = -1;                  // 0,1,2 = numerals; 3 = go
    this._onGo = null;
  }

  static get STAGE_S() { return 1.0; }

  start(onGo) {
    this.active = true;
    this.group.visible = true;
    this._onGo = onGo || null;
    this._t = 0;
    this._stage = -1;
    this._faceMat.opacity = 0;
    this._orbitMat.opacity = 0;
    this.bloom.material.opacity = 0;
    this.goRing.material.opacity = 0;
  }

  // draw the face: smoked disc, sweeping arc, crisp numeral
  _drawFace(numeral, sweep01, appear01) {
    const g = this._g, c = CV / 2;
    g.clearRect(0, 0, CV, CV);

    // smoked glass disc (guarantees contrast over any room)
    g.fillStyle = `rgba(3,7,14,${0.88 * appear01})`;
    g.beginPath();
    g.arc(c, c, CV * R_DISC, 0, Math.PI * 2);
    g.fill();
    // a thin quiet rim
    g.strokeStyle = `rgba(102,184,255,${0.5 * appear01})`;
    g.lineWidth = 4;
    g.stroke();

    // the sweep: one bright arc unwinding clockwise from 12 o'clock
    if (sweep01 > 0.001) {
      g.strokeStyle = `rgba(217,237,255,${0.95 * appear01})`;
      g.lineWidth = 14;
      g.lineCap = "round";
      g.shadowColor = "rgba(102,184,255,0.9)";
      g.shadowBlur = 22;
      g.beginPath();
      g.arc(c, c, CV * R_ARC, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * sweep01);
      g.stroke();
      g.shadowBlur = 0;
    }

    // the numeral: large, thin, perfectly sharp
    const scalePulse = 1 + 0.10 * (1 - appear01);
    g.save();
    g.translate(c, c);
    g.scale(scalePulse, scalePulse);
    g.font = `250 ${CV * 0.52}px system-ui, -apple-system, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.shadowColor = "rgba(217,237,255,0.85)";
    g.shadowBlur = 34;
    g.fillStyle = `rgba(255,255,255,${0.98 * appear01})`;
    g.fillText(numeral, 0, CV * 0.02);
    g.restore();

    this._tex.needsUpdate = true;
  }

  _beginStage(s) {
    this._stage = s;
    if (s < 3) {
      this.audio.bell([0, 2, 3][s], 1, { gain: 0.24 });
    } else {
      this.audio.bell(0, 2, { gain: 0.30 });
      this.audio.resolve(null, { gain: 0.16 });
      if (this._onGo) this._onGo();
    }
  }

  update(dt, camera) {
    if (!this.active) return;
    this._t += dt;
    const S = Countdown.STAGE_S;
    const total = 3 * S;
    const stage = this._t >= total ? 3 : Math.floor(this._t / S);
    if (stage !== this._stage) this._beginStage(stage);

    // the set piece presents itself to the viewer
    if (camera) this.group.quaternion.copy(camera.quaternion);

    if (this._stage < 3) {
      const ts = this._t - this._stage * S;              // 0..1 within the second
      const appear = easeOut(clamp(ts / 0.22, 0, 1));    // quick, elegant arrival
      const numeral = String(3 - this._stage);
      // the 2D face redraw is the expensive part: ~30 Hz is invisible to the
      // eye and kind to the headset's CPU
      if (this._lastDraw === undefined || this._t - this._lastDraw > 0.032 || ts < 0.05) {
        this._lastDraw = this._t;
        this._drawFace(numeral, 1 - ts / S, appear);
      }
      this._faceMat.opacity = Math.min(1, this._faceMat.opacity + dt * 6);
      // stars orbit inward as the count approaches go
      const shrink = lerp(1.5, 1.02, this._t / total);
      this._placeOrbit(shrink);
      this._orbitMat.opacity = Math.min(0.95, this._orbitMat.opacity + dt * 3);
    } else {
      // go: the face releases, the stars fly, light blooms
      const ts = this._t - total;
      this._faceMat.opacity = Math.max(0, 1 - ts * 4);
      this.face.scale.setScalar(this.size * 2.4 * (1 + ts * 0.9));
      this._placeOrbit(1.02 + ts * 3.2);
      this._orbitMat.opacity = Math.max(0, 0.95 - ts * 1.6);
      this.bloom.material.opacity = ts < 0.12 ? ts / 0.12 : Math.max(0, 1 - (ts - 0.12) * 2.2);
      this.bloom.scale.setScalar(this.size * (2.2 + ts * 3.5));
      this.goRing.material.opacity = Math.max(0, 0.9 - ts * 1.4);
      this.goRing.scale.setScalar(this.size * (1.2 + ts * 4.5));
      if (ts > 0.9) { this.active = false; this.group.visible = false; }
    }
  }

  _placeOrbit(radiusK) {
    const R = this.size * 1.35 * radiusK;
    for (let i = 0; i < this._orbitN; i++) {
      const [a0, rj, zj, sp] = this._orbitSeed[i];
      const a = a0 + this._t * sp;
      this._orbitPos[i * 3] = Math.cos(a) * R * rj;
      this._orbitPos[i * 3 + 1] = Math.sin(a) * R * rj;
      this._orbitPos[i * 3 + 2] = zj;
    }
    this.orbit.geometry.attributes.position.needsUpdate = true;
  }
}
