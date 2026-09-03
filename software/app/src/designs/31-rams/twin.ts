// 31-rams twin - the white product, photographed on the panel.
//
// Satin white members under a thin clearcoat, so the cylinders carry one
// crisp highlight each from a large softbox high on the left; dark steel
// pins and graphite encoder boards for contrast INSIDE the object; a cool
// strip light from behind right to draw the silhouette off the grey; and a
// ground that catches one shadow, so the hand stands on the panel rather
// than floating in front of it.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import { type TwinSpec, softboxScene, dir } from '../../twin/Stage';
import { C } from './tokens';

const phys = (color: string, roughness: number, metalness = 0, clearcoat = 0, clearcoatRoughness = 0.2) =>
  new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), roughness, metalness, clearcoat, clearcoatRoughness, envMapIntensity: 1 });

function materials(): Materials {
  return {
    shell: phys('#E2E1DC', 0.40, 0, 0.5, 0.22),
    link: phys('#EFEEEA', 0.34, 0, 0.55, 0.18),
    pin: phys('#45464A', 0.32, 0.85, 0, 0),
    bank: phys('#2C2C2E', 0.55, 0.15, 0.1, 0.5),
    board: phys('#2A2B2E', 0.5, 0.2, 0.15, 0.4),
    glass: phys('#2A2B2E', 0.5, 0.2),
    spool: phys('#E6E6E6', 0.5, 0, 0.2, 0.4),
  } as Materials;
}

const KEY = dir(300, 50, 7);
const RIM = dir(120, 22, 7);

function Lights() {
  return React.createElement(React.Fragment, null,
    React.createElement('directionalLight', {
      position: KEY, intensity: 2.4, color: '#FFF8EE', castShadow: true,
      'shadow-mapSize-width': 2048, 'shadow-mapSize-height': 2048, 'shadow-radius': 6,
      'shadow-bias': -0.0006, 'shadow-normalBias': 0.02,
      'shadow-camera-near': 1, 'shadow-camera-far': 16,
      'shadow-camera-left': -0.8, 'shadow-camera-right': 0.8, 'shadow-camera-top': 0.8, 'shadow-camera-bottom': -0.8,
    }),
    React.createElement('directionalLight', { position: RIM, intensity: 1.6, color: '#DDE7FF' }),
    React.createElement('directionalLight', { position: dir(200, 10, 6), intensity: 0.5, color: '#FFFFFF' }),
    React.createElement('hemisphereLight', { args: ['#FFFFFF', '#9E9B94', 0.55] }),
  );
}

export const twin: TwinSpec = {
  materials,
  Lights,
  camera: { fov: 27, distance: 1.9, azimuth: 198, elevation: 30, roll: 0, yaw0: 0.5, target: [0.03, 0.1, 0], fitAspect: 0.69 },
  background: C.window,
  environment: softboxScene([
    { pos: [-3, 4, 2], size: [5, 3], color: '#FFFFFF', intensity: 2.6 },
    { pos: [3.5, 2, -3], size: [1, 6], color: '#DDE7FF', intensity: 2.0 },
    { pos: [0, -3, 0], size: [8, 8], color: '#D9D6CF', intensity: 0.5 },
  ], '#6E6C68'),
  envIntensity: 0.9,
  toneMapping: 'neutral',
  exposure: 1.0,
  shadow: true,
  ground: { y: -0.31, opacity: 0.28, color: '#2A2620', size: 6 },
  idle: 'sway', idleAmp: 0.09, idleSpeed: 0.2,
  scale: 1.0,
  part: 'hand',
  drag: true,
};
