// 32-editorial twin - the hand as a printed plate.
//
// Ink, not photography: toon shading in three tones, a black outline drawn
// by an inverted hull pushed out along the vertex normals, no environment
// and no soft shadow. The page is the stage. The lithograph reads as a
// precise instrument because every edge is drawn and every part has its
// own tone: mid grey members, darker palm, near-black encoder boards, pale
// pins.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import { type TwinSpec, dir } from '../../twin/Stage';

function steps(values: number[]) {
  const data = new Uint8Array(values.length * 4);
  values.forEach((v, i) => { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255; });
  const t = new THREE.DataTexture(data, values.length, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}
const RAMP = steps([95, 175, 250]);

const toon = (color: string) => new THREE.MeshToonMaterial({ color: new THREE.Color(color), gradientMap: RAMP });

function materials(): Materials {
  return {
    shell: toon('#A39F98'),
    link: toon('#D2CFC8'),
    pin: toon('#E8E6E1'),
    bank: toon('#2A2A2A'),
    board: toon('#232323'),
    glass: toon('#232323'),
    spool: toon('#B9B6B0'),
  } as unknown as Materials;
}

/** the drawn line: a back-facing hull pushed along the normals */
function outlineMaterial(width: number) {
  const m = new THREE.MeshBasicMaterial({ color: new THREE.Color('#151413'), side: THREE.BackSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uW = { value: width };
    sh.vertexShader = 'uniform float uW;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\ntransformed += normalize(normal) * uW;',
    );
  };
  return m;
}

function decorate(root: THREE.Group) {
  const size = 1 / root.scale.x;
  const mat = outlineMaterial(size * 0.0036);
  const hulls: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as any).__hull) return;
    const h = new THREE.Mesh(mesh.geometry, mat);
    (h as any).__hull = true;
    h.castShadow = false; h.receiveShadow = false;
    hulls.push(h);
    (h as any).__host = mesh;
  });
  for (const h of hulls) ((h as any).__host as THREE.Mesh).add(h);
}

function Lights() {
  return React.createElement(React.Fragment, null,
    React.createElement('directionalLight', { position: dir(310, 48, 6), intensity: 2.2, color: '#FFFFFF' }),
    React.createElement('directionalLight', { position: dir(140, 20, 6), intensity: 0.6, color: '#FFFFFF' }),
    React.createElement('ambientLight', { intensity: 0.55 }),
  );
}

export const twin: TwinSpec = {
  materials,
  Lights,
  decorate,
  camera: { fov: 30, distance: 1.6, azimuth: 190, elevation: 22, roll: -6, yaw0: 0.62, target: [0.02, 0.06, 0], fitAspect: 0.75 },
  background: null,
  environment: 'none',
  toneMapping: 'none',
  exposure: 1,
  shadow: false,
  idle: 'sway', idleAmp: 0.05, idleSpeed: 0.18,
  followRoll: 0.6,
  part: 'hand',
  drag: true,
};
