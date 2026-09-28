# TAKTO ONE host bridge

`teensy_bridge.py` connects the device (USB serial) to every surface (web
console, AR, phone app) over one WebSocket, `ws://<host>:<port>/ws`. It owns the
shared state, the calibrations and the take library, and it broadcasts one
snapshot to all clients at 60 Hz. The motion data contract it implements is
[`../MOTION_PIPELINE.md`](../MOTION_PIPELINE.md).

Dependencies: `pyserial` and `websockets` only (`requirements.txt`). All motion
math is pure Python.

| File | Role |
| --- | --- |
| `teensy_bridge.py` | serial/sim ingest, snapshot, commands, recording, SD library |
| `motion.py` | the body model: frames, neutral, wrist angles, arm model, inertial elbow |
| `sdcard.py` | the `F,` protocol client (list/get/auto, CRC-32) and the take CSV parser |
| `sim_device.py` | a line-level firmware v16 device for `--sim` (S/E/F lines, fake SD card) |
| `motion_synth.py` | synthetic arm + BNO085 sensor synthesis (ground truth for tests and the sim) |
| `tendon.py` | guarded tendon calibration (unchanged by the motion pipeline) |

## Run

```bash
pip install -r requirements.txt

python3 teensy_bridge.py --port /dev/cu.usbmodemXXXX   # the device
python3 teensy_bridge.py --sim                         # no hardware
```

Options: `--ws-port 8765` (default), `--hz 60` (snapshot rate), `--raw-encoders`,
`--ssl-cert/--ssl-key` (serve `wss://` for an https page on the Quest).

**Phone / headset on the LAN:** bind all interfaces with `--ws-host 0.0.0.0`
(the default `127.0.0.1` only serves this machine). The snapshot's
`link.lan` / `link.port` carry the address for QR pairing.

State (calibrations, takes, environments) lives in `SENSORYHAND_STATE_DIR`
(default: your home directory, dot-files). Tests and experiments should point it
at a scratch directory. `--sim` writes `.sim`-suffixed calibration files so a
demo never touches the bench calibration.

### `--sim`

The simulator is a *device*, not a fake bridge state: `sim_device.SimDevice`
prints the same text a firmware v16 Teensy prints (100 Hz `S,` lines with raw
game quaternions under a random per-boot heading reference, mounting rotations
from the bench priors, gyro, gravity-free acceleration, preintegrated `dv`,
stability classes, boot id, SD flags; `E,` events; the `F,` protocol over an
in-memory SD card holding two standalone takes), and the bridge parses it with
the same code as the serial port. A 36 s choreography moves the elbow, wrist,
pronation and the shoulder. `N` makes the simulated wearer hold the neutral
pose. `{"cmd":"sim","action":"reboot"}` power-cycles it (new boot id).

Two sim-only shims remain and are labelled in the code: the finger encoders
stream joint-space degrees (+180), and the zero-filled motor block is ignored so
the simulated motor bank keeps working.

## The neutral calibration (every power-up)

The game rotation vector's heading reference is re-chosen at every boot, so the
body frame needs one neutral per device boot.

**Pose:** forearm roughly level and pointing forward, **palm down, wrist
straight, fingers extended**, still for 2 s.

**Trigger:** the device (button / crown "calibrate"), or any surface:
`{"cmd":"calibrate","what":"neutral"}`. The bridge sends `N`; the device counts
down 3-2-1 (screen + buzzer), holds 2 s, and reports the averaged raw
quaternions (`E,neutral,done,...`). Progress is broadcast to every client:

```json
{"kind":"ack","event":"neutral","phase":"countdown","t":3,"source":"console"}
{"kind":"ack","event":"neutral","phase":"hold","t":2,"source":"console"}
{"kind":"ack","event":"neutral","phase":"done","t":0,"ok":true,"report":{...}}
{"kind":"ack","event":"neutral","phase":"abort","t":0,"ok":false,"reason":"moved during the hold"}
```

(The requester also gets `phase:"requested"`; an automatic neutral is announced
as `phase:"provisional"`.) Firmware older than v16 has no `N`: the bridge runs
the same countdown on host time and averages its own frames.

