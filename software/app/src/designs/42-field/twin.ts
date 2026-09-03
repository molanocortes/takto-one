// 42-field twin - a white object on a blue field.
//
// Matte white members with no coat, lit by a soft sky and, from below, by
// the blue field itself: the hemisphere's ground colour is the Klein blue,
// so the undersides go blue the way a white object on a blue floor does.
// One soft key, one long shadow onto the field.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import { type TwinSpec, dir } from '../../twin/Stage';

export const IKB = '#002FA7';
const std = (color: string, roughness: number, metalness = 0) => new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness });

function materials(): Materials {
  return {
    shell: std('#EDEDEA', 0.72),
    link: std('#F7F7F4', 0.68),
    pin: std('#8C8C8C', 0.45, 0.6),
    bank: std('#0A1A4F', 0.7),
    board: std('#0A1A4F', 0.7),
    glass: std('#0A1A4F', 0.7),
    spool: std('#F7F7F4', 0.68),
  } as Materials;
}

function Lights() {
  return React.createElement(React.Fragment, null,
    React.createElement('directionalLight', {
      position: dir(285, 44, 7), intensity: 2.4, color: '#FFFFFF', castShadow: true,
      'shadow-mapSize-width': 2048, 'shadow-mapSize-height': 2048, 'shadow-radius': 5, 'shadow-bias': -0.0005, 'shadow-normalBias': 0.02,
      'shadow-camera-near': 1, 'shadow-camera-far': 20, 'shadow-camera-left': -1, 'shadow-camera-right': 1, 'shadow-camera-top': 1, 'shadow-camera-bottom': -1,
    }),
    React.createElement('hemisphereLight', { args: ['#FFFFFF', '#2A56D6', 1.1] }),
  );
}

export const twin: TwinSpec = {
  materials,
  Lights,
  camera: { fov: 28, distance: 2.0, azimuth: 208, elevation: 30, roll: 0, yaw0: 0.55, target: [0.02, 0.08, 0], fitAspect: 0.8 },
  background: IKB,
  environment: 'none',
  toneMapping: 'none',
  exposure: 1,
  shadow: true,
  ground: { y: -0.31, opacity: 0.55, color: '#00124A', size: 8 },
  idle: 'sway', idleAmp: 0.1, idleSpeed: 0.18,
  part: 'hand',
  drag: true,
};
