# Bill of materials

Scope: the four-finger configuration, with eight motors and twelve instrumented joints. TAKTO
ONE is designed for ten motors, two per digit. This page prices the eight for the four long
fingers; the thumb's two are left out because there is no thumb mechanism yet. The prototype
has two motors, on one finger, because it was self-funded.

There are two builds. TAKTO ONE is everything below. TAKTO Lite reads the hand without driving
it: it leaves out the eight servos, the tendons and conduit, the elastic elements, the printed
ratchets, the 74HC241 bus driver and the motor supply. It keeps the twelve encoders, both IMUs,
the EMG input, the Teensy with its display and SD logging, and both circuit boards. The firmware
doesn't use the motor bus until it's told to (`M,t,1`), so a Lite build runs the same firmware.
The `in_lite` column in [`bom.csv`](bom.csv) shows which lines belong to Lite.

| | TAKTO Lite | TAKTO ONE |
| --- | ---: | ---: |
| Priced parts (EUR) | **164.48** | **1,222.25** |
| Both circuit boards, one JLCPCB order (USD) | 170.73 | 170.73 |

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="media/bom-cost-dark.svg">
    <img src="media/bom-cost-light.svg" alt="Parts cost by group: actuation EUR 1040 of a EUR 1222.25 total, then print stock 50.00, motion sensing 44.38, control 43.97, joint sensing 26.40, transmission 17.50" width="100%">
  </picture>
</div>

Two notes on this total. First, the forearm has ten spool/tensioner bays, not eight. The two
spare bays are for a thumb pair, and the firmware already reads fourteen encoder channels, of
which twelve are used. The thumb itself hasn't been built; its linkage, tendon routing and
kinematics are still open (see Contributing in the top-level README). Second, the firmware as
released is configured for two motors (`N_MOTOR = 2` in `firmware/takto_one/takto_one.ino`),
one antagonist pair on one finger. That's the bench setup, not a full build. Buy for the
configuration you plan to build.

The quantities come from the firmware pin map and constants, the two KiCad projects and their
manufacturing BOMs, and the export manifest in [`../cad/README.md`](../cad/README.md), not from
an earlier parts list. Every line below is also in [`bom.csv`](bom.csv).

> **Prices are indicative, not a quote.** They come from the project's own purchases in 2026
> from the suppliers named, and they exclude VAT and shipping unless a line says otherwise.
> Chip and motor prices change, so get new quotes before ordering. Lines marked `—` were bought
> as part of a larger order, salvaged, or not recorded separately. You still need those parts,
> but there is no reliable price for them.

---

## Actuation

| Item | Part number | Supplier | Qty | Unit (EUR) |
| --- | --- | --- | ---: | ---: |
| Dynamixel servo | XC330-M181-T | Robotis / mybotshop.de | 8 | 130.00 |

Two per long finger, as an antagonist pair on one spool. The firmware checks for this exact
model, both for its baud rate limit and in its model check, so a different XC330 variant won't
pass `M,t,1`.

A U2D2 interface set (EUR 103.95) appears in older costings but isn't needed. The Teensy drives
the bus through the 74HC241. A U2D2 is only useful for development and diagnostics, and it has
to be unplugged before the firmware will take the bus, because the firmware allows only one bus
master.

## Sensing

| Item | Part number | Supplier | Qty | Unit (EUR) |
| --- | --- | --- | ---: | ---: |
| AS5600 magnetic encoder IC | AS5600-ASOM · LCSC `C79815` | AMS / JLCPCB | 12 | — |
| Diametric magnet, N35 6 × 2.5 mm | — | generic | 12 | 2.20 |
| 100 nF 0805 capacitor | LCSC `C49678` | JLCPCB | 24 | — |
| BNO085 IMU breakout | — | generic / Amazon.de | 2 | 22.19 |
| Surface EMG sensor, envelope out | MyoWare 2.0 | SparkFun / generic | 1 | — |

