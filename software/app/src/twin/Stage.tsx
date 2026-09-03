// Stage.tsx - a twin stage that a design describes as data.
//
// Twin.tsx is the baseline's stage and stays untouched for design 30. Every
// design from 31 on renders the same rigged hand (Hand.tsx, the shared
// kinematics, the real GLB) through this component, and owns everything
// that makes it LOOK like something: the material set, the lights, the
// lens, the ground, the environment, the transform and the idle motion.
import React, { useMemo, useRef } from 'react';
import { View, PanResponder, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Canvas, useFrame, useThree } from './canvas';
import { Hand } from './Hand';
import type { Materials } from './materials';
import { session } from '../data/session';

export type CameraSpec = {
  /** vertical field of view, degrees. 22-32 is a product lens */
  fov: number;
  distance: number;
  /** degrees around the world vertical; 180 looks from -Z, 214 is the baseline three-quarter */
  azimuth: number;
  /** degrees above the horizon */
  elevation: number;
  /** camera roll, degrees */
  roll?: number;
  /** the resting turntable angle of the hand */
  yaw0?: number;
  /** a fixed tilt of the hand about its own X */
  pitch0?: number;
  target?: [number, number, number];
  /**
   * The window aspect (w/h) the distance was set for. A wider window than
   * this moves the camera in by the square root of the ratio, so a hand
   * framed for a tall window is not lost in a short one.
   */
  fitAspect?: number;
};

export type Orbit = { yaw: number; pitch: number; drifting: boolean; t: number };

export type TwinSpec = {
  materials: () => Materials;
  Lights: React.ComponentType<{ orbit: React.MutableRefObject<Orbit> }>;
  camera: CameraSpec;
  /** scene background; null keeps the canvas transparent so the design paints the stage */
  background?: string | null;
  environment?: 'room' | 'none' | (() => THREE.Scene);
  envIntensity?: number;
  toneMapping?: 'aces' | 'none' | 'neutral' | 'agx' | 'reinhard' | 'cineon';
  exposure?: number;
  shadow?: boolean;
  /** a shadow catcher under the hand */
  ground?: { y: number; opacity: number; color?: string; size?: number };
  idle?: 'sway' | 'turntable' | 'still' | 'breathe';
  idleAmp?: number;
  idleSpeed?: number;
  /** how much of the feed's own hand roll the twin performs, 0..1 */
  followRoll?: number;
  scale?: number;
  part?: 'hand' | 'device';
  /** extra scene content: grids, backdrops, floors, particles */
  Extras?: React.ComponentType<{ orbit: React.MutableRefObject<Orbit> }>;
  /** runs once over the rigged model */
  decorate?: (root: THREE.Group, model: THREE.Object3D) => void;
  drag?: boolean;
  dpr?: [number, number];
  /** pitch band the drag may reach */
  pitchBand?: [number, number];
  /** the material set is shared, so a design that animates materials per frame does it here */
  onFrame?: (mats: Materials, dt: number, orbit: Orbit) => void;
};

const TONE: Record<NonNullable<TwinSpec['toneMapping']>, THREE.ToneMapping> = {
  aces: THREE.ACESFilmicToneMapping, none: THREE.NoToneMapping, neutral: THREE.NeutralToneMapping,
  agx: THREE.AgXToneMapping, reinhard: THREE.ReinhardToneMapping, cineon: THREE.CineonToneMapping,
};

const HAND_QUAT = new THREE.Quaternion();

function Rig({ spec, orbit, mats }: { spec: TwinSpec; orbit: React.MutableRefObject<Orbit>; mats: Materials }) {
  const turn = useRef<THREE.Group>(null);
  const { camera, size } = useThree();
  const cam = spec.camera;
  const part = spec.part ?? 'hand';
  const aspect = size.width / Math.max(1, size.height);
  const fit = cam.fitAspect && aspect > cam.fitAspect ? Math.sqrt(cam.fitAspect / aspect) : 1;

  useMemo(() => {
    const az = (cam.azimuth * Math.PI) / 180;
    const el = (cam.elevation * Math.PI) / 180;
    const roll = ((cam.roll ?? 0) * Math.PI) / 180;
    const d = cam.distance * fit;
    camera.position.set(
      d * Math.cos(el) * Math.sin(az),
      d * Math.sin(el),
      d * Math.cos(el) * Math.cos(az),
    );
    camera.up.set(Math.sin(roll), Math.cos(roll), 0);
    const t = cam.target ?? [0, 0, 0];
    camera.lookAt(t[0], t[1], t[2]);
    (camera as THREE.PerspectiveCamera).fov = cam.fov;
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
  }, [camera, cam.azimuth, cam.elevation, cam.distance, cam.roll, cam.fov, cam.target, fit]);

  useFrame((_: any, dt: number) => {
    const g = turn.current;
    if (!g) return;
    const o = orbit.current;
    o.t += dt;
    const amp = spec.idleAmp ?? 0.13;
    const spd = spec.idleSpeed ?? 0.24;
    let idle = 0, bob = 0;
    if (o.drifting) {
      if (spec.idle === 'turntable') idle = o.t * spd;
      else if (spec.idle === 'sway' || spec.idle === undefined) idle = Math.sin(o.t * spd) * amp;
      else if (spec.idle === 'breathe') bob = Math.sin(o.t * spd) * amp * 0.1;
    }
    g.rotation.y = (cam.yaw0 ?? 0.62) + o.yaw + idle;
    g.rotation.x = (cam.pitch0 ?? 0) + o.pitch;
    g.position.y = bob;
    if (spec.followRoll) {
      // the feed carries a wrist roll; a slice of it moves the whole hand
      const q = session.frame.hand;
      HAND_QUAT.set(q[1], q[2], q[3], q[0]);
      const e = new THREE.Euler().setFromQuaternion(HAND_QUAT);
      g.rotation.z = e.z * spec.followRoll;
    }
    spec.onFrame?.(mats, dt, o);
  });

  return (
    <group ref={turn} rotation={[0, cam.yaw0 ?? 0.62, 0]} scale={(spec.scale ?? 1) * (part === 'hand' ? 0.58 : 0.78)}>
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <Hand materials={mats} part={part} decorate={spec.decorate} />
      </group>
    </group>
  );
}

