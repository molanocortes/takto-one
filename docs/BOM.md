# Bill of materials

**Scope: the four-finger configuration — eight motors, twelve instrumented joints.** That is
what the device controls today, and it is what the published CAD, boards and firmware were
dimensioned around.

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="media/bom-cost-dark.svg">
    <img src="media/bom-cost-light.svg" alt="Parts cost by group: actuation EUR 1040 of a EUR 1244.44 total, then motion sensing 66.57, print stock 50.00, control 43.97, joint sensing 26.40, transmission 17.50" width="100%">
  </picture>
</div>

Two things this total is not. The forearm carries **ten** spool/tensioner bays, not eight: the
two spare bays are deliberate headroom for a thumb pair, and the firmware already addresses
fourteen encoder channels of which twelve are populated. Nobody has built that thumb — the
linkage, the tendon routing and the kinematics are all open, and it is named as an invitation
in the top-level README. And the shipped firmware is configured for **two** motors
(`N_MOTOR = 2` in `firmware/takto_one/takto_one.ino`), one antagonist pair on one finger, which
is the bench setup rather than a full build. Buy against the configuration you intend to build.

Quantities come from primary sources, not from an earlier parts list: the firmware pin map and
constants, the two KiCad projects and their manufacturing BOMs, and the export manifest in
[`../cad/README.md`](../cad/README.md). A machine-readable copy of every line below is in
[`bom.csv`](bom.csv).

> **Prices are indicative, not a quotation.** They are carried from the project's own 2026
> purchasing at the suppliers named, are **ex VAT and ex shipping** unless a line says
> otherwise, and were correct to the best of the author's records in **2026**. Semiconductor
> and motor pricing moves — re-quote every line before ordering. Lines marked `—` were bought
> as part of a larger order, salvaged, or not separately recorded; they are real requirements
> with no price the author can honestly publish.

---

## Actuation

| Item | Part number | Supplier | Qty | Unit (EUR) |
| --- | --- | --- | ---: | ---: |
| Dynamixel servo | XC330-M181-T | Robotis / mybotshop.de | 8 | 130.00 |

Two per long finger, an antagonist pair on one spool. The firmware names this model both in its
baud ceiling and in its model check, so a different XC330 variant will not pass `M,t,1`.

A **U2D2 interface set** (EUR 103.95) appears in older costings and is **not required**. The
Teensy owns the bus through the 74HC241; a U2D2 is a development and diagnostic convenience
only, and must be physically disconnected before the firmware will take the bus — it enforces
single-master.

## Sensing

| Item | Part number | Supplier | Qty | Unit (EUR) |
| --- | --- | --- | ---: | ---: |
| AS5600 magnetic encoder IC | AS5600-ASOM · LCSC `C79815` | AMS / JLCPCB | 12 | — |
| Diametric magnet, N35 6 × 2.5 mm | — | generic | 12 | 2.20 |
| 100 nF 0805 capacitor | LCSC `C49678` | JLCPCB | 24 | — |
| BNO085 IMU breakout | — | generic / Amazon.de | 3 | 22.19 |
| Surface EMG sensor, envelope out | MyoWare | generic | 1 | — |

One encoder and one magnet per instrumented joint, three per long finger; two capacitors per
encoder board. The ICs are supplied and placed as part of the JLCPCB assembly order below.

The firmware addresses **14** encoder channels (`N_CHANNELS = 14`, muxes at `0x70` and `0x71`),
of which twelve are populated here — channels 12 and 13 are wired-through spares for a thumb.

The three IMUs sit at dorsal hand (`0x4A`, `Wire1`), forearm (`0x4B`, `Wire2`) and thumb tip
(`0x4B`, `Wire1`). The BNO085 has only two addresses, so the thumb shares the hand bus at the
second address. EMG is optional: its envelope goes to pin 14 (A0), and the firmware reports the
sensor as absent and runs without it.

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

The Teensy runs at 600 MHz, owns the motor bus and runs the control law; its built-in SDIO
socket is the capture target, so size the card for the recording length you want. The display
is on SPI0 (CS 10 / DC 9 / RST 8) and is painted by the firmware's own rasterizer. Crown on pin
27 (A13), presence-checked so an unwired pin cannot fabricate assist authority; button on pin 5;
piezo on pin 2.

The **74HC241** is the half-duplex Dynamixel interface on `Serial1`, direction on pin 7
(HIGH = transmit). It is **central to the current architecture** — earlier documentation calling
it a superseded part is wrong. It is not on the published palm-carrier Gerbers, so wire it
separately and verify the truth table, voltage domains, common ground and receive-default state
on the bench. Keep actuator power independently removable; see the safety note in the top-level
README.