One encoder and one magnet per instrumented joint, three per long finger, and two capacitors
per encoder board. The ICs are supplied and placed as part of the JLCPCB assembly order below.

The firmware reads 14 encoder channels (`N_CHANNELS = 14`, muxes at `0x70` and `0x71`), and
twelve of them are populated here. Channels 12 and 13 are wired-through spares for a thumb.

Two IMUs are fitted, on the back of the hand (`0x4A`, `Wire1`) and on the forearm (`0x4B`,
`Wire2`). The firmware and the wiring have a third position at the thumb tip (`0x4B`, `Wire1`).
The BNO085 has only two addresses, so a thumb IMU would share the hand bus at the second
address. It isn't fitted here or priced above; fitting it takes one more BNO085 (EUR 22.19).
The empty channel reports MISSING in the `s` bus scan and streams a live flag of zero. EMG is
optional: its envelope goes to pin 14 (A0), and if the sensor isn't there the firmware reports
it as absent and runs without it. The MyoWare 2.0 uses three electrodes, two along the muscle
belly and a reference on quiet tissue, and takes standard disposable Ag/AgCl gel electrodes.

## Control and interface

| Item | Part number | Supplier | Qty | Unit (EUR) |
| --- | --- | --- | ---: | ---: |
| Teensy 4.1 | TEENSY41 | PJRC | 1 | 31.20 |
| Round display, 1.28 in 240 × 240 | GC9A01A | generic / Amazon.de | 1 | 12.50 |
| Octal buffer / line driver | SN74HC241N | TI / Reichelt | 1 | 0.27 |
| microSD card | — | generic | 1 | — |
| Potentiometer, the crown | — | generic | 1 | — |
| Tactile button | — | generic | 1 | — |
| Piezo buzzer | — | generic | 1 | — |
| Motor supply and wiring | — | — | 1 | — |

The Teensy runs at 600 MHz, drives the motor bus and runs the control law. Recordings go to the
microSD card in its built-in SDIO socket, so choose the card size for the recording length you
need. The display is on SPI0 (CS 10 / DC 9 / RST 8) and is drawn by the firmware's own
renderer. The crown is on pin 27 (A13); the firmware checks that it's connected, so a floating
pin can't be read as an assist setting. The button is on pin 5 and the piezo on pin 2.

The 74HC241 is the half-duplex Dynamixel interface on `Serial1`, with direction on pin 7
(HIGH = transmit). The current design depends on it; earlier documentation that calls it a
superseded part is wrong. It isn't on the published palm-carrier Gerbers, so wire it separately
and check the truth table, voltage domains, common ground and default receive state on the
bench. Make sure the actuator power can be removed on its own; see the safety note in the
top-level README.

## Custom boards

| Item | Source | Qty |
| --- | --- | ---: |
| Encoder board, AS5600 | [`../electronics/encoder_board/`](../electronics/encoder_board/) | 12 |
| Palm carrier / multiplexer board | [`../electronics/palm_carrier/`](../electronics/palm_carrier/) | 1 |
| TCA9548A I²C multiplexer | LCSC `C130026` | 2 |
| Palm carrier passives | LCSC `C15850`, `C49678`, `C17673`, `C17414` | 1 set |

Both boards were made and assembled in one JLCPCB order on 2026-06-17 that cost USD 170.73
delivered: USD 127.83 for the goods, USD 15.64 for shipping and USD 27.26 for customs and
duties. Within that order, the palm carrier PCBA was USD 50.59 for five pieces. These are the
costs of one real order, not unit prices. The muxes are on the palm carrier: `0x70` serves
channels 0–7 and `0x71` serves channels 8–13. The passives are 1 × 10 µF, 2 × 100 nF, 2 × 4.7 k
and 2 × 10 k; the full list is in the board's manufacturing BOM.

> **Erratum, palm carrier channels 8–13.** On the second multiplexer (`U2`) the `SDA`/`SCL` net
> labels are swapped on all six used channels. Wire your sensor's `SCL` to the pad marked `SDA`
> and its `SDA` to the pad marked `SCL`. `U1` (channels 0–7) is labelled correctly. Details are
> in [`README.md`](README.md).

