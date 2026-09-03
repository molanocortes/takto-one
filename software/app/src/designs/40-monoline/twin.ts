// 40-monoline twin - a technical line illustration, seen in plan.
//
// The body is the white of the page: no shading at all. Everything you
// see is line: a thin dark inverted hull for the silhouettes and
// EdgesGeometry creases at 24 degrees for every hard edge, in one ink and
// one weight. The camera looks almost straight down, so the hand is a plan
// view, fingers up, the way a drawing of a hand is laid out.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import type { TwinSpec } from '../../twin/Stage';

export const INK = '#1E2A38';
export const PAGE = '#FFFFFF';

const flat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PAGE) });

function materials(): Materials {
  return { shell: flat, link: flat, pin: flat, bank: flat, board: flat, glass: flat, spool: flat } as unknown as Materials;
}

function hullMaterial(width: number) {
  const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(INK), side: THREE.BackSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uW = { value: width };
    sh.vertexShader = 'uniform float uW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * uW;');
  };
  return m;
}

function decorate(root: THREE.Group) {
  const size = 1 / root.scale.x;
  const hull = hullMaterial(size * 0.0022);
  const crease = new THREE.LineBasicMaterial({ color: new THREE.Color(INK), transparent: true, opacity: 0.75 });
  const adds: [THREE.Mesh, THREE.Object3D][] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as any).__hull) return;
    const h = new THREE.Mesh(mesh.geometry, hull);
    (h as any).__hull = true;
    adds.push([mesh, h]);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 24), crease);
    (edges as any).__hull = true;
    adds.push([mesh, edges]);
  });
  for (const [host, child] of adds) host.add(child);
}

function Lights() { return null; }

export const twin: TwinSpec = {
  materials,
  Lights,
  decorate,
  camera: { fov: 18, distance: 2.7, azimuth: 180, elevation: 8, roll: 0, yaw0: 0.0, target: [0, 0.02, 0], fitAspect: 0.9 },
  background: null,
  environment: 'none',
  toneMapping: 'none',
  shadow: false,
  idle: 'sway', idleAmp: 0.05, idleSpeed: 0.14,
  part: 'hand',
  drag: true,
  pitchBand: [-0.3, 0.3],
};
