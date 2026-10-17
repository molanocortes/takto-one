# Frame budget

The watch face must not slow down the sensor loop. This page records what is
known about the cost, what has been measured, and what is still pending.

**Nothing here is a device measurement.** Every number below is from the host
target. The device numbers come from the firmware's own `T` report and have not
been recorded in this repository; `FLASH-RUNBOOK.md`, step 6, describes how to
take them.

## What the engine costs

These host numbers were taken when all three faces were built. Only the thesis
face is built now. The Ferro and Rams figures are kept as a record of the two
designs in the source.

`watch_render --profile` times one paint. `watch_render --duty` is the more
important number: it steps through simulated time, counts the paints the
value-dirty signature requests, and reports milliseconds of paint per second of
wall clock. The physical firmware now applies a stricter 130 ms presentation
gate, added after this host-side characterization.

Per-paint cost is small: 0.03 to 0.54 ms across all three faces on the host.
The faces differ mainly in how often they paint. The thesis face is static
between quantized animation steps and paints 2.3 times a second at idle, while
Ferro animates continuously and paints 21.5 times a second. That idle figure is
older than the thesis face's current idle screen. Idle now shows the connection
sweep, which moves every 60 ms, so on the device an idle face paints at the
gate's limit of 7.7 times a second.

That makes per-state ratios unsuitable as a safety signal (any animated face is
"hundreds of times" a nearly static one). The relevant ceiling is the busiest
thing the submitted firmware already sustains on the hardware, which is its own
teleoperation screen at 20.6 paints/s.

| face | worst sustained duty (host) | vs the thesis face's worst |
|---|---|---|
| thesis | 6.85 ms/s (teleop) | 1.00x |
| rams | 7.99 ms/s (calib) | **1.17x** |
| ferro | 9.67 ms/s (fault) | **1.41x** |

So in its heaviest state each of the two other designs needed roughly 1.2 to
1.4 times the paint work the device is already known to do in its own heaviest
state. The ratio compares two measurements taken the same way on the same
machine, so it is the part that transfers; the absolute milliseconds do not.

Use the ratio for any comparison. The absolute figures move by up to 75 % with
whatever else the host is doing: the same unchanged Ferro code measured 10.37,
16.88 and 9.67 ms/s in three sessions. The ratio held at 1.41-1.44x across all
of them, which is why it is usable. Any comparison must therefore come from a
single `--duty` run, and a run taken while a build is going should be
discarded.

### Rams after the spacing-system pass (2026-07-30)

The Rams re-lay was checked state by state against its own previous layout,
each side normalised to the thesis face's worst state in the same run. Every
state but stop got cheaper, stop stayed at 0.39x, and none regressed:

| state | before | after | | state | before | after |
|---|---|---|---|---|---|---|
| boot | 1.18x | 0.99x | | saved | 1.12x | 0.91x |
| idle | 1.13x | 0.94x | | stop | 0.39x | 0.39x |
| linked | 1.10x | 0.90x | | fault | 1.11x | 0.93x |
| standalone | 1.02x | 0.75x | | battery | 1.08x | 0.87x |
| teleop | 1.34x | 1.15x | | **worst** | **1.36x** | **1.17x** |
| recording | 1.13x | 0.91x | | calib | 1.36x | 1.17x |

Fewer, larger elements are cheaper to rasterize than many small ones, which is
why the legibility pass also reduced the paint cost. One state did regress in
the first version: the major-fault hatch bounded its scan by the full circle
instead of the wedge, which pushed fault from 1.11x to 1.39x. Bounding the scan
by the wedge brought it to 0.93x. Ferro was not changed and reproduced its
1.41x, which is the control showing that the harness itself did not drift.

## Why the ratio may not transfer exactly

- The host has a much faster FPU and much larger caches than a 600 MHz
  Cortex-M7. Ferro and Rams also use different maths from the thesis face, so
  they are not just scaled-up versions of it.
