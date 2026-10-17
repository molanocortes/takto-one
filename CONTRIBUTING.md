# Contributing

Thanks for looking. This is a research prototype, released so that other people can build on
it. Contributions of any size are welcome.

## The most useful contributions

1. Build reports. If you build one, or part of one, open an issue and say what happened: what
   was unclear, what didn't fit and what you changed. This helps more than code.
2. Documentation corrections. The build guide is older than some of the current hardware; the
   known differences are listed in [`docs/README.md`](docs/README.md). If you find another,
   please report it.
3. Bug fixes and improvements to the firmware, the bridge or the console.

## Before you open a pull request

- Say what you changed and why. Link an issue if there is one.
- Keep firmware changes compiling for a Teensy 4.1.
- Keep the console dependency-free. It bundles what it needs and makes no external network
  calls, so please don't add a CDN or analytics dependency.
- For hardware changes, include the KiCad or CAD sources, not just exports.

## Adding images and media

The README relies on images, and more are welcome. To add one:

1. Put the file in `docs/media/`, named for what it shows (`pcb-palm-carrier.png`, not `img3.png`).
2. Strip metadata. JPEG for renders and photographs; PNG for diagrams, plots and screenshots
   (a 128-colour palette is usually indistinguishable, but check coloured strokes on dark
   grounds, which drift). Keep stills under ~250 KB: GitHub loads every image in a README at
   once and strips `loading="lazy"`, so the page's total is what a phone downloads before it
   settles. Motion is the exception: GitHub never autoplays real video (an uploaded `.mp4` sits
   behind a click and `<video autoplay>` is stripped), so an autoplaying loop has to be a GIF,
   and GIFs are heavy (`docs/media/turntable.gif` is 6.2 MB). Keep a loop as small as the
   content allows. That one is 900 px at 15 fps on a 64-colour palette, which looks the same as
   the 1080 px 20 fps original at the width GitHub renders it. Never embed a GIF on its own: the
   GitHub Android app can't show a README that loads a GIF (the page flickers on every frame and
   looks empty), and it ignores `<source>`. Put the loop in
   a `<picture>` whose `<img>` is a still frame, `docs/media/<name>-still.jpg` (or `.png`), and
   whose `<source>` hands the GIF only to a wide screen with a mouse; copy an existing block
   from the README, media query included. A film that needs the inline
   player is a separate case and must be under 10 MB, the ceiling for the attachment URL that
   player needs.
3. Reference it from `README.md` with a relative path and a one-line `<sub>` caption saying what
   it is.

Photos of real builds are especially welcome, because they show that the design works.

## Claims and evidence

The project keeps what has been verified on hardware separate from what has only been
simulated or written down. If you add a claim about hardware behavior, say how it was measured
and on what hardware. Name the exact quantity: loop rate, telemetry rate and end-to-end latency
are different numbers.

## Licensing of contributions

Contributions are released under the same terms as the part of the repository they touch:

- `firmware/`, `software/` -> Apache-2.0
- `cad/`, `electronics/` -> CERN-OHL-S-2.0
- `docs/` and media -> CC-BY-4.0

There is also a short [Contributor License Agreement](CLA.md). **You keep the copyright in your
work**; the CLA grants the maintainer the right to distribute it, including under different terms
later. That may seem formal for a project this size. The reason is that without it, the project
could never be relicensed. If a licence ever had to change, to loosen it, to offer commercial
terms alongside it, or to replace one that turned out to be a poor fit, every past contributor
would have to be found and asked. Agreeing once at the start avoids that.

To accept it, put this line in your pull request description:

```
I have read CLA.md and I agree to its terms.
```

and sign off your commits with `git commit -s`, which certifies the same thing under the
Developer Certificate of Origin.

Please only submit work you have the right to license this way.

## Safety

Do not submit changes that remove or weaken torque-off startup, bus fault accounting,
communication watchdogs, or bounded control modes without a clear explanation. People wear this
device on their hand.
