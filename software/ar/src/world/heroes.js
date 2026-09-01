// heroes.js - the three bespoke mode objects in the Atelier. Purpose-built
// jewels whose form and light say what they open, with no words needed
// (the gentle label stays as a whisper):
//
//   CAPTURE - an aperture: a titanium ring holding a glass lens, with a bright
//             recording mote endlessly writing a loop around the rim.
//   RHYTHM  - a rising chord: three note-orbs on a tilted axis that pulse in
//             sequence ON the live beat of the generative bed.
//   TOUCH   - a yielding drop: a soft glass drop a phantom fingertip presses;
//             the surface dimples, the warm core answers.
//
// Each hero owns a deliberate lighting identity (S4 refinement 1): crisp
// near-white glints for silhouette legibility, a distinct intensity character,
// and light that answers the approaching hand. update(dt, t, wake) drives it.

import * as THREE from "../../vendor/three.module.js";
import { luminousGlass, titanium, fresnelShell, makeGlow, makeRingSprite, glowTexture } from "./materials.js";
import { AQUA, AQUA_DEEP, AQUA_HALO, AMBER, CANDLE } from "../design/palette.js";
import { clamp, lerp, Spring } from "../design/motion.js";
import { DeviceHand, FINGERS } from "./deviceHand.js";

// a tiny crisp glint: the legibility anchor that survives any room exposure
function glint(size = 0.007, color = AQUA_HALO, opacity = 0.9) {
  const s = makeGlow(color, size, opacity, { depthTest: false });
  s.renderOrder = 7;
  return s;
}

// a concentrated heart: hot small centre, short spill, so the light reads as
// carried INSIDE the glass instead of washing the whole body
function coreGlow(color, size, opacity = 0.7) {
  const s = makeGlow(color, size, opacity, { depthTest: false });
  s.material.map = glowTexture(128, 0, 0.13);
  s.renderOrder = 6;
  return s;
}

