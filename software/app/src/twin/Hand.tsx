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
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from './canvas';
import { loadHand } from './loadHand';
import { makeMaterials, makeLookMaterials, materialFor, type Materials, type Look } from './materials';
import { fingerPose, spoolAngleDeg, SPOOL_STATIONS, type FingerPose } from '../data/kinematics';
import { FINGERS, type Finger } from '../ui/tokens';
import { session } from '../data/session';

const D2R = Math.PI / 180;
const AX_X = new THREE.Vector3(1, 0, 0);
const AX_Y = new THREE.Vector3(0, 1, 0);

type Hinge = { node: THREE.Object3D; base: THREE.Quaternion; baseZ: number };
type Slide = { node: THREE.Object3D; baseZ: number };
type Rig = {
  root: THREE.Group;
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

  // Normalise: centre the device on the origin and scale it to a unit box, so
  // the camera framing below is independent of the export's units.
  const box = new THREE.Box3().setFromObject(model);
  const size = Math.max(...box.getSize(new THREE.Vector3()).toArray());
  const centre = box.getCenter(new THREE.Vector3());
  model.position.sub(centre);
  // ...and shrink the whole device to a unit box, so VIEW.distance in Twin.tsx
  // means the same thing whatever units the export happens to carry.
  root.scale.setScalar(1 / size);
  root.add(model);

  const grab = (n: string) => model.getObjectByName(n) ?? undefined;
  const fingers = {} as Rig['fingers'];
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
  }

  const spools = Object.keys(SPOOL_STATIONS)
    .map((name) => ({ name, node: grab(name) }))
    .filter((s): s is { name: string; node: THREE.Object3D } => !!s.node)
    .map((s) => ({ ...s, base: s.node.quaternion.clone() }));

  return { root, size, fingers, spools, screen: mats.glass };
}

export function Hand({ onReady, colourway = 'white', look = 'studio', part = 'device' }: {
  onReady?: (size: number) => void; colourway?: 'white' | 'graphite'; look?: Look; part?: 'device' | 'hand';
}) {
  const [rig, setRig] = useState<Rig | null>(null);
  const mats = useMemo(() => colourway === 'graphite' ? makeLookMaterials(look) : makeMaterials(), [colourway, look]);
  const q = useRef(new THREE.Quaternion()).current;

  useEffect(() => {
    let live = true;
    loadHand()
      .then((gltf) => {
        if (!live) return;
        const built = buildRig(gltf.scene, mats, part);
        setRig(built);
        onReady?.(built.size);
        // a flag the capture tool waits on, so a frame is never shot before
        // the 154k-triangle model has actually been uploaded and rigged
        (globalThis as any).__taktoTwinReady = true;
      })
      .catch((e) => console.warn('[twin] hand model failed to load:', e));
    return () => { live = false; };
  }, [mats, part]);

  useFrame(() => {
    if (!rig) return;
    const frame = session.frame;
    const poses: Record<string, FingerPose> = {};

    for (const f of FINGERS) {
      const j = frame.joints[f];
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
