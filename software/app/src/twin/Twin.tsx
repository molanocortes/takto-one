// Twin.tsx - the stage the machine stands on.
//
// Framing follows what the project's render work already learned the hard way:
// elevation around 26-36 degrees, because low angles foreshorten the fingers
// into a cluster and a raised camera opens the top face so the screen, the
// spool bank and the finger array all read at once. Exactly ONE light casts.
import React, { useMemo, useRef, useState } from 'react';
import { View, PanResponder, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from './canvas';
import { Hand } from './Hand';
import { STUDIO, keyDirection } from './materials';
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

function Rig({ orbit }: { orbit: React.MutableRefObject<Orbit> }) {
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
    const roll = (VIEW.rollDeg * Math.PI) / 180;
    camera.position.set(
      VIEW.distance * Math.cos(el) * Math.sin(az),
      VIEW.distance * Math.sin(el),
      VIEW.distance * Math.cos(el) * Math.cos(az),
    );
    // Roll the camera rather than the model: the machine keeps its own upright
    // frame, and the diagonal is a framing decision, not a pose.
    camera.up.set(Math.sin(roll), Math.cos(roll), 0);
    camera.lookAt(VIEW.target[0], VIEW.target[1], VIEW.target[2]);
  }, [camera]);

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
    <group ref={turn} rotation={[0, VIEW.yaw0, 0]}>
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <Hand />
      </group>
    </group>
  );
}

function Lights({ shadow }: { shadow: boolean }) {
  const key = useMemo(() => keyDirection(6), []);
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

export function Twin({ style, shadow = true }: { style?: StyleProp<ViewStyle>; shadow?: boolean }) {
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
    <View style={[styles.wrap, style]} {...pan.panHandlers}>
      <Canvas
        shadows={shadow}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: false }}
        camera={{ fov: VIEW.fovDeg, near: 0.1, far: 40 }}
        onCreated={({ gl, scene }: any) => {
          // Standard view transform, no look. A filmic transform flattens a
          // white page to grey, which is the one thing this stage cannot do.
          gl.toneMapping = THREE.NoToneMapping;
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
          scene.background = new THREE.Color(STUDIO.page);
        }}
      >
        <Lights shadow={shadow} />
        <Rig orbit={orbit} />
        {/* the ground exists only to catch the one shadow */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.52, 0]} receiveShadow>
          <planeGeometry args={[7, 7]} />
          <shadowMaterial opacity={0.19} />
        </mesh>
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: C.stage, overflow: 'hidden' },
});