// ---------------------------------------------------------------------------
// CAPTURE - the scribe: a comet of light forever re-tracing a hand gesture,
// leaving a written ribbon behind it, under a softly pulsing record lamp.
// Motion, traced, kept: that is what the mode does.
// ---------------------------------------------------------------------------
export function makeCaptureHero({ size = 0.105 } = {}) {
  const group = new THREE.Group();
  const R = size * 0.5;

  // the gesture path: an upright, gently folded stroke (a hand's sweep in air)
  const PATH_N = 96;
  const path = [];
  for (let i = 0; i < PATH_N; i++) {
    const u = (i / PATH_N) * Math.PI * 2;
    path.push(new THREE.Vector3(
      Math.sin(u) * R,
      Math.cos(u) * R * 0.60 + Math.sin(u * 2) * R * 0.10,
      Math.sin(u * 2) * R * 0.22
    ));
  }

  // the written ribbon: the whole path as a faint thread of record
  const ribbonGeo = new THREE.BufferGeometry().setFromPoints([...path, path[0]]);
  const ribbonMat = new THREE.LineBasicMaterial({
    color: AQUA, transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  group.add(new THREE.Line(ribbonGeo, ribbonMat));

  // the fresh stroke: a fading trail of points behind the comet
  const TRAIL_N = 26;
  const trailPts = [];
  for (let i = 0; i < TRAIL_N; i++) {
    const p = makeGlow(i < 4 ? AQUA_HALO : AQUA, 0.011 - i * 0.00028, 0, { depthTest: false });
    p.material.map = glowTexture(128, 0, 0.16);
    p.renderOrder = 6;
    group.add(p);
    trailPts.push(p);
  }
  // the comet itself: the pen of light
  const comet = glint(0.014);
  group.add(comet);

  // the record lamp: a small warm pulse above the loop (recording's heartbeat)
  const lamp = coreGlow(AMBER, 0.026, 0.85);
  lamp.position.set(0, R * 0.95, 0);
  group.add(lamp);
  const lampRing = makeRingSprite(AMBER, 0.030, 0.6);
  lampRing.material.depthTest = false;
  lampRing.renderOrder = 6;
  lampRing.position.copy(lamp.position);
  group.add(lampRing);

  let phase = 0;
  return {
    group,
    update(dt, t, wake) {
      // the comet writes; curiosity quickens the pen
      phase += dt * (10 + wake * 16);
      const at = (k) => path[((Math.floor(phase - k) % PATH_N) + PATH_N) % PATH_N];
      comet.position.copy(at(0));
      comet.material.opacity = 0.9 + wake * 0.1;
      comet.scale.setScalar(0.014 * (1 + wake * 0.5));
      for (let i = 0; i < TRAIL_N; i++) {
        trailPts[i].position.copy(at((i + 1) * 1.5));
        trailPts[i].material.opacity = (0.75 - i * 0.028) * (0.65 + wake * 0.45);
      }
      const br = 0.5 + 0.5 * Math.sin(t * 0.8);
      ribbonMat.opacity = 0.30 + br * 0.10 + wake * 0.35;

      // the lamp breathes like a record light: calm, unmistakable
      const pulse = Math.pow(0.5 + 0.5 * Math.sin(t * 2.6), 3);
      lamp.material.opacity = 0.55 + pulse * 0.45;
      lamp.scale.setScalar(0.024 + pulse * 0.010 + wake * 0.008);
      lampRing.material.opacity = 0.35 + pulse * 0.35 + wake * 0.2;
      lampRing.scale.setScalar(0.030 + pulse * 0.012);

      group.rotation.y = 0.3 + Math.sin(t * 0.18) * 0.22;
    },
  };
}

// ---------------------------------------------------------------------------
// RHYTHM - the rising chord
// ---------------------------------------------------------------------------
export function makeRhythmHero({ size = 0.105 } = {}) {
  const group = new THREE.Group();

  // three note-orbs on a tilted rising axis
  const radii = [size * 0.14, size * 0.18, size * 0.23];
  const offsets = [
    new THREE.Vector3(-size * 0.34, -size * 0.28, size * 0.06),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(size * 0.36, size * 0.30, -size * 0.06),
  ];
  const notes = [];
  for (let i = 0; i < 3; i++) {
    const bodyMat = luminousGlass({ emissiveIntensity: 0.03 });
    const orb = new THREE.Mesh(new THREE.SphereGeometry(radii[i], 40, 28), bodyMat);
    const { shell, mat: shellMat } = fresnelShell(orb, { intensity: 1.2 });
    orb.add(shell);
    orb.position.copy(offsets[i]);
    const core = coreGlow(AQUA_HALO, radii[i] * 1.4, 0.7);
    core.position.copy(offsets[i]);
    const pulse = new Spring(0, 120, 13);
    group.add(orb, core);
    notes.push({ orb, core, bodyMat, shellMat, pulse, r: radii[i], base: offsets[i].clone() });
  }
  // one crisp glint on the crowning note
  const crown = glint(0.006);
  crown.position.copy(offsets[2]).add(new THREE.Vector3(radii[2] * 0.45, radii[2] * 0.6, radii[2] * 0.5));
  group.add(crown);

  // a thin lane thread beneath, pointing home to the strike zone
  const lanePts = [];
  for (let i = 0; i <= 12; i++) {
    const u = i / 12;
    lanePts.push(new THREE.Vector3(
      lerp(-size * 0.5, size * 0.55, u),
      lerp(-size * 0.52, size * 0.14, u * u),
      lerp(size * 0.14, -size * 0.10, u)));
  }
  const laneMat = new THREE.LineBasicMaterial({
    color: AQUA_DEEP, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(lanePts), laneMat));

  let beatCount = 0;
  return {
    group,
    // the atelier forwards the live audio beat here
    onBeat(count) {
      beatCount = count;
      const n = notes[count % 3];
      n.pulse.x = 1;
      // every fourth cycle the crowning note warms (the strong-note promise)
      n.warm = (count % 12) >= 9 && (count % 3) === 2;
    },
    update(dt, t, wake) {
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        n.pulse.to(0); n.pulse.step(dt);
        const p = clamp(n.pulse.x, 0, 1.3);
        const br = 0.5 + 0.5 * Math.sin(t * 0.9 + i * 1.1);
        n.orb.scale.setScalar(1 + p * 0.22 + wake * 0.05);
        n.orb.position.y = n.base.y + Math.sin(t * 0.7 + i * 0.9) * size * 0.02;
        n.core.position.copy(n.orb.position);
        const warmNow = n.warm && p > 0.05;
        n.core.material.color.setHex(warmNow ? AMBER : AQUA_HALO);
        n.core.material.opacity = 0.55 + br * 0.12 + p * 0.45 + wake * 0.25;
        n.core.scale.setScalar(n.r * (1.35 + p * 0.8 + wake * 0.3));
        n.bodyMat.emissiveIntensity = lerp(0.02 + p * 0.16, 0.2, wake);
        n.shellMat.uniforms.uIntensity.value = 1.2 + p * 0.9 + wake * 0.9;
      }
      laneMat.opacity = 0.4 + 0.18 * Math.sin(t * 1.6) + wake * 0.3;
      group.rotation.y = Math.sin(t * 0.18) * 0.12;
    },
  };
}

// ---------------------------------------------------------------------------
// TOUCH - the yielding drop
// ---------------------------------------------------------------------------
export function makeTouchHero({ size = 0.105 } = {}) {
  const group = new THREE.Group();
  const R = size * 0.42;

  const geo = new THREE.SphereGeometry(R, 48, 34);
  const base = Float32Array.from(geo.attributes.position.array);
  const bodyMat = luminousGlass({ emissiveIntensity: 0.03 });
  const drop = new THREE.Mesh(geo, bodyMat);
  const { shell, mat: shellMat } = fresnelShell(drop, { intensity: 1.2 });
  drop.add(shell);
  group.add(drop);

  // the warm heart: this hero's identity is candle warmth inside aqua glass
  const heart = coreGlow(CANDLE, R * 1.3, 0.7);
  group.add(heart);
  const dropGlint = glint(0.006);
  dropGlint.position.set(R * 0.42, R * 0.62, R * 0.5);
  group.add(dropGlint);

  // the phantom fingertip that presses the drop in a slow rite
  const phantom = glint(0.010, AQUA_HALO, 0.0);
  group.add(phantom);
  const touchRing = makeRingSprite(CANDLE, 0.02, 0);
  touchRing.material.depthTest = false;
  touchRing.renderOrder = 7;
  group.add(touchRing);

  const pressDir = new THREE.Vector3(0.35, 0.88, 0.32).normalize();
  const contact = pressDir.clone().multiplyScalar(R);
  const posAttr = geo.attributes.position;

  function dimple(depth) {
    const falloff = R * 1.05;
    for (let i = 0; i < posAttr.count; i++) {
      const bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2];
      const d = Math.hypot(bx - contact.x, by - contact.y, bz - contact.z);
      const w = d < falloff ? Math.pow(1 - d / falloff, 2) : 0;
      // a soft bulge just outside the dimple keeps the volume believable
      const ring = Math.exp(-Math.pow((d - falloff * 0.55) / (falloff * 0.22), 2));
      const off = -depth * w + depth * 0.35 * ring;
      posAttr.array[i * 3] = bx + pressDir.x * off;
      posAttr.array[i * 3 + 1] = by + pressDir.y * off;
      posAttr.array[i * 3 + 2] = bz + pressDir.z * off;
    }
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  let lastDepth = -1;
  return {
    group,
    update(dt, t, wake) {
      // the press cycle: approach, press, release; curiosity quickens it
      const period = lerp(4.6, 2.6, wake);
      const ph = (t % period) / period;
      const press = Math.max(0, Math.sin((ph - 0.18) * Math.PI / 0.64));  // 0 outside the press window
      const depth = press * R * 0.30;

      // phantom tip rides the surface as it presses
      const reach = 1 - Math.min(1, Math.abs(ph - 0.5) * 3.2);
      const hover = lerp(R * 1.9, R * 1.0, clamp(reach, 0, 1)) - depth;
      phantom.position.copy(pressDir).multiplyScalar(hover);
      phantom.material.opacity = clamp(reach, 0, 1) * (0.55 + wake * 0.4);
      touchRing.position.copy(pressDir).multiplyScalar(Math.max(R * 0.98 - depth, R * 0.6));
      touchRing.material.opacity = press * (0.5 + wake * 0.3);
      touchRing.scale.setScalar(0.016 + press * 0.012);

      if (Math.abs(depth - lastDepth) > R * 0.004) { dimple(depth); lastDepth = depth; }

      const br = 0.5 + 0.5 * Math.sin(t * 0.75);
      heart.material.opacity = 0.55 + br * 0.12 + press * 0.35 + wake * 0.25;
      heart.scale.setScalar(R * (1.2 + press * 0.45 + wake * 0.25));
      bodyMat.emissiveIntensity = lerp(0.02 + press * 0.12, 0.2, wake);
      shellMat.uniforms.uIntensity.value = 1.2 + press * 0.6 + wake * 0.9;
      group.rotation.y = Math.sin(t * 0.15) * 0.18;
    },
  };
}

// ---------------------------------------------------------------------------
// TWIN - a miniature of the REAL device CAD, waving: the twin, in the flesh
// ---------------------------------------------------------------------------
export function makeTwinHero({ size = 0.105 } = {}) {
  const group = new THREE.Group();
  const hand = new DeviceHand(group, { scale: 0.5 });
  // a private key + cool rim so the little machine reads silver at the hub
  const key = new THREE.PointLight(0xeaf3ff, 1.4, 0.9, 1.6);
  key.position.set(0.16, 0.24, 0.18);
  group.add(key);
  const rim = new THREE.PointLight(0x86b8f0, 0.9, 0.8, 1.6);
  rim.position.set(-0.18, 0.12, -0.2);
  group.add(rim);
  const pos = new THREE.Vector3(0, size * 0.30, 0);
  const quat = new THREE.Quaternion();
  const qSway = new THREE.Quaternion();
  const euler = new THREE.Euler();
  // present it raised: fingers up, dorsal outward (same base as TWIN mode)
  const qBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0))
    .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)));
  const joints = {};

  return {
    group,
    update(dt, t, wake) {
      // a slow, alive wave on the real mechanism: MCP abduction ripples the
      // fingers apart, the two flexion hinges roll a greeting curl through
      for (let f = 0; f < FINGERS.length; f++) {
        const wavePh = t * (1.1 + wake * 0.9) - f * 0.55;
        const curl = 0.5 + 0.5 * Math.sin(wavePh);
        joints[`${FINGERS[f]}_mcp`] = Math.sin(t * 0.7 + f * 1.6) * 7;   // abduction
        joints[`${FINGERS[f]}_pip`] = 8 + curl * 46;                     // MCP flexion
        joints[`${FINGERS[f]}_dip`] = 6 + curl * 40;                     // PIP flexion
      }
      euler.set(Math.sin(t * 0.4) * 0.10, Math.sin(t * 0.27) * 0.35, Math.sin(t * 0.33) * 0.10);
      qSway.setFromEuler(euler);
      quat.copy(qSway).multiply(qBase);
      hand.pose(pos, quat, joints, 0.35 + wake * 0.5, dt);
      hand.update(t);
    },
  };
}
