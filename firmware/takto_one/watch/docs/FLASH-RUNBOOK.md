# Flash runbook: the watch face engine on the physical screen

**Status: the firmware compiles clean for Teensy 4.1 and has NOT been flashed.
Every image produced so far is a host render of the same face code, not a
photograph of the panel. On-device behaviour is PENDING until you walk this.**

Budget about 20 minutes. Nothing here needs the motors, the SEA runner, or a
host connection except where it says so.

---

## 0. Before you start

You need the Teensy connected by USB and the Arduino IDE's `arduino-cli`, which
is already on this machine:

```bash
/Applications/Arduino\ IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli version
```

The sketch reaches the face engine through a symlink
(`DeviceFirmware/watch -> Fable/watch/faces`). If you ever copy the sketch
folder somewhere else, copy it with `cp -R` so the symlink resolves, or the
build will fail with `watch/watch_engine.h: No such file`.

## 1. Compile (should be identical to what is already verified)

```bash
cd <repo>/firmware/takto_one
"/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli" compile --fqbn teensy:avr:teensy41 .
```

Expect roughly `FLASH: code:149484` and `RAM2: variables:250496`. A wildly
different RAM2 number means the vignette cache did not land in the second bank
and something in `face_thesis.h` was edited.

## 2. Flash

```bash
"/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli" upload --fqbn teensy:avr:teensy41 -p /dev/cu.usbmodem* .
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
heart at centre, and a pentagon of five lamps (IMU, ENC, EMG, MOT, LNK). MOT is
a hollow gold ring, not a fault, because the host owns the motor bus. A real
drop-out turns a lamp coral and names it underneath.

**Ferro.** A dark ferrofluid pool on a near-black field with a lit rim. **This
is the one to scrutinise.** The canon puts the mass at #15181C on a #050607
field, which is a genuinely subtle 6 % luminance difference before the panel's
own gamma touches it. On the host render the body reads as a dark mass with a
bright rim. If on the panel it reads as an empty outline with nothing inside,
that is a real legibility finding and worth telling me: it is a property of the
approved canon, not a porting bug, and changing it is a design decision that is
yours to make.

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
cd <repo>/software/bridge
python3 teensy_bridge.py --port /dev/cu.usbmodem*
python3 -m http.server 8096 --directory ../app     # in another shell
```

Open `http://localhost:8096/#/operator`, expand **Tools**, then **Watch face**.

- Pick a face and a colorway. The screen should change within a second.
- The caption under the swatches should now read that the **device confirmed
  it**. With no device attached it reads "held by the host", which is the
  honesty rule: until the Teensy echoes, nothing claims the screen changed.
- The Android app's Settings has the same selector and should show the same
  state, since both read `snap.watch`.

## 8. Failure modes and what they mean

| symptom | cause |
|---|---|
| Blank screen, serial fine | SPI or panel wiring, not the engine |
| Comes up on the wrong face | EEPROM holds an older selection. Send the face you want; it saves |
| Always boots thesis/sapphire despite saving | The EEPROM write is failing or `WATCH_EE_ADDR` (64) collides with something. Check the `E,watch,...,1` echo is arriving |
| `E,watch,...,0` on a valid id | The index is out of range for the registry. Regenerate `catalog.json` (`make catalog` in `Fable/watch/host`) so the host and the firmware agree |
| Console offers a face the device refuses | `catalog.json` is stale relative to the firmware. Same fix |
| Ferro looks like an empty outline | Expected-ish; see step 5. A legibility finding, not a port bug |
| Joint bars flat, Ferro does not deform | Encoders are only sampled while streaming or recording. Connect the bridge, or send `j` |
| Loop rate collapses on Ferro | The real frame-budget failure. Report the `T` numbers |

## 8b. The DOOM build (a SEPARATE image, optional, do it last)

`Fable/doom/firmware/takto_doomgeneric` is a different sketch that also uses
this face engine: it boots to the normal watch and hides real id DOOM behind a
crown sequence. It is not part of the face-engine verification and it does no
sensing. Walk it only after steps 1 to 7 above are green, because it needs
hardware the sensing build does not.

Extra hardware it needs, which the guards report on screen if missing:
**PSRAM soldered** (8 MB, the bottom QSPI pads) and a **FAT32 microSD** holding
`DOOM1.WAD` at the card root (`Fable/doom/server/fetch_wad.sh --to <card>`).

```bash
ACLI="/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli"
"$ACLI" compile --fqbn "teensy:avr:teensy41:opt=oslto" Fable/doom/firmware/takto_doomgeneric
# stop teensy_bridge.py first, then upload with -p <PORT>
```

Host-verified figures to check against on the bench (2026-07-30):
FLASH code 187,904 + data 180,880; **RAM1 free for locals 36,640 B**;
RAM2 free 155,520 B. That RAM1 headroom is the number to watch: it is the stack
DOOM runs in, and it is less than half what the DOOM-only build had before the
face engine was linked in. It has NOT been proven on hardware.

| symptom | cause |
|---|---|
| `NO PSRAM` / `NO SD CARD` / `NO DOOM1.WAD` on entry | exactly what it says; the watch stays usable, the gate just refuses |
| The crown sequence never opens anything | steps time out at 1.5 s apart. Three pips at the bottom of the dial mean you are three steps in |
| It opens DOOM and then immediately returns to the watch | the stall watchdog. The engine booted but never drew: suspect the SD read or the zone heap |
| It opens DOOM and hangs with no way out | the one failure the gate cannot catch, because a hang inside a tic stops the loop that services it. Report it: this is the case that would need the hardware watchdog |
| Long press does not leave | the gate is not seeing crown events; check `uiIn.begin` pins against `dg_config.h` |

Report the RAM1 stack headroom under load and whether E1M1 holds frame rate.
Until then `README-EGG.md` says the watch build compiles and has not been
flashed, because that is what is true.

## 9. When it works

Tell me and I will replace the PENDING notes in `FACE-ENGINE.md` and
`FRAME-BUDGET.md` with the measured numbers, and record the on-device state in
memory. Until then every document in this directory says the firmware compiles
and has not been flashed, because that is what is true.
