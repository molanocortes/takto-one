# TAKTO Lab

The bench camera experiment station: a fixed camera, the device on the same
clock, four protocols that a page walks you through, and a composer that
cuts the result into the two-panel portrait videos the evidence needs.

<div align="center"><em>One clock. Every frame and every device sample carries a monotonic
timestamp taken on this machine the instant it arrived; the page's GO is one
such timestamp. Alignment is therefore a subtraction, never a guess.</em></div>

## Why the computer and not the phone

The phone would give a faster sensor, but not the same picture twice. The
Mac on a stand gives the same lens, the same distance and the same angle for
every take, which is what a comparison needs, and the bridge, the tracker,
the recorder and the page all run in one process on one clock. The cost is
frame rate: the FaceTime camera delivers 30 frames per second at 1280x720
and no more, whatever is requested. The page shows the rate it measures, so
"fast" is never a claim the software makes on the camera's behalf. Any UVC
camera or an iPhone as Continuity Camera can be selected with `--camera N`,
and a 60 or 120 fps device raises the rate with no other change.

## Run it

```bash
cd software/lab
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python lab.py                       # camera 0, bridge on localhost
```

Open http://localhost:8790. macOS asks once for camera access for the
terminal that runs it. Options: `--camera 1`, `--fps 60`, `--bridge
ws://192.168.1.20:8765/ws`, `--tracker markers`, `--source take.mp4` (a video
file stands in for the camera; the take is looped). The bridge is
`../bridge/teensy_bridge.py`; with `--sim` it feeds synthetic joints.

## The four protocols

| Protocol | The person | The device | What comes out |
| --- | --- | --- | --- |
| **Bare finger** | index finger alone; rest, 3-2-1, 10 s comfortable pace, rest, 3-2-1, 10 s as fast as possible | none | the reference: range of motion, peak angular speed, cadence, per block |
| **Finger in TAKTO** | the identical script, wearing the device, motors off | encoders stream | the same numbers; camera-vs-encoder RMSE and lag; twin reconstruction accuracy; and against the bare take, **"x % slower"** and range retained |
| **Robot follows** | bare finger moves freely for 20 s | on the table, string-coupled; the bridge's camera-follow gateway drives it | target-vs-actual RMSE, follower lag, share of poses reached; the device plays every pose back late but whole |
| **Assisted targets** | wearing the device, hand relaxed | motors on; six named poses, one after another | time from GO to settle (within 4 deg, held 300 ms), per target |

The two comparison protocols are identical on purpose, phase for phase.
Rest phases define "straight": both the camera angles and the encoder angles
are zeroed on the median of the last second of rest, the same operation on
both sides. Motion onset (velocity above 30 deg/s for three samples) aligns
two takes so their movements start on the same frame.

## The follower

The finger will be faster than the device. Chasing the newest pose would
skip the ones in between, so the follower keeps every sampled pose in a
queue and moves to the next only when the device has reached the current
one (within 4 deg) or has had 1.5 s to try. The device plays the motion back
late but complete, and the queue measures how late: that lag, and the share
of poses reached, are the result. The bridge's own gateway is the only path
to the motors (neutral, directions, arm, target at 10 Hz, its 250 ms
freshness watchdog and 35/45 deg envelope all stay in force); the lab never
issues a current. "Newest pose only" is there for comparison.

The inverse kinematics in `lab/kinematics.py` is the mechanism's own law,
ported from the shared `kinematics.js` and proven equal to it by
`tests/test_kinematics.py` (200 random poses through node, agreement to
1e-9): joint angle to spool angle is `theta_s = (h_arm / r_spool) theta_j`,
the slides follow from the joint angle, and nothing is iterated or guessed.

## Tracking

Two trackers write the same `track.csv`:

- **Hand model** (MediaPipe hand landmarker, pinned to the 0.10 line; 1.0 on
  macOS aborts in its Metal helper): 21 landmarks, world coordinates when
  present; MCP, PIP and DIP flexion read as 180 deg minus the interior angle,
  0 = straight. For the bare finger.
- **Colour markers**: a small coloured dot on the wrist line, the MCP, the
  PIP and the DIP, seen from the side; each is calibrated by clicking it in
  the picture. For the finger in TAKTO and for the device on the table: a
  hand model trained on hands does not find a hand wearing an exoskeleton
  (checked on the studio photograph), and a device is not a hand.

The live pass gives feedback and drives the follower (a One Euro filter for
the eye). The analysis pass re-runs the tracker on every frame of the saved
video and filters with a zero-phase Savitzky-Golay window, so the dataset is
complete and timing is unbiased, whatever the live load was.

## What a take contains

```
takes/<id>/  meta.json  video.mp4  frames.csv  device.csv  events.csv
             live_track.csv  track.csv  follow.csv  twin/  exports/
```

`frames.csv` is the video's real clock (one row per encoded frame);
`device.csv` one row per bridge snapshot on arrival; `events.csv` the phases
and GO; `track.csv` the analysis pass. Every number the page shows is in
`meta.json` under `analysis`, with the method above.

## Composing the videos

The Compose tab stacks two panels into 1080 x 1920: the camera's truth on
top, the comparison below. Each panel is a take's video (crop by dragging)
or the digital twin rendered from that take's device rows (the Twin button
on a take: the same CAD and the same kinematics as every other TAKTO surface,
one frame per 30th of a second, uploaded as PNG). Both panels start at their
own onset. The headline is one number and its method line, suggested from
the analysis; slow-motion is nearest-frame, so it never invents a frame.

## Tests

```bash
./.venv/bin/python tests/test_kinematics.py      # parity with kinematics.js
./.venv/bin/python tests/test_capture_stack.py   # tracker + recorder, no camera
./.venv/bin/python tests/test_analysis.py        # metrics on synthetic traces
./.venv/bin/python tests/test_compose.py         # the composer on synthetic takes
./.venv/bin/python tests/make_marker_video.py t.mp4 && ./.venv/bin/python lab.py --source t.mp4 --tracker markers
```

The last line is a full rehearsal without a hand: four coloured dots move
like a finger, and every protocol can be run against `../bridge/teensy_bridge.py --sim`.

## Honesty

Synthetic is labelled synthetic (`--source`, `--sim`); a number is shown
with what it is and how it was taken; the follower's lag is reported, not
hidden; and no protocol claims more than the bridge and the firmware allow.
