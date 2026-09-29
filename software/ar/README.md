# TAKTO ONE AR layer (WebXR, Meta Quest 3S)

A static WebXR page (`index.html`, three.js r165 vendored, no build step). In the
headset it runs an `immersive-ar` session (local-floor, hand tracking, depth,
mesh/plane detection, anchors). On a desktop browser it falls back to a
preview with a simulated desk, driven by the in-page mock.

The motion data contract is [`../MOTION_PIPELINE.md`](../MOTION_PIPELINE.md)
(the `body`, `device` and `world` snapshot blocks, the neutral calibration, the
take row columns). Where code and that page disagree, the code is wrong.

## Where the data comes from (transport)

The page never picks a data source silently.

| URL | Transport |
| --- | --- |
| `?ws=<url>` | that bridge; **remembered** in the browser for the next visits |
| `?ws=off` | forget the remembered bridge |
| `?mock=1` | the in-page simulator, even if a bridge is remembered (an explicit `?ws=` in the same URL still wins) |
| `?mock=0` | refuse the simulator: `ws://localhost:8765/ws` (http) |
| nothing | the remembered bridge; else on **https** `wss://<same host>/ws` (the `serve_https.py` tunnel); else on **http** the simulator |

Whenever the simulator runs, the page shows an amber **SIMULATED** badge (and,
in the headset, the status HUD reads **SIMULATED** in amber). A bridge that is
configured but not connected shows a red "bridge offline · <url>" badge (HUD:
**OFFLINE**). The mock never pretends to store anything: room
uploads are refused with an error, and its takes are labelled simulated.

## Running it on the Quest

WebXR needs a secure origin: https, or `localhost` (including `*.localhost`).
An https page can only open `wss://` sockets. Pick one option.

### Option A: bridge with TLS, page over https

```sh
# a self-signed certificate for the PC's LAN address (once)
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout key.pem -out cert.pem \
    -subj "/CN=takto" -addext "subjectAltName=IP:<PC-IP>"
python3 software/bridge/teensy_bridge.py --ws-host 0.0.0.0 --ssl-cert cert.pem --ssl-key key.pem
python3 software/ar/serve_https.py --cert cert.pem --key key.pem   # or any https static server
```

On the Quest, open `https://<PC-IP>:8765/ws` once and accept the certificate
(the socket will not connect until the browser trusts it), then open
`https://<PC-IP>:8443/?ws=wss://<PC-IP>:8765/ws` and accept that certificate too.
The `?ws=` is remembered, so later visits need only `https://<PC-IP>:8443/`.

### Option B: USB (adb reverse), no certificates

`*.localhost` is a secure origin, so plain http works over a USB tunnel. On this
Mac the AR folder is served by the localhost-router:

```sh
python3 ~/.localhost-router/register.py add takto-ar --root /abs/path/to/software/ar
python3 software/bridge/teensy_bridge.py            # plain ws on 127.0.0.1:8765
adb reverse tcp:8080 tcp:8080
adb reverse tcp:8765 tcp:8765
```

On the Quest open `http://takto-ar.localhost:8080/?ws=ws://localhost:8765/ws`.

### Option C: one https server that also tunnels the socket

`serve_https.py` (Python stdlib only) serves this folder over https, tunnels
`/ws` to the bridge's plain `ws://127.0.0.1:8765/ws`, and accepts the page's
`POST /diag` beacon into `~/.sensoryhand_diag.log`. The bridge needs no TLS and
can stay on 127.0.0.1; one certificate covers the page and the socket.

```sh
python3 software/bridge/teensy_bridge.py
python3 software/ar/serve_https.py --cert cert.pem --key key.pem   # :8443, LAN
```

On the Quest open `https://<PC-IP>:8443/` (no parameters: https defaults to the
same-origin `/ws`). Ports 8096/8097 are reserved for the console/AR test suites.

## Desktop preview

Serve the folder with any static server (on this Mac: the localhost-router, see
Option B) and open `http://takto-ar.localhost:8080/?mock=1`. Click the veil (or
Enter) to begin. `?mode=<name>` starts in a mode, `?guide=0` hides the
first-run guide, `?hud=0` the status HUD. `window.AR` exposes the app for
scripted checks (`AR.status`, `AR.guideCard`, `AR.stage`, `AR.lane`,
`AR.recenter()`, `AR.doAction(id)`, `AR.pickAt(x, y)`).

