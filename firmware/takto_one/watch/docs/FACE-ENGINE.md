# TAKTO watch face engine

Three complete watch faces for the on-device round screen (GC9A01, 240x240,
RGB565, Teensy 4.1), switchable at runtime from the console, with the choice
persisted on the device.

**What the evidence is:** every face is verified visually on a host build of
the same C++ the Teensy runs. Those renders are not photographs of the panel,
and the on-device frame-budget numbers have not been recorded in this
repository. `FLASH-RUNBOOK.md` is how to take them.

```
firmware/takto_one/watch/        the engine. Compiles unchanged for Teensy and for a host
  watch_state.h                    DeviceState, FaceState, Colorway, the WatchFace interface
  watch_gfx.h                      the RGB565 rasterizer + MiniCanvas1 text
  watch_fonts.h                    the three stock Adafruit GFX fonts
  watch_presentation.h             the presentation filters and paint cadence
  face_thesis.h                    FACE 1, a preservation port of the submitted UI
  face_ferro.h                     FACE 2, a port of the approved Ferro canon
  face_rams.h                      FACE 3, a new Braun/Rams instrument face
  watch_engine.h                   registry, selection, finger-amplitude law, carousel
software/watch/catalog.json      generated from the registry; the only face list anything reads
```

Not included in this release: the host render and fidelity-test harness
(`watch_render`, `fidelity_test`, the verbatim legacy copy and the mock feed),
the Ferro design canon, and the review renders. Where this document cites them
it is describing how the faces were verified, not files you will find here.

## The architecture

A face is a pure **consumer** of `DeviceState`. It reads the struct, paints a
240x240 framebuffer, and returns. It never reads a sensor, never touches a bus,
never blocks, and never triggers work of its own. The sketch owns everything
else and calls the engine in four steps:

1. fill a `DeviceState` from signals it already has;
2. `watch::engineUpdate(state, dt)` derives the per-finger amplitude envelope;
3. compare `watch::signature(state, carousel)` with the last one and return
   early if unchanged (the value-dirty rule the submitted firmware already
   used: identical signature means zero paint, zero tile scan, zero SPI);
4. `watch::engineRender(fb, state, carousel)`.

The panel push is untouched: the dirty-run DMA engine in `firmware_ui.h` still
ships at most one coalesced row band per loop pass.

### Dual target

The same headers compile for the Teensy and for a host binary that renders to
PNG. That is the verification backbone: every face, state and colorway is looked
at as an image before anything is flashed. Only the font tables come from
outside the repo (the stock `Adafruit_GFX_Library` the firmware already needs).

The sketch includes the engine directly from `firmware/takto_one/watch/`, so
there is exactly one copy of the face code and no install step.

## Face 1 - THESIS (preservation)

The on-wrist UI exactly as submitted. Every painter is moved verbatim from
`DeviceFirmware.ino`: same geometry, same constants, same quantized animation
phases. The only mechanical changes are that `millis()` became the engine clock
and the palette is indirected so a colorway can be selected.

A host fidelity test (not in this release) is the gate. It renders a
**verbatim copy** of the submitted painters and the engine's port side by side
for every original state at eight animation phases and compares them byte for
byte, plus it checks the text rasterizer against the raw font tables. Result at
the time of the port: **68 assertions, 0 failures, 0 differing pixels.**

If the port and the copy ever disagree, the **engine** is wrong; the submitted
painters are the reference.

Sapphire Depth is the original palette and the only canonical colorway. The two
extras are explicitly non-canonical recolors that change nothing but the palette
entries.

## Face 2 - FERRO (canon port)

A port of an approved design canon (a set of JavaScript canvas sketches, not
included here), not a redesign. Every parameter curve is transcribed from those
sketches with the numbers unchanged; the translation is JS canvas to RGB565
software rasterizer.

Per the canon's selection record: finger v5 Mass-lobe, boot v3 Fusion, idle v3 Breathe,
linked L1 Moon (the one explicit owner pick), standalone v3 Drift, teleop v3
Channel, recording recA Witness orbit, calib v3 Settle, stop v3 Freeze+invert,
fault v3 Fracture, battery v3 Thin/feed.

Boot is tagged **[B]** in the canon, so per the brief it uses its sketched
**[A] fallback**: no per-droplet gather memory, fade-in plus bloom ring-out with
bounded droplets. Everything else is [A] and implemented directly.

Feasibility follows FERRO-SPEC "Implementation readiness": a 140-step radius
LUT, 2-stop radial shading, at most 10 droplets and 7 feed dots, and a
precomputed crack tree. No solver, no allocation, no dynamic memory.

## Face 3 - RAMS (new design)

A precision instrument to Ferro's organism. Braun/Rams language: a strict grid,
near-monochrome with one accent, nothing decorative in motion.

**The layout is a documented system, not a set of chosen positions**, and the
header of `faces/face_rams.h` is its spec: a 4 px base unit with a fixed
spacing scale, exactly two text sizes (measured cap heights 35 px and 13 px),
a round-canvas rule (safe radius 106, composed centre-out, secondary readouts
on rings and arcs), and minimum stroke weights derived from what 32.5 mm
actually resolves at a wrist glance. Any state added later inherits it.

