// Twin.tsx - the stage the machine stands on.
//
// Framing follows what the project's render work already learned the hard way:
// elevation around 26-36 degrees, because low angles foreshorten the fingers
// into a cluster and a raised camera opens the top face so the screen, the
// spool bank and the finger array all read at once. Exactly ONE light casts.
import React, { useMemo, useRef, useState } from 'react';
import { View, PanResponder, StyleSheet, Platform, type StyleProp, type ViewStyle } from 'react-native';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Canvas, useFrame, useThree } from './canvas';
import { Hand } from './Hand';
import { STUDIO, keyDirection, LOOKS, type Look } from './materials';
import { C } from '../ui/tokens';

const VIEW = {
  fovDeg: 26,          // a long lens: product photography, not a game camera
  distance: 2.62,
  azimuth: 214,        // degrees, inside the front arc
  elevation: 27,
  // A slight roll puts the device on the diagonal, which is the only way a
  // long object fills a portrait frame without being shrunk to fit it.
  rollDeg: -15,
  /** the resting turntable angle: the three-quarter that opens the top face */
  yaw0: 0.62,
  target: [0, 0.01, 0] as [number, number, number],
};

type Orbit = { yaw: number; pitch: number; drifting: boolean; t: number };

function Rig({ orbit, colourway, scale = 1, look, part }: { orbit: React.MutableRefObject<Orbit>; colourway: 'white' | 'graphite'; scale?: number; look: Look; part: 'device' | 'hand' }) {
  // TWO frames, deliberately. The outer group turns about the WORLD vertical,
  // which is what a turntable is; the inner group carries the fixed rotation
  // that stands the device up (+Z is distal in the CAD, so the fingers point
  // along +Y once it is up). Collapsing these into one group makes the yaw
  // spin the device about its own length instead, which reads as a tumble.
  const turn = useRef<THREE.Group>(null);
  const { camera } = useThree();

  useMemo(() => {
    const az = (VIEW.azimuth * Math.PI) / 180;
    const el = (VIEW.elevation * Math.PI) / 180;
    // the hand alone is a squarer object: no diagonal needed to fill the frame
    const roll = ((part === 'hand' ? -4 : VIEW.rollDeg) * Math.PI) / 180;
    camera.position.set(
      VIEW.distance * Math.cos(el) * Math.sin(az),
      VIEW.distance * Math.sin(el),
      VIEW.distance * Math.cos(el) * Math.cos(az),
    );
    // Roll the camera rather than the model: the machine keeps its own upright
    // frame, and the diagonal is a framing decision, not a pose.
    camera.up.set(Math.sin(roll), Math.cos(roll), 0);
    camera.lookAt(VIEW.target[0], VIEW.target[1], VIEW.target[2]);
  }, [camera, part]);

  useFrame((_: any, dt: number) => {
    const g = turn.current;
    if (!g) return;
    const o = orbit.current;
    o.t += dt;
    // Motion is information, so the idle is a slow sway, not a carousel: it
    // says the twin is live without asking to be watched. A full turn is for
    // the capture harness, not for someone reading numbers.
    const idle = o.drifting ? Math.sin(o.t * 0.24) * 0.13 : 0;
    g.rotation.y = VIEW.yaw0 + o.yaw + idle;
    g.rotation.x = o.pitch;
  });

  return (
    <group ref={turn} rotation={[0, VIEW.yaw0, 0]} scale={scale * (part === 'hand' ? 0.8 : 1)}>
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <Hand colourway={colourway} look={look} part={part} />
      </group>
    </group>
  );
}

function Lights({ shadow, dark }: { shadow: boolean; dark: boolean }) {
  const key = useMemo(() => keyDirection(6), []);
  if (dark) {
    // The black studio of a product shoot: one large soft key high left, a
    // broad cool rim from behind right to draw the silhouette off the black,
    // a low warm bounce so the underside is not a hole, and the room
    // environment doing the rest as a sheen on the clearcoat.
    return (
      <>
        <directionalLight position={key} intensity={1.9} color="#FFF6EC" castShadow={shadow}
          shadow-mapSize-width={2048} shadow-mapSize-height={2048} shadow-radius={8}
          shadow-bias={-0.0008} shadow-normalBias={0.02} shadow-camera-near={0.5} shadow-camera-far={14}
          shadow-camera-left={-1.05} shadow-camera-right={1.05}
          shadow-camera-top={1.05} shadow-camera-bottom={-1.05} />
        <directionalLight position={[-4, 2.5, -5]} intensity={1.5} color="#CFE0FF" />
        <directionalLight position={[4, 1, -3]} intensity={1.2} color="#E8EEFF" />
        <directionalLight position={[2, -3, 3]} intensity={0.35} color="#FFD9C4" />
        <hemisphereLight args={['#8A8D94', '#0A0A0C', 1.0]} />
        <directionalLight position={[0, 4, 4]} intensity={0.6} color="#FFFFFF" />
      </>
    );
  }
  return (
    <>
      {/* One casting light. Five casting lights smear five overlapping
          shadows across the ground and no key position improves it. */}
      <directionalLight
        position={key}
        intensity={2.05}
        castShadow={shadow}
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-radius={4}
        shadow-bias={-0.0012}
        shadow-camera-near={0.5}
        shadow-camera-far={14}
        shadow-camera-left={-1.05}
        shadow-camera-right={1.05}
        shadow-camera-top={1.05}
        shadow-camera-bottom={-1.05}
      />
      {/* Fill only: it lifts the shadow side off black without casting. */}
      <hemisphereLight args={['#FFFFFF', '#D8D6D2', 1.15]} />
      <ambientLight intensity={0.42} />
    </>
  );
}

