# Flash runbook: the watch face engine on the physical screen

The face renders in this repository are host renders of the same face code, not
photographs of the panel, and the on-device frame-budget numbers have not been
recorded here. Working through this runbook on your build produces the
device-side evidence.

Budget about 20 minutes. Nothing here needs the motors, the SEA runner, or a
host connection except where it says so.

---

## 0. Before you start

You need the Teensy connected by USB and `arduino-cli` with the Teensy board
package installed (the Arduino IDE bundles one; see
[`../../../README.md`](../../../README.md) for the compile line).

```bash
arduino-cli version
```

The sketch includes the face engine from its own `watch/` subfolder, so the
whole of `firmware/takto_one/` must be copied together if you move it.

## 1. Compile (should be identical to what is already verified)

```bash
cd <repo>/firmware/takto_one
arduino-cli compile --fqbn teensy:avr:teensy41 .
```

With the Teensy 1.60.0 core, expect roughly `FLASH: code:154508` and
`RAM2: variables:250496` (measured 2026-10-17). A very different RAM2 number
means the vignette cache did not land in the second bank and something in
`face_thesis.h` was edited.

## 2. Flash

```bash
arduino-cli upload --fqbn teensy:avr:teensy41 -p /dev/cu.usbmodem* .
```

If the Teensy Loader does not pick it up, press the button on the board and
re-run. The Arduino IDE's own Upload button also works.

## 3. What you should see immediately

The device boots into the selection saved in EEPROM. On a board that has never
run this firmware, that is the thesis face in sapphire, because the magic byte
will not match and it falls back to the canonical default.

With no host attached, the face shows the connection screen: a short sapphire
arc moving slowly round the bezel, a diamond of four sensor dots and a dot at
the centre. It is the submitted firmware's searching screen, slowed down for
the panel and with a still centre. If no IMU and no encoder answers, the
firmware treats that as total sensor loss and shows STOP instead.

**If the screen is blank or shows garbage, stop.** Check `TFT_CS 10 / DC 9 /
RST 8` and the SPI wiring before blaming the engine.

## 4. Switch colorways from the serial console

Open the Arduino Serial Monitor at 115200, or:

```bash
screen /dev/cu.usbmodem* 115200
```

Send `?` for the menu. The watch command is `W,<face>,<colorway>`. Face 0,
thesis, is the only face built, and it has three colorways:

| command | expect |
|---|---|
| `W,0,0` | thesis, Sapphire Depth |
| `W,0,1` | thesis, Graphite |
| `W,0,2` | thesis, Amber |
| `W,0,3` | refused: only three colorways are exposed |
| `W,1,0`, `W,2,0` | refused: only face 0 is built |

Each command echoes `E,watch,<face>,<colorway>,<ok>` with the face and colorway
now showing. `ok=1` means the firmware applied the selection and wrote it to
EEPROM. A refused command echoes `ok=0` with the selection that is still
showing, and the screen does not change.

Then test persistence: send `W,0,2`, unplug the board and plug it back in. It
must come up in Amber. This checks the persistence claim, which is the one most
likely to fail if the EEPROM address collides with something.

## 5. What the face should look like

There is no host render of the current build in this repository. The contact
sheet in `docs/media/watch-faces.jpg` is older than the current linked and
calibration screens, so go by the descriptions here. Colours on the panel will
not match a render exactly (panel gamma, viewing angle), but the geometry must.

The thesis face is sapphire on a soft dark vignette. With no host, and with a
host connected and idle, it shows the connection screen from step 3.

The fault screen appears when the bridge is streaming but no IMU or no encoder
answers. It shows the TAKTO five-bar mark near the top, a pulsing gold dot at
the centre, and a pentagon of five lamps (IMU, ENC, EMG, MOT, LNK). A missing
part turns its lamp coral and is named underneath. MOT stays a hollow gold ring
until the Teensy has taken the bus and enabled torque (`M,t,1` then `M,e,1`).
That is not a fault: with motor power off it is the expected state.

In the linked state (operator mode) the face shows a full ring, CONNECTED, and
four lamps for IMU, encoders, motors and link: green when that part works, red
when it does not. The lamps are drawn when the screen appears and are not
redrawn while it stays up, so a change shows only at the next forced repaint (a
state change, a `W` command or a screen rotation). If you enable torque while
this screen shows, the motors lamp stays red until then.

In STOP, the face shows a flashing coral ring, an octagon and the word Stop. If
STOP is subtle, report it as a bug.

