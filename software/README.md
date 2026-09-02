# Software

Five surfaces sit on one data path. All of them run against a simulated device, so the whole
stack can be explored before a single part is printed.

| Folder | What it is |
| --- | --- |
| [`console/`](console/) | The operator console: live 3D twin, per-joint encoders, motor state, EMG effort, calibration. Defaults to a built-in simulated source, so it opens with no hardware and no bridge. |
| [`web/`](web/) | The project's public front end plus the app routes behind it, including the capture library and the 4D session replay. Three locales. Ships without `assets/docs/`; see [`../docs/README.md`](../docs/README.md). |
| [`ar/`](ar/) | The WebXR layer: the worn hand twin plus the touch, rhythm and capture modules. A working prototype, not a polished product, and the app only — its capture and asset tooling is not included. |
| [`app/`](app/) | The phone companion: the twin, session replay and the channel read-outs. One Expo codebase for iOS, Android and the browser, on the same synthetic feed or a real bridge. |
| [`bridge/`](bridge/) | The Python serial-to-WebSocket bridge that connects a real Teensy to any of the above, with a `--sim` mode that feeds synthetic joints. |
| [`watch/`](watch/) | The device screen's face assets. The face engine itself is firmware, in [`../firmware/takto_one/watch/`](../firmware/takto_one/watch/). |

The phone companion is in [`app/`](app/); it supersedes an earlier Android-only build, whose
source is not published. The sign-language stack is **not** in this release.

## Preview without hardware

The console needs nothing but a static file server. From the repository root:

```bash
python3 -m http.server 8096 --directory software/console/app
```

Open `http://localhost:8096/`. Point `--directory` at `software/web` instead to serve the
public front end, or at `software/ar` for the AR layer, which falls back to a desktop
preview when no WebXR device is present.

## Connect the Teensy

Create a Python environment and install the two bridge dependencies:

```bash
python3 -m venv .venv
.venv/bin/pip install -r software/bridge/requirements.txt
```

Run a bridge simulation:

```bash
SENSORYHAND_STATE_DIR=.takto-state .venv/bin/python software/bridge/teensy_bridge.py --sim
```

Or replace `--sim` with the detected Teensy port, for example:

```bash
SENSORYHAND_STATE_DIR=.takto-state .venv/bin/python software/bridge/teensy_bridge.py --port /dev/cu.usbmodemXXXX
```

Then open `http://localhost:8096/?ws=ws://localhost:8765/ws`.

The state-directory setting keeps local calibrations and captures inside an ignored repository folder. Do not commit recorded sessions or calibration files unless they have been reviewed for privacy.
