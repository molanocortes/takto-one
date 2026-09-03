// 44-cutaway twin - a section through the mechanism.
//
// A clipping plane facing the camera removes the near half of every
// member, so the telescopic slides, the pins and the encoder boards inside
// are seen the way a cutaway drawing shows them. Members matte pale
// grey-blue, double sided so the hollow interiors read; pins bright
// orange, boards cyan, on navy. A cool key from the front, a warm rim.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import { type TwinSpec, dir } from '../../twin/Stage';

export const NAVY = '#0B1730';
const AZ = 200;
// the plane sits a hair toward the camera from the hand's centre and keeps the far half
const n = new THREE.Vector3(Math.sin((AZ * Math.PI) / 180), 0, Math.cos((AZ * Math.PI) / 180));
const PLANE = new THREE.Plane(n.clone().negate(), -0.012);

const mat = (color: string, roughness: number, metalness = 0, emissive?: string) =>
  new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness, side: THREE.DoubleSide, clippingPlanes: [PLANE], emissive: new THREE.Color(emissive ?? '#000000'), emissiveIntensity: emissive ? 0.6 : 0 });

function materials(): Materials {
  return {
    shell: mat('#93A3B8', 0.72),
    link: mat('#BFCBD9', 0.68),
    pin: mat('#FF7A1A', 0.4, 0.3, '#FF7A1A'),
    bank: mat('#22D3EE', 0.5, 0.1, '#22D3EE'),
    board: mat('#22D3EE', 0.5, 0.1, '#22D3EE'),
    glass: mat('#22D3EE', 0.5, 0.1, '#22D3EE'),
    spool: mat('#BFCBD9', 0.68),
  } as Materials;
}

function Lights() {
  return React.createElement(React.Fragment, null,
    React.createElement('directionalLight', { position: dir(AZ + 40, 40, 6), intensity: 2.2, color: '#E8F1FF' }),
    React.createElement('directionalLight', { position: dir(AZ + 180, 20, 6), intensity: 0.9, color: '#FFB27A' }),
    React.createElement('hemisphereLight', { args: ['#9FB6D6', '#0B1730', 0.8] }),
  );
}

export const twin: TwinSpec = {
  materials,
  Lights,
  camera: { fov: 24, distance: 2.1, azimuth: AZ, elevation: 18, roll: 0, yaw0: 0.62, target: [0, 0.05, 0], fitAspect: 0.8 },
  background: NAVY,
  environment: 'none',
  toneMapping: 'none',
  exposure: 1,
  shadow: false,
  clipping: true,
  idle: 'still',
  part: 'hand',
  drag: true,
};
