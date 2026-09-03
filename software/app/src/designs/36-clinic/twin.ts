// 36-clinic twin - glazed porcelain.
//
// A white glaze under a full clearcoat, the room environment mirrored in
// every curve, dark navy encoder boards and steel pins for contrast, a
// soft high key and a wide fill so nothing is harsh, and a light shadow on
// a pale blue ground. Clean, calm, clinical: the hand as an instrument
// that has been sterilised.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import { type TwinSpec, dir } from '../../twin/Stage';

const phys = (color: string, roughness: number, metalness = 0, clearcoat = 0, clearcoatRoughness = 0.1) =>
  new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), roughness, metalness, clearcoat, clearcoatRoughness, envMapIntensity: 1 });

function materials(): Materials {
  return {
    shell: phys('#EDEFF1', 0.28, 0, 1, 0.08),
    link: phys('#F7F8F9', 0.22, 0, 1, 0.06),
    pin: phys('#8D96A3', 0.25, 0.9),
    bank: phys('#1B2A3F', 0.35, 0.1, 0.6, 0.15),
    board: phys('#1B2A3F', 0.35, 0.1, 0.6, 0.15),
    glass: phys('#1B2A3F', 0.35, 0.1, 0.6, 0.15),
    spool: phys('#F7F8F9', 0.22, 0, 1, 0.06),
  } as Materials;
}

function Lights() {
  return React.createElement(React.Fragment, null,
    React.createElement('directionalLight', {
      position: dir(290, 58, 7), intensity: 2.0, color: '#FFFFFF', castShadow: true,
      'shadow-mapSize-width': 2048, 'shadow-mapSize-height': 2048, 'shadow-radius': 10, 'shadow-bias': -0.0005, 'shadow-normalBias': 0.02,
      'shadow-camera-near': 1, 'shadow-camera-far': 16, 'shadow-camera-left': -0.8, 'shadow-camera-right': 0.8, 'shadow-camera-top': 0.8, 'shadow-camera-bottom': -0.8,
    }),
    React.createElement('directionalLight', { position: dir(110, 25, 6), intensity: 0.9, color: '#DCE9FF' }),
    React.createElement('hemisphereLight', { args: ['#FFFFFF', '#C9D6E4', 0.9] }),
  );
}

export const BG = '#EAF1F8';

export const twin: TwinSpec = {
  materials,
  Lights,
  camera: { fov: 28, distance: 1.95, azimuth: 204, elevation: 34, roll: 0, yaw0: 0.5, target: [0.02, 0.1, 0], fitAspect: 0.8 },
  background: BG,
  environment: 'room',
  envIntensity: 0.75,
  toneMapping: 'neutral',
  exposure: 1.0,
  shadow: true,
  ground: { y: -0.31, opacity: 0.16, color: '#1B2A3F', size: 6 },
  idle: 'sway', idleAmp: 0.08, idleSpeed: 0.2,
  part: 'hand',
  drag: true,
};
