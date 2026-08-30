<div align="center">

<img src="docs/media/hero.png" alt="TAKTO ONE" width="100%">

# TAKTO ONE

**A sensor-integrated, tendon-driven hand exoskeleton — open from the CAD up.**

Twelve magnetic joint encoders. Embedded Dynamixel control with no host PC in the loop.
A live browser digital twin. Every source file needed to build one.

[![Software: Apache-2.0](https://img.shields.io/badge/software-Apache--2.0-blue.svg)](LICENSE.md)
[![Hardware: CERN-OHL-S-2.0](https://img.shields.io/badge/hardware-CERN--OHL--S--2.0-orange.svg)](LICENSE.md)
[![Docs: CC-BY-4.0](https://img.shields.io/badge/docs-CC--BY--4.0-lightgrey.svg)](LICENSE.md)
[![Platform: Teensy 4.1](https://img.shields.io/badge/MCU-Teensy%204.1-red.svg)](firmware/)

[**Build it**](docs/README.md) · [**CAD**](cad/) · [**Electronics**](electronics/) · [**Firmware**](firmware/) · [**Software**](software/)

</div>

---

## What it is

TAKTO ONE is a wearable robotic hand platform built end to end as a master's thesis — mechanics,
industrial design, custom PCBs, embedded firmware, motor control, and a live web interface.
It exists so other people can study it, build it, and take it further.

| | |
| --- | --- |
| **Mechanism** | Tendon-driven, four instrumented long-finger assemblies |
| **Joint sensing** | 12 × AS5600 magnetic encoders, 3 per finger, read live together |
| **Controller** | Teensy 4.1 |
| **Motor bus** | Dynamixel Protocol 2.0 over a 74HC241 half-duplex interface — **the microcontroller owns the bus; no host PC required** |
| **Electronics** | 2 custom PCBs, full KiCad sources + manufacturing outputs |
| **Interface** | Browser operator console with a live 3D twin, over a serial→WebSocket bridge |
| **Structure** | 3D printed; as built, a mix of PETG and PLA |

<img src="docs/media/personalize.png" alt="Personalize it — ten tendon spools, printable in any colour" width="100%">

## Every angle

<table>
<tr>
<td width="50%"><img src="docs/media/top-view.png" alt="Plan view" width="100%"></td>
<td width="50%"><img src="docs/media/side-view.png" alt="Profile view" width="100%"></td>
</tr>
<tr>
<td align="center"><sub>Plan — ten tendon spools, twelve instrumented joints</sub></td>
<td align="center"><sub>Profile — actuator bank and forearm shell</sub></td>
</tr>
</table>

## Repository

| Area | Contents |
| --- | --- |
| [`cad/`](cad/) | Mechanical parts as print-ready STL and neutral STEP |
| [`electronics/`](electronics/) | KiCad sources and manufacturing outputs for both boards |
| [`firmware/`](firmware/) | Unified Teensy 4.1 firmware — sensing, display, recording, Dynamixel |
| [`software/`](software/) | Operator console, live 3D twin, serial→WebSocket bridge |
| [`docs/`](docs/) | System architecture, wiring, build guide, and build notes |

## Start here

**Read [`docs/README.md`](docs/README.md) first.** It carries the system architecture, the
illustrated build guide, and the known corrections between the documentation and the hardware.

```bash
git clone https://github.com/molanocortes/takto-one.git
cd takto-one

# see the console and 3D twin immediately, no hardware needed
python3 -m http.server 8096 --directory software/console/app
# open http://localhost:8096/
```

Then: [`cad/README.md`](cad/README.md) for parts → [`electronics/README.md`](electronics/README.md)
before ordering boards → [`firmware/README.md`](firmware/README.md) to flash →
[`software/README.md`](software/README.md) to connect to hardware.

The embedded Dynamixel driver is also maintained standalone as
[**dynamixel-on-device**](https://github.com/molanocortes/dynamixel-on-device).

## What is verified, and what is not

Being precise about this matters more than a longer feature list.

**Verified:** four long-finger assemblies physically built and instrumented · all 12 encoders
read live together and visualized in the web twin · the Teensy owns the Dynamixel bus through
the 74HC241 · both PCBs exist as manufactured designs with complete sources · the firmware
compiles for a Teensy 4.1 and the bridge serves a live console session in simulation
([verification record](docs/RELEASE_VERIFICATION.md)).

**Not established here:** the firmware supports sensors and control modes beyond what has been
worn and tested — a code path is not a validated behavior. Force rendering, transparency
control, and assistance behavior are not characterized. Simulation exercises the software
pipeline, not the device. Loop rate, telemetry rate, console update rate, and end-to-end
latency are different quantities and are not interchangeable.

**Known limitations.** Ten motors makes this an expensive build. The actuation is a ratchet-based
spool, not a series-elastic actuator. Recent soft-robotics work achieves comparable joint and
force sensing with simpler mechanisms. This is a working, well-instrumented research platform —
not a claim to the state of the art.

## Safety

> TAKTO ONE is an experimental research prototype. **It is not a medical device and not a
> certified protective product.** Do not use it for diagnosis, treatment, unsupervised
> rehabilitation, or safety-critical operation.

Keep actuator power independently removable, begin with torque disabled, test away from the
body, confirm mechanical limits, and validate watchdog and fault behavior before any worn
experiment.

## Contributing

Issues and pull requests are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). If you build
one, open an issue and show it; build reports are the most useful contribution there is.

## License

Software **Apache-2.0** · Hardware **CERN-OHL-S-2.0** · Documentation and media **CC-BY-4.0**.
Full detail, attribution format, and the text-and-data-mining reservation are in
[`LICENSE.md`](LICENSE.md).

<div align="center">
<sub>Designed and built by Sebastian Molano · Hochschule Anhalt · Made in Germany</sub>
</div>
