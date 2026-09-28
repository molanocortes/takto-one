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
in the headset, a "simulated" word under the exit ring plus a SIMULATED panel on
entry). A bridge that is configured but not connected shows a red
"bridge offline · <url>" badge. The mock never pretends to store anything: room
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
Enter) to begin. Keys: `1`-`6` atelier / capture / rhythm / touch / twin /
replay, `Esc` hub, `c` calibrate (when the body model streams). In replay:
space play/pause, left/right seek, up/down pick a take. `?mode=<name>` starts in
a mode. `window.AR` exposes the app for scripted checks.

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

The amber "calibrate" ring (beside the exit ring) appears whenever the bridge
streams the body model. Reaching it sends `{"cmd":"calibrate","what":"neutral"}`;
the countdown / hold / done / abort acks are shown next to it. While the bridge
runs on a provisional neutral it reads "calibrate: hold your hand flat".

## Replay

Capture's "replay" light (or key `6`) opens the replay mode: the newest takes
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
recovery, the pose stream gate, the replay track builder and the transport
choice. `harness.html` is a plain telemetry readout (tolerates `actuators: []`).
