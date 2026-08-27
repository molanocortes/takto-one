# Operator software

This release includes one focused browser console: the live operator view and 3D hand twin. It defaults to a built-in simulated data source, so it can be inspected without hardware.

## Preview without hardware

From the repository root:

```bash
python3 -m http.server 8096 --directory software/console/app
```

Open `http://localhost:8096/`.

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
