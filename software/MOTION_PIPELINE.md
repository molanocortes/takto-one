# TAKTO ONE motion pipeline and data contract (firmware v16)

This is the single contract between the device, the bridge and every surface
(web console, AR, phone app). It exists because the twin used to be driven by
five slightly different ideas of what a quaternion meant. Everything that
touches motion follows this page; if code and this page disagree, the code is
wrong.

## 1. What the sensors can and cannot do

- **Encoders (AS5600, up to 14):** absolute joint angles of the exoskeleton
  links, 0.09 deg resolution, drift-free. They are the finger ground truth.
- **IMUs (BNO085: hand, forearm, thumb tip):** each chip fuses accelerometer +
  gyroscope on board and reports
  - the **game rotation vector** (orientation, gravity-referenced tilt, heading
    relative to an arbitrary per-boot reference that drifts slowly);
  - **linear acceleration** (gravity removed, sensor frame);
  - **calibrated gyroscope**; accelerometer; gravity; magnetometer; and a
    **stability classifier** (on table / stationary / stable / in motion).
- **What no BNO085 reports is position.** Position has to be *estimated*.
  Double-integrating acceleration alone drifts by metres within seconds, so the
  estimate below is built from constraints (a jointed arm, zero-velocity
  updates) and only uses integration where it is physically bounded.
- The magnetometer is **not** used for orientation: the device carries twelve
  neodymium encoder magnets that dominate the Earth's field near the sensors.
  That is why heading is relative (game rotation vector) and why a neutral
  calibration per power-up is required.

## 2. Frames

All positions are metres, all quaternions `[w, x, y, z]` (Hamilton, active).

| Frame | Definition |
| --- | --- |
| Sensor `S` | The BNO085 chip axes. |
| Sensor world `W_s` | Per IMU: Z up (against gravity), heading arbitrary per boot. The game rotation vector is `W_s <- S`. |
| Segment | Anatomical/model axes of a body segment: **+Z distal** (elbow to fingertips), **+Y dorsal** (back of the hand), **+X toward the thumb** (for the right hand). These are also the twin model's axes. |
| **Body `B`** | The shared frame every surface renders in: **+Y up**, **+Z forward** (the horizontal direction the forearm pointed at the last neutral capture), **+X left** (= `Y x Z`, the thumb side of a palm-down right hand). Origin at the **shoulder**. Right-handed, three.js-native. |

Mounting `M_s` (per IMU, `S <- Segment`): a fixed rotation from the CAD
placement of each IMU, refined by calibration. Segment orientation in body:

```
Q_seg(t) = H_s * C * q_s(t) * M_s
```

- `q_s(t)`: raw game rotation vector (`W_s <- S`).
- `C`: fixed Z-up to Y-up change of basis, a -90 deg rotation about X,
  `C = [0.70710678, -0.70710678, 0, 0]`, i.e. `(x, y, z)_W -> (x, z, -y)_B`
  (W +Z becomes B +Y; the heading it leaves is absorbed by `H_s`).
- `H_s`: per-IMU heading alignment, a rotation about +Y only, set at the neutral
  capture so that the forearm's +Z points to body +Z and the hand's heading
  matches the forearm's.

## 3. Calibration

### Neutral capture (every power-up; required)

Pose: forearm roughly horizontal and **pointing at the screen** (that direction becomes the
twin's forward, and the twin's camera looks along it), **palm down, wrist
straight, fingers extended**, hold still for 2 s.

Triggers: the device (button / crown carousel "calibrate"), the bridge command
`{"cmd":"calibrate","what":"neutral"}`, the web console, the phone app, the AR.
The bridge sends `N` to the device; the device runs a 3-2-1 countdown on the
screen and the buzzer, holds 2 s, and prints `E,neutral,done,<t_ms>`. The
bridge averages the raw quaternions over the hold and solves:

1. `H_f` from the forearm's distal axis projected on the horizontal plane.
2. `H_h` = the heading that best aligns the hand's distal axis with the
   forearm's.
3. A residual tilt correction folded into `M_h` so that the hand and forearm
   segment frames coincide at neutral (a straight wrist reads 0/0/0).
4. The encoder "open" reference (existing `joints_open`).