| key | action |
| --- | --- |
| `1`-`6` | atelier (hub) / capture / rhythm / touch / twin / replay; `Esc` hub |
| `C` | calibrate neutral |
| `T` | record a take / stop it (switches to capture, 3-2-1) |
| `P` | replay (in replay: next take) |
| `R` | recenter |
| `H` | hub (at the hub in XR: exit AR) |
| `G` | show / hide the first-run guide |
| `[` / `]`, `U` | desktop head simulation: turn 30 deg left / right, stand up / sit down (to try recenter) |
| `?` | key help |
| replay | space play/pause, left/right seek, up/down pick a take |

In the capture console plain letters type the take name, so there the letter
shortcuts need **Shift** (Shift+T, Shift+P, ...). The mouse clicks the dock
buttons and every mode object.

## Placement: recenter (`src/ui/stage.js`)

Every mode is laid out in one canonical frame (desk point `(0, 0.75, -0.55)`,
the `ANCHOR` of every mode). That frame is placed in the room by one rigid
transform, the **stage** (yaw + translation), applied as an **offset reference
space** off `local-floor`. Hands, camera, room anchors and the scan are all read
in the canonical frame, so no mode code changed.

- **At XR entry** the scene is placed from the head pose: the desk point lands
  0.45 m ahead of the eyes along the gaze heading and 0.25 m below them, or **on
  the table** when plane detection reports a horizontal plane under that point
  0.12-0.70 m below the eyes (a table far below a standing user is ignored: the
  scene floats at chest height instead). Planes arrive late, so 2.5 s after
  entry the height is refined once onto a table if one appeared.
- **On demand**: the dock's **recenter** button, `R`, a controller **A/X held
  0.6 s**, **both hands pinched for 1 s** (the desk reach and height then come
  from the pinches: "put it here"), or the **headset's own recenter** (hold the
  Meta button, or the palm-up pinch hold), which fires `reset` on local-floor.
  The scene glides there in 0.45 s; the HUD says where it went ("on the table
  (0.74 m)", "45 cm ahead", "at your hands").
- **Blocked while a take or a room scan runs** (both are recorded in the stage
  frame); the HUD says so. The headset's own recenter is always honoured.
- **Per room**: when a persisted room anchor is live (this session's scan or the
  restored last room), the stage is stored in the anchor's frame
  (`localStorage takto.ar.stage.v1`). When that anchor localizes in a later
  session, the scene glides back to where it was in that room (unless you
  recentered by hand first).
- A recenter carries everything cached in canonical coordinates: the labelled
  scene objects, the body anchor, a room scanned this session (its env frame),
  and a replay placed against an anchored room. The bridge's `world` echo is
  ignored for 0.6 s (it still carries poses from the old frame).

## In-headset status HUD and first-run guide (`src/ui/hud.js`, `src/ui/status.js`)

A small strip, body-locked with a **lazy follow** (it moves only after a ~25 deg
head turn), ~24 deg above the gaze and never below eye level, 0.6 m out, so it
never covers the scene or the hands. Text is sized for the Quest 3S (~20 px/deg):
headline ~1 deg, detail ~0.75 deg, textures redrawn only when a word changes.

| row | content |
| --- | --- |
| 1 | link: **LIVE** (green) / **SIMULATED** / **BRIDGE SIM** (amber) / **OFFLINE** / **NO DEVICE** / **STALLED** (red); **REC m:ss** (or SD REC) on the right |
| 2 | `IMU 2/2` (bridge health), `ENC n/12` (live joint channels), neutral: `neutral ✓` / `provisional` / `no neutral` / `old` |
| 3 | `pose 100 Hz · 14 ms · 72 fps` (pose lane rate + measured latency + render rate), or `snap 60 Hz (no pose lane)`; transient recenter notes |

Under it, the **first-run guide** card walks connect -> calibrate neutral -> try
the twin (5 s with the device driving it) -> record -> replay. Steps complete
from the live state only (never from a "next" click), so the card can never
claim a step that did not happen; a running calibration always takes the card
with the bridge's own countdown. After "All set" it disappears.

## Action dock and input (`src/ui/dock.js`, `src/ui/pointer.js`, `src/ui/gestures.js`)

Six round buttons (4.8 cm faces) on a small panel at the **left** of the scene,
facing you: **hub** (at the hub in XR: **exit AR**), **twin**, **calibrate**,
**record / stop m:ss**, **replay / next take**, **recenter**. Each one answers:

- **poke** with a bare index finger (hover grows the face and lights its rim, a
  soft tick; crossing the face presses it in, flashes, bell + haptic);
- **point and select**: the left hand's ray + pinch, or a controller's ray +
  trigger (a beam and a cursor appear only on a target). Mode objects (hub
  heroes, take rows, capture lights) are ray-selectable too;
- mouse click and keyboard on the desktop.

**The rig hand never presses UI while the device is linked**: its pokes, rays
and pinches are the glove's data (a hand flexing through a take must never hit
STOP). The left hand and the controllers work the dock; with no device linked
both hands do. Disabled buttons dim and say why (`record ·off`,
`calibrate ·off`, `recenter ·busy`).

