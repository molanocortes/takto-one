# Sample takes

This folder holds three demonstration takes and the Sim Lab environment mesh, so the
session-replay viewer has something to play on a fresh clone before any hardware exists.

**These are choreographed, synthetic recordings.** No hand wore the device to make
them. Every row is produced by the motion functions in [`generate.py`](generate.py),
which is their only source: running it reproduces these exact files. They use the
device's real take format, column layout and geometry. The motion was written to look
good on camera, and the effort trace was set to lead the motion, the way measured
intent leads a real grasp.

| File | What it plays |
| --- | --- |
| `take_demo_cascade.json` | Three rolling finger waves, index to pinky, each pass fuller than the last (14 s) |
| `take_demo_grasp.json` | Approach, pre-shape, staggered close, carry, release (12 s) |
| `take_demo_signature.json` | A figure-eight path with rolling supination while the fingers slowly open and close, then the hand rests open (16 s) |
| `env_sim_lab.json` | The simulated lab room the takes reference (296 vertices, 148 triangles) |

## Replay them

Install the samples into the bridge's state store (its default store is the home
directory, with dot-prefixed names):

```bash
for f in software/bridge/samples/take_demo_*.json; do
  cp "$f" ~/.sensoryhand_takedata_$(basename "$f" .json).json
done
cp software/bridge/samples/env_sim_lab.json ~/.sensoryhand_env_env_0001.json
```

Start the bridge in simulation and serve the web app:

```bash
python3 software/bridge/teensy_bridge.py --sim &
python3 -m http.server 8096 --directory software/web
```

Open `http://localhost:8096/?ws=ws://localhost:8765/ws#/replay`. On a fresh store the
picker lists the samples. If you already have a take library, the picker shows only
your newest takes; load a sample directly from the browser console instead:

```js
const m = await import('/src/views/replay.js');
m.setReplayTake('take_demo_signature');
location.hash = '#/replay';
```

The takes reference `env_0001`, so the Sim Lab wireframe loads with them. Recording
your own takes writes the same format; see the capture surface in the web app.
