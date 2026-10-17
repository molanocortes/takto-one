# TAKTO watch face engine

The engine that draws the on-device round screen (GC9A01, 240x240, RGB565,
Teensy 4.1). One face, thesis, is built into the firmware. Its colorway can be
switched at runtime from the console, and the choice is saved on the device.
Two earlier designs, Ferro and Rams, are still in the source for reference but
aren't built: `watch_engine.h` registers only the thesis face
(`FACE_COUNT = 1`).

Every face was verified visually on a host build of the face code. Those
renders are not photographs of the panel, and the on-device frame-budget
numbers have not been recorded in this repository. `FLASH-RUNBOOK.md`
describes how to take them.

```
firmware/takto_one/watch/        the engine. Compiles unchanged for Teensy and for a host
  watch_state.h                    DeviceState, FaceState, Colorway, the WatchFace interface
  watch_gfx.h                      the RGB565 rasterizer + MiniCanvas1 text
  watch_fonts.h                    the three stock Adafruit GFX fonts
  watch_presentation.h             the presentation filters and paint cadence
  face_thesis.h                    the thesis face, ported from the submitted UI. The only face built
  face_ferro.h                     Ferro, a port of the approved Ferro canon. Not built
  face_rams.h                      Rams, a Braun/Rams instrument face. Not built
  watch_engine.h                   registry (thesis only), selection, finger-amplitude law, carousel
software/watch/catalog.json      generated from the registry; the face list the bridge serves
```

Not included in this release: the host render and fidelity-test harness
(`watch_render`, `fidelity_test`, the verbatim legacy copy and the mock feed),
the Ferro design canon, and the review renders. Where this document cites them,
it is describing how the faces were verified.

## The architecture

A face only consumes `DeviceState`: it reads the struct, paints a 240x240
framebuffer, and returns. It does not read sensors, touch a bus, block, or start
work of its own. The sketch owns everything else and calls the engine in four
steps:

1. fill a `DeviceState` from signals it already has;
2. `watch::engineUpdate(state, dt)` derives the per-finger amplitude envelope;
3. compare `watch::signature(state, carousel)` with the last one and return
   early if unchanged (the value-dirty rule the submitted firmware already
   used: an identical signature skips the paint, the tile scan and the SPI
   transfer);
4. `watch::engineRender(fb, state, carousel)`.

The panel push lives in `firmware_ui.h`. It sends at most one run of up to
64 x 16 px per loop pass, synchronously, and commits its shadow copy of the
panel only after the write returns.

### Dual target

The same headers compile for the Teensy and for a host binary that renders to
PNG. The host build is the main verification tool: every face, state and
colorway is inspected as an image before anything is flashed. Only the font
tables come from outside the repo (the stock `Adafruit_GFX_Library` the
firmware already needs).

The sketch includes the engine directly from `firmware/takto_one/watch/`, so
there is one copy of the face code and no install step.

## The thesis face

This is the face the firmware runs. It began as a port of the on-wrist UI as
submitted. The painters were moved from `DeviceFirmware.ino` with the same
geometry, constants and quantized animation phases. `millis()` became the
engine clock and the palette was indirected so a colorway can be selected.

The gate for the port was a host fidelity test (not in this release). It
rendered a verbatim copy of the submitted painters and the engine's port side
by side for every original state at eight animation phases and compared them
byte for byte. It also checked the text rasterizer against the raw font tables.
At the time of the port the result was 68 assertions, 0 failures and 0
differing pixels.

The face has changed since then, so that result describes the port, not the
face as it is now:

- Idle, standalone and calibration show the connection screen, as boot does.
  In the submitted UI, idle had its own home screen and calibration had a
  prompt.
- The connection sweep was slowed to 10 degrees a second, which is 0.6 degrees
  per frame on the boot screen. A full degree per frame read as a series of
  jumps on the panel. The centre dot no longer pulses.
- The linked screen says CONNECTED above four lamps for IMU, encoders, motors
  and link.
- The home screen with the five-bar mark and the pentagon of five lamps now
  appears only in the fault state.

Where a painter was not changed, the submitted one is still the reference.

Sapphire Depth is the original palette and the only canonical colorway.
Graphite and Amber are marked non-canonical. They change the palette entries
and re-tint the vignette, and nothing else. `face_thesis.h` also defines Sea
Glass, Violet and Ice, but the face exposes only the first three colorways, so
the device refuses colorway 3 and up.

## Ferro (in the source, not built)

Ferro ports an approved design canon (a set of JavaScript canvas sketches, not
included here) without redesigning it. Every parameter curve is transcribed
from those sketches with the numbers unchanged; the translation is from JS
canvas to the RGB565 software rasterizer.

Per the canon's selection record: finger v5 Mass-lobe, boot v3 Fusion, idle v3 Breathe,
linked L1 Moon (the one explicit owner pick), standalone v3 Drift, teleop v3
Channel, recording recA Witness orbit, calib v3 Settle, stop v3 Freeze+invert,
fault v3 Fracture, battery v3 Thin/feed.

Boot is tagged [B] in the canon, so per the brief it uses its sketched [A]
fallback: no per-droplet gather memory, fade-in plus bloom ring-out with
bounded droplets. Everything else is [A] and implemented directly.

Feasibility follows FERRO-SPEC "Implementation readiness": a 140-step radius
LUT, 2-stop radial shading, at most 10 droplets and 7 feed dots, and a
precomputed crack tree. There is no solver and no dynamic memory allocation.

## Rams (in the source, not built)

Rams is an instrument-style face in the Braun/Rams design language: a strict
grid, near-monochrome with one accent, and no decorative motion.

