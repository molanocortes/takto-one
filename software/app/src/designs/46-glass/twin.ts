// 46-glass twin - anodised aluminium on charcoal.
//
// Satin anodised members (metalness 0.85, roughness 0.42) in space grey,
// the palm a step darker, polished pins, black gloss boards. A neutral
// room environment so the satin has something to hold, one wide key, one
// cool rim, and a soft contact shadow on a charcoal ground: the finish of
// a good laptop, photographed for its own box.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import { type TwinSpec, dir } from '../../twin/Stage';

const phys = (color: string, roughness: number, metalness: number, clearcoat = 0, ccr = 0.1) =>
  new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), roughness, metalness, clearcoat, clearcoatRoughness: ccr, envMapIntensity: 1.1 });

function materials(): Materials {
  return {
    shell: phys('#5F6368', 0.46, 0.85),
    link: phys('#9A9EA4', 0.42, 0.85),
    pin: phys('#E8EAED', 0.12, 1.0),
    bank: phys('#0E0F11', 0.18, 0.2, 1, 0.05),
    board: phys('#0E0F11', 0.18, 0.2, 1, 0.05),
    glass: phys('#0E0F11', 0.18, 0.2, 1, 0.05),
    spool: phys('#9A9EA4', 0.42, 0.85),
  } as Materials;
}

function Lights() {
  return React.createElement(React.Fragment, null,
    React.createElement('directionalLight', {
      position: dir(305, 55, 7), intensity: 1.9, color: '#FFFFFF', castShadow: true,
      'shadow-mapSize-width': 2048, 'shadow-mapSize-height': 2048, 'shadow-radius': 8, 'shadow-bias': -0.0005, 'shadow-normalBias': 0.02,
      'shadow-camera-near': 1, 'shadow-camera-far': 20, 'shadow-camera-left': -1, 'shadow-camera-right': 1, 'shadow-camera-top': 1, 'shadow-camera-bottom': -1,
    }),
    React.createElement('directionalLight', { position: dir(120, 22, 6), intensity: 1.3, color: '#D6E4FF' }),
    React.createElement('hemisphereLight', { args: ['#6E7278', '#111214', 0.6] }),
  );
}

export const twin: TwinSpec = {
  materials,
  Lights,
  camera: { fov: 27, distance: 2.0, azimuth: 206, elevation: 28, roll: 0, yaw0: 0.58, target: [0, 0.06, 0], fitAspect: 0.7 },
  background: null,
  environment: 'room',
  envIntensity: 0.9,
  toneMapping: 'aces',
  exposure: 1.1,
  shadow: true,
  ground: { y: -0.31, opacity: 0.6, color: '#000000', size: 8 },
  idle: 'sway', idleAmp: 0.1, idleSpeed: 0.2,
  part: 'hand',
  drag: true,
};
