// Hand.tsx - the articulated twin.
//
// The rig binds to the GLB's own node names, because those names ARE the
// mechanism. Per finger, palm outward:
//
//   {f}_mcp        MCP abduction   - a vertical axle, local Y
//   {f}_pip        MCP flexion     - curls toward the palm, local X.
//                                    This hinge RIDES the knuckle block, so it
//                                    also carries the knuckle slide.
//   {f}_dip        PIP flexion     - local X, riding the distal member
//   {f}_mcp_slide  the knuckle joint block, migrating distally
//   {f}_pip_mid    the centre member of the two-stage pair: slides s/2
//   {f}_pip_slide  the distal member: slides s
//   {f}_dip_slide  the fingertip cradle pair
//
// Every angle and every slide comes from kinematics.js, the model shared with
// the operator console. Nothing here is tuned by eye: a slide is what the
// mechanism must do to permit the angle, not a number that looks right.
//
// The arm (MOTION_PIPELINE.md): the model's own axes ARE the segment axes
// (+Z distal, +Y dorsal, +X toward the thumb), so the body quaternions drive
// it directly. The palm and fingers hang from a wrist pivot inside the
// forearm group; the hand turns about that pivot by hand-relative-to-forearm.
//   view 'hand': the forearm holds still and only the wrist moves;
//   view 'arm' : the forearm group is placed at wrist_m with forearm_quat,
//                in metres in the body frame, so the arm moves through space.
// A finger whose flexion channels the bridge marked dead is drawn as a ghost
// at the neutral pose: absent, never a confident 0 degrees.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from './canvas';
import { loadHand, twinStatus } from './loadHand';
import { makeMaterials, makeLookMaterials, materialFor, type Materials, type Look } from './materials';
import { fingerPose, spoolAngleDeg, SPOOL_STATIONS, type FingerPose } from '../data/kinematics';
import { FINGERS, type Finger } from '../ui/tokens';
import { session } from '../data/session';
import { armBody } from '../data/arm';
import { QI } from '../data/quat';
import type { Quat } from '../data/types';

/** the anatomical wrist pivot in model millimetres: between the housing's
 *  distal end (z 0) and the palm plate (z 26), below the dorsal shell */
const PIVOT_MM = new THREE.Vector3(0, -8, 13);
const NEUTRAL_ARM = armBody(QI, QI, { origin: 'body', cal: 'none', live: false });

const D2R = Math.PI / 180;
const AX_X = new THREE.Vector3(1, 0, 0);
const AX_Y = new THREE.Vector3(0, 1, 0);

type Hinge = { node: THREE.Object3D; base: THREE.Quaternion; baseZ: number };
type Slide = { node: THREE.Object3D; baseZ: number };
type Ghost = { mesh: THREE.Mesh; solid: THREE.Material | THREE.Material[]; ghost: THREE.Material | THREE.Material[] };
type Rig = {
  root: THREE.Group;
  /** carries the forearm; its origin is the wrist pivot */
  fore: THREE.Group;
  /** carries the palm and fingers; rotates by hand-relative-to-forearm */
  wrist: THREE.Group;
  /** model centre relative to the pivot, model units */
  centre: THREE.Vector3;
  ghosts: Record<Finger, Ghost[]>;
  dead: Record<Finger, boolean>;
  size: number;
  screen: THREE.MeshStandardMaterial | null;
  fingers: Record<Finger, {
    abduct: Hinge | null; mcpFlex: Hinge | null; pipFlex: Hinge | null;
    mcpSlide: Slide | null; pipMid: Slide | null; pipSlide: Slide | null; dipSlide: Slide | null;
  }>;
  spools: { name: string; node: THREE.Object3D; base: THREE.Quaternion }[];
};

function hinge(o: THREE.Object3D | undefined): Hinge | null {
  return o ? { node: o, base: o.quaternion.clone(), baseZ: o.position.z } : null;
}
function slide(o: THREE.Object3D | undefined): Slide | null {
  return o ? { node: o, baseZ: o.position.z } : null;
}

/** A dark steel pin through each hinge: the detail that keeps a white
 *  lattice legible against a white page. */
function addPin(h: Hinge | null, axis: 'x' | 'y', r: number, len: number, mat: THREE.Material) {
  if (!h) return;
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 14), mat);
  if (axis === 'x') pin.rotation.z = Math.PI / 2;   // cylinder's own axis is Y
  pin.castShadow = false;
  pin.receiveShadow = false;
  h.node.add(pin);
}


/** the nodes that are the forearm housing, hidden when only the hand is shown */
const FOREARM = new Set(['forearm', 'forearm_cover', 'motors', 'internals', 'screen']);

