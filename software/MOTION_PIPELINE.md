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

Pose: forearm roughly horizontal and pointing forward, **palm down, wrist
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
- `body.pos_source` = `"arm"` or `"arm+inertial"`.
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
