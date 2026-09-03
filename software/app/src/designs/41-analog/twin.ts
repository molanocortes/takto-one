// 41-analog twin - bronze under a tungsten lamp.
//
// Warm bronze members, a darker bronze palm, brass pins, bakelite-brown
// encoder boards. The environment is three tungsten panels (2700K) in a
// dark brown room, so every reflection is warm and the shadows go to
// bakelite. A gentle sway, a lamp-lit pool of amber under the hand.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import { type TwinSpec, softboxScene, dir } from '../../twin/Stage';

const metal = (color: string, roughness: number, metalness = 0.9, clearcoat = 0) =>
  new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), roughness, metalness, clearcoat, clearcoatRoughness: 0.3, envMapIntensity: 1.1 });

function materials(): Materials {
  return {
    shell: metal('#6E4E2C', 0.42),
    link: metal('#A57A48', 0.36),
    pin: metal('#E8C377', 0.2, 1.0),
    bank: metal('#2A1F18', 0.55, 0.1, 0.6),
    board: metal('#2A1F18', 0.55, 0.1, 0.6),
    glass: metal('#2A1F18', 0.55, 0.1, 0.6),
    spool: metal('#A57A48', 0.36),
  } as Materials;
}

function Lights() {
  return React.createElement(React.Fragment, null,
    React.createElement('directionalLight', { position: dir(300, 50, 6), intensity: 1.6, color: '#FFD9A6' }),
    React.createElement('directionalLight', { position: dir(120, 18, 6), intensity: 0.7, color: '#FFB877' }),
    React.createElement('hemisphereLight', { args: ['#5A4230', '#0F0A08', 0.6] }),
  );
}

export const twin: TwinSpec = {
  materials,
  Lights,
  camera: { fov: 26, distance: 2.0, azimuth: 206, elevation: 26, roll: 0, yaw0: 0.6, target: [0, 0.06, 0], fitAspect: 0.9 },
  background: null,
  environment: softboxScene([
    { pos: [-2, 4, 2], size: [5, 2.5], color: '#FFD3A0', intensity: 2.8 },
    { pos: [3.5, 1, -3], size: [0.8, 6], color: '#FFB874', intensity: 2.0 },
    { pos: [-4, 0, -2], size: [0.6, 5], color: '#FFE2B8', intensity: 1.2 },
  ], '#1A120C'),
  envIntensity: 1.0,
  toneMapping: 'aces',
  exposure: 1.0,
  shadow: false,
  idle: 'sway', idleAmp: 0.12, idleSpeed: 0.17,
  part: 'hand',
  drag: true,
};
