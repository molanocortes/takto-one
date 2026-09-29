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
| `sim_device.py` | a line-level firmware v17 device for `--sim` (S/E/F lines, v17 timing, fake SD card) |
| `motion_synth.py` | synthetic arm + BNO085 sensor synthesis (ground truth for tests and the sim); `SampledSensors` puts each IMU on its own report clock |
| `research.py` | device clock unwrap, take quality, the raw stream sidecar, the SI research CSV and its column dictionary |
| `rederive.py` | CLI: re-run the pipeline offline on a take's raw stream or an SD CSV (rows + take.json [+ CSV]) |
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
prints the same text a firmware v17 Teensy prints (100 Hz `S,` lines with raw
game quaternions under a random per-boot heading reference, mounting rotations
from the bench priors, gyro, gravity-free acceleration, preintegrated `dv`,
stability classes, boot id, SD flags, and the v17 timing tail - each IMU
reports on its own clock, so the quaternion ages sweep 0..10 ms + ~1 ms bus
and a frame can repeat or skip a report; encoder sweep 2..3 ms; `E,` events;
the `F,` protocol over an
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
2 calibrated), plus the 32 raw/timing columns (see "Research-grade takes"). Each
take also keeps its raw device stream, its quality and its provenance. On firmware v16 the device records the same take to its SD card;
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

## Timing (firmware v17)

S-line fields 140..144 (MOTION_PIPELINE.md s.8): `t_us`, the age of each IMU's
quaternion at frame start, the encoder sweep time. Everything is length-gated:
a v15/v16 line parses as before (`fr["timing"] = None`).

- **Device clock.** `research.unwrap_us(t_ms, t_us)` returns microseconds since
  boot: the 32-bit `t_us` wraps every 71.6 min, and the wrap count is recovered
  per frame from `t_ms` (both count the same crystal), so it is stateless (a
  bridge joining an hours-old device, drops across the wrap, re-deriving a
  slice). The body model, the frame rate, the strapdown trackers and the take
  quality run on it; without v17 it is `t_ms * 1000`.
- **IMU sample time** = frame time - qage (`imu_sample_times`). The body model
  gets it as `frame["ts"]` and uses, per IMU, the interval between successive
  *samples* instead of the frame interval: the preintegrated `dv` is divided
  by the time it actually spans, a frame that re-reports an old sample
  integrates nothing (and learns nothing), and quaternion rates use the sample
  interval. On the synthetic arm with each IMU on its own clock (10 ms +-0.4 %,
  bus 0.8..1.4 ms) and the deadbands off, the worst wrist error of the
  shoulder-reach scenario drops from 11.2 cm to 2.4 cm on one seed and moves
  5.8 -> 6.4 cm on another (mean 1.0-1.9 cm with, 1.8-4.3 cm without); with the
  default deadbands the difference is within +-1 cm. The orientation is NOT
  extrapolated to the frame time: the row records what was measured, and the
  age rides along (`h_qage_us` ...) for anyone who wants to align it.

## The fast pose lane

The 60 Hz snapshot carries everything; the twin can additionally ride a
100 Hz lane built in the ingest thread the moment an S-line is parsed:

```json
{"cmd":"stream","pose":true}      -> {"kind":"ack","event":"stream","pose":true,"hz":100.0}
{"kind":"pose","t":2010,"us":2010000,"seq":187,"rx":1790642494014.3,"tx":1790642494014.8,
 "cal":2,"live":true,"e":[x,y,z],"w":[x,y,z],"h":[x,y,z],"fq":[w,x,y,z],"hq":[w,x,y,z],
 "wd":[flex,dev,pro],"j":[12 x deg|null],"tq":[w,x,y,z]|null}
```

Only opted-in clients get it (`{"cmd":"stream","pose":false}` stops it). The
message is serialised once in the ingest thread (without its closing brace; the
writer appends `tx` at send time), handed to the event loop through one
latest-wins slot with at most one pending `call_soon_threadsafe`, and from
there into each client's own latest-wins slot. Nothing can queue up: a busy
loop or a slow client drops stale poses (counted in `link.pose_coalesced`),
never delays fresh ones. `rx`/`tx` are the bridge's wall clock in ms.

