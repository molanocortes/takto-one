// 38-brutal twin - cast iron on a concrete slab.
//
// Matte black members, a hard low sun casting one sharp shadow onto the
// slab, safety-orange encoder boards as the one colour, no environment to
// soften anything. A wide 34 degree lens from low down, so the hand is a
// monument.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import { type TwinSpec, dir } from '../../twin/Stage';

export const CONCRETE = '#A8A59F';
const std = (color: string, roughness: number, metalness = 0) =>
  new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness });

function materials(): Materials {
  return {
    shell: std('#1A1A1A', 0.8, 0.1),
    link: std('#232323', 0.78, 0.1),
    pin: std('#8A8A8A', 0.5, 0.6),
    bank: std('#FF4D00', 0.6),
    board: std('#FF4D00', 0.6),
    glass: std('#FF4D00', 0.6),
    spool: std('#232323', 0.78, 0.1),
  } as Materials;
}

function Lights() {
  return React.createElement(React.Fragment, null,
    React.createElement('directionalLight', {
      position: dir(250, 38, 8), intensity: 3.2, color: '#FFFFFF', castShadow: true,
      'shadow-mapSize-width': 2048, 'shadow-mapSize-height': 2048, 'shadow-radius': 1.5, 'shadow-bias': -0.0004, 'shadow-normalBias': 0.02,
      'shadow-camera-near': 1, 'shadow-camera-far': 20, 'shadow-camera-left': -1, 'shadow-camera-right': 1, 'shadow-camera-top': 1, 'shadow-camera-bottom': -1,
    }),
    React.createElement('directionalLight', { position: dir(60, 30, 6), intensity: 0.6, color: '#CFD6E0' }),
    React.createElement('hemisphereLight', { args: ['#D8D5CE', '#5A5854', 0.7] }),
  );
}

export const twin: TwinSpec = {
  materials,
  Lights,
  camera: { fov: 34, distance: 1.55, azimuth: 214, elevation: 14, roll: 0, yaw0: 0.45, target: [0, 0.06, 0], fitAspect: 1.0 },
  background: CONCRETE,
  environment: 'none',
  toneMapping: 'none',
  exposure: 1,
  shadow: true,
  ground: { y: -0.31, opacity: 0.55, color: '#2A2925', size: 8 },
  idle: 'still',
  followRoll: 0.5,
  part: 'hand',
  drag: true,
};