## Transmission and mechanical hardware

| Item | Part number | Supplier | Qty | Unit (EUR) |
| --- | --- | --- | ---: | ---: |
| Braided UHMWPE tendon, 0.30 mm | J-Braid X8 | Daiwa | 1 spool | 17.50 |
| PTFE conduit | — | generic | — | — |
| Ratchet, printed | [`../cad/third_party/orca/`](../cad/third_party/orca/) | ORCA hand · CC BY 4.0 | 10 | — |
| Elastic tendon element | — | generic | 8 | — |
| Fasteners and pins | — | generic | — | — |

An antagonist cable pair runs on one 5 mm spool per joint, so flexion and extension come from
the same motor with no backlash when it reverses. The conduit length depends on the distance
from your forearm to your hand. The ratchet, one per spool station, is third-party geometry from
the ORCA hand project. It is redistributed unmodified under CC BY 4.0 and printed like any other
part, and it isn't covered by this project's CERN-OHL-S-2.0 licence. See
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). The elastic elements make the
actuation series-elastic. It's a simple version of the idea (elastic tendons and ratchet
spools), not a full SEA design, and the transmission has been run on the bench both with and
without them. Fasteners aren't listed in this release; choose them and check them against the
STEP files.

## Printed parts

| Item | Supplier | Qty | Unit (EUR) |
| --- | --- | ---: | ---: |
| PETG filament | generic | 1 kg | 20.00 |
| TPU filament | generic | 1 kg | 30.00 |
| PLA filament | generic | 1 kg | — |

A full build has 71 printed parts: 61 TAKTO parts (24 different components) plus the 10 ORCA
ratchets above. The TAKTO parts are all in [`../cad/stl/`](../cad/stl/), with editable solids
in [`../cad/step/`](../cad/step/) and the per-part manifest, including Fusion cloud versions, in
[`../cad/README.md`](../cad/README.md). Ten of the 61 are `BaseSpool` and ten are `SpoolCover`,
one of each for the forearm's ten tensioner bays, of which eight are used here. PETG is for the
structure and TPU for the soft parts against the skin. The prototype as built uses a mix of
PETG and PLA, so it isn't all PETG.

Two links per finger were also designed for metal 3D printing in AlSi10Mg or 316L. That option
was only studied in CAD and in linear-static FEA. No metal parts have been made, and none are
claimed here. Machine time for in-house LPBF isn't included in the cost.

---

## Cost summary

| Group | EUR |
| --- | ---: |
| Actuation (8 × XC330-M181-T) | 1040.00 |
| Motion sensing (2 × BNO085) | 44.38 |
| Print stock (PETG + TPU) | 50.00 |
| Control (Teensy 4.1, GC9A01A, SN74HC241N) | 43.97 |
| Joint sensing (12 magnets) | 26.40 |
| Transmission (tendon) | 17.50 |
| **Priced subtotal, TAKTO ONE** | **1222.25** |
| **Priced subtotal, TAKTO Lite** (without the actuation, the tendon and the 74HC241) | **164.48** |

The two custom boards cost another USD 170.73, as one delivered order. These lines have no
published price and aren't in the subtotal: EMG sensor, microSD, crown pot, button, piezo,
motor supply and wiring, PTFE conduit, elastic elements, fasteners and PLA stock.

Earlier project material quoted EUR 1,599.84. That was an older costing of the same
four-finger design. The main differences: it included a U2D2 set at EUR 103.95, which the
current motor setup doesn't need, and it counted the whole JLCPCB order as a single PCB line at
EUR 155.21 instead of one order covering both boards. The project website uses the same figures
as this page; if you change one, change the other.

The eight motors are most of the cost, EUR 1,040 of the EUR 1,222.25. Using fewer motors, for
example through underactuation, would make the build much cheaper. It's one of the open
problems listed under Contributing in the top-level README.
