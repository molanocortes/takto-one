# Contributing

Thanks for looking. This is a research platform released so other people can build on it, and
contributions of every size are welcome.

## The most useful contributions

1. **Build reports.** If you build one — or part of one — open an issue and say what happened.
   What was unclear, what did not fit, what you changed. This is worth more than code.
2. **Documentation corrections.** The build guide predates some of the current hardware; known
   deltas are listed in [`docs/README.md`](docs/README.md). If you find another, report it.
3. **Bug fixes and improvements** to firmware, bridge, or console.

## Before you open a pull request

- Say what you changed and why. Link an issue if there is one.
- Keep firmware changes compiling for a Teensy 4.1.
- Keep the console dependency-free — it deliberately vendors what it needs and makes no
  external network calls. Please do not add a CDN or analytics dependency.
- For hardware changes, include the KiCad or CAD sources, not just exports.

## Adding images and media

The README is deliberately image-led and is meant to keep growing. To add to it:

1. Put the file in `docs/media/`, named for what it shows (`pcb-palm-carrier.png`, not `img3.png`).
2. Strip metadata and keep it under ~1 MB where you can; PNG for renders and diagrams.
3. Reference it from `README.md` with a relative path and a one-line `<sub>` caption saying what
   it is.

Photographs of real builds are especially welcome — renders show the design, photographs show
that it works.

## Claims and evidence

This project draws a hard line between what has been physically verified and what has only
been simulated or written. If you add a claim about hardware behavior, say how it was measured
and on what hardware. Name the exact quantity — loop rate, telemetry rate, and end-to-end
latency are not the same number.

## Licensing of contributions

By contributing you agree that your contribution is licensed under the same terms as the part
of the repository it touches:

- `firmware/`, `software/` → Apache-2.0
- `cad/`, `electronics/` → CERN-OHL-S-2.0
- `docs/` and media → CC-BY-4.0

Apache-2.0 contributions include the patent grant in section 3 of that license. Please only
submit work you have the right to license this way.

## Safety

Do not submit changes that remove or weaken torque-off startup, bus fault accounting,
communication watchdogs, or bounded control modes without a clear explanation. This is a device
people strap to a hand.