- Ferro's body pass calls `atan2f` and `sqrtf` per pixel inside the mass
  bounding box. The thesis face's primitives are `sqrtf`-heavy and call
  `atan2f` only for the pixels in the thin band of a partial ring. If `atan2f`
  is relatively more expensive on the M7's libm than on the host's, Ferro's
  ratio gets worse.
- Rams is dominated by rectangle fills and short anti-aliased segments, which
  are the cheapest operations on either target, so its ratio should transfer
  better than Ferro's.

The bound is therefore useful for planning but is not a guarantee. The device
figure still has to be measured.

## What protects the sensing loop regardless

- Normal presentation is capped at 130 ms (7.7 Hz) in `screenService()`. The
  crown carousel gets 104 ms (9.6 Hz), and the boot screen, whose small arc is
  cheap to move, gets 60 ms (16.7 Hz). State and safety are still inspected
  every 20 ms (50 Hz), and a state/face/safety discontinuity paints
  immediately.
- An animation sample never rebuilds a framebuffer that is still being sent.
  If the panel is busy when a sample becomes due, that visual sample is
  skipped/deferred. Sensor and control samples are not. A discontinuity (a
  state change or a `W` selection) is the exception: it repaints at once, even
  mid-frame, and then resends every tile.
- Readouts are presentation-filtered: joints use a 300 ms low-pass, roll
  350 ms, torque 250 ms, calibration 200 ms, and EMG and battery 750 ms.
  Joints, torque and calibration are displayed in 2 % steps, the EMG and
  battery percentages in 5 % steps, and roll in 2 degree steps. The underlying
  telemetry and control values are unchanged.
- With the value-dirty signature, a face that is not changing is not repainted,
  tile-scanned or sent over SPI. The thesis face's linked and saved screens
  have a constant signature, so after their first paint they cost nothing.
- The panel push is bounded and coherent: `firmware_ui.h` sends at most one
  synchronous coalesced run of up to 64 x 16 px per loop pass, commits its
  shadow only after the write returns, and finishes that frame before the next
  animation frame is built.
- Faces do no I/O. They only receive a filled `DeviceState` and paint the
  framebuffer; no face code reads a sensor or touches a bus.
- Encoder reads were reduced. `emitStream()` and `recWrite()` used to read every
  channel over I2C independently, so a frame that was both recording and
  streaming read each channel twice. They now share one pass per frame. The
  screen reads the same pass, so it runs every frame.

## Memory

The first two columns were measured from two compiles with the same board and
toolchain: the submitted firmware, and the build with all three faces. The last
column is the current build (thesis face only), compiled on 2026-10-17 with the
Teensy 1.60.0 core. It also includes firmware changes made after those two
builds, so its difference from the second column is not the cost of the faces.

| | before (submitted) | three faces | current (thesis only) |
|---|---|---|---|
| FLASH code | 103,596 | 149,484 | 154,508 |
| RAM1 variables | 16,512 | 26,784 | 52,768 |
| RAM2 variables | 250,496 | 250,496 | 250,496 |
| free for local variables | 376,704 | 333,664 | 307,680 |

The three faces cost about 46 kB of flash out of roughly 8 MB free. RAM2 is
byte-identical in all three builds because the 115 kB vignette cache stayed in
the second bank, where the submitted firmware put it.

## Getting the real numbers

The firmware takes these measurements itself. Send `T` over the serial console
(115200) and it prints, for the window since the last `T`:

```
# paint face=thesis/sapphire last=NNNNus max=NNNNus mean=NNNNus paints=N (N/s) samples=N (N/s) loop=N/s window=Nms tiles=N panel_runs=N panel_last=Nus panel_max=Nus slow=N cadence=130ms interact=104ms deferred=N pending=0 rot=N sync=1
```

`loop=N/s` is the field to watch. If the loop pass rate holds while the face
animates, the sensing duty is intact. The procedure is step 6 of the flash
runbook.