The neutral is **per boot**: it is keyed by the device `boot_id` (S-line field
124). It is kept across bridge restarts while the device stays powered, and
discarded the moment the device reboots (the game rotation vector heading
reference changes on every power-up, so an old neutral is silently wrong).

Until a neutral exists for the current boot, the bridge takes a **provisional**
neutral the first time both IMUs are still for 1.5 s, flags it
(`body.provisional = true`), and every surface shows "Calibrate: hold your hand
flat".

### Wrist axis (optional functional step)

`{"cmd":"calibrate","what":"wrist_axis"}`: 5 s of wrist flexion/extension.
The principal axis of the hand's angular velocity relative to the forearm (in
the hand sensor frame) is the anatomical flexion axis, i.e. segment +X. It
replaces the CAD guess for the hand mounting (gravity at neutral fixes -Y).
Persisted, because mounting is physical and survives power cycles.

### Hand-frame self-check (automatic)

The neutral absorbs every mounting error except one: which way the hand
module's "forward" points. A hand frame that is 180 deg off looks right at the
neutral, turns correctly side to side, and pitches and rolls **mirrored**. The
bridge checks it continuously from co-rotation: whenever hand and forearm turn
together (both >= 0.35 rad/s, rates within 30 %), their body-frame angular
velocities must agree; a backwards hand agrees only about the vertical (x and z
negated). Samples where the wrist moves by itself fit neither and are skipped.
After 40 decisive votes with an 85 % majority the check either verifies the
frame or turns it around (`hand_flip`), re-solves the neutral, and persists it.
Surfaces see `body.quality.hand_frame` (`checking` / `verified`) and an ack
`{"event":"hand_frame","corrected":bool,"votes":{...}}`.

[BENCH 2026-09-29] On this rig the co-rotation check found hand and forearm
180 deg apart (351 of 358 votes), and the wearer then saw the whole twin tilt
and twist opposite to the arm once they agreed: the **forearm** prior points
backwards. The forearm sets "forward" for the whole twin, and a backwards body
frame is self-consistent, so no IMU-only check can see it; it is the measured
setting `forearm_flip` (default true, as the old IMU-config bench note had
found: "180 Y <- upright AND forward"). Takes record both flags in their
provenance; takes recorded before the fix re-derive without them.

### Heading drift

The two game rotation vectors drift independently (typically < 1 deg/min).
The bridge bleeds the hand-vs-forearm **axial twist** toward zero with a 30 s
time constant (the radiocarpal joint has almost no axial rotation; pronation
happens in the forearm and moves the forearm IMU with it). Drift in the other
axes is only removed by a new neutral capture. `body.quality.since_neutral_s`
tells the surfaces when to suggest one.

## 4. Position estimate (the arm model)

Segment lengths (configurable, defaults for an adult): shoulder to elbow
`L_ua = 0.30 m`, elbow to wrist `L_fa = 0.26 m`, forearm IMU 0.095 m proximal of
the wrist pivot (bridge `REL_F2W_MM`), hand IMU 0.05 m distal of the wrist pivot.

```
elbow  = shoulder + L_ua * u(t)                  u = upper-arm unit vector
wrist  = elbow + Q_forearm * [0, 0, L_fa]
hand   = wrist + Q_hand * [0, 0.01, 0.055]       palm centre, for the AR
```

- With no inertial evidence, `u = [0, -1, 0]` (upper arm hanging): forearm and
  wrist rotations move the wrist on a sphere around the elbow. This part is
  exact and drift-free.
- **Shoulder motion** (the arm moving through space with the forearm pose
  unchanged) is only visible to the accelerometers. The bridge integrates the
  forearm IMU's world-frame acceleration (firmware-preintegrated `dv`, exact at
  the IMU's own rate) to a velocity with zero-velocity updates (ZUPT: the
  BNO085 stability classifier says stationary/stable, or |a| and |w| are small
  for 80 ms), subtracts the velocity explained by forearm rotation about the
  elbow (`w x r`), and integrates the remainder into the elbow. The elbow is
  then **projected back onto the sphere of radius `L_ua` around the shoulder**,
  and clamped to an anatomical cone (upper-arm elevation 0..170 deg). Drift is
  therefore bounded to that sphere, and velocity cannot run away because every
  pause is a ZUPT.
- When still for more than 4 s, `u` relaxes toward hanging with an 8 s time
  constant (the most likely resting posture; bounded, visible error if the arm
  is actually held raised).