function buildRig(scene: THREE.Object3D, mats: Materials, part: 'device' | 'hand' = 'device'): Rig {
  const root = new THREE.Group();
  const model = scene.clone(true);

  if (part === 'hand') {
    // drop the housing before normalising, so the hand fills the frame
    const gone: THREE.Object3D[] = [];
    model.traverse((o) => { if (FOREARM.has(o.name) || o.name.startsWith('spool_')) gone.push(o); });
    for (const o of gone) o.parent?.remove(o);
  }

  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = materialFor(o.name, mats);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });

  // Measure before any regrouping: the framing in Twin.tsx assumes a unit box.
  const box = new THREE.Box3().setFromObject(model);
  const size = Math.max(...box.getSize(new THREE.Vector3()).toArray());
  const centre = box.getCenter(new THREE.Vector3()).sub(PIVOT_MM);

  // the wrist: palm (and every finger under it) re-hung from a pivot group,
  // so turning the group turns the hand about the anatomical wrist
  const wrist = new THREE.Group();
  wrist.name = 'wrist_pivot';
  const palm = model.getObjectByName('palm');
  if (palm?.parent) {
    model.updateMatrixWorld(true);
    palm.parent.add(wrist);
    wrist.position.copy(PIVOT_MM);
    wrist.updateMatrixWorld(true);
    wrist.attach(palm);
  } else {
    model.add(wrist);
  }
  // the pivot is the origin of `fore`
  model.position.copy(PIVOT_MM).negate();
  const fore = new THREE.Group();
  fore.add(model);
  root.add(fore);

  const grab = (n: string) => model.getObjectByName(n) ?? undefined;
  const fingers = {} as Rig['fingers'];
  const ghosts = {} as Rig['ghosts'];
  const dead = {} as Rig['dead'];
  const ghostOf = new Map<THREE.Material, THREE.Material>();
  const toGhost = (m: THREE.Material) => {
    let g = ghostOf.get(m);
    if (!g) {
      g = m.clone();
      // grey, not white: a white ghost over the light page reads as nothing
      // at all, and "absent" must still be visibly a finger that is there
      const tint = (g as THREE.MeshStandardMaterial).color;
      if (tint) tint.set('#8E8E8E');
      const em = (g as THREE.MeshStandardMaterial).emissive;
      if (em) em.set('#000000');
      g.transparent = true;
      g.opacity = 0.3;
      g.depthWrite = false;
      ghostOf.set(m, g);
    }
    return g;
  };
  const pinR = size * 0.0055, pinL = size * 0.035;
  for (const f of FINGERS) {
    const rec = {
      abduct: hinge(grab(`${f}_mcp`)),
      mcpFlex: hinge(grab(`${f}_pip`)),
      pipFlex: hinge(grab(`${f}_dip`)),
      mcpSlide: slide(grab(`${f}_mcp_slide`)),
      pipMid: slide(grab(`${f}_pip_mid`)),
      pipSlide: slide(grab(`${f}_pip_slide`)),
      dipSlide: slide(grab(`${f}_dip_slide`)),
    };
    addPin(rec.mcpFlex, 'x', pinR, pinL, mats.pin);
    addPin(rec.pipFlex, 'x', pinR, pinL * 0.82, mats.pin);
    fingers[f] = rec;
    const list: Ghost[] = [];
    rec.abduct?.node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const solid = mesh.material;
      list.push({ mesh, solid, ghost: Array.isArray(solid) ? solid.map(toGhost) : toGhost(solid) });
    });
    ghosts[f] = list;
    dead[f] = false;
  }

  const spools = Object.keys(SPOOL_STATIONS)
    .map((name) => ({ name, node: grab(name) }))
    .filter((s): s is { name: string; node: THREE.Object3D } => !!s.node)
    .map((s) => ({ ...s, base: s.node.quaternion.clone() }));

  return { root, fore, wrist, centre, ghosts, dead, size, fingers, spools, screen: mats.glass };
}

