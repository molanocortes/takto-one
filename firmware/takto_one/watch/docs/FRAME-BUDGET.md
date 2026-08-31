# Frame budget

A face that drops the sensor loop is a failure however good it looks. This is
what is known, what is measured, and what is still pending.

**Nothing here is a device measurement.** Every number below is from the host
target. The device numbers come from the firmware's own `T` report and are
PENDING until the board is flashed (`FLASH-RUNBOOK.md`, step 6).

## What the engine costs

`watch_render --profile` times one paint. `watch_render --duty` is the number
that actually matters: it walks simulated time, counts the paints the
**value-dirty signature** asks for, and reports milliseconds of paint per
second of wall clock. The physical firmware now applies a stricter 130 ms
presentation gate after this host-side characterization.

Per-paint cost is unremarkable, 0.03 to 0.54 ms across all three faces on the
host. The interesting difference is frequency: the thesis face is static between
quantized animation steps and paints 2.3 times a second at idle, while Ferro
breathes continuously and paints 21.5 times a second.

That makes per-state ratios useless as a safety signal (any animated face is
"hundreds of times" a nearly static one). The ceiling that matters is the
busiest thing the submitted firmware **already sustains on the hardware**, which
is its own teleoperation screen at 20.6 paints/s.

| face | worst sustained duty (host) | vs the thesis face's worst |
|---|---|---|
| thesis | 6.85 ms/s (teleop) | 1.00x |
| rams | 7.99 ms/s (calib) | **1.17x** |
| ferro | 9.67 ms/s (fault) | **1.41x** |

So in its heaviest state each new face asks for roughly 1.2 to 1.4 times the
paint work the device is already known to do in its own heaviest state. That is
a ratio between two measurements taken the same way on the same machine, which
is the part that transfers; the absolute milliseconds do not.

**Always read the ratio, never the milliseconds.** The absolute figures move by
up to 75 % with whatever else the host is doing: the same unchanged Ferro code
measured 10.37, 16.88 and 9.67 ms/s in three sessions. The ratio held at
1.41-1.44x across all of them, which is what makes it usable. Any comparison
must therefore come from a single `--duty` run, and a run taken while a build
is going is worthless.

### Rams after the spacing-system pass (2026-07-30)

The Rams re-lay was checked state by state against its own previous layout,
each side normalised to the thesis face's worst state in the same run. Every
state got cheaper and none regressed:

| state | before | after | | state | before | after |
|---|---|---|---|---|---|---|
| boot | 1.18x | 0.99x | | saved | 1.12x | 0.91x |
| idle | 1.13x | 0.94x | | stop | 0.39x | 0.39x |
| linked | 1.10x | 0.90x | | fault | 1.11x | 0.93x |
| standalone | 1.02x | 0.75x | | battery | 1.08x | 0.87x |
| teleop | 1.34x | 1.15x | | **worst** | **1.36x** | **1.17x** |
| recording | 1.13x | 0.91x | | calib | 1.36x | 1.17x |

Fewer, larger elements are cheaper to rasterize than many small ones, which is
why a legibility pass paid for itself. One thing did regress on the first cut:
the major-fault hatch bounded its scan by the full circle instead of the wedge,
which pushed fault from 1.11x to 1.39x. Bounding the wedge properly brought it
to 0.93x. Ferro was untouched and reproduced its 1.41x, which is the control
that says the harness itself did not drift.

## Why the ratio may not transfer exactly

Say so rather than pretend otherwise:

- The host has a much faster FPU and much larger caches than a 600 MHz
  Cortex-M7. The two faces are not merely scaled-up versions of the thesis
  face, they lean on different maths.
- Ferro's body pass calls `atan2f` and `sqrtf` **per pixel** inside the mass
  bounding box. The thesis face's primitives are `sqrtf`-heavy but call no
  inverse trig. If `atan2f` is relatively more expensive on the M7's libm than
  on the host's, Ferro's ratio gets worse.
- Rams is dominated by rectangle fills and short anti-aliased segments, which
  are the cheapest possible operations on either target, so its ratio should
  transfer better than Ferro's.

The bound is therefore a good planning number and a bad guarantee. Measure it.

## What protects the sensing loop regardless

- **Normal presentation is capped at 130 ms** (7.7 Hz) in `screenService()`;
  the crown carousel is 104 ms (9.6 Hz). State and safety are still inspected
  every 20 ms (50 Hz), and a state/face/safety discontinuity paints immediately.
- **A new framebuffer is never built while the previous one is still being
  shipped.** If the panel is busy when an animation sample becomes due, that
  visual sample is skipped/deferred. Sensor and control samples are not.
- **Readouts are presentation-filtered:** joints use a 300 ms low-pass, EMG and
  roll 350 ms, torque 250 ms, and calibration 200 ms; normalized values are
  displayed in 2 % steps and roll in 2 degree steps. The underlying telemetry
  and control values are unchanged.
- **The value-dirty signature** means a face that is not changing costs zero
  paint, zero tile scan and zero SPI. Ferro's STOP state paints 0.5 times a
  second because the substance is frozen.
- **The panel push is bounded and coherent**: `firmware_ui.h` ships at most one
  synchronous coalesced 64 x 16 px run per loop pass, commits its shadow only
  after the write returns, and now finishes that frame before the next buffer
  is built.
- **Faces never do I/O.** They cannot read a sensor or touch a bus even by
  accident; they only receive a filled `DeviceState`.
- **Encoder reads went down, not up.** `emitStream()` and `recWrite()` used to
  read every channel over I2C independently, so a frame that was both recording
  and streaming read each channel twice. They now share one pass, and it is only
  taken when something is consuming it.

## Memory

Measured from the two compiles, same board, same toolchain:

| | before (submitted) | after (three faces) |
|---|---|---|
| FLASH code | 103,596 | 149,484 |
| RAM1 variables | 16,512 | 26,784 |
| RAM2 variables | 250,496 | 250,496 |
| free for local variables | 376,704 | 333,664 |

The three faces cost about 46 kB of flash out of roughly 8 MB free. RAM2 is
byte-identical because the 115 kB vignette cache stayed in the second bank
exactly where the submitted firmware put it.

## Getting the real numbers

The firmware measures itself. Send `T` over the serial console (115200) and it
prints, for the window since the last `T`:

```
# paint face=ferro/electric-blue last=NNNNus max=NNNNus mean=NNNNus paints=N (N/s) samples=N (N/s) loop=N/s window=Nms tiles=N panel_runs=N panel_last=Nus panel_max=Nus slow=N cadence=100ms interact=80ms deferred=N pending=0 rot=N sync=1
```

`loop=N/s` is the one to watch. Compare it against the same reading on the
thesis face: if the loop pass rate holds, the sensing duty is intact. The
procedure is step 6 of the flash runbook.
