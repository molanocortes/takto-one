# Electronics

This folder contains the two custom PCB designs used by TAKTO ONE.

- `encoder_board/` is the AS5600 magnetic encoder board.
- `palm_carrier/` is the palm sensor carrier and TCA9548A multiplexer board.

Each board includes its KiCad source and the matching manufacturing outputs. The checked-in sources match the working project copies used for this release.

The current embedded motor architecture uses a separate 74HC241 half-duplex interface on Teensy `Serial1`, with direction control on pin 7. That interface is not integrated into the published palm-carrier Gerbers. Do not infer motor-bus wiring from the PCB files alone; use the pin map in `firmware/takto_one/takto_one.ino` and verify the buffer truth table, voltage domains, common ground, and receive-default state on the bench.

Before ordering, open both projects in KiCad, update footprints only deliberately, and run ERC/DRC plus an independent manufacturing review. The manufacturing files are provided as the project outputs, not as a guarantee from a board house.
