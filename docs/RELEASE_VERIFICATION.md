# Release verification record

This record documents how the public release candidate was assembled and checked, so the
release can be independently reviewed. It describes **file integrity and provenance**. It is
not a medical, mechanical, electrical, or worn-actuation certification.

## Provenance

- CAD was exported on 2026-08-27 from the live Fusion document `Zero_Final_Assembly_Complete`
  version 35. Fusion reported the assembly current, with no out-of-date child references.
- 24 TAKTO-authored components were exported as binary STL and 23 solid components as STEP.
  `BaseSpool` is mesh-only in the current Fusion assembly and is therefore provided as STL only.
  Component versions and assembly quantities are recorded in [`../cad/README.md`](../cad/README.md).
- Only TAKTO-authored mechanical bodies were exported. The hidden personal arm scan and all
  third-party reference models were deliberately excluded, and each STEP file was created from
  an isolated body so it carries no external references.
- Firmware, the two current KiCad projects with their manufacturing outputs, and the operator
  console and bridge were taken from the current working sources. Historical branches and the
  unfinished AR/Android prototypes were not copied.

## Checks performed

| Check | Result |
| --- | --- |
| STL integrity — triangle count, file length, finite coordinates, plausible bounds | Passed on every file |
| STEP integrity — complete ISO 10303-21 envelope | Passed on every file |
| STEP headers — author, organization, originating path | Empty; no identity or path leakage |
| Firmware build for Teensy 4.1 | Compiled successfully |
| Bridge byte-compile (Python 3.12) | Passed |
| Bridge simulation — sensor and catalog initialization | 12 synthetic joints, two IMUs, EMG |
| End-to-end WebSocket session against the bridge | Passed — see below |
| Console module graph — every relative import resolves | Passed, no broken imports |
| Console external dependencies | None; no CDN, analytics, or third-party calls |
| Secret patterns, private absolute paths, oversized files, symlinks | None found |
| Published image metadata — author, camera, timestamp, GPS | None present |
| Git history — files added then deleted, oversized blobs, author email | Clean; commits use a GitHub noreply address |

### End-to-end WebSocket verification

The initial release preparation could not complete this check because the local ports it tried
were already occupied. It has since been run to completion on a free port:

- The bridge started in `--sim` mode and accepted a WebSocket client on the first attempt.
- It broadcast `snap` frames continuously, each carrying 12 joints and 2 motors, alongside
  `takes`, `envs`, `watch_catalog`, and `imu_cfg` messages.
- A representative joint payload was well formed, e.g.
  `{"id": "index_mcp", "deg": 9.03, "ok": true, "calibrated": true}`.

Hardware communication over a physical serial link was **not** retested as part of repository
preparation. Simulation exercises the calibration and snapshot pipeline, not the device.

## Excluded from the release

The submitted master's thesis, the personal arm scan, historical CAD and firmware branches,
vendor CAD models, JLCPCB account and order history, AR and Android prototypes that are not
ready for a polished release, papers, application documents, private photos, and build guides
containing stale technical claims.

## Third-party material

The vendored Three.js files and their MIT terms are recorded in
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Reviewer note

A second reviewer should still inspect the exact repository tree before publication.
Licensing is settled and documented in [`../LICENSE.md`](../LICENSE.md).
