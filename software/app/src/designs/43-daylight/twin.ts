// 43-daylight twin - chrome in the open air.
//
// A mirror finish (metalness 1, roughness 0.06) reflecting a gradient sky:
// blue overhead, pale at the horizon, warm ground below, so the top of
// every member goes sky and the underside goes earth. A soft sun, no hard
// key, no ground: the hand floats in daylight and breathes.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import { type TwinSpec, gradientSkyScene, dir } from '../../twin/Stage';

const chrome = (color: string, roughness: number) =>
  new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), roughness, metalness: 1, envMapIntensity: 1.4 });

function materials(): Materials {
  return {
    shell: chrome('#E6E9EC', 0.10),
    link: chrome('#F4F6F8', 0.06),
    pin: chrome('#FFFFFF', 0.04),
    bank: new THREE.MeshPhysicalMaterial({ color: new THREE.Color('#1B2E45'), roughness: 0.25, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1 }),
    board: new THREE.MeshPhysicalMaterial({ color: new THREE.Color('#1B2E45'), roughness: 0.25, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1 }),
    glass: chrome('#E6E9EC', 0.10),
    spool: chrome('#F4F6F8', 0.06),
  } as Materials;
}

function Lights() {
  return React.createElement(React.Fragment, null,
    React.createElement('directionalLight', { position: dir(300, 58, 8), intensity: 1.1, color: '#FFF6E8' }),
    React.createElement('hemisphereLight', { args: ['#BFD9F7', '#C9B79A', 0.5] }),
  );
}

export const twin: TwinSpec = {
  materials,
  Lights,
  camera: { fov: 26, distance: 2.0, azimuth: 204, elevation: 22, roll: 0, yaw0: 0.6, target: [0, 0.04, 0], fitAspect: 0.8 },
  background: null,
  environment: gradientSkyScene('#4E93E0', '#EDF4FA', '#B9A583', 1.0),
  envIntensity: 1.0,
  toneMapping: 'aces',
  exposure: 1.05,
  shadow: false,
  idle: 'breathe', idleAmp: 0.5, idleSpeed: 0.5,
  followRoll: 0.7,
  part: 'hand',
  drag: true,
};