export function Hand({ onReady, colourway = 'white', look = 'studio', part = 'device', view = 'hand' }: {
  onReady?: (size: number) => void; colourway?: 'white' | 'graphite'; look?: Look; part?: 'device' | 'hand';
  /** 'hand': a unit-box device, forearm still, wrist articulated; 'arm': metres, body frame */
  view?: 'hand' | 'arm';
}) {
  const [rig, setRig] = useState<Rig | null>(null);
  const mats = useMemo(() => colourway === 'graphite' ? makeLookMaterials(look) : makeMaterials(), [colourway, look]);
  const q = useRef(new THREE.Quaternion()).current;
  const qf = useRef(new THREE.Quaternion()).current;
  const qh = useRef(new THREE.Quaternion()).current;
  const setQ = (dst: THREE.Quaternion, v: Quat) => dst.set(v[1], v[2], v[3], v[0]);

  // how the rig sits in its parent: a centred unit box, or millimetres -> metres
  useEffect(() => {
    if (!rig) return;
    if (view === 'arm') {
      rig.root.scale.setScalar(1);
      rig.root.position.set(0, 0, 0);
      rig.fore.scale.setScalar(0.001);
    } else {
      const s = 1 / rig.size;
      rig.root.scale.setScalar(s);
      rig.root.position.copy(rig.centre).multiplyScalar(-s);
      rig.fore.scale.setScalar(1);
      rig.fore.position.set(0, 0, 0);
      rig.fore.quaternion.identity();
    }
  }, [rig, view]);

  useEffect(() => {
    let live = true;
    loadHand()
      .then((gltf) => {
        if (!live) return;
        const built = buildRig(gltf.scene, mats, part);
        setRig(built);
        onReady?.(built.size);
        // a flag the capture tool waits on, so a frame is never shot before
        // the model has actually been uploaded and rigged
        (globalThis as any).__taktoTwinReady = true;
      })
      .catch((e) => {
        console.warn('[twin] hand model failed to load:', e);
        twinStatus.set({ state: 'error', detail: String(e?.message ?? e) });
      });
    return () => { live = false; };
  }, [mats, part]);

  useFrame(() => {
    if (!rig) return;
    const frame = session.frame;
    const poses: Record<string, FingerPose> = {};

    // the arm: hand relative to forearm at the wrist, and (arm view) the
    // forearm itself placed and turned in the body frame
    const body = frame.body ?? NEUTRAL_ARM;
    setQ(qf, body.forearmQuat);
    setQ(qh, body.handQuat);
    rig.wrist.quaternion.copy(qf).invert().multiply(qh);
    if (view === 'arm') {
      rig.fore.quaternion.copy(qf);
      rig.fore.position.set(body.wrist[0], body.wrist[1], body.wrist[2]);
    }

    for (const f of FINGERS) {
      const j = frame.joints[f];
      const ok = frame.ok[f];
      const isDead = !ok.mcp && !ok.pip;
      if (isDead !== rig.dead[f]) {
        rig.dead[f] = isDead;
        for (const g of rig.ghosts[f]) { g.mesh.material = isDead ? g.ghost : g.solid; g.mesh.castShadow = !isDead; }
      }
      // a dead channel is held at the neutral pose the bridge client filled in
      const p = fingerPose(f, j.ab, j.mcp, j.pip);
      poses[f] = p;
      const r = rig.fingers[f];

      if (r.abduct) {
        q.setFromAxisAngle(AX_Y, p.ab * D2R);
        r.abduct.node.quaternion.copy(r.abduct.base).multiply(q);
      }
      if (r.mcpFlex) {
        q.setFromAxisAngle(AX_X, p.mcp * D2R);
        r.mcpFlex.node.quaternion.copy(r.mcpFlex.base).multiply(q);
        r.mcpFlex.node.position.z = r.mcpFlex.baseZ + p.slideKnuckleMm;
      }
      if (r.pipFlex) {
        q.setFromAxisAngle(AX_X, p.pip * D2R);
        r.pipFlex.node.quaternion.copy(r.pipFlex.base).multiply(q);
        r.pipFlex.node.position.z = r.pipFlex.baseZ + p.slideMcpMm;
      }
      if (r.mcpSlide) r.mcpSlide.node.position.z = r.mcpSlide.baseZ + p.slideKnuckleMm;
      if (r.pipMid) r.pipMid.node.position.z = r.pipMid.baseZ + p.slideMcpMidMm;
      if (r.pipSlide) r.pipSlide.node.position.z = r.pipSlide.baseZ + p.slideMcpMm;
      if (r.dipSlide) r.dipSlide.node.position.z = r.dipSlide.baseZ + p.slidePipMm;
    }

    // The screen wakes with the hand. On the device that round display runs a
    // Rams instrument face whose brightness tracks activity; here it is only
    // the glass lighting up, which is the honest amount of it to claim from a
    // model that carries no panel. Sapphire, because on the real machine the
    // screen is blue and the app is reporting what the object looks like.
    if (rig.screen) {
      let sum = 0;
      for (const f of FINGERS) sum += poses[f].mcp / 90 + poses[f].pip / 110;
      const frac = Math.max(0, Math.min(1, sum / 8));
      rig.screen.emissiveIntensity = 0.14 + frac * 0.52;
    }

    // The spool bank turns with the tendon the joints just demanded. It is the
    // one part of the device you can watch do the work.
    for (const s of rig.spools) {
      const deg = spoolAngleDeg(s.name, poses);
      if (!Number.isFinite(deg)) continue;
      q.setFromAxisAngle(AX_Y, deg * D2R);
      s.node.quaternion.copy(s.base).multiply(q);
    }
  });

  if (!rig) return null;
  return <primitive object={rig.root} />;
}