The snapshot `link` block reports it: `latency_ms` {median, p95, n,
window_s: 5} of `tx - rx` over the last 5 s, `pose_hz` (built), `pose_clients`,
`pose_coalesced`, `frame_hz` (the device frame rate on the device clock),
`serial_jitter_ms` {median, p95} (receive time minus device time relative to
its 6 s minimum: USB/serial delivery jitter), `imu_age_ms` {hand, forearm,
thumb} and `enc_sweep_ms` of the newest frame.

Measured with `--sim` on the development Mac (one pose client, 20 s):
pose lane 100.0 Hz on the device clock, 0 missed; `tx - rx` p50 0.4-0.5 ms,
p95 0.9-1.1 ms; S-line received -> message parsed by a local Python client
p50 0.6-0.7 ms, p95 1.3-1.7 ms; in Chrome (web console) p50 0.5 ms, p95 1.6
ms. Bridge process CPU (including the simulated device thread): 14-16 % pose
lane off, 15-18 % on, 18 % on while recording (raw sidecar gzip). While a
40 MB take file streams to the same client the lane keeps ~100 Hz (p50 0.7 ms,
p95 11 ms): bulk chunks are paced (one per 20 ms to a pose-lane client).

## Research-grade takes

Every take (live or SD import) is reproducible from what is stored with it.

