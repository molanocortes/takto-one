# Documentation

| Document | What it covers |
| --- | --- |
| [`system-architecture.svg`](system-architecture.svg) | Sensing, aggregation, control, and host layers as one diagram |
| [`global-wiring.pdf`](global-wiring.pdf) | Full point-to-point wiring: every pin terminated, both I²C multiplexers, all encoder channels, three IMUs, and the 74HC241 servo bus. Rendered inline in the top-level README as [`media/global-wiring.png`](media/global-wiring.png) |
| [`BOM.md`](BOM.md) | Bill of materials for the costed four-finger configuration: parts, quantities, suppliers, and dated indicative prices. Machine-readable copy in [`bom.csv`](bom.csv) |
| [`build-guide.pdf`](build-guide.pdf) | 24-page illustrated assembly walkthrough, including 1:1 part-check plates |
| [`RELEASE_VERIFICATION.md`](RELEASE_VERIFICATION.md) | How this release was assembled and checked |

## Build notes and corrections

Read these alongside the documents above. They are the known deltas between the written
documentation and the current hardware and firmware.

### I²C channel labels on the palm carrier, channels 8–13

On the palm carrier, the second multiplexer (`U2`) has its `SDA`/`SCL` net labels transposed
on all six channels it uses. The nets named `SDA8`–`SDA13` land on that device's clock pins,
and `SCL8`–`SCL13` land on its data pins.

**When wiring channels 8–13, swap the two signal wires relative to the label:** connect your
sensor's `SCL` to the pad marked `SDA`, and its `SDA` to the pad marked `SCL`. The first
multiplexer (`U1`, channels 0–7) is labelled correctly and needs no change.

This is a net-naming error only. The routing, the silkscreen positions, and the board itself
are otherwise correct, and the firmware works against the hardware as built once the six pairs
are wired as described.

### The build guide predates the current motor architecture

The build guide was written during the thesis work and two of its statements have since been
superseded:

- It states that the motor bus is owned by a host PC through a U2D2 and that the Teensy only
  senses. **This is no longer the case.** The Teensy 4.1 owns the Dynamixel bus directly
  through a 74HC241 half-duplex interface; a host PC is optional. See the top-level README and
  [`dynamixel-on-device`](https://github.com/molanocortes/dynamixel-on-device).
- It describes the prototype as 100% PETG. The as-built prototype uses **both PETG and PLA**.

Everything else in the guide, the mechanical assembly order, part-check plates, tendon
routing, spool and ratchet setup, and board fitting, reflects the device as built.

### The ratchet is a third-party part

The actuation uses ratchet spools, and the ratchet itself is not TAKTO-authored. It is ORCA's
`Ratchet.stl`, redistributed unmodified at
[`cad/third_party/orca/`](../cad/third_party/orca/) under CC BY 4.0, **not** under this
project's CERN-OHL-S-2.0. Print one per spool station, ten for a full build. That folder carries
the licence text, the attribution, and a SHA-256 you can check against upstream.

The mating `cad/stl/base_spool.stl` in this release is a TAKTO-modified adaptation of ORCA's
`BaseSpool.stl` and *is* included; `cad/stl/spool_cover.stl` is TAKTO's own design and is not
interchangeable with ORCA's `SpoolCover.stl`. See
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

### Board revision

The wiring documentation cites carrier nets from a `Zero_Palm_V2` schematic. The KiCad project
published here is `Zero_Palm_V1`. Treat the published KiCad sources as authoritative for pad
and net questions, and the wiring PDF as the routing overview.

### Motor bus is not on the published Gerbers

The 74HC241 half-duplex interface is wired separately on Teensy `Serial1` with direction
control on pin 7. It is not integrated into the published palm-carrier Gerbers. Use the pin map
in `firmware/takto_one/takto_one.ino` and verify the buffer truth table, voltage domains,
common ground, and receive-default state on the bench.

## Notes on the bundled website

The website in `software/web/` is the source of the public front end, with one deliberate
omission: **`assets/docs/` is not included.** In the working copy that folder holds private documents that are not
distributed here. A preprint call-to-action that pointed into it was removed along with it. Add
such a link back only when there is a published paper to point at, and prefer a DOI to a bundled
PDF.

The page also probes for three optional files and simply hides the corresponding element when
they are absent: `assets/cv.pdf`, `assets/vision.jpg` and `assets/film/poster.jpg`. If you drop a
CV at that path in a public fork, it becomes public with everything in it. That is worth knowing
before you use it.

The AR layer in `software/ar/` is the app only. Its capture and asset tooling is not included.
It also has a known bug on high-DPI displays: it sizes its render target from CSS pixels while
the canvas backs at the device ratio, so on a 2x screen the scene draws into a quarter of the
canvas. Force a device pixel ratio of 1 as a workaround.
