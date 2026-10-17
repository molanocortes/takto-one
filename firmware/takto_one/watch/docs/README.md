# TAKTO watch face engine

The engine that draws the TAKTO ONE on-device screen. One face, thesis, is built
into the firmware, in three colorways. Two earlier designs, Ferro and Rams, are
still in the source for reference but aren't built. A single registry in
`watch_engine.h` defines the face list.

- [FACE-ENGINE.md](FACE-ENGINE.md): the architecture, what each face is, and
  the known gaps. Read this one first.
- [FRAME-BUDGET.md](FRAME-BUDGET.md): what the faces cost and what is still
  unmeasured.
- [FLASH-RUNBOOK.md](FLASH-RUNBOOK.md): how to put it on the board and what to
  check.

Every image of these faces in this repository is a host render of the face
code, driven by a simulated hand feed. The renders are not photographs of the
panel, and some are older than the current thesis face; FACE-ENGINE.md lists
what changed. The on-device frame-budget numbers (the firmware's own `T`
report) have not been recorded in this repository; step 6 of the flash runbook
describes how to take them.

## Where the pieces live

| what | where |
|---|---|
| the engine, the thesis face and the two earlier designs | [`../`](../) (`watch_*.h`, `face_*.h`) |
| the sketch that runs it | [`../../takto_one.ino`](../../takto_one.ino), `screenService()` |
| the face catalog the bridge serves | [`../../../../software/watch/catalog.json`](../../../../software/watch/catalog.json) |
| the bridge that serves the catalog | [`../../../../software/bridge/teensy_bridge.py`](../../../../software/bridge/teensy_bridge.py) |
| the console colorway picker | [`../../../../software/console/app/src/views/operator.js`](../../../../software/console/app/src/views/operator.js), the "Device screen" card |
| the browser mirrors of Ferro and Rams | [`../../../../software/web/src/watch_face_renderers.js`](../../../../software/web/src/watch_face_renderers.js) |

Not in this release: the host render and fidelity-test harness, the Ferro
design canon that Ferro was ported from, and a watch-face selector for the
phone companion (the app in `software/app/` does not carry one yet). The
documents here describe them where the history matters.

## The rule that keeps it consistent

`catalog.json` is generated from the C++ face registry in `watch_engine.h`,
and the bridge serves it to the console and every other client. With no
bridge, the console and the web front end fall back to a mock copy
(`MOCK_WATCH_CATALOG` in each `telemetry.js`), which still lists six
colorways. If you add a face or a colorway, update `catalog.json` and both
mocks in the same change, or every other surface goes stale. Without
`catalog.json` the bridge still starts, but it rejects every watch command.
