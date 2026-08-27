# Firmware

`takto_one/` is the unified Teensy 4.1 firmware. The checked-in sketch reports firmware version 15 and includes:

- Up to 14 AS5600 channels through two TCA9548A multiplexers
- BNO085 support across the configured I²C buses
- EMG-envelope input, SD recording, crown/button/piezo input, and a GC9A01A display
- A production TAKTO watch face
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