- **Camera upper arm** (`{"cmd":"vision"}`, 2026-09-29). The two IMUs measure
  the forearm and the hand; nothing on the device measures the upper arm, and
  double-integrating a BNO085 drifts by tens of cm in a second (section 1), so
  a reach made from the shoulder with the forearm angle unchanged is
  invisible. A webcam facing the wearer fills exactly that gap: the web
  operator's camera button runs MediaPipe's pose model in the browser and
  streams the arm's shoulder, elbow and wrist (metric world landmarks, about
  30 Hz; the video never leaves the browser). The bridge maps them to a
  camera-body frame (up = up, +Z toward the camera, i.e. toward the screen
  the neutral points at), learns the remaining heading offset by comparing
  the camera's forearm direction with the IMU forearm (horizontal parts, 4 s
  time constant), and steers `u` toward the camera's upper-arm direction
  with a 0.12 s time constant. Forearm and hand stay IMU (100 Hz, far more
  precise than the camera). Samples older than 0.5 s or below 0.5 visibility
  are ignored, and the arm then holds, then relaxes as above. Takes record every
  applied sample as a `#V` line in the raw sidecar, so re-derivation replays
  it. Synthetic check (tests/test_motion.py, 3 cm landmark noise, camera 20 deg
  off-axis): shoulder-reach wrist error 8.8 -> 2.1 cm mean, 20.5 -> 6.8 cm worst.
