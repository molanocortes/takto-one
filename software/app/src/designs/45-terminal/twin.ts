// 45-terminal twin - a point cloud on phosphor.
//
// Every vertex of the CAD drawn as a tiny green point, additive, over a
// black body that occludes the points behind it, so the hand reads as a
// scanned dot-matrix surface: dense where the mesh is dense (the slides,
// the boards), sparse on the plain cylinders. A slow turntable, because a
// scan is something you rotate.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import type { TwinSpec } from '../../twin/Stage';

export const PHOSPHOR = '#33FF66';
export const BLACK = '#000000';

const body = new THREE.MeshBasicMaterial({ color: new THREE.Color('#020503') });

function materials(): Materials {
  return { shell: body, link: body, pin: body, bank: body, board: body, glass: body, spool: body } as unknown as Materials;
}

function decorate(root: THREE.Group) {
  const dots = new THREE.PointsMaterial({ color: new THREE.Color(PHOSPHOR), size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false });
  const boards = new THREE.PointsMaterial({ color: new THREE.Color('#B8FFD0'), size: 2.0, sizeAttenuation: false, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
  const adds: [THREE.Mesh, THREE.Object3D][] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as any).__hull) return;
    const p = new THREE.Points(mesh.geometry, mesh.name.endsWith('_enc') ? boards : dots);
    (p as any).__hull = true;
    adds.push([mesh, p]);
  });
  for (const [host, child] of adds) host.add(child);
}

function Lights() { return null; }

export const twin: TwinSpec = {
  materials,
  Lights,
  decorate,
  camera: { fov: 26, distance: 2.2, azimuth: 200, elevation: 22, roll: 0, yaw0: 0.5, target: [0, 0.04, 0], fitAspect: 0.9 },
  background: BLACK,
  environment: 'none',
  toneMapping: 'none',
  shadow: false,
  idle: 'turntable', idleSpeed: 0.12,
  part: 'hand',
  drag: true,
};