## Custom boards

| Item | Source | Qty |
| --- | --- | ---: |
| Encoder board, AS5600 | [`../electronics/encoder_board/`](../electronics/encoder_board/) | 12 |
| Palm carrier / multiplexer board | [`../electronics/palm_carrier/`](../electronics/palm_carrier/) | 1 |
| TCA9548A I²C multiplexer | LCSC `C130026` | 2 |
| Palm carrier passives | LCSC `C15850`, `C49678`, `C17673`, `C17414` | 1 set |

Both boards were fabricated and assembled in a **single JLCPCB order on 2026-06-17: USD 170.73
delivered** — merchandise USD 127.83, shipping USD 15.64, customs and duties USD 27.26. Within
that order the palm carrier PCBA was USD 50.59 for five pieces. Treat these as what one order
actually cost, not as a per-unit price. The muxes sit on the palm carrier: `0x70` serves
channels 0–7, `0x71` serves channels 8–13. Passives are 1 × 10 µF, 2 × 100 nF, 2 × 4.7 k and
2 × 10 k; the full list is in the board's manufacturing BOM.

> **Erratum, palm carrier channels 8–13.** On the second multiplexer (`U2`) the `SDA`/`SCL` net
> labels are transposed on all six used channels. Wire your sensor's `SCL` to the pad marked
> `SDA` and its `SDA` to the pad marked `SCL`. `U1` (channels 0–7) is correct as labelled.
> Detail in [`README.md`](README.md).

## Transmission and mechanical hardware

| Item | Part number | Supplier | Qty | Unit (EUR) |
| --- | --- | --- | ---: | ---: |
| Braided UHMWPE tendon, 0.30 mm | J-Braid X8 | Daiwa | 1 spool | 17.50 |
| PTFE conduit | — | generic | — | — |
| Elastic tendon element | — | generic | 8 | — |
| Fasteners and pins | — | generic | — | — |

An antagonist cable pair runs on one 5 mm spool per joint, so flexion and extension come from
the same motor with no backlash at reversal. Conduit length depends on your forearm-to-hand run.
The elastic elements are what make the actuation series-elastic — a simple implementation of the
idea, elastic tendons and ratchet spools, not an advanced SEA design. Fasteners are not
enumerated in this release; select and verify them against the STEP files.

## Printed parts

| Item | Supplier | Qty | Unit (EUR) |
| --- | --- | ---: | ---: |
| PETG filament | generic | 1 kg | 20.00 |
| TPU filament | generic | 1 kg | 30.00 |
| PLA filament | generic | 1 kg | — |

**61 printed occurrences across 24 unique components**, all in [`../cad/stl/`](../cad/stl/) with
editable solids in [`../cad/step/`](../cad/step/) and the per-part manifest, with Fusion cloud
versions, in [`../cad/README.md`](../cad/README.md). Ten of those occurrences are `BaseSpool` and
ten are `SpoolCover` — the ten tensioner bays the forearm provides, of which eight are used here.
PETG is structural and TPU is the compliant skin interface; the as-built prototype mixes PETG and
PLA, so any claim that it is entirely PETG is wrong.

Two links per finger are engineered for metal additive manufacturing in AlSi10Mg or 316L. That
path was studied in CAD and linear-static FEA; **no metal parts were fabricated**, and no metal
build is claimed here. Machine time for in-house LPBF is not costed.

---

## Cost summary

| Group | EUR |
| --- | ---: |
| Actuation — 8 × XC330-M181-T | 1040.00 |
| Motion sensing — 3 × BNO085 | 66.57 |
| Print stock — PETG + TPU | 50.00 |
| Control — Teensy 4.1, GC9A01A, SN74HC241N | 43.97 |
| Joint sensing — 12 magnets | 26.40 |
| Transmission — tendon | 17.50 |
| **Priced subtotal** | **1244.44** |

Both custom boards came to a further **USD 170.73** as one delivered order. These lines carry no
published price and are not in the subtotal: EMG sensor, microSD, crown pot, button, piezo, motor
supply and wiring, PTFE conduit, elastic elements, fasteners, PLA stock.

**This supersedes the EUR 1,599.84 figure** that earlier project material quoted. That number was
an earlier costing of the same four-finger design, and it differs for two reasons: it included a
U2D2 set at EUR 103.95, which the current motor architecture does not need, and it attributed the
whole JLCPCB order to a single PCB line at EUR 155.21 rather than recording it as one order
covering both boards. The project website carries the same figure as this page, so the two agree;
if you change one, change the other.

**The eight motors are most of the cost, and that is the honest headline.** Reducing the motor
count through underactuation is the single change that would most widen who can build this, and
it is named as an open invitation in the top-level README.