What the neutral sets: the forearm heading defines body +Z; the forearm's
residual tilt and the hand's (and thumb's) mounting residuals are folded in so a
straight wrist reads 0/0 and a level palm-down forearm reads identity; the legacy
display home (`hand`/`forearm` keys) is seated on the same averages; a
console-requested neutral also sets the encoder open reference (as before).

**Per boot, persisted:** the neutral is saved with the device `boot_id`
(`.takto_body.json`). It survives a bridge restart while the device stays
powered and is dropped the moment the device reports another boot (an ack
`{"event":"device_boot","neutral_dropped":true}` says so). The legacy tare
follows the same rule: it is never reloaded from a different boot (the old
tare-from-disk bug), and a tare file without a boot id is ignored.

**Provisional:** until a neutral exists for this boot, the bridge takes one the
first time hand and forearm are still for 1.5 s (heading only, no folding) and
flags `body.provisional = true`: surfaces should show "Calibrate: hold your hand
flat".

**Other captures:** `what:"imu"` = "this pose is home now" (last 0.5 s, refused
if moving). `what:"wrist_axis"` = 5 s of wrist flexion/extension (forearm resting
still, or after a neutral); the principal axis of the hand's motion relative to
the forearm becomes the hand's flexion axis, persisted (it is physical) and used
for the hand heading at every later neutral. Result:
`{"kind":"ack","event":"wrist_axis","phase":"done","ok":true,"axis_sensor":[...],"planarity":0.97,...}`.
`what:"wrist_axis_reset"` forgets it.

## The `body` and `device` snapshot blocks

Exactly as in MOTION_PIPELINE.md section 7, plus additive diagnostics in
`body.quality` (`neutral`, `neutral_kind`, `boot_id`, `wrist_axis`, `twist_deg`,
`heading_bleed_deg`, `elevation_deg`) and in `device` (`link`, `streaming`,
`rate_hz`, `transfer`, `neutral`, `last_error`, `messages`).

Notes on meaning:

- `calibrated` is true only for a real neutral of this boot; a provisional one
  is `calibrated:false, provisional:true`. Before any neutral both are false and
  the heading is arbitrary.
- Body quaternions are the measurement: never clamped. Only `rel.quat` (legacy
  views) is soft-limited to the anatomical envelope (flexion +80/extension -70,
  radial +20/ulnar -35, axial +-90); `rel.source` says `"body"` or `"legacy"`.
- `wrist_deg.flex/dev` are hand-in-forearm (flexion about the forearm's X, then
  deviation). `wrist_deg.pro` is **forearm** pronation, measured as the roll of
  the forearm about its axis away from the elbow hinge (`forearm axis x upper-arm
  axis`), 0 at the neutral; it is only as good as the upper-arm estimate.
- Heading drift between the two IMUs is bled out of the hand's heading with a
  30 s time constant, driven by the hand-vs-forearm axial twist (which a real
  wrist cannot have). That twist only reveals heading drift when the forearm
  is not level; with a level forearm the drift is unobservable and only a new
  neutral removes it (`quality.since_neutral_s` tells surfaces when to ask).
- `pos_source: "arm+inertial"` means the elbow may move on the upper-arm sphere
  from the forearm IMU's acceleration; `"arm"` means the upper arm is taken as
  hanging. See the accuracy table below for what that buys.

