# Firmware

`takto_one/` is the unified Teensy 4.1 firmware. The checked-in sketch reports firmware version 16 and includes:

- Up to 14 AS5600 channels through two TCA9548A multiplexers
- BNO085 support across the configured I²C buses
- EMG-envelope input, SD recording, crown/button/piezo input, and a GC9A01A display
- A production TAKTO watch face
- 100 Hz motion frames with on-device preintegrated IMU velocity (see [`../software/MOTION_PIPELINE.md`](../software/MOTION_PIPELINE.md))
- Standalone recording to the SD card, a neutral-pose calibration, and a sound for every key moment
- Two-motor Dynamixel Protocol 2.0 support through a 74HC241 on `Serial1`
- Torque-off startup, bus fault accounting, communication watchdogs, and bounded control modes

## Build

Install the Teensy board package and the Adafruit GFX and Adafruit GC9A01A libraries, then open `takto_one/takto_one.ino` in Arduino IDE and select **Teensy 4.1**.

From an Arduino IDE installation that bundles `arduino-cli`, the equivalent compile is:

```bash
arduino-cli compile --fqbn teensy:avr:teensy41 --libraries "$HOME/Documents/Arduino/libraries" firmware/takto_one
```

The BNO085 and Dynamixel drivers used by this sketch are included locally. The full pin map, serial stream, command menu, and motor commands are documented at the top of `takto_one.ino`.

## Bring-up order

Compile first, then verify sensing, display, storage, and the serial stream with motor power disconnected. Test the 74HC241 receive-default state and single-master rule before taking the Dynamixel bus. Enable torque only with the mechanism clear, an independent power cutoff available, and feedback confirmed.

## Using the device on its own (power bank)

With no computer holding the USB port open for 6 s after power-up, the device is
**standalone**. With auto-record on (the default) and a card in, it starts a take by
itself; every take starts with a neutral-pose capture so it can be turned into a
calibrated twin later.

| Gesture | What happens |
| --- | --- |
| Press (no host) | Start / stop a take on the SD card |
| Turn the crown | Open the mode carousel; press to pick. **Calibrate** = neutral-pose capture, **Capture** = start/stop a take |
| Hold 0.6 s | Back to home |
| Hold 3 s | Standby: the take is closed safely and the screen goes dark. Press to wake. Unplug only in standby or with no take running |

Neutral pose: forearm forward and roughly level, **palm down, wrist straight, fingers
extended**. The screen counts 3-2-1 (one beep per second) and then asks you to hold still
for 2 s; moving restarts the hold, and after 7 s without a still window the capture is
abandoned rather than calibrating a moving arm.

Takes are written to `/TAKES/TKnnnnn.CSV` (format in `MOTION_PIPELINE.md` section 6). The
bridge lists and imports them over USB, so the card never has to leave the device.
`F,auto,0` over serial turns standalone auto-record off (stored in EEPROM).

### Sounds

| Sound | Meaning |
| --- | --- |
| Rising four-note arpeggio | Powered on |
| Falling four-note arpeggio / short rising pair | Standby / awake again |
| Soft rising / falling pair | A computer connected / disconnected |
| Low then high / high then low | Take started / take saved |
| Two low buzzes | No SD card, card full, write failed, or a neutral capture abandoned |
| Ticks, then a bright chime | Neutral countdown, then captured |
| Falling / rising warble | An IMU stopped / came back (the device restarts it by itself) |
| Three rising notes, two beeps, beep-low | Motor bus connected, torque on, torque off |
| Urgent two-tone alarm | Motor fault: the safety path turned torque off |

`Q` over serial mutes the buzzer for bench work. A true power cut cannot make a sound (the
board has no energy left to play it), which is why the power-off gesture is the 3 s hold.
