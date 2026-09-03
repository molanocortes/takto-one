// 37-watch twin - brushed steel in a watch case.
//
// Anisotropic metal: the brushing runs along each member, so a highlight
// stretches into a streak instead of a point. Gunmetal palm, black boards,
// polished rose-gold pins as the one warm note. A two-strip studio and a
// black room, exposure held down so the steel stays dark with bright
// streaks, the way a watch case photographs.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import { type TwinSpec, softboxScene, dir } from '../../twin/Stage';

const metal = (color: string, roughness: number, anisotropy = 0) =>
  new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), roughness, metalness: 1, anisotropy, anisotropyRotation: Math.PI / 2, envMapIntensity: 1.3 });

function materials(): Materials {
  return {
    shell: metal('#7C8086', 0.42, 0.9),
    link: metal('#C4C7CB', 0.36, 1.0),
    pin: metal('#D9A66A', 0.12, 0),
    bank: metal('#111214', 0.5, 0.5),
    board: metal('#131416', 0.5, 0.5),
    glass: metal('#131416', 0.5, 0.5),
    spool: metal('#C4C7CB', 0.36, 1.0),
  } as Materials;
}

function Lights() {
  return React.createElement(React.Fragment, null,
    React.createElement('directionalLight', { position: dir(300, 60, 6), intensity: 1.4, color: '#FFFFFF' }),
    React.createElement('directionalLight', { position: dir(120, 15, 6), intensity: 0.8, color: '#CFDCFF' }),
  );
}

export const twin: TwinSpec = {
  materials,
  Lights,
  camera: { fov: 24, distance: 2.25, azimuth: 200, elevation: 30, roll: 0, yaw0: 0.55, target: [0, 0.04, 0], fitAspect: 1.2 },
  background: null,
  environment: softboxScene([
    { pos: [-2, 5, 1], size: [7, 1.2], color: '#FFFFFF', intensity: 3.5 },
    { pos: [3.5, 1, -3], size: [0.6, 8], color: '#C9D8FF', intensity: 2.2 },
    { pos: [-4, -1, -1], size: [0.5, 6], color: '#FFFFFF', intensity: 1.2 },
  ], '#050506'),
  envIntensity: 1.0,
  toneMapping: 'aces',
  exposure: 0.95,
  shadow: false,
  idle: 'breathe', idleAmp: 0.4, idleSpeed: 0.6,
  part: 'hand',
  drag: true,
};
