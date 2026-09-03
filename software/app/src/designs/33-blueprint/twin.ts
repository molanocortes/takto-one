// 33-blueprint twin - the hand as line work on a cyanotype.
//
// The body is the blue of the sheet, a shade lighter so the volumes read;
// the silhouette is a white inverted hull; the creases are EdgesGeometry
// lines at 30 degrees, so every hard edge of the CAD is drawn and every
// smooth cylinder is left to its silhouette. A long lens (16 degrees) keeps
// the perspective close to a drafting projection.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import { type TwinSpec, dir } from '../../twin/Stage';

export const BLUE = '#1B4796';
const BODY = '#2A5AB0';
const LINE = '#EEF4FF';

const body = (c: string) => new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: 0.9, metalness: 0 });

function materials(): Materials {
  return {
    shell: body(BODY), link: body(BODY), pin: body('#4E7BD1'), bank: body('#1E4A9E'), board: body('#1E4A9E'),
    glass: body('#1E4A9E'), spool: body(BODY),
  } as Materials;
}

function hullMaterial(width: number) {
  const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(LINE), side: THREE.BackSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uW = { value: width };
    sh.vertexShader = 'uniform float uW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * uW;');
  };
  return m;
}

function decorate(root: THREE.Group) {
  const size = 1 / root.scale.x;
  const hull = hullMaterial(size * 0.0028);
  const crease = new THREE.LineBasicMaterial({ color: new THREE.Color(LINE), transparent: true, opacity: 0.55 });
  const adds: [THREE.Mesh, THREE.Object3D][] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as any).__hull) return;
    const h = new THREE.Mesh(mesh.geometry, hull);
    (h as any).__hull = true;
    adds.push([mesh, h]);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), crease);
    (edges as any).__hull = true;
    adds.push([mesh, edges]);
  });
  for (const [host, child] of adds) host.add(child);
}

function Lights() {
  return React.createElement(React.Fragment, null,
    React.createElement('directionalLight', { position: dir(300, 50, 6), intensity: 1.6, color: '#FFFFFF' }),
    React.createElement('ambientLight', { intensity: 0.9 }),
  );
}

export const twin: TwinSpec = {
  materials,
  Lights,
  decorate,
  camera: { fov: 16, distance: 3.3, azimuth: 202, elevation: 28, roll: 0, yaw0: 0.5, target: [0.02, 0.05, 0], fitAspect: 0.8 },
  background: null,
  environment: 'none',
  toneMapping: 'none',
  shadow: false,
  idle: 'sway', idleAmp: 0.06, idleSpeed: 0.16,
  part: 'hand',
  drag: true,
};