Measured on the synthetic ground truth (`pytest tests/test_motion.py -s`; 2 deg
random mounting error, per-sensor heading offsets and drift, gyro/accel bias and
noise, the fusion's gravity leak):

| scenario | wrist flex/dev error | segment error | wrist position error |
| --- | --- | --- | --- |
| elbow + wrist + pronation, shoulder still | < 2.4 deg | < 2.5 deg | max 0.3-0.9 cm |
| same, exact mounting, no noise | 0.00 deg | 0.00 deg | 0.0 cm |
| shoulder reaches, arm model only | < 3.6 deg | < 2.2 deg | max 20.5 cm, mean 9 cm |
| shoulder reaches, arm + inertial | < 3.6 deg | < 2.2 deg | max 9-11 cm, mean 6 cm |
| 12 deg hand-mount error, no wrist-axis cal | 11-12 deg | 17 deg | - |
| same after the 5 s wrist-axis calibration | 0.5 deg | 0.6 deg | - |
| 60 s still with bias + noise | 0.8 deg | 0.7 deg | 0.2 cm (no runaway) |

The inertial elbow is deliberately conservative: a BNO085's linear acceleration
carries g times its own tilt error, which is indistinguishable from a slow reach,
so unexplained acceleration below a (rate-dependent) deadband is ignored. With a
perfect accelerometer the same code tracks the shoulder to 1.8 cm; with a real
one it roughly halves the arm-only error. In the AR, the headset's hand tracking
remains the absolute position (the `world` block, unchanged).

## Recording

`{"cmd":"record","action":"start"|"stop"}` records one shared take. Rows are
written **once per device frame** (100 Hz on v16), never resampled at the
snapshot rate, so `t_ms` never repeats. Rows stream to a spool file while
recording (constant memory; capped at 2 h). Columns: the 44 legacy columns plus
`b_ex,b_ey,b_ez,b_wx,b_wy,b_wz,b_fq_w..z,b_hq_w..z,b_cal` (0 none, 1 provisional,
2 calibrated). On firmware v16 the device records the same take to its SD card;
`E,rec,start` binds the card's take number to the bridge take (`sd_take`,
`sd_name`, `sd_rows` in the take meta). SD failures (`E,rec,fail,<reason>`,
`# SD WRITE FAILED`, `No SD card`) are broadcast as acks and shown in the `sd`
health entry.

## SD takes (standalone recordings)

Without a host (power bank) the device records to `/TAKES/TK000nn.CSV` on its
own, starting with its own neutral capture. Over USB:

```json
{"cmd":"sd","action":"list"}                                  -> {"kind":"sd_takes",...}
{"cmd":"sd","action":"import","name":"TAKES/TK00012.CSV"}    -> progress + sd_imported
{"cmd":"sd","action":"auto","on":true}                        -> {"kind":"ack","event":"sd_auto","on":true}
```

The library message (sent on connect, after `list`, after an import):

```json
{"kind":"sd_takes","items":[{"name":"TAKES/TK00012.CSV","file":"TK00012.CSV","bytes":123456,
  "imported_take":"take_0042"}],"busy":false,"busy_name":null,"listed":true,"auto":true}
```

`name` is the device path that `F,get` takes (the device lists `TAKES/...`, and
legacy `REC*.CSV` at the card root). Import progress:
`{"kind":"ack","event":"sd_import","name":..,"pct":0..100}`, then
`{"kind":"ack","event":"sd_imported","name":..,"take":"take_0042","neutral":"device","rows":N}`;
a failure is `sd_import` with `"ok":false,"error":...`.

The transfer is verified (byte count and CRC-32 against `F,done`) and then run
offline through the same pipeline as live data - encoder mapping, a fresh body
model, legacy display, the row builder - into a normal take (`source:"sd"`,
`sd_name`, `neutral`: `device` when the file carries the device's own neutral,
`bridge` when this bridge captured one for that boot, `provisional` when only a
still window was found). The live state is untouched. A transfer pauses the
device's S stream: the snapshot keeps `link.device:true` with
`link.paused:"sd_transfer"` and reports the sensors as not live meanwhile.
Import is refused while recording or while camera follow is armed.

## Tests

```bash
python3 -m venv /tmp/takto-venv && /tmp/takto-venv/bin/pip install -r requirements.txt pytest
SENSORYHAND_STATE_DIR=/tmp/takto-state /tmp/takto-venv/bin/python -m pytest tests -s
```

`tests/test_motion.py` (body model vs synthetic truth; prints the error table),
`tests/test_bridge.py` (v16 parsing, per-boot tare, E-events, rows per frame,
stale-state clearing, the F client, offline import vs truth) and
`tests/test_smoke_sim.py` (launches `teensy_bridge.py --sim` on a free port
- 8799 or the next free one, never 8096/8097/8765 - and drives it over
WebSocket: provisional -> neutral -> calibrated, record, SD list/import, reboot).

## What was not verified without hardware

The simulator and the tests prove the parsing, the math and the flows against a
model. Not verified here: the real BNO085's linear-acceleration error during
motion (the inertial deadbands are set for a 0.4-0.8 deg dynamic tilt error),
the real mounting of the three chips against the bench priors (the neutral folds
small errors; run the wrist-axis step once per mount), and the timing of a real
`F,get` of a large file over USB.
