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

Expect roughly `FLASH: code:149484` and `RAM2: variables:250496`. A very
different RAM2 number means the vignette cache did not land in the second bank
and something in `face_thesis.h` was edited.

## 2. Flash

```bash
arduino-cli upload --fqbn teensy:avr:teensy41 -p /dev/cu.usbmodem* .
```

If the Teensy Loader does not pick it up, press the button on the board and
re-run. The Arduino IDE's own Upload button also works.

## 3. What you should see immediately

The device boots into whatever face was saved in EEPROM. On a board that has
never run this firmware, that is the thesis face in sapphire, because the magic
byte will not match and it falls back to the canonical default.

With no host attached, the thesis face shows the searching comet: a sapphire
arc sweeping the bezel, the diamond of four sensor dots, and the pulsing
centre. This is the same screen the submitted firmware showed. Confirm it
first, because it tests the preservation claim.

**If the screen is blank or shows garbage, stop.** Check `TFT_CS 10 / DC 9 /
RST 8` and the SPI wiring before blaming the engine.

## 4. Switch faces from the serial console

Open the Arduino Serial Monitor at 115200, or:

```bash
screen /dev/cu.usbmodem* 115200
```

Send `?` for the menu. The new command is `W,<face>,<colorway>`:

| command | expect |
|---|---|
| `W,0,0` | thesis, sapphire |
| `W,1,0` | ferro, electric blue |
| `W,2,0` | rams, signal yellow |
| `W,1,3` | ferro, deep red |
| `W,9,0` | refused: the echo ends in `,0` and the screen does not change |

Each command echoes `E,watch,<face>,<colorway>,<ok>`. `ok=1` means the firmware
applied the selection and wrote it to EEPROM.

Then test persistence: send `W,2,0`, unplug the board and plug it back in. It
must come up on Rams. This checks the persistence claim, which is the one most
likely to fail if the EEPROM address collides with something.

## 5. What each face should look like

Compare against `out/contact-all-states.png`, which is the host render of the
same code. Colours will not match exactly (panel gamma, viewing angle), but the
geometry must.

The thesis face is sapphire on a soft dark vignette. With no host it shows the
searching comet. With a host connected and idle it shows the TAKTO five-bar
mark near the top, a pulsing azure heart at the centre, and a pentagon of five
lamps (IMU, ENC, EMG, MOT, LNK). MOT stays a hollow gold ring until the Teensy
has taken the bus and enabled torque (`M,t,1` then `M,e,1`). That is not a
fault: with motor power off it is the expected state. A real drop-out turns a
lamp coral and names it underneath.

Ferro is a dark ferrofluid pool on a near-black field with a lit rim. Look at
this face most closely. The canon puts the mass at #15181C on a #050607 field,
a subtle 6 % luminance difference before the panel's own gamma is applied. On
the host render the body reads as a dark mass with a bright rim. If on the
panel it reads as an empty outline, that is a legibility finding and worth an
issue. It is a property of the approved canon, not a porting bug, and changing
it is a design decision.

Move your instrumented finger and the mass should bulge toward that finger's
bearing along the top arc, with a small counter-lobe opposite. If nothing moves,
the encoders are not being read (see step 7).

Rams is near-black with one yellow accent. It shows a 270-degree tick scale
with a bold index bar on it, a centre numeral, an EMG level bar, and twelve
joint bars along the bottom that trace the profile of your hand. At idle the
index pulses slowly; in an active state it stops pulsing and turns yellow.

In STOP, the thesis face shows a flashing coral ring and an octagon. On Ferro
the substance freezes and inverts to pale, with "S T O P" blinking. On Rams the
entire panel becomes a solid red field with black "STOP" and
"MOTION DISABLED". If STOP is subtle on any face, report it as a bug.

## 6. Measure the frame budget (this is the pending verification)

Send `T`. It prints the paint cost for the window since the last `T`:

