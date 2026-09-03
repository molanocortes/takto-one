# Mechanical CAD

These files were exported directly from Autodesk Fusion on 2026-08-27 from the current cloud state of `Zero_Final_Assembly_Complete` version 35. Fusion reported no out-of-date child references.

- `stl/` contains high-resolution binary meshes in millimetres for slicing and inspection.
- `step/` contains isolated solid bodies for neutral CAD interchange and editing.

The source assembly also contains third-party reference models and a hidden personal arm scan. Those items, and the complete unfiltered assembly archive, are intentionally not published, **with one deliberate exception**: `base_spool` is an adaptation of a third-party part from the ORCA hand project and is published here with the attribution its CC BY 4.0 licence requires. See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). Every STEP file was created from an isolated TAKTO-authored body so it does not carry the unpublished references.

## Export manifest

Quantities are occurrences in the designed assembly, not a validated procurement or print plan.

| Fusion component | Cloud version | Quantity | Files |
| --- | ---: | ---: | --- |
| `BaseSpool` | 5 | 10 | STL only; Fusion source is mesh-only. **Adapted from the ORCA hand project, CC BY 4.0**, see [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) |
| `SpoolCover` | 6 | 10 | STL, STEP |
| `Zero_Corners` | 9 | 4 | STL, STEP |
| `Zero_Finger2_Knuckle_Thin_V3` | 7 | 3 | STL, STEP |
| `Zero_Finger2_Knuckle_V3` | 13 | 4 | STL, STEP |
| `Zero_Finger2_MCP_Center_V3` | 18 | 2 | STL, STEP |
| `Zero_Finger2_MCP_Thick_V3` | 22 | 2 | STL, STEP |
| `Zero_Finger2_MCP_Thin_V3` | 9 | 2 | STL, STEP |
| `Zero_Finger2_PIP_Center_V3` | 12 | 4 | STL, STEP |
| `Zero_Finger2_PIP_Thin_V3` | 14 | 4 | STL, STEP |
| `Zero_Finger3_Knuckle_Thin_V3` | 5 | 1 | STL, STEP |
| `Zero_Finger4_MCP_Center_V3` | 8 | 1 | STL, STEP |
| `Zero_Finger4_MCP_Thick_V4` | 1 | 1 | STL, STEP |
| `Zero_Finger4_MCP_Thin_V4` | 1 | 1 | STL, STEP |
| `Zero_Finger5_MCP_Center_V3` | 6 | 1 | STL, STEP |
| `Zero_Finger5_MCP_Thick_V4` | 2 | 1 | STL, STEP |
| `Zero_Finger5_MCP_Thin_V4` | 1 | 1 | STL, STEP |
| `Zero_Forearm_Part2_V1` | 151 | 1 | STL, STEP |
| `Zero_Forearm_V5` | 67 | 1 | STL, STEP |
| `Zero_Generated3` | 6 | 1 | STL, STEP |
| `Zero_Generative1` | 9 | 3 | STL, STEP |
| `Zero_Heels` | 1 | 1 | STL, STEP |
| `Zero_Palm_Cap_V3` | 18 | 1 | STL, STEP |
| `Zero_Palm_V3` | 39 | 1 | STL, STEP |

A full build also needs the ratchet, one per spool station. It is a third-party part and lives in [`third_party/orca/`](third_party/orca/) under CC BY 4.0, separate from the CERN-OHL-S-2.0 geometry in `stl/` and `step/`.

The physical prototype contains both PETG and PLA parts. Material, orientation, supports, tolerances, and fasteners must be selected and verified for the intended build; this release does not claim one universal print profile.
