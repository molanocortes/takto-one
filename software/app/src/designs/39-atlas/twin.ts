// 39-atlas twin - relief on a map.
//
// Matte olive members, a deeper olive palm, burnt sienna encoder boards
// and cream pins: the palette of a printed relief map. The sun comes from
// the north-west, which is the cartographer's convention for hill shading,
// and the shadow falls onto the paper so the hand sits on the sheet. No
// environment, so the tones stay printed.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import { type TwinSpec, dir } from '../../twin/Stage';

const std = (color: string, roughness: number) => new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness: 0 });

function materials(): Materials {
  return {
    shell: std('#5F6B49', 0.9),
    link: std('#7C8A60', 0.88),
    pin: std('#EFE6CF', 0.7),
    bank: std('#9E4F2C', 0.85),
    board: std('#9E4F2C', 0.85),
    glass: std('#9E4F2C', 0.85),
    spool: std('#7C8A60', 0.88),
  } as Materials;
}

function Lights() {
  return React.createElement(React.Fragment, null,
    React.createElement('directionalLight', {
      position: dir(315, 48, 7), intensity: 2.3, color: '#FFF4E0', castShadow: true,
      'shadow-mapSize-width': 2048, 'shadow-mapSize-height': 2048, 'shadow-radius': 6, 'shadow-bias': -0.0005, 'shadow-normalBias': 0.02,
      'shadow-camera-near': 1, 'shadow-camera-far': 20, 'shadow-camera-left': -1, 'shadow-camera-right': 1, 'shadow-camera-top': 1, 'shadow-camera-bottom': -1,
    }),
    React.createElement('directionalLight', { position: dir(135, 20, 6), intensity: 0.5, color: '#D8E4F0' }),
    React.createElement('hemisphereLight', { args: ['#F4EBD6', '#7A6E55', 0.8] }),
  );
}

export const twin: TwinSpec = {
  materials,
  Lights,
  camera: { fov: 30, distance: 1.9, azimuth: 200, elevation: 42, roll: 0, yaw0: 0.55, target: [0, 0.06, 0], fitAspect: 0.85 },
  background: null,
  environment: 'none',
  toneMapping: 'none',
  exposure: 1,
  shadow: true,
  ground: { y: -0.31, opacity: 0.22, color: '#3A2E1E', size: 8 },
  idle: 'sway', idleAmp: 0.07, idleSpeed: 0.15,
  part: 'hand',
  drag: true,
};