```
# paint face=thesis/sapphire last=NNNNus max=NNNNus mean=NNNNus paints=N (N/s) samples=N (N/s) loop=N/s window=Nms tiles=N panel_runs=N panel_last=Nus panel_max=Nus slow=N cadence=100ms interact=80ms deferred=N pending=0 rot=N sync=1
```

Follow these steps closely, because they give the only device measurement in
this runbook:

1. `W,0,0`, then `T` twice about 10 s apart. Note `loop=N/s` and `mean`.
2. `W,1,0`, wait 10 s, `T` twice. Ferro animates continuously, but both
   `samples/s` and `paints/s` must stay at or below 10.0. `deferred` may rise
   when a full frame needs longer than 100 ms; that is intended backpressure
   and does not mean sensor data was dropped.
3. `W,2,0`, same again.
4. Repeat all three with the host bridge connected and streaming, which is the
   loaded case.

Then hold each animated stage for 20 seconds and watch the whole circle. No
region may freeze while another updates, fast numerals must advance in stable
2 % steps rather than chatter, and capture time must change once per second.
Turn the crown quickly: the carousel may reach 12.5 Hz but must settle cleanly.
Finally enter SAFE: the state is checked every 20 ms and must appear without
waiting for the ordinary 100 ms cadence.

**The pass condition is that `samples/s <= 10.0` in normal faces, `pending`
returns to 0, no half-frame or flashing numeral appears, and `loop=N/s` does
not collapse when you switch from Thesis to Ferro or Rams.** If `deferred`
continues increasing while `pending` never returns to 0, record the `panel_max`
and `slow` numbers; that means the physical SPI path is not completing rather
than the animation running too quickly.

## 7. Switch faces from the console and the phone

With the bridge running against the real device:

```bash
cd <repo>
SENSORYHAND_STATE_DIR=.takto-state python3 software/bridge/teensy_bridge.py --port /dev/cu.usbmodem*
python3 -m http.server 8096 --directory software/console/app     # in another shell
```

Open `http://localhost:8096/?ws=ws://localhost:8765/ws#/operator`, expand
**Tools**, then **Watch face**.

- Pick a face and a colorway. The screen should change within a second.
- The caption under the swatches should now say that the device confirmed it.
  With no device attached it reads "held by the host", because nothing reports
  the screen as changed until the Teensy echoes the selection.
- Any other client of the bridge shows the same state, since everything reads
  `snap.watch`.

## 8. Failure modes and what they mean

| symptom | cause |
|---|---|
| Blank screen, serial fine | SPI or panel wiring, not the engine |
| Comes up on the wrong face | EEPROM holds an older selection. Send the face you want; it saves |
| Always boots thesis/sapphire despite saving | The EEPROM write is failing or `WATCH_EE_ADDR` (64) collides with something. Check the `E,watch,...,1` echo is arriving |
| `E,watch,...,0` on a valid id | The index is out of range for the registry. Bring `software/watch/catalog.json` back in step with `watch_engine.h` so the host and the firmware agree |
| Console offers a face the device refuses | `catalog.json` is stale relative to the firmware. Same fix |
| Ferro looks like an empty outline | A known risk; see step 5. A legibility finding, not a port bug |
| Joint bars flat, Ferro does not deform | Encoders are only sampled while streaming or recording. Connect the bridge, or send `j` |
| Loop rate collapses on Ferro | A frame-budget failure. Report the `T` numbers |

## 8b. The DOOM build

A separate firmware image, not in this release, links this same face engine and
hides a port of the 1993 DOOM behind a crown sequence on the round screen; the
remote-control page for it is still present in `software/web/src/views/doom.js`.
It needs soldered PSRAM and a FAT32 card holding the game data, and it is not
part of the face-engine verification. It is mentioned only to explain the
console's DOOM route; there is nothing here to flash.

## 9. When it works

Open an issue with the `T` numbers from step 6 for each face, loaded and
unloaded. Those are the measurements `FRAME-BUDGET.md` still lacks, and a
photograph of each face on the panel is more useful than any render here.