## 6. Measure the frame budget (this is the pending verification)

Send `T`. It prints the paint cost for the window since the last `T`:

```
# paint face=thesis/sapphire last=NNNNus max=NNNNus mean=NNNNus paints=N (N/s) samples=N (N/s) loop=N/s window=Nms tiles=N panel_runs=N panel_last=Nus panel_max=Nus slow=N cadence=130ms interact=104ms deferred=N pending=0 rot=N sync=1
```

Follow these steps closely, because they give the only device measurement in
this runbook:

1. `W,0,0`, then `T` twice about 10 s apart. Note `loop=N/s` and `mean`. With
   no host since power-on the face shows the boot screen, which may present up
   to 16.7 frames a second, so `samples/s` stays at or below 16.7.
2. Repeat with the host bridge connected and streaming, which is the loaded
   case. On the idle screen both `samples/s` and `paints/s` must stay at or
   below 7.7. `deferred` may rise when a frame is due while the panel is still
   sending the previous one; that is intended backpressure and does not mean
   sensor data was dropped.

Then hold each animated stage for 20 seconds and watch the whole circle. No
region may freeze while another updates, the effort percentage must move in
steady 5 % steps rather than chatter, and capture time must change once per
second. Turn the crown quickly: the carousel may reach 9.6 Hz but must settle
cleanly. Finally enter SAFE: the state is checked every 20 ms and must appear
without waiting for the ordinary 130 ms cadence.

**The pass condition is that `samples/s` stays at or below 7.7 on ordinary
screens (9.6 with the carousel open, 16.7 on the boot screen), `pending`
returns to 0, no half-frame or flashing numeral appears, and `loop=N/s` stays
steady while the face animates.** If `deferred` continues increasing while
`pending` never returns to 0, record the `panel_max` and `slow` numbers; that
means the physical SPI path is not completing rather than the animation running
too quickly.

## 7. Switch colorways from the console

With the bridge running against the real device:

```bash
cd <repo>
SENSORYHAND_STATE_DIR=.takto-state python3 software/bridge/teensy_bridge.py --port /dev/cu.usbmodem*
python3 -m http.server 8096 --directory software/console/app     # in another shell
```

Open `http://localhost:8096/?ws=ws://localhost:8765/ws`. The colorway swatches
sit in the "Device screen" card, under the screen preview.

- Pick a colorway. The screen should change within a second.
- The console marks the swatch as soon as the bridge accepts the choice, so the
  swatch does not tell you whether the device took it. The bridge's state does:
  in `snap.watch`, `persisted` turns true and `source` becomes `device` only
  when the Teensy echoes the selection. With no device attached they stay
  `false` and `host`.
- Every client of the bridge gets the same state in `snap.watch`.

## 8. Failure modes and what they mean

| symptom | cause |
|---|---|
| Blank screen, serial fine | SPI or panel wiring, not the engine |
| STOP right after boot | No IMU and no encoder answered, which the firmware treats as total sensor loss. Check the wiring and send `s` to re-scan |
| Comes up in the wrong colorway | EEPROM holds an older selection. Send the one you want; it saves |
| Always boots thesis/sapphire despite saving | The EEPROM write is failing or `WATCH_EE_ADDR` (64) collides with something. Check the `E,watch,...,1` echo is arriving |
| `E,watch,...,0` on a valid id | The index is out of range for the registry. Bring `software/watch/catalog.json` back in step with `watch_engine.h` so the host and the firmware agree |
| Console offers a colorway the device refuses | `catalog.json` is stale relative to the firmware. Same fix |
| Console shows six colorways | It is running on its simulated source, whose mock catalog lists six. Open it with `?ws=` pointing at the bridge (step 7) |
| Loop rate collapses while the face animates | A frame-budget failure. Report the `T` numbers |

## 8b. The DOOM build

A separate firmware image, not in this release, links this same face engine and
hides a port of the 1993 DOOM behind a crown sequence on the round screen; the
remote-control page for it is still present in `software/web/src/views/doom.js`.
It needs soldered PSRAM and a FAT32 card holding the game data, and it is not
part of the face-engine verification. It is mentioned only to explain the
`#/doom` route in `software/web`; there is nothing here to flash.

## 9. When it works

Open an issue with the `T` numbers from step 6, loaded and unloaded. Those are
the measurements `FRAME-BUDGET.md` still lacks, and a photograph of the face on
the panel is more useful than any render here.
