// 34-hud twin - a hologram.
//
// A fresnel shader: faces turned toward the viewer are nearly transparent,
// faces turning away glow phosphor green, so the hand is drawn by its own
// silhouettes and by the creases where one part meets another. Additive
// blending over black, depth writes off, a shimmer on the opacity, and a
// slow turntable, because a hologram rotates.
import React from 'react';
import * as THREE from 'three';
import type { Materials } from '../../twin/materials';
import type { TwinSpec } from '../../twin/Stage';

export const GREEN = '#62F5A3';
export const BG = '#040A07';

function holo(color: string, glow: string, power: number, base: number, opacity: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) }, uGlow: { value: new THREE.Color(glow) },
      uPower: { value: power }, uBase: { value: base }, uOpacity: { value: opacity },
    },
    vertexShader: `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform vec3 uGlow; uniform float uPower; uniform float uBase; uniform float uOpacity;
      varying vec3 vN; varying vec3 vV;
      void main() {
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), uPower);
        vec3 c = mix(uColor, uGlow, f);
        gl_FragColor = vec4(c * (uBase + f), (uBase + f) * uOpacity);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
}

function materials(): Materials {
  return {
    shell: holo('#0E4D30', GREEN, 2.4, 0.06, 0.8),
    link: holo('#146B42', '#A8FFD0', 2.0, 0.12, 0.9),
    pin: holo('#3AB57A', '#FFFFFF', 1.2, 0.35, 1.0),
    bank: holo('#0A3A24', '#8CFFC0', 1.6, 0.25, 0.9),
    board: holo('#0A3A24', '#8CFFC0', 1.6, 0.25, 0.9),
    glass: holo('#0A3A24', '#8CFFC0', 1.6, 0.25, 0.9),
    spool: holo('#146B42', '#A8FFD0', 2.0, 0.12, 0.9),
  } as unknown as Materials;
}

function Lights() { return null; }

export const twin: TwinSpec = {
  materials,
  Lights,
  camera: { fov: 26, distance: 2.1, azimuth: 195, elevation: 24, roll: 0, yaw0: 0.4, target: [0, 0.04, 0], fitAspect: 0.6 },
  background: null,
  environment: 'none',
  toneMapping: 'none',
  shadow: false,
  idle: 'turntable', idleSpeed: 0.18,
  part: 'hand',
  drag: true,
  onFrame: (mats, _dt, o) => {
    // the shimmer of a projection: a slow beat and a faint fast flicker
    const k = 0.92 + 0.06 * Math.sin(o.t * 1.7) + 0.02 * Math.sin(o.t * 23);
    for (const m of [mats.shell, mats.link] as unknown as THREE.ShaderMaterial[]) m.uniforms.uOpacity.value = k;
  },
};