## Fast pose lane and latency (`src/ui/poseLane.js`)

On every (re)connect the page sends `{"cmd":"stream","pose":true}`
(MOTION_PIPELINE.md section 8). Each `{"kind":"pose"}` is merged over the newest
snap (body block + the 12 joints, device clock `t`), so the device hand, the twin
and contacts render from the 100 Hz device frame. If no pose arrives for 250 ms
(old bridge, lane off) the snap is used unchanged and the HUD says
`snap 60 Hz (no pose lane)`. Latency on the HUD = bridge leg (median `tx - rx`,
same clock) + network (median `Date.now() - tx`), the latter only when the two
clocks agree (-5..400 ms); otherwise it prints `bridge N ms (clocks differ)`
instead of inventing a number. Sequence gaps are counted as drops (`AR.lane`).
The in-page mock emulates the lane.

## Comfort and performance (Quest 3S)

- 72 Hz requested (`updateTargetFrameRate(72)` when offered), fixed foveation
  at maximum, framebuffer scale 0.9, no shadow maps.
- HUD/guide/dock textures redraw only on a changed string; the HUD strings are
  composed at 5 Hz; the pose merge happens at most once per frame.
- Removed per-frame allocations in the hot paths (capture quality meter, replay,
  rhythm, desktop cursor writes); the idle "CONNECTED" banner that covered the
  room for 8 s at entry is replaced by the HUD (scan progress still shows).
- Raycasts use centimetre Points/Line thresholds (three's default is 1 m, which
  let any mote field swallow every pick).
- The HUD reports the measured render rate; the diag beacon carries it plus
  `ui.stage` and `ui.lane`.

## Defense demo script

Before: bridge running against the device (`python3 software/bridge/teensy_bridge.py`),
page served (Option B or C), glove on the right hand and powered, Quest charged,
Space Setup done in this room (for table planes and anchors).

1. **Enter.** Open the page in the Quest browser, tap the round glyph (bottom
   right). *See:* the hub appears on your desk, 45 cm in front of you, within
   reach; after ~2 s it settles onto the table top if the headset found it. The
   HUD strip above your gaze reads **LIVE**, `IMU 2/2 · ENC 12/12`, and the guide
   card says *Step 2/5 Calibrate neutral*. *Say:* "The scene is placed around me,
   not at fixed coordinates; the strip is the live state of the glove: link,
   sensors, calibration, rate and latency."
2. **Calibrate.** Forearm level and forward, palm down, fingers straight; poke
   **calibrate** on the left panel with the left index (or pinch it with the
   left hand's ray). *See:* the card counts 3-2-1 with the device's beeps, then
   "Hold still", then "Calibrated"; the HUD turns `neutral ✓`. *Say:* "The IMUs
   report only relative heading, and the magnets of twelve encoders rule out the
   magnetometer, so every power-up gets a neutral pose."
3. **Twin.** Press **twin**. Move fingers and wrist. *See:* the hand of light
   follows the glove; the word under it says `device`; the HUD shows
   `pose 100 Hz · N ms`. *Say:* "Fingers are the encoders, the wrist is the two
   IMUs through the body model, 100 frames a second over the pose lane; this is
   the measured end-to-end latency."
4. **Record.** Press **record** (it opens capture and counts 3-2-1). Do the task
   for ~10 s. Press **stop** (same button, now red with the timer; the HUD shows
   **REC**). *Say:* "The take is stored on the bridge with its raw device stream,
   quality and provenance."
5. **Replay.** Press **replay**. *See:* the take plays at real scale on the desk,
   the ribbon coloured by pose source (blue vision, amber body model); reach
   along the ribbon to scrub; **next take** cycles. The guide says "All set" and
   leaves. *Say:* "Where the cameras lost the hand, the IMU body model carried
   it: amber on the ribbon."
6. **Recenter (if asked, or if you stood up).** Poke **recenter**, or pinch both
   hands for a second where you want the scene. *See:* the scene glides in front
   of you; the HUD says where it went.
7. **Exit.** Press **hub**, then **exit AR** at the hub.

If the HUD says **SIMULATED**, the page is on the in-page mock (fix the `?ws=`);
**NO DEVICE**: bridge up but the glove is not streaming (USB / power);
**snap 60 Hz (no pose lane)**: the bridge predates section 8, everything still
works at the snapshot rate.

## On-headset checklist

- [ ] Page opens over https (or adb reverse + `*.localhost`); the AR glyph is not amber.
- [ ] Entry: scene in front of you within reach, not at your feet or behind you; on the table when there is one.
- [ ] HUD strip readable at a glance, above the scene, not covering your hands; follows after a big head turn, stays put for small ones.
- [ ] HUD reads LIVE, IMU 2/2, ENC 12/12 (or names the dead channel count), fps ~72.
- [ ] `pose ~100 Hz` with a latency number (or "snap 60 Hz (no pose lane)" on an old bridge).
- [ ] Dock: each button hovers (grows + tick) and presses with the LEFT index; also with the left-hand ray + pinch and with a controller trigger; the gloved right hand does NOT press it.
- [ ] Calibrate: card counts 3-2-1 in step with the device beeps, then Calibrated; HUD neutral ✓.
- [ ] Twin follows the glove with no visible lag; word under it says `device`.
- [ ] Record -> REC m:ss on the HUD and the dock; stop -> guide moves to Replay.
- [ ] Replay plays the take on the desk; next take cycles.
- [ ] Recenter: dock button, A/X held, both-hand pinch, and the Meta-button recenter all put the scene in front of you; recenter is refused (HUD note) during a take.
- [ ] Stand up and recenter: the scene floats at chest height, reachable.
- [ ] Scan a room, exit, re-enter: after the anchor localizes the HUD says "placement restored for this room" and the scene is back where it was.
- [ ] No stutter while scanning, replaying or with both hands in view (fps on the HUD).

## How the hand is placed

1. **Vision**: the headset tracks the bare right hand. It always wins. Joints are
   read from each `XRFrame` (`src/input/xrHands.js`); a lost hand is dropped
   after a 150 ms grace instead of freezing where it left the cameras.
2. **World**: the bridge's `world` block (our own wrist poses, fused with IMU
   dead reckoning through occlusions), used only while it is anchored by this
   session's vision: `quest-fused` while we stream, `imu-model` up to 20 s
   after our last pose (`src/world/poseFallback.js`, `acceptWorld`).