In short: the outer 270-degree scale ring plus a bold index bar is the primary
readout, the centre numeral sits on the exact geometric centre and only
confirms it, the EMG meter is the one cartesian instrument on a polar face, and
the gauge's own 90-degree dead sector at the bottom carries four per-finger
bars, ten charge segments, or a hatched warning band depending on state.

Three things were removed rather than compressed, which is the part of the
system that keeps it honest: twelve per-joint bars became four per-finger bars
(twelve bars in 13 mm mush into a grey block at arm's length), the "EMG"
caption went entirely (it cost a row and pushed the meter off the axis), and
the ring numerals went (the majors and the centre numeral already say it). The
accent is spent only on state signals, never on routine readings.

Verified on host renders at 240 px, at physical scale (141 px = 32.5 mm at
110 DPI), blurred for the squint test, and before/after per state.

Motion is information: the index breathes at rest and goes steady and accent
when engaged, teleop adds a second hollow index for commanded torque and fills
the sector between them, recording blinks a 1 Hz square, calibration grows the
captured span as an arc, a major fault adds a hatched warning band, and STOP
replaces the entire panel with a solid alarm field.

STOP uses a dedicated alarm red regardless of colorway. An e-stop that changes
appearance with a user preference is not an e-stop.

## Honest gaps, stated plainly

These are the places where the engine can render something the device cannot
currently produce. None of them are bugs; all of them would be lies if left
undocumented.

| Gap | The truth |
|---|---|
| `FS_BATTERY` | The board has **no fuel gauge**. The firmware never enters this state and always reports `battery = -1`. Both new faces implement it, and the harness exercises it, because the Ferro canon specifies it and a future board may have one. |
| `DeviceState.torque` | Measured, not commanded. The Teensy owns the motor bus, and the sketch fills this field with the largest measured motor current normalised by the software current cap (`I_CAP_MA`), or 0 whenever the bus is not taken or torque is off. It is a current-effort proxy, not a torque measurement at the finger; the faces label it as effort. |
| Thesis face, battery screen | The submitted firmware has **no battery screen**. The one here is an engine-era addition built from the thesis face's own vocabulary, and it is excluded from the pixel-fidelity gate because there is no original to be faithful to. |
| Ferro, `FS_SAVED` | The canon never explored a saved state. It is rendered as the canon's own documented recording exit (pinch-off, rejoin, completion ring-out), so no new vocabulary is invented, but it is canon-**derived**, not canon-selected. |
| Ferro, battery phases | The canon's battery entry is an 18 s demo **loop**. The device has real values, so the three phases are selected by `(battery, charging)` instead of by loop time. The curves inside each phase are unchanged. |
| `FS_STANDALONE` | New. The submitted firmware showed the searching-comet screen forever when the link went away; the shared state machine now distinguishes "never linked" (boot) from "was linked, link lost" (standalone), because the Ferro canon requires that distinction. The thesis face still renders it with its own vocabulary, and its **painters** remain pixel-identical, but this is a state-machine change, not a pure preservation. |
| Joint data when idle | Encoder channels are only read when something is already consuming them (streaming or recording). An idle, unlinked device reports `joints = -1` and the faces draw them as **absent** rather than inventing values. |
| Colorway `canonical: false` | Explored candidates or non-canonical recolors. Every surface must label them. A `note` containing `[panel-risk]` is a legibility warning from the design canon and must be shown, not hidden. |

## One deliberate change to a shared primitive

`blend565` (verbatim from the submitted firmware) computes
`(s*a + d*(255-a)) >> 8`, so at `a = 255` it returns one 565 level **below** the
source. On the thesis face that only ever touches thin anti-aliased edges and is
invisible. Ferro fills its whole body through the blend path and its darkest
gradient stops sit at 565 level 1, where losing a level rounds the mass to pure
black and the body vanishes into the field.

The alpha-aware primitives added for Ferro and Rams therefore write the source
directly at full coverage (`blendOver`). The verbatim primitives still call
`blend565` unchanged, which is why the thesis fidelity gate is still green.

## The finger-amplitude law

Shared by every face, derived once per tick by `watch::engineUpdate`:
`a_i = min(1, 4 * |dtheta_i/dt|)` over each finger's live channels, instant
attack, exponential decay with tau = 0.45 s. That is FERRO-SPEC's AMP rule, and
it is harmless to the faces that ignore it. Channels reading < 0 contribute
nothing, so a partially populated hand produces fewer deformations rather than
fake ones.

## Regenerating everything

The host harness that rendered the review sheets and regenerated the catalog is
not part of this release. What matters for a contributor is the invariant it
enforced:

`software/watch/catalog.json` mirrors the C++ registry in `watch_engine.h` and
is the **only** face list the bridge and the console are allowed to read. If
you add a face or a colorway, update `catalog.json` in the same change, or
every other surface goes stale. The bridge refuses to start without the file.
