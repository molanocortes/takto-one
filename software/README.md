# Software

Five surfaces sit on one data path, and all of them follow one contract:
[`MOTION_PIPELINE.md`](MOTION_PIPELINE.md) (frames, calibration, the arm model, the
firmware v16 stream, SD takes, and the `body` block every twin renders).

```
 Teensy (firmware v16, 100 Hz)  --USB-->  bridge (motion model, takes)  --WebSocket-->  web console / AR / phone app
        \-- SD card takes (standalone) ---- imported over USB by the bridge --/
```

| Folder | What it is |
| --- | --- |
| [`bridge/`](bridge/) | The Python hub: reads the device, runs the body model (neutral calibration, arm model, inertial elbow), records takes, imports SD-card takes, serves every client over WebSocket. `--sim` synthesizes raw sensor data and runs it through the same pipeline. |
| [`web/`](web/) | The public front end plus the app routes: operator twin with the arm in space, IMU bench, capture library, SD import, 4D session replay. Three locales. |
| [`console/`](console/) | The operator console (a focused subset of `web/`). |
| [`ar/`](ar/) | The WebXR layer for Meta Quest 3S: the worn hand in the room, the touch and rhythm modules, room capture, and replay of a take in the room. See [`ar/README.md`](ar/README.md). |
| [`app/`](app/) | The phone companion (Expo: iOS, Android, web): live twin, recording, calibration, take library and replay, SD import. |
| [`lab/`](lab/) | The bench camera experiment station (four protocols, camera vs encoder analysis). |
| [`watch/`](watch/) | The device screen's face assets. The face engine itself is firmware. |

Every surface marks simulated data as **SIMULATED**; live data is only ever labelled live
when a real device is delivering it.

## Preview without hardware

```bash
python3 -m venv .venv
.venv/bin/pip install -r software/bridge/requirements.txt
SENSORYHAND_STATE_DIR=.takto-state .venv/bin/python software/bridge/teensy_bridge.py --sim
```

Then serve the web front end with any static server and open it; it finds the bridge on
`ws://localhost:8765/ws` by itself (add `?mock` to force the in-browser simulation, or
`?ws=<url>` to pin a bridge). On this machine the static sites are registered with the
localhost router, e.g. `http://takto-web.localhost:8080`.

## Connect the device

Plug the Teensy in and start the bridge on its port instead of `--sim`:

```bash
SENSORYHAND_STATE_DIR=.takto-state .venv/bin/python software/bridge/teensy_bridge.py --port /dev/cu.usbmodemXXXX
```

For the phone app or the Quest on the same Wi-Fi, add `--ws-host 0.0.0.0` and connect to
`ws://<this-computer's-LAN-IP>:8765/ws` (the Quest needs `wss://`; see `ar/README.md`).

### First thing every session: the neutral pose

The IMUs' heading reference changes at every power-up, so the twin needs one neutral
capture per power-up: forearm forward and level, **palm down, wrist straight, fingers
extended**, hold still. Start it from any surface (the Calibrate prompt), or on the device
(crown carousel: Calibrate). The device counts 3-2-1 with a chime and checks that you
really are still. Until then the twin runs on a provisional neutral and says so.

### Recording

- From any surface: Record starts a take on the bridge **and** on the device's SD card.
- On a power bank: the device records by itself (press the button to start/stop, hold 3 s
  for standby). Later, with the bridge connected, the SD panel imports those takes and they
  replay like any other take, on the web, the phone and in the AR.

The state directory keeps local calibrations and captures inside an ignored folder. Do not
commit recorded sessions or calibration files unless they have been reviewed for privacy.