- **Translation from the two IMUs** (default on, `cfg.translation`; 2026-09-29).
  A free translation `d` of the whole arm is added to the jointed-arm model:
  each IMU's gravity-free acceleration minus the acceleration the model's own
  rotations imply at that point (from the gyros: `w x lever`, one difference,
  never twice-differentiated orientations) is what no orientation can show -
  a lift, a reach from the torso. Noise handling:
  per-sensor accelerometer bias and noise are learned at every rest (sensor
  frame); the two IMUs are fused by inverse measured variance; the gate is
  `k x measured noise` with a horizontal floor that grows with the rotation
  rate (the BNO085 fusion's tilt leak is horizontal to first order, so up/down
  is the best-measured direction) and passes real motion unshaved; zero-
  velocity updates at rests that last long enough for the preceding speed (a
  smooth move's mid-point is also acceleration-free); end-of-move constant-
  bias de-drift (`d -= v_end T / 2`); velocity bled hard after 2 s without a
  pause (travel comes in bursts); `d` bounded to the reach and returned home
  when the forearm hangs still. The upper arm points at the translated elbow
  and the radial remainder moves the shoulder (`shoulder_m` is no longer
  always zero). It stands down while the camera is fresh. Synthetic (bias,
  noise, static + dynamic tilt leak 0.4-0.8 deg per rad/s): lifts, reaches
  and side moves 20.1 -> 1.7-2.5 cm worst, 5.0 -> 0.4-0.6 cm mean; shoulder
  swings 20.5 -> 15.7 worst, 9.0 -> 5.4 cm mean; elbow/wrist exercise 1.1 cm
  worst (0.3 without); 60 s still 0.2 cm. Bench, both BNO085s at rest:
  1.7 / 2.0 mg noise, `d` = 0.0 over 25 s.
- `body.pos_source` = `"arm"`, `"arm+vision"` or `"arm+inertial"`.
- In the AR, the headset's own hand tracking (when it sees the hand) is the
  absolute position; the bridge fuses it into `world` exactly as before, and
  the AR places the body model under that anchor when tracking is lost.

## 5. Firmware v16 wire additions

### S-line (append-only; every earlier index unchanged)

`S,` line at **100 Hz** (was 50). Fields 0..120 are v15 (see the sketch header).

| idx | field |
| --- | --- |
| 121 | `fw_flags`: bit0 recording to SD, bit1 SD present, bit2 standby, bit3 host link seen by device, bit4 auto-record when standalone, bit5 neutral capture in progress |
| 122 | take number being recorded (0 = none) |
| 123 | rows written in the current take |
| 124 | `boot_id` (random 1..65535 per power-up) |
| 125..133 | `dv` hand x,y,z; forearm x,y,z; thumb x,y,z: m/s, sum of `R(q)*a_lin*dt` over every linear-acceleration report since the previous S-line, in that IMU's own `W_s` (Z up) |
| 134..136 | stability classifier hand, forearm, thumb: 0 unknown, 1 on table, 2 stationary, 3 stable, 4 motion, 255 not reported |
| 137..139 | number of linear-acceleration reports integrated into each `dv` |

### Device events (device to host, one line each)

| line | meaning |
| --- | --- |
| `E,rec,start,<take>,<source>` | SD take opened (`source` = `host` or `device`) |
| `E,rec,stop,<take>,<rows>,<ms>` | SD take closed and flushed |
| `E,rec,fail,<reason>` | `nosd`, `open`, `write`, `full` |
| `E,neutral,start` | countdown began (3 s, one beep per second), then a 2 s still hold |
| `E,neutral,done,<t_ms>,<hq w,x,y,z>,<fq w,x,y,z>,<tq w,x,y,z>` | hold completed; the 12 numbers are the sign-aligned averages of the raw **game** quaternions (hand, forearm, thumb) over the still window, which ended at device time `t_ms` |
| `E,neutral,abort,<why>` | `moving` (no still 2 s window within 7 s) or `imu` (a main IMU dropped) |
| `E,standby,<0or1>` | entered / left standby (long hold of the button, 3 s) |

Existing `E,nav/press/screen/home/cal/watch` lines are unchanged.

### Host commands added

| command | effect |
| --- | --- |
| `N` | start a neutral capture (countdown, beeps, `E,neutral,...`) |
| `F,list` | device replies `F,item,<name>,<bytes>` per take, then `F,end,<count>` |
| `F,get,<name>` | device pauses the S stream, replies `F,begin,<name>,<bytes>`, one `F,d,<line>` per file line, then `F,done,<name>,<bytes>,<crc32hex>` (CRC-32/IEEE over the file bytes including newlines); on error `F,err,<reason>` |
| `F,get,<path>,<offset>,<max>` | **firmware v18+**: one verifiable chunk: `F,begin,<path>,<filesize>`, whole `F,d,<line>` lines from `<offset>`, then `F,chunk,<path>,<offset>,<end>,<crc32 of offset..end>`. The bridge requests 32 KB chunks, re-requests a damaged one, and checks the whole file with `F,crc,<path>` -> `F,crc,<path>,<size>,<crc32>`. (macOS's USB-serial driver drops bytes when a reader falls behind a multi-MB burst; the single-burst form lost 36-75 % of a 6 MB take on the bench.) |
| `F,auto,<0or1>` | auto-record when standalone on/off (persisted); device replies `F,auto,<0or1>` |
| `Q` | mute/unmute the buzzer (bench work) |

## 6. SD takes (standalone recording)

When the device boots without a host (a power bank), it plays the boot chime,
asks for a neutral capture on the screen, and (auto-record on) starts a take.
A short button press starts/stops a take; a 3 s hold closes any take and
enters standby. With a host connected the bridge's `record` command also
records to the card (the card is the archival copy).

Files: `/TAKES/TK00012.CSV`, one self-describing file per take:

```
# takto take v1
# fw=16 boot=<boot_id> take=12 source=device rate_hz=100 start_ms=<millis>
t_ms,enc00,...                              <- the column header
<rows>
#E,<t_ms>,neutral,done,<hq 4>,<fq 4>,<tq 4> <- events inline, '#E' prefix
# end rows=<n> ms=<duration>
```

A take started while a neutral already exists for this boot carries it in the
header too: `# neutral=<t_ms>,<hq 4>,<fq 4>,<tq 4>`. A take started on the
device always begins with its own neutral capture. Other events:
`#E,<t>,neutral,start`, `#E,<t>,neutral,abort,<why>`, `#E,<t>,imu_lost,<name>`,
`#E,<t>,imu_back,<name>`.

Columns: the v15 row (t_ms, 14 encoders, hand quat, forearm quat, emg env/rms,
crown, thumb quat, thumb_live, motor block, crown_live, the 69-column IMU set),
then `h_live,f_live,t_live,emg_present`, then the nine `dv` columns
(`h_dvx,h_dvy,h_dvz,f_dvx,...,t_dvz`) and the three stability columns
(`h_stab,f_stab,t_stab`). The v7 IMU block keeps its v15 names
(`hand_lax ... thumb_rotacc`, game quaternion = `<name>_gqw..gqz`). Consumers must skip lines starting with `#` and index
columns by name.

The bridge imports a take over USB (`F,list` / `F,get`), runs it through the
same pipeline as live data (encoder calibration, body model, neutral from the
`#E ... neutral` event), and stores it as a normal take that the web replay,
the phone app and the AR can play.

## 7. Snapshot `body` block (bridge to every surface)

```jsonc
"body": {
  "frame": "body_yup_v1",
  "calibrated": true,            // a neutral exists for this boot
  "provisional": false,          // true = auto neutral, ask the user to calibrate
  "live": true,                  // hand + forearm IMUs live
  "shoulder_m": [0, 0, 0],
  "elbow_m":    [x, y, z],
  "wrist_m":    [x, y, z],
  "hand_m":     [x, y, z],       // palm centre
  "upperarm_quat": [w, x, y, z], // segment axes, +Z distal
  "forearm_quat":  [w, x, y, z],
  "hand_quat":     [w, x, y, z],
  "thumb_quat":    [w, x, y, z] | null,
  "wrist_deg": {"flex": f, "dev": d, "pro": p},  // + flexion (palm-ward), + radial, + pronation
  "pos_source": "arm" | "arm+inertial",
  "quality": {"since_neutral_s": s, "inertial_conf": 0..1, "still": bool}
}
```

Take rows gain the columns `b_ex,b_ey,b_ez` (elbow), `b_wx,b_wy,b_wz` (wrist),
`b_fq_w..z` (forearm), `b_hq_w..z` (hand), `b_cal` (0 none, 1 provisional,
2 calibrated). Rows are written once per **device** frame (100 Hz), never
duplicated.

Snapshot `device` block (device-side recording and power state, from the
v16 S-line fields and `E,` events):

```jsonc
"device": {
  "fw": 16, "boot_id": 4711,
  "sd_present": true, "sd_recording": true, "sd_take": 12, "sd_rows": 5310,
  "standby": false, "standalone_auto_record": true, "neutral_running": false
}
```

The SD library travels as its own message, `{"kind":"sd_takes","items":[{"name":
"TK00012.CSV","bytes":123456,"imported_take":"take_0042"|null}],"busy":false}`,
sent on connect, after `{"cmd":"sd","action":"list"}`, and after an import.
`{"cmd":"sd","action":"import","name":"TK00012.CSV"}` imports one take (progress
arrives as `{"kind":"ack","event":"sd_import","name":..,"pct":0..100}` and a
final `{"kind":"ack","event":"sd_imported","name":..,"take":"take_0042"}`), and
`{"cmd":"sd","action":"auto","on":true|false}` sets standalone auto-record.
Neutral progress is broadcast as `{"kind":"ack","event":"neutral","phase":
"countdown"|"hold"|"done"|"abort","t":seconds_left}`.

How surfaces use it:

- **Twin (web/console/app):** forearm mesh pivots at the **elbow** end and is
  placed along elbow to wrist; the hand pivots at the wrist; both take the body
  quaternions directly; the arm translates in space with `wrist_m`. A faint
  upper-arm/forearm limb makes shoulder motion readable.
- **AR:** when the headset tracks the hand, vision wins; otherwise the device
  hand is placed from `world` (vision-anchored dead reckoning) or, with no
  anchor, from `body` under the room anchor.
- Old keys (`hand`, `forearm`, `rel`, `world`, `inertial`) stay for
  compatibility; `rel.quat` is derived from the body model when calibrated so
  every view agrees.

## 8. Timing, the fast pose lane, and research-grade takes (firmware v17)

### Device timing (S-line fields 140..144, SD columns of the same names)

| idx | SD column | field |
| --- | --- | --- |
| 140 | `t_us` | device `micros()` at the start of this frame (32-bit, wraps every 71.6 min); `t_ms` stays for compatibility |
| 141..143 | `h_qage_us,f_qage_us,t_qage_us` | age of each IMU's latest game quaternion at frame start, on the sensor's own clock (SH-2 timebase + report delay); 0 = no quaternion yet |
| 144 | `enc_us` | duration of the encoder sweep of this frame (the encoders were sampled over `[t_us, t_us + enc_us]`, in channel order) |

The orientation in a frame is therefore the one at `t_us - qage_us`, not at `t_us`. At 100 Hz reports the age is 0..10 ms plus bus latency; a host that time-aligns IMU and encoders subtracts it.

### The fast pose lane (bridge to clients)

The 60 Hz `snap` carries everything. For the twin, a client may additionally ask for the pose lane with `{"cmd":"stream","pose":true}`; the bridge then sends, **once per device frame (100 Hz)**, a compact message built in the ingest thread the moment the line arrives:

```jsonc
{"kind":"pose", "t":<device t_ms>, "us":<device t_us>, "seq":<frame counter>,
 "rx":<bridge wall-clock ms when the S-line arrived>, "tx":<bridge wall ms when sent>,
 "cal":0|1|2,                      // body neutral: none / provisional / calibrated
 "live":true,                      // hand + forearm IMUs live
 "e":[x,y,z], "w":[x,y,z], "h":[x,y,z],          // elbow, wrist, palm (m, body frame)
 "fq":[w,x,y,z], "hq":[w,x,y,z],                  // forearm, hand segment quats (body frame)
 "wd":[flex,dev,pro],                             // wrist degrees
 "j":[12 x deg|null],             // joints in JOINT order index_mcp,index_pip,index_dip,middle_...,pinky_dip (wire names; null = channel not live)
 "tq":[w,x,y,z]|null}             // thumb relative quat
```

Numbers are rounded to 4 decimals (positions 0.1 mm). Clients render the twin from the newest `pose` and use `snap` for everything else. Latency: `rx - (device frame time)` is the serial leg; clients on the bridge machine measure `Date.now() - rx` for the rest; the bridge reports `link.latency_ms` = median (`tx - rx`) and the pose-lane rate.

### Research-grade takes

- Every take (live or imported) keeps its **raw device stream**: the bridge appends each raw S/E line with its receive time to `<take>.raw.txt.gz` (`<rx_ms>\t<line>`); SD takes keep the original CSV. Derived rows can always be recomputed with the importer.
- Take rows gain raw columns: `enc_raw_00..13` (unfiltered encoder degrees, -1 absent), `hq_raw_w..z`, `fq_raw_w..z` (raw game quaternions), `t_us`.
- Take metadata gains `quality`: `{frames, rate_hz, dropped, max_gap_ms, imu_live_pct:{hand,forearm}, enc_live:[ch...], neutral:{kind, age_s, spread_deg}, pos_source_pct:{arm, arm+inertial, vision}, latency_ms:{median,p95}}` and `provenance`: `{fw, boot_id, bridge_version, enc_map, imu_mounting, body_params}`.
- Export (web): a take downloads as a research package: `take.csv` (rows, SI units, header documented), `take.json` (metadata, quality, provenance, column dictionary), and the raw stream.

### Section 8 as implemented (bridge, 2026-09-29)

- `{"cmd":"stream","pose":true|false}` is acked with `{"kind":"ack","event":"stream","pose":bool,"hz":100.0}`.
- Snapshot `link` gains `latency_ms{median,p95,n,window_s}`, `pose_hz`, `pose_clients`, `pose_coalesced` (stale pose frames replaced by a newer one for a slow client), `frame_hz`, `serial_jitter_ms{median,p95}`, `imu_age_ms{hand,forearm,thumb}`, `enc_sweep_ms`.
- Raw take columns in practice: `t_us`, `rx_ms`, `enc_raw_00..13`, `hq_raw_*`, `fq_raw_*`, `tq_raw_*`, `h/f/t_qage_us`, `enc_us` (91 columns per row).
- The raw sidecar also carries `#meta` lines (provenance at start) and `#N,<a|b>,...` annotation lines besides `<rx_ms>\t<line>`.
- `{"cmd":"take_file","id","what":"raw"|"meta"|"csv"}` streams `{"kind":"take_file","id","what","name","mime","bytes","seq","last","data":<base64 <= 192 KiB>}`; errors come back as `{"kind":"ack","event":"error","cmd":"take_file",...}`.
- The research CSV uses SI units and names (rad, m, s); the column dictionary is in `take.json`.
- `software/bridge/rederive.py <take.raw.txt.gz | SD .CSV>` re-runs the pipeline offline with the provenance recorded in the take; on a live take it reproduces the live rows to their rounding.
- Measured on the development Mac with `--sim`: pose lane 100.0 Hz, bridge latency (line in to socket) p50 0.5 ms, p95 about 1.4 ms; bridge CPU 15-18 %.

## 9. Surface EMG (firmware v19, 2026-09-30)

The MyoWare 2.0 has three outputs; the device reads two. **ENV** (the analog
envelope: rectified and smoothed on the sensor) goes to **pin 14 (A0)**;
**RAW** (the amplified, band-limited EMG centred on Vs/2) to **pin 15 (A1)**,
optional but required for the spectrum, fatigue and contact quality. Power the
sensor from **3.3 V** (the Teensy's analog inputs are not 5 V tolerant).

### Acquisition (firmware `emg.h`)

- A 2 kHz `IntervalTimer` samples both pins on **ADC1** (12 bit, 4x hardware
  averaging; ISR measured at 39 us worst case). The crown pot (pin 27) has no
  ADC1 channel and stays on ADC2 through the core `analogRead`, so the ISR and
  the loop never share a converter; the ISR spins on the conversion flag
  itself (the core `analogRead` yields and must not run in an interrupt).
- Both pins are pulled down: an unconnected output reads ~0, so `present`
  (ENV above ~6.5 mV, RAW centred mid-rail) is a measurement.
- RAW chain per sample: 4th-order Butterworth high-pass 20 Hz, notches at 50
  and 100 Hz (Q 25), 2nd-order Butterworth low-pass 450 Hz. Before the notches
  a Goertzel detector measures the 50 Hz share of the band over 200 ms (10
  mains periods): the electrode-contact indicator.
- Per 10 ms frame: RAW RMS, MAV, waveform length, zero crossings (adaptive
  hysteresis), clipping count of connected channels; ENV mean and SD.
- A 256-point real FFT (CMSIS-DSP, Hann window, 64 ms hop) of the filtered RAW
  gives the mean and median frequency of 20-450 Hz.

### Wire (append-only)

S-line fields 145..157 and SD columns of the same names:
`emg_n, env_mv, env_sd_mv, raw_present, raw_rms_mv, raw_mav_mv, raw_wl_mv,
raw_zc, mnf_hz, mdf_hz, line50_pct, emg_sat, emg_ovr` (mV at the pin; the
spectral and mains fields are 0 without RAW). The v3 fields `emg_env`,
`emg_rms` (ENV in 10-bit counts) and `emg_present` keep their meaning.

### Activation (bridge `emg_engine.py`)

- Amplitude: RAW RMS when RAW is present, else the ENV mean.
- **Guided MVC calibration** (`{"cmd":"calibrate","what":"emg"}`, the Effort
  card's *calibrate*): rest 3 s, then three maximal contractions of 3 s with
  3 s rests. Rest = median, noise = MAD x 1.4826, MVC = the highest 500 ms
  moving mean (SENIAM), SNR = 20 log10((MVC - rest) / noise); refused below
  6 noise SDs. Persisted in `.takto_emg.json`; dropped if the wiring changes
  source. Before it: an automatic rest floor / peak tracker with a physical
  minimum span (80 mV ENV), reported as `calibrated: false`, `quality: "no
  contraction yet"` until a real contraction sets the scale.
- `level` = fraction of MVC after Sanger's Bayesian amplitude posterior (the
  Fable estimator, `fable_activation.BayesianAmplitude`, ported to pure
  Python); `pct_mvc` = level x 100.
- Onset / offset: Page's CUSUM on the log energy standardized by the rest
  statistics (k 1.2, h 10); `active` carries the contraction state, `onset`
  holds 150 ms.
- Fatigue (RAW only): median-frequency drop within a contraction bout against
  its value 1 s in; 25 % = 1.0. `fatigue_available` says when it is real.
- Quality: `sqi` 0..1 and a reason: mains share > 20 % (fair) / > 50 % (poor
  contact), clipping, a flat line, SNR < 20 dB.
- Synthetic checks (`tests/test_emg_engine.py`): MVC within 5 %, onset within
  60 ms of a 20 % MVC contraction, no false onset in 20 s of rest, fatigue
  > 0.7 for a 22 % MDF drop, rest reads 0 before calibration. Bench (ENV
  only): 20.6 mV rest, ISR 39 us, rest level 0.
