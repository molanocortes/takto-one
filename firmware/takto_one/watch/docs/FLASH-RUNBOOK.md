# Flash runbook: the watch face engine on the physical screen

**What this establishes.** The face renders in this repository are host renders
of the same face code, not photographs of the panel, and the on-device
frame-budget numbers have not been recorded here. Walking this runbook on your
build is what turns the host evidence into device evidence.

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

Expect roughly `FLASH: code:149484` and `RAM2: variables:250496`. A wildly
different RAM2 number means the vignette cache did not land in the second bank
and something in `face_thesis.h` was edited.

## 2. Flash

```bash
arduino-cli upload --fqbn teensy:avr:teensy41 -p /dev/cu.usbmodem* .
```

If the Teensy Loader does not pick it up, press the button on the board and
re-run. The Arduino IDE's own Upload button works just as well.

## 3. What you should see immediately

The device boots into whatever face was saved in EEPROM. On a board that has
never run this firmware, that is **the thesis face, sapphire** because the
magic byte will not match and it falls back to the canonical default.

With no host attached, the thesis face shows the **searching comet**: a sapphire
arc sweeping the bezel, the diamond of four sensor dots, and the breathing
centre. That is exactly what the submitted firmware showed, and it is the first
thing to confirm, because it is the preservation claim.

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
| `W,9,0` | **refused.** The echo ends in `,0` and the screen does not change |

Every one echoes `E,watch,<face>,<colorway>,<ok>`. `ok=1` means it applied it
AND wrote it to EEPROM.

**Power-cycle test:** set `W,2,0`, unplug, plug back in. It must come up on
Rams. That is the persistence claim, and it is the one most likely to be wrong
if the EEPROM address collides with something.

## 5. What each face should look like

Compare against `out/contact-all-states.png`, which is the host render of the
same code. Colours will not match perfectly (panel gamma, viewing angle), but
the geometry must.

**Thesis.** Sapphire on a soft dark vignette. No host: the searching comet.
Host connected and idle: the TAKTO five-bar mark near the top, a breathing azure
heart at centre, and a pentagon of five lamps (IMU, ENC, EMG, MOT, LNK). MOT
stays a hollow gold ring, not a fault, until the Teensy has taken the bus and
enabled torque (`M,t,1` then `M,e,1`); with motor power off that is the
expected state. A real drop-out turns a lamp coral and names it underneath.

**Ferro.** A dark ferrofluid pool on a near-black field with a lit rim. **This
is the one to scrutinise.** The canon puts the mass at #15181C on a #050607
field, which is a genuinely subtle 6 % luminance difference before the panel's
own gamma touches it. On the host render the body reads as a dark mass with a
bright rim. If on the panel it reads as an empty outline with nothing inside,
that is a real legibility finding and worth an issue: it is a property of the
approved canon, not a porting bug, and changing it is a design decision.

Move your instrumented finger and the mass should bulge toward that finger's
bearing along the top arc, with a small counter-lobe opposite. If nothing moves,
the encoders are not being read (see step 7).

**Rams.** Near-black, one yellow accent, a 270-degree tick scale with a bold
index bar riding it. Centre numeral, an EMG level bar, and twelve joint bars
along the bottom that are literally your hand's profile. At idle the index
breathes slowly; in an active state it stops breathing and goes yellow.

**STOP, on all three.** Thesis: a flashing coral ring and an octagon. Ferro: the
substance freezes and inverts to pale, with "S T O P" blinking. Rams: the entire
panel becomes a solid red field with black "STOP" and "MOTION DISABLED". If any
face's STOP is subtle, that is a bug worth reporting.

## 6. Measure the frame budget (this is the pending verification)

Send `T`. It prints the paint cost for the window since the last `T`:

```
# paint face=thesis/sapphire last=NNNNus max=NNNNus mean=NNNNus paints=N (N/s) samples=N (N/s) loop=N/s window=Nms tiles=N panel_runs=N panel_last=Nus panel_max=Nus slow=N cadence=100ms interact=80ms deferred=N pending=0 rot=N sync=1
```

Do this properly, because it is the only real number in the whole exercise:

1. `W,0,0`, then `T` twice about 10 s apart. Note `loop=N/s` and `mean`.
2. `W,1,0`, wait 10 s, `T` twice. Ferro animates continuously, but both
   `samples/s` and `paints/s` must stay at or below 10.0. `deferred` may rise
   when a full frame needs longer than 100 ms; that is intentional backpressure,
   not dropped sensor data.
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
- The caption under the swatches should now read that the **device confirmed
  it**. With no device attached it reads "held by the host", which is the
  honesty rule: until the Teensy echoes, nothing claims the screen changed.
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
| Ferro looks like an empty outline | Expected-ish; see step 5. A legibility finding, not a port bug |
| Joint bars flat, Ferro does not deform | Encoders are only sampled while streaming or recording. Connect the bridge, or send `j` |
| Loop rate collapses on Ferro | The real frame-budget failure. Report the `T` numbers |

## 8b. The DOOM build

A separate firmware image, not in this release, links this same face engine and
hides a port of the 1993 DOOM behind a crown sequence on the round screen; the
remote-control page for it is still present in `software/web/src/views/doom.js`.
It needs soldered PSRAM and a FAT32 card holding the game data, and it is not
part of the face-engine verification. It is mentioned so the console's DOOM
route is not a mystery, not because there is anything here to flash.

## 9. When it works

Open an issue with the `T` numbers from step 6 for each face, loaded and
unloaded. Those are the measurements `FRAME-BUDGET.md` is waiting for, and a
photograph of each face on the panel is worth more than any render here.