/** The look the dark stage renders. On web, ?look= overrides it for exploration. */
export const DEFAULT_LOOK: Look = 'studio';
function urlLook(): Look {
  if (Platform.OS === 'web' && typeof location !== 'undefined') {
    const l = new URLSearchParams(location.search).get('look') as Look | null;
    if (l && LOOKS.includes(l)) return l;
  }
  return DEFAULT_LOOK;
}
/** ?part=hand renders the hand alone, without the forearm housing */
function urlPart(): 'device' | 'hand' {
  if (Platform.OS === 'web' && typeof location !== 'undefined') {
    if (new URLSearchParams(location.search).get('part') === 'hand') return 'hand';
  }
  return 'device';
}

export function Twin({ style, shadow = true, stage = 'dark', scale = 1, look, part }: {
  style?: StyleProp<ViewStyle>; shadow?: boolean; stage?: 'dark' | 'light'; scale?: number; look?: Look;
  part?: 'device' | 'hand';
}) {
  const dark = stage === 'dark';
  const theLook = look ?? urlLook();
  const thePart = part ?? urlPart();
  const exposure = ({ studio: 0.92, graphite: 1.15, clay: 1.05, ceramic: 0.85, ink: 1.2, xray: 1.0, midnight: 1.3, slate: 1.15, frost: 0.9 } as Partial<Record<Look, number>>)[theLook] ?? 1.05;
  const orbit = useRef<Orbit>({ yaw: 0, pitch: 0, drifting: true, t: 0 });
  const start = useRef({ yaw: 0, pitch: 0 });

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 3,
        onPanResponderGrant: () => {
          orbit.current.drifting = false;
          start.current = { yaw: orbit.current.yaw, pitch: orbit.current.pitch };
        },
        onPanResponderMove: (_, g) => {
          orbit.current.yaw = start.current.yaw + g.dx * 0.008;
          // Keep the camera in the band that flatters the device: never below
          // the horizon, never straight down on it.
          orbit.current.pitch = Math.max(-0.55, Math.min(0.42, start.current.pitch + g.dy * 0.006));
        },
      }),
    [],
  );

  return (
    <View style={[styles.wrap, dark && { backgroundColor: C.bg }, style]} {...pan.panHandlers}>
      {/* the dark stage is one tone of black: the machine is the only thing lit */}
      <Canvas
        shadows={shadow}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: dark }}
        camera={{ fov: VIEW.fovDeg, near: 0.1, far: 40 }}
        onCreated={({ gl, scene }: any) => {
          // Standard view transform, no look. A filmic transform flattens a
          // white page to grey, which is the one thing this stage cannot do.
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
          scene.background = dark ? null : new THREE.Color(STUDIO.page);
          if (dark) {
            // A filmic transform and a neutral room environment: the graphite
            // shell needs something to reflect, or it reads as flat plastic.
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = exposure;
            const pmrem = new THREE.PMREMGenerator(gl);
            scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
            scene.environmentIntensity = 0.45;
            pmrem.dispose();
          } else {
            gl.toneMapping = THREE.NoToneMapping;
          }
        }}
      >
        <Lights shadow={shadow} dark={dark} />
        <Rig orbit={orbit} colourway={dark ? 'graphite' : 'white'} scale={scale} look={theLook} part={thePart} />
        {/* the ground exists only to catch the one shadow; on black there is none to catch */}
        {!dark && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.52, 0]} receiveShadow>
            <planeGeometry args={[7, 7]} />
            <shadowMaterial opacity={0.19} />
          </mesh>
        )}
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: '#FFFFFF', overflow: 'hidden' },
});
