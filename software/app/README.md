# TAKTO companion

A digital twin and instrument panel for TAKTO ONE, for iOS, Android and the
browser from one codebase.

<div align="center">
<img src="../../docs/media/app-live.gif" alt="Overview, Analytics and Logs running on one clock" width="100%">
</div>

Three surfaces on one data path:

| | |
| --- | --- |
| **Overview** | The device at a glance: the twin lying on the page, the system health number and its trace, the hand picker, four housekeeping channels with live traces, the battery and the mode. |
| **Analytics** | The twelve joints and the activation channel as traces, finger by finger. |
| **Logs** | The source and its address, the bundled sessions to replay, and the four rates that are easy to confuse. |

Everything runs with **no hardware attached**. The app opens on a synthetic
feed; point it at a bridge from the Logs tab when you have a device.

## Run it

```bash
npm install
npx expo start
```

Then press `w` for the browser, `i` for an iOS simulator, or `a` for Android.
A native run builds through Expo in the usual way (`npx expo run:ios`,
`npx expo run:android`) and needs the corresponding platform toolchain.

To drive it from real hardware, start the bridge and give the app its address
on the Data screen:

```bash
SENSORYHAND_STATE_DIR=.takto-state python3 ../bridge/teensy_bridge.py --sim
```

`--sim` feeds synthetic joints; swap it for `--port /dev/cu.usbmodemXXXX` with
a Teensy attached. The default address is `ws://localhost:8765/ws`; from a
phone, use the machine's LAN address instead of localhost.

## What it is built on

- **The real CAD, at full resolution.** `assets/model/zero_hand_full.glb` is the
  repository's own export of the V7 assembly, 607k triangles, names and
  transforms untouched. It ships without normals, so the loader welds its
  vertices and computes smooth ones; `zero_hand.glb` (143k, web-decimated)
  stays beside it for low-memory devices, switched by one constant in
  `src/twin/loadHand.ts`. The rig binds to the GLB's own node names, because
  those names are the mechanism.
- **The shared mechanical model.** `src/data/kinematics.js` is carried
  byte-for-byte from `software/console`. Joint angles, the telescopic slides
  they demand, and the spool rotations that produce them all come from there.
  Nothing in the twin is tuned by eye.
- **The real take format.** The three bundled sessions are the repository's own
  samples from `software/bridge/samples/`, and a take recorded by the device
  drops in unchanged.
- **The real wire contract.** The bridge client reads the same `snap` frames
  the operator console reads.

## The look

A light instrument, built to a reference screen and checked against it
pixel for pixel at the reference's own 393 by 895 points:

- **The page** is one warm grey. There are no cards; the only surfaces are
  the three-tile pickers and the tab bar, and the only lines are hairlines.
- **Two typefaces.** JetBrains Mono, in tracked capitals, for every label.
  Inter for words and numerals, at weight 300 for the big ones.
- **The machine lies on the page** as in the product still: white, matte,
  seen from high and to the front, with a short soft shadow. It is the same
  articulated CAD as before, so it moves with the feed.
- **Three signal colours** belong to the traces and their dots: blue, green,
  amber. Green also marks the battery arc and the mode's AUTO tag. Nothing
  else is coloured.

Tokens are stated once in `src/ui/tokens.ts`; the shapes every screen is
built from are `src/ui/primitives.tsx` and `src/ui/Chrome.tsx`.

## Honest limits

- The twin renders **the mechanism**, not a person. Wrist articulation from the
  IMUs is not applied yet, and the thumb is sensing-only on the device.
- **Temperature, motor load, position accuracy, response time, battery and
  the health number are modelled by the synthetic feed**, not measured by the
  device. The bridge does not carry them yet; on a real link they show as a
  dash until the firmware reports them. The joints and the activation channel
  are the real contract.
- The reference still shows the tendon cables between hand and housing. The
  CAD export carries no cables, so the twin shows the gap.
- The screen on the forearm lights with activity. That is the glass lighting
  up, not a capture of the panel: the model carries no display content.
- The bundled takes are **choreographed and synthetic**, by their own README's
  admission. No hand wore the device to make them. The live synthetic feed is
  the same kind of thing: a 32 s choreography in `src/data/sim.ts` that rests
  open and spread, and departs from that pose into taps, a bloom, a wave and
  a grasp.
- The samples write anatomical values into the `{f}_mcp` column, which the
  device's wire contract uses for MCP **abduction**. This app maps columns the
  same way `software/web/src/views/replay.js` does, so replayed abduction can
  read past the mechanism's 16 degree limit. The transport says so and the
  twin clamps it.
- The full mesh is 10.9 MB in the bundle and 607k triangles on the GPU. It
  renders at 60 Hz on a laptop's software GL; on a low-end phone, flip
  `MODEL` in `src/twin/loadHand.ts` to `lite`.
- Verified on the **web** target, which is also what the capture tool renders
  and what every image on this page came from. The iOS and Android bundles
  export from the same source (`npx expo export --platform ios` and
  `--platform android`), but neither has been run on a device or a simulator
  here, so treat the native targets as compiling rather than as exercised.
  `expo-blur` on Android needs `experimentalBlurMethod` to blur at all, which
  is an open item for the first device run.

## Regenerating the media

The synthetic feed is a pure function of time and the app accepts `?t=`,
`?screen=` and `?take=`, so every captured frame is reproducible. See
[`tools/capture.mjs`](tools/capture.mjs) for the stills and the loop frames,
[`tools/compose.mjs`](tools/compose.mjs) for the docs composite, and
[`tools/gif.mjs`](tools/gif.mjs) for the loop.