**Raw device stream.** A live take keeps `<take>.raw.txt.gz`
(`.sensoryhand_takedata_<id>.raw.txt.gz` in the state dir): every S/E line
received while recording, byte for byte, as `<rx_ms>\t<line>`, preceded by
`#takto-raw v1` and one `#meta {json}` line (take id, provenance, the neutral
in force at the first row, the model state at the first row - heading bleed,
upper-arm direction, elbow velocity, accelerometer bias, the strapdown
trackers - and `preroll`: the first N S-lines are the second before the take,
for warming the filters, not rows). Bridge annotations in stream order:
`#N,<b|a>,<t_dev_s>,<kind>,<prov>,<hq 4>,<fq 4>,<tq 4>` whenever the body neutral
changed (`b` between frames, apply before the next S-line; `a` inside the
preceding frame's update). `#end {rows, lines}` closes a complete file; a
truncated one (bridge killed) is still readable up to the damage. An SD import
keeps the card file itself as `<take>.sd.csv.gz`.

**Raw columns** (appended to every row, 59 -> 91 columns; `research.RAW_COLS`):
`t_us, h_qage_us, f_qage_us, t_qage_us, enc_us` (v17, else empty), `rx_ms`
(bridge receive time, Unix ms; empty for SD), `enc_raw_00..13` (unfiltered
degrees as streamed, -1 absent; the sim streams joint degrees + 180),
`hq_raw_w..z, fq_raw_w..z, tq_raw_w..z` (the raw game quaternions the pipeline
used; empty while that IMU is not live).

**Take quality** (`take.quality`, computed at stop by
`research.QualityAccumulator` from the recorded rows; the SD importer and
rederive.py use the same class):

| key | definition |
| --- | --- |
| `frames` | rows written (one per device frame; a repeated device time counts in `dup`) |
| `duration_s`, `rate_hz` | device time first -> last row (`clock`: `t_us` on v17, else `t_ms`); (frames - 1) / duration |
| `nominal_hz` | 100 on v16+, 50 before (SD: the file's `rate_hz`); P = 1 / nominal |
| `gaps`, `dropped`, `dropped_pct`, `max_gap_ms` | intervals > 1.5 P; missing frames = sum of floor(gap / P + 0.5) - 1; dropped / (frames + dropped); largest interval |
| `imu_live_pct` | per IMU, % of rows with a valid quaternion |
| `enc_live`, `enc_live_pct` | channels valid in >= 95 % of rows; % per channel ever valid |
| `cal_pct` | % of rows calibrated / provisional / no neutral |
| `neutral` | at the first row: kind, `age_s` (device s from its capture to the first row; negative = captured during the take), `spread_deg` (largest hand/forearm deviation in the hold, when known), status |
| `pos_source_pct` | % of rows positioned by the headset (`vision`, fresh AR wrist pose), else `arm+inertial`, else `arm` |
| `latency_ms` | pose-lane `tx - rx` over the take {median, p95, max, mean, n}; null when no client rode the lane |
| `timing` | `qage_ms` per IMU, `enc_ms`, `rx_jitter_ms` (median/p95/max) |
| `grade`, `issues` | poor: dropped > 5 %, hand/forearm live < 90 %, or no neutral > 50 %; fair: dropped > 1 %, a gap > 100 ms, IMU live < 99 %, or calibrated < 50 % of rows; else good |

**Provenance** (in take.json, and in the raw `#meta`): `fw, boot_id,
bridge_version, git` (commit of the running checkout, `-dirty` if modified),
`source` (live / sd), `sim`, `enc_map` (channels, open/closed marks, joint-space
flag, sim bias, the One-Euro filter), `imu_mounting` (IMU config, mounting
priors, wrist axis, orientation source), `body_params` (arm lengths, IMU
offsets, drift/inertial parameters), `row_cols`.

**Take files** (the web's research export): `.sensoryhand_takedata_<id>.meta.json`
is the take.json (`research.take_json`: take metadata, quality, provenance,
file names, frames, the column dictionary of take.csv).

```json
{"cmd":"take_file","id":"take_0042","what":"raw"|"meta"|"csv"}
-> {"kind":"take_file","id":"take_0042","what":"csv","name":"take_0042.csv","mime":"text/csv",
    "bytes":<total>,"seq":0,"last":false,"data":"<base64 of <=192 KiB>"}  ... "last":true
-> on failure {"kind":"ack","event":"error","cmd":"take_file","id":..,"what":..,"error":".."}
```

Chunks go through a 4-slot queue per client that the producer awaits on
(constant memory for any size; a client that stops reading for 30 s ends the
transfer) and are interleaved with poses and snapshots. `csv` is generated on
demand (streamed from the row file) with SI units: `t_s`, `t_dev_s`, joint
angles in rad with anatomical names (`index_mcp_abd_rad`,
`index_mcp_flex_rad`, `index_pip_flex_rad`), positions in m, ages in s, raw
encoders in rad; the column dictionary (`name, unit, source, description`) is
`research.RESEARCH_COLUMNS` and ships in take.json.

**Re-derivation.** `python3 rederive.py <take>.raw.txt.gz -o out --csv` applies
the take's provenance, replays the pre-roll, restores the first row's model
state and every neutral change, and writes `<take>.rows.json`, `<take>.json`
and `<take>.csv`. It is the same code path as the SD import
(`OfflineDeriver`); `python3 rederive.py TK00012.CSV [--sim]` re-derives an SD
take with this machine's calibration. Live vs re-derived rows of a sim take
agree to the rounding of the row (joints 0.00 deg, body columns <= 1e-4,
strapdown mm-exact); `blend`/`act` are live-only state.

## Tests

```bash
python3 -m venv /tmp/takto-venv && /tmp/takto-venv/bin/pip install -r requirements.txt pytest
SENSORYHAND_STATE_DIR=/tmp/takto-state /tmp/takto-venv/bin/python -m pytest tests -s
```

`tests/test_motion.py` (body model vs synthetic truth; prints the error table),
`tests/test_bridge.py` (v17/v16 parsing, per-boot tare, E-events, rows per frame,
stale-state clearing, the F client, offline import vs truth),
`tests/test_research.py` (t_us wrap through the bridge, IMU sample times,
quality on synthetic gaps and on a live take with dropped frames, raw sidecar
-> rederive.py == live rows, truncated raw streams, SD import quality /
provenance / re-derivation, the pose message), `tests/test_pose_lane.py` (a
`--sim` bridge over WebSocket: pose lane opt-in and rate, latency in the
snapshot, take_file raw/meta/csv round trips; prints the measured numbers) and
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
