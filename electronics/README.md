# Electronics

This folder contains the two custom PCB designs used by TAKTO ONE.

- `encoder_board/` is the AS5600 magnetic encoder board.
- `palm_carrier/` is the palm sensor carrier and TCA9548A multiplexer board.

Each board includes its KiCad source and the matching manufacturing outputs. The checked-in sources match the working project copies used for this release.

The current embedded motor architecture uses a separate 74HC241 half-duplex interface on Teensy `Serial1`, with direction control on pin 7. That interface is not integrated into the published palm-carrier Gerbers. Do not infer motor-bus wiring from the PCB files alone; use the pin map in `firmware/takto_one/takto_one.ino` and verify the buffer truth table, voltage domains, common ground, and receive-default state on the bench.

## Wiring note: palm carrier channels 8-13

The second multiplexer (`U2`) on the palm carrier has its `SDA`/`SCL` net labels transposed on
all six channels it uses. When wiring channels 8-13, connect your sensor's `SCL` to the pad
marked `SDA` and its `SDA` to the pad marked `SCL`. The first multiplexer (`U1`, channels 0-7)
is correct as labelled. Routing and silkscreen are otherwise correct; this affects net naming
only. Full detail in [`../docs/README.md`](../docs/README.md).

Before ordering, open both projects in KiCad, update footprints only deliberately, and run ERC/DRC plus an independent manufacturing review. The manufacturing files are provided as the project outputs, not as a guarantee from a board house.