3. **Body**: the `body` arm model, placed with a yaw + translation solved
   continuously while vision sees the wrist, so an occlusion hands over without
   a jump. Before vision has ever seen the hand, a head-derived default is used
   (desktop: the neutral palm lands at the rest point).
4. **Rest**: nothing measured the position: the eased stand-in (contacts are not
   recorded from it).

Fingers always come from the device's joint channels in the fallback; wire
convention: `{f}_mcp` = MCP abduction, `{f}_pip` = MCP flexion, `{f}_dip` = PIP
flexion. In **twin** mode, a linked device drives the fingers even while the
headset sees the hand; the wrist follows the body model (forearm-relative hand
rotation) when present.

While the rig is linked (not only while recording) the page streams the right
wrist pose at 30 Hz so the bridge's world fusion always has a fresh anchor.

## Calibration

The dock's **calibrate** button (or `C`) sends `{"cmd":"calibrate","what":"neutral"}`
(disabled while the device is not streaming). The bridge's countdown / hold /
done / abort acks drive the first-run guide card (a big 3-2-1 from the acks
themselves, then "hold still", then "Calibrated") and the button's label; a
beep per countdown step and a haptic pulse on done. While the bridge runs on a
provisional neutral the HUD reads "neutral provisional" in amber.

## Replay

The dock's **replay** button (`P`, key `6`, or capture's "replay" light) opens the replay mode: the newest takes
from the bridge library, the device hand at real scale following the recorded
wrist, a wrist path line, and a timeline ribbon coloured by pose source (aqua
vision, amber body model, grey none). Reach along the ribbon to scrub. If the
take's room was scanned this session, or its persisted anchor was restored and
localized, the recorded point cloud is drawn in place; otherwise an XR replay is
recentred on the desk and labelled "unanchored".

## Room anchors

Each scan drops a new persisted anchor. At session start the last room's anchor
is restored (frame-free); its pose is read in later XR frames, and only once it
localizes does that room become the session's env. Poses are then streamed in
that env's frame (and the `world` echo is mapped back). If it never localizes
within 15 s, the diag says so and nothing is relocated.

## Tests

```sh
node software/ar/utils/test_pose_fallback.mjs      # Node >= 22, no dependencies
```

Pure-function checks for the XR hand reader, the fallback ladder, the body
anchor, anchor restore/relocation, the chunked room upload with late-ack
recovery, the pose stream gate, the replay track builder, the transport choice,
and the UI layer: recenter math (head / table / hand, planes, glide, per-room
persistence, the scanned room and the body anchor carried across a recenter),
the pose lane (merge, drops, stale fallback, latency with and without synced
clocks), the HUD words and the first-run guide, and the poke / two-hand pinch /
held-button gestures. `harness.html` is a plain telemetry readout (tolerates
`actuators: []`).
