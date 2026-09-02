# TAKTO watch face engine

Three switchable watch faces for the TAKTO ONE on-device screen, one engine,
one source of truth.

- **[FACE-ENGINE.md](FACE-ENGINE.md)** - the architecture, what each face is,
  and the honest gaps (read this one first).
- **[FRAME-BUDGET.md](FRAME-BUDGET.md)** - what the faces cost and what is
  still unmeasured.
- **[FLASH-RUNBOOK.md](FLASH-RUNBOOK.md)** - how to put it on the board and
  what to check.

**What the evidence is.** Every image of these faces in this repository is a
host render produced by the same C++ the Teensy runs, driven by a simulated
hand feed. The renders are not photographs of the panel. The on-device
frame-budget numbers, the firmware's own `T` report, have not been recorded in
this repository; step 6 of the flash runbook is how to take them.

## Where the pieces live

| what | where |
|---|---|
| the engine and the three faces | [`../`](../) (`watch_*.h`, `face_*.h`) |
| the sketch that runs it | [`../../takto_one.ino`](../../takto_one.ino), `screenService()` |
| the face catalog every surface reads | [`../../../../software/watch/catalog.json`](../../../../software/watch/catalog.json) |
| the bridge that serves the catalog | [`../../../../software/bridge/teensy_bridge.py`](../../../../software/bridge/teensy_bridge.py) |
| the console selector | [`../../../../software/console/app/src/views/operator.js`](../../../../software/console/app/src/views/operator.js), Tools drawer, "Watch face" |
| the browser mirrors of Ferro and Rams | [`../../../../software/web/src/watch_face_renderers.js`](../../../../software/web/src/watch_face_renderers.js) |

Not in this release: the host render and fidelity-test harness, the Ferro
design canon the second face was ported from, and a watch-face selector for
the phone companion (the app in `software/app/` does not carry one yet). The documents here describe them where the history matters.

## The rule that keeps it consistent

`catalog.json` is generated from the C++ face registry in `watch_engine.h`
and is the only face list the bridge and the console are allowed to read. If
you add a face or a colorway, update `catalog.json` in the same change or every
other surface goes stale. The bridge refuses to start without it.
