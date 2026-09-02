# TAKTO companion

A digital twin and instrument panel for TAKTO ONE, for iOS, Android and the
browser from one codebase.

<div align="center">
<img src="../../docs/media/app-screens.png" alt="Live, Replay and Data" width="100%">
</div>

Three surfaces on one data path:

| | |
| --- | --- |
| **Live** | The device now. The articulated twin above, the twelve joints and the activation channel below. |
| **Replay** | A recorded session played back into the same twin, with a scrubber over the take's own effort trace. |
| **Data** | The channels themselves, what each one measures, and where the stream is coming from. |

Everything runs with **no hardware attached**. The app opens on a synthetic
feed and says so on every screen; point it at a bridge when you have a device.

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

- **The real CAD.** `assets/model/zero_hand.glb` is the repository's own
  web-decimated export of the V7 assembly, 154k triangles, names and
  transforms untouched. The rig binds to the GLB's own node names, because
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

The app is the device's own instrument language scaled up, and two things are
carried over deliberately rather than invented here.

The **Rams watch face** that ships in the firmware
(`firmware/takto_one/watch/face_rams.h`) is a strict grid, near-monochrome,
with exactly one accent spent on state and nothing decorative in motion. This
app obeys the same three rules. The accent is the oxide of the lit beat in the
TAKTO mark, and it appears only when a value is at its limit, a channel is
live, or a control is primary.

The **white studio** of the product stills and the film is the twin's stage,
by the numbers: a pure white page, a neutral shell reading 228-232 against it,
finger links a half step deeper so the lattice separates, dark joint pins
peppered through it for legibility, a motor bank that is true black in every
frame, and exactly one casting light. Those values live in
`src/twin/materials.ts`. The result is that the twin and the photography read
as the same object.

## Honest limits

- The twin renders **the mechanism**, not a person. Wrist articulation from the
  IMUs is not applied yet, and the thumb is sensing-only on the device.
- The screen on the forearm lights with activity. That is the glass lighting
  up, not a capture of the panel: the model carries no display content.
- The bundled takes are **choreographed and synthetic**, by their own README's
  admission. No hand wore the device to make them.
- The samples write anatomical values into the `{f}_mcp` column, which the
  device's wire contract uses for MCP **abduction**. This app maps columns the
  same way `software/web/src/views/replay.js` does, so replayed abduction can
  read past the mechanism's 16 degree limit. The Data screen marks any such
  value in accent and the twin clamps it.
- Verified on the **web** target, which is also what the capture tool renders
  and what every image on this page came from. The iOS and Android bundles
  build clean from the same source (`npx expo export --platform ios` and
  `--platform android`, 660 modules each), but neither has been run on a
  device or a simulator here, so treat the native targets as compiling rather
  than as exercised.

## Regenerating the media

The synthetic feed is a pure function of time and the app accepts `?t=` and
`?screen=`, so every captured frame is reproducible. See
[`tools/capture.mjs`](tools/capture.mjs).
