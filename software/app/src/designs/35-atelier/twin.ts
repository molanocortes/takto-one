// 35-atelier twin - a jewel.
//
// Polished titanium-gold members (metalness 0.95, roughness 0.16) that
// mirror a studio: a large warm softbox overhead, a long cool strip from
// behind, a low warm bounce, and a dark walnut room so the reflections
// have something dark to turn into. Encoder boards in black lacquer, pins
// in bright steel. A low lens, a slow swing, no ground: the hand floats in
// a pool of light.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import { type TwinSpec, softboxScene, dir } from '../../twin/Stage';

const phys = (color: string, roughness: number, metalness: number, clearcoat = 0, clearcoatRoughness = 0.1) =>
  new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), roughness, metalness, clearcoat, clearcoatRoughness, envMapIntensity: 1.2 });

function materials(): Materials {
  return {
    shell: phys('#B8955A', 0.22, 0.95),
    link: phys('#D2B27A', 0.16, 0.95),
    pin: phys('#F2F2F0', 0.10, 1.0),
    bank: phys('#0B0907', 0.12, 0.2, 1, 0.05),
    board: phys('#0B0907', 0.12, 0.2, 1, 0.05),
    glass: phys('#0B0907', 0.12, 0.2, 1, 0.05),
    spool: phys('#D2B27A', 0.16, 0.95),
  } as Materials;
}

function Lights() {
  return React.createElement(React.Fragment, null,
    React.createElement('directionalLight', { position: dir(320, 55, 6), intensity: 1.2, color: '#FFF1DC' }),
    React.createElement('directionalLight', { position: dir(130, 20, 6), intensity: 1.0, color: '#D9E4FF' }),
    React.createElement('directionalLight', { position: dir(200, -30, 6), intensity: 0.4, color: '#FFD9A8' }),
  );
}

export const twin: TwinSpec = {
  materials,
  Lights,
  camera: { fov: 24, distance: 2.1, azimuth: 208, elevation: 16, roll: 0, yaw0: 0.75, target: [0, 0.05, 0], fitAspect: 1.0 },
  background: null,
  environment: softboxScene([
    { pos: [-1.5, 5, 1], size: [6, 3], color: '#FFF3E0', intensity: 3.2 },
    { pos: [4, 1.5, -3], size: [0.8, 7], color: '#DCE6FF', intensity: 2.6 },
    { pos: [-4, 0.5, -2], size: [0.5, 5], color: '#FFE8C8', intensity: 1.4 },
    { pos: [0, -4, 0], size: [10, 10], color: '#3A2A1A', intensity: 0.8 },
  ], '#1A120C'),
  envIntensity: 1.0,
  toneMapping: 'aces',
  exposure: 1.05,
  shadow: false,
  idle: 'sway', idleAmp: 0.26, idleSpeed: 0.11,
  part: 'hand',
  drag: true,
};