Positions on this face are derived from a documented layout system, and the
header of `watch/face_rams.h` is its spec: a 4 px base unit with a fixed
spacing scale, only two text sizes (measured cap heights 35 px and 13 px), a
round-canvas rule (safe radius 106, composed centre-out, secondary readouts on
rings and arcs), and minimum stroke weights derived from what the eye can
resolve on the 32.5 mm panel at a wrist glance. Any state added later uses the
same system.

The centre numeral, on the geometric centre, is the primary reading. A bold
index bar on the outer 270-degree scale ring shows the same value as a needle.
The EMG meter is the only cartesian readout on the polar face. The gauge's
90-degree dead sector at the bottom carries four per-finger bars, ten charge
segments, or a hatched warning band, depending on state.

Three elements were removed instead of being shrunk. Twelve per-joint bars
became four per-finger bars (at arm's length, twelve bars in 13 mm blur into a
grey block). The "EMG" caption was dropped (it cost a row and pushed the meter
off the axis). The ring numerals were dropped (the major ticks and the centre
numeral already carry that information). The accent is used only for state
signals; routine readings are drawn without it.

The layout was verified on host renders at 240 px, at physical scale (141 px =
32.5 mm at 110 DPI), blurred for the squint test, and as before/after pairs for
each state.

Each animation shows a state. At rest the index pulses; when engaged it holds
steady in the accent. Teleop adds a second, hollow index for the torque
value and fills the sector between the two. Recording blinks a 1 Hz square.
Calibration grows the captured span as an arc. A major fault adds a hatched
warning band, and STOP replaces the entire panel with a solid alarm field.

STOP uses a dedicated alarm red regardless of colorway, so that the e-stop
display does not change with a user preference.

## Known gaps

These are the places where the engine can render something the device cannot
currently produce. None of them are bugs, but each would mislead if it were
left undocumented.

| Gap | Detail |
|---|---|
| `FS_BATTERY` | The board has no fuel gauge. The firmware never enters this state and always reports `battery = -1`. Ferro and Rams implement it, and the harness exercised it, because the Ferro canon specifies it and a future board may have one. |
| `DeviceState.torque` | The value is measured, not commanded. The Teensy owns the motor bus, and the sketch fills this field with the largest measured motor current normalised by the software current cap (`I_CAP_MA`), or 0 whenever the bus is not taken or torque is off. It is a current-effort proxy and does not measure torque at the finger. The thesis face does not draw it. |
| Thesis face, battery screen | The submitted firmware has no battery screen. The one here is an engine-era addition built from the thesis face's own vocabulary, and it is excluded from the pixel-fidelity gate because there is no original to compare it with. |
| Ferro, `FS_SAVED` | The canon did not explore a saved state. It is rendered as the canon's own documented recording exit (pinch-off, rejoin, completion ring-out), so no new vocabulary is invented, but it counts as canon-derived rather than canon-selected. |
| Ferro, battery phases | The canon's battery entry is an 18 s demo loop. The device has real values, so the three phases are selected by `(battery, charging)` instead of by loop time. The curves inside each phase are unchanged. |
| `FS_STANDALONE` | This state is new. The submitted firmware kept showing the searching-comet screen indefinitely after the link went away; the shared state machine now distinguishes "never linked" (boot) from "was linked, link lost" (standalone), because the Ferro canon requires that distinction. The thesis face shows the connection screen for it, as it does for boot, so on that face the two states look the same. |
| Joint data | The sketch reads every live encoder once per frame, whether or not anything is streaming or recording, and passes the first twelve channels to the face. A channel reports `-1`, and the faces draw it as absent instead of inventing a value, until it answers at a scan and has shown at least 5 degrees of range since power-on. The thesis face does not draw joints. |
| Colorway `canonical: false` | Explored candidates or non-canonical recolors. Every surface must label them. A `note` containing `[panel-risk]` is a legibility warning from the design canon and must be shown. |

## One change to a shared primitive

`blend565` (verbatim from the submitted firmware) computes
`(s*a + d*(255-a)) >> 8`, so at `a = 255` it returns one 565 level below the
source. On the thesis face this only affects thin anti-aliased edges and is not
visible. Ferro fills its whole body through the blend path and its darkest
gradient stops sit at 565 level 1, where losing a level rounds the mass to pure
black and the body can no longer be told apart from the field.

The alpha-aware primitives added for Ferro and Rams therefore write the source
directly at full coverage (`blendOver`). The verbatim primitives still call
`blend565` unchanged, and the thesis face draws only through `blend565`, so
adding `blendOver` did not change a thesis pixel.

## The finger-amplitude law

`watch::engineUpdate` derives the amplitude once per tick, and every face shares
the result: `a_i = min(1, 4 * |dtheta_i/dt|)` over each finger's live channels,
with instant attack and exponential decay (tau = 0.45 s). This is FERRO-SPEC's
AMP rule; faces that ignore it are unaffected. Channels reading < 0 contribute
nothing, so a partially populated hand produces fewer deformations and none
from the missing channels.

## Regenerating everything

The host harness that rendered the review sheets and regenerated the catalog is
not part of this release. The invariant it enforced still applies to
contributors:

`software/watch/catalog.json` mirrors the C++ registry in `watch_engine.h`, and
the bridge serves it to every client. The simulated sources in the console and
the web front end carry their own copy (`MOCK_WATCH_CATALOG` in each
`telemetry.js`), which still lists six colorways. If you add a face or a
colorway, update `catalog.json` and both mocks in the same change, or every
other surface goes stale. Without `catalog.json` the bridge still starts, but
it rejects every watch command.