export function Stage({ spec, style, orbitRef }: {
  spec: TwinSpec; style?: StyleProp<ViewStyle>; orbitRef?: React.MutableRefObject<Orbit>;
}) {
  const own = useRef<Orbit>({ yaw: 0, pitch: 0, drifting: true, t: 0 });
  const orbit = orbitRef ?? own;
  const start = useRef({ yaw: 0, pitch: 0 });
  const mats = useMemo(() => spec.materials(), [spec.materials]);
  const band = spec.pitchBand ?? [-0.55, 0.42];

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => spec.drag !== false,
    onMoveShouldSetPanResponder: (_, g) => spec.drag !== false && Math.abs(g.dx) + Math.abs(g.dy) > 3,
    onPanResponderGrant: () => {
      orbit.current.drifting = false;
      start.current = { yaw: orbit.current.yaw, pitch: orbit.current.pitch };
    },
    onPanResponderMove: (_, g) => {
      orbit.current.yaw = start.current.yaw + g.dx * 0.008;
      orbit.current.pitch = Math.max(band[0], Math.min(band[1], start.current.pitch + g.dy * 0.006));
    },
  }), [spec.drag]);

  const Lights = spec.Lights;
  const Extras = spec.Extras;
  const shadow = spec.shadow ?? false;
  const transparent = spec.background === null || spec.background === undefined;

  return (
    <View style={[st.wrap, style]} {...pan.panHandlers}>
      <Canvas
        shadows={shadow}
        dpr={spec.dpr ?? [1, 2]}
        gl={{ antialias: true, alpha: transparent, premultipliedAlpha: true }}
        camera={{ fov: spec.camera.fov, near: 0.1, far: 40 }}
        onCreated={({ gl, scene }: any) => {
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
          gl.toneMapping = TONE[spec.toneMapping ?? 'neutral'];
          gl.toneMappingExposure = spec.exposure ?? 1;
          scene.background = transparent ? null : new THREE.Color(spec.background as string);
          const env = spec.environment ?? 'room';
          if (env !== 'none') {
            const pmrem = new THREE.PMREMGenerator(gl);
            const src = env === 'room' ? new RoomEnvironment() : env();
            scene.environment = pmrem.fromScene(src, 0.04).texture;
            scene.environmentIntensity = spec.envIntensity ?? 0.5;
            pmrem.dispose();
          }
        }}
      >
        <Lights orbit={orbit} />
        <Rig spec={spec} orbit={orbit} mats={mats} />
        {Extras && <Extras orbit={orbit} />}
        {spec.ground && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, spec.ground.y, 0]} receiveShadow>
            <planeGeometry args={[spec.ground.size ?? 8, spec.ground.size ?? 8]} />
            <shadowMaterial opacity={spec.ground.opacity} color={spec.ground.color ?? '#000000'} />
          </mesh>
        )}
      </Canvas>
    </View>
  );
}

/** A soft studio softbox: a bright plane in the environment scene. */
export function softboxScene(panels: { pos: [number, number, number]; size: [number, number]; color: string; intensity: number; lookAt?: [number, number, number] }[], ambient = '#000000') {
  return () => {
    const s = new THREE.Scene();
    s.background = new THREE.Color(ambient);
    for (const p of panels) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(p.size[0], p.size[1]),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color).multiplyScalar(p.intensity), side: THREE.DoubleSide }),
      );
      m.position.set(...p.pos);
      const la = p.lookAt ?? [0, 0, 0];
      m.lookAt(la[0], la[1], la[2]);
      s.add(m);
    }
    return s;
  };
}

/** A gradient sky: a big sphere lit from the top tone down to the ground tone. */
export function gradientSkyScene(top: string, horizon: string, bottom: string, intensity = 1) {
  return () => {
    const s = new THREE.Scene();
    const geo = new THREE.SphereGeometry(20, 32, 16);
    const cols: number[] = [];
    const pos = geo.attributes.position;
    const a = new THREE.Color(top), b = new THREE.Color(horizon), c = new THREE.Color(bottom);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 20;
      if (y >= 0) tmp.copy(b).lerp(a, y); else tmp.copy(b).lerp(c, -y);
      cols.push(tmp.r * intensity, tmp.g * intensity, tmp.b * intensity);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    s.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    return s;
  };
}

/** Shell out a direction on a sphere, degrees, for light placement. */
export function dir(azimuthDeg: number, elevationDeg: number, r = 6): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180, el = (elevationDeg * Math.PI) / 180;
  return [r * Math.cos(el) * Math.sin(az), r * Math.sin(el), r * Math.cos(el) * Math.cos(az)];
}

const st = StyleSheet.create({ wrap: { overflow: 'hidden' } });
