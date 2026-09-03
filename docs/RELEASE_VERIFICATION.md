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
  console and bridge were taken from the current working sources. Historical branches were not
  copied.
- **Added after this record was first written:** the public web front end, the AR layer and the
  watch-face engine. They were audited the same way as the tree above — no absolute paths, no
  secrets, no third-party reference models — but the check table below predates them, so treat
  it as covering the original set. **Added 2026-09-02:** the phone companion in
  `software/app/`, an Expo project whose media were captured from its own web target; its
  `node_modules` and capture output are ignored and it carries no other build artefacts. It
  supersedes an earlier Android-only build, which remains unpublished. The sign-language stack
  remains outside this release.

## Checks performed

| Check | Result |
| --- | --- |
| STL integrity, triangle count, file length, finite coordinates, plausible bounds | Passed on every file |
| STEP integrity, complete ISO 10303-21 envelope | Passed on every file |
| STEP headers, author, organization, originating path | Empty; no identity or path leakage |
| Firmware build for Teensy 4.1 | Compiled successfully |
| Bridge byte-compile (Python 3.12) | Passed |
| Bridge simulation, sensor and catalog initialization | 12 synthetic joints, two IMUs, EMG |
| End-to-end WebSocket session against the bridge | Passed. See below |
| Console module graph, every relative import resolves | Passed, no broken imports |
| Console external dependencies | None; no CDN, analytics, or third-party calls |
| Secret patterns, private absolute paths, oversized files, symlinks | None found |
| Published image metadata, author, camera, timestamp, GPS | None present |
| Git history, files added then deleted, oversized blobs, author email | Clean. Re-checked 2026-09-01: no private document has ever been committed on `main`; deleted paths are superseded media only. Commit identities are normalised to a GitHub noreply address before publication |

### End-to-end WebSocket verification

The initial release preparation could not complete this check because the local ports it tried
were already occupied. It has since been run to completion on a free port:

- The bridge started in `--sim` mode and accepted a WebSocket client on the first attempt.
- It broadcast `snap` frames continuously, each carrying 12 joints and 2 motors, alongside
  `takes`, `envs`, `watch_catalog`, and `imu_cfg` messages.
- A representative joint payload was well formed, e.g.
  `{"id": "index_mcp", "deg": 9.03, "ok": true, "calibrated": true}`.

**Fresh-clone re-run, 2026-09-02.** Following the README's own commands on a brand-new clone
(Python 3.12 venv, `--sim`), the bridge crashed on its first state write because the
`SENSORYHAND_STATE_DIR` directory did not exist yet. The earlier check had run in a directory
that already had one. The bridge now creates the directory on start; after the fix the same
clone served `snap` frames with 12 joints and the console loaded from the `http.server`
command. The firmware compile was not repeated for this re-run.

### Scope of these checks

These checks cover **repository integrity**, that the published files are complete, current,
and free of private data. They are not the project's hardware validation.

The device itself has been operated on hardware by the author: the firmware runs on the Teensy,
the Teensy drives the fingers over the Dynamixel bus, and all twelve encoders feed the browser
twin live. That testing predates this release and was not repeated as part of packaging it, so
it is reported in the README under what is verified on hardware, not claimed here as something
this checklist established.

## Excluded from the release

The submitted master's thesis, the personal arm scan, historical CAD and firmware branches,
vendor CAD models, JLCPCB account and order history, the earlier Android-only companion and
the sign-language stack, the AR layer's capture and asset tooling, papers, application
documents, private photos, and build guides containing stale technical claims.

## Third-party material

The vendored Three.js and QR Code Generator files and their MIT terms, and the ORCA hand
spool-station attribution, are recorded in
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Reviewer note

A second reviewer should still inspect the exact repository tree before publication.
Licensing is settled and documented in [`../LICENSE.md`](../LICENSE.md).
