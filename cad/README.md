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

## How it goes together

The STEP and STL files above are isolated parts. The assembly is documented, but not in this
folder, and a builder who lands here first has missed it: the **24-page illustrated build guide**
at [`../docs/build-guide.pdf`](../docs/build-guide.pdf) walks the whole device in order, with
1:1 part-check plates on the last page. Read [`../docs/README.md`](../docs/README.md) beside it:
two of the guide's statements (U2D2 on the motor bus, 100 % PETG) are superseded and the
corrections are listed there. Everything mechanical in the guide reflects the device as built.

| Guide chapter | Pages | What it assembles |
| --- | ---: | --- |
| Build one finger | 3 to 8 | MCP link, knuckle, root bearings, PIP link, three magnets, three encoder boards |
| Forearm housing and electronics | 9 to 14 | Shell, corner pillars, ten servos, deck, Teensy plate, display, IMU, EMG |
| A tendon spool bay | 15 | Spool, ratchet, cover, one of ten |
| Palm stack | 16 to 18 | Palm, carrier board, spacers, IMU, cap |
| Wiring and soldering | 19 to 22 | Every run cut to length, and the carrier pad each one lands on |
| Part-check plates | 24 | Print at 100 %, lay each part on its outline |

### Reading the filenames

Fingers are numbered as anatomical digits, so the thumb would be 1 and **`finger2` is the
index, `finger3` the middle, `finger4` the ring, `finger5` the little finger**. The finger
chapter is drawn for the index and the other three follow the same sequence.

A `finger2` prefix does not always mean index-only. The quantities in the export manifest above
say what is shared:

| Part in the guide | File | Used by |
| --- | --- | --- |
| MCP link, thick half | `zero_finger2_mcp_thick_v3` | index and middle |
| | `zero_finger4_mcp_thick_v4` | ring |
| | `zero_finger5_mcp_thick_v4` | little |
| MCP centre piece | `zero_finger2_mcp_center_v3` | index and middle |
| | `zero_finger4_mcp_center_v3` | ring |
| | `zero_finger5_mcp_center_v3` | little |
| MCP link, thin half | `zero_finger2_mcp_thin_v3` | index and middle |
| | `zero_finger4_mcp_thin_v4` | ring |
| | `zero_finger5_mcp_thin_v4` | little |
| Knuckle base | `zero_finger2_knuckle_v3` | all four |
| Knuckle plate | `zero_finger2_knuckle_thin_v3` | index, ring, little |
| | `zero_finger3_knuckle_thin_v3` | middle |
| PIP link | `zero_finger2_pip_thin_v3` | all four |
| PIP centre piece | `zero_finger2_pip_center_v3` | all four |
| Palm, palm cap | `zero_palm_v3`, `zero_palm_cap_v3` | one each |
| Forearm shell, in two parts | `zero_forearm_v5`, `zero_forearm_part2_v1` | one each |
| Corner pillars | `zero_corners` | four |
| Spool, ratchet, cover | `base_spool`, [`third_party/orca/Ratchet.stl`](third_party/orca/), `spool_cover` | one set per bay, ten bays |
| Deck and supports | `zero_generative1` (3), `zero_generated3`, `zero_heels` | forearm chapter |

Hardware that is not printed, all on the part-check plate: MR84-2Z bearings (4 x 8 x 3 mm, two
per MCP), 2 x 5 x 2.5 mm bearings (two per PIP), 4 x 2 mm **diametrically** magnetised magnets
(three per finger, orientation matters), 2 mm guide rods (13.2 mm at the MCP, 16 mm at the
PIP), and the M2, M2.5 and M3 screws listed with counts on page 24.

### The full assembly and the Fusion sources

They are not here yet, and the reason is worth stating rather than hiding. The Fusion assembly
the release was exported from also contains a personal 3D scan of the author's arm, used as a
fitting reference, and third-party reference models of purchased parts whose redistribution
terms are not the author's to grant. The one complete export that exists was made for the
thesis examiners, not for publication: it carries both of those, still shows the superseded
U2D2 architecture, and its components lost their names on export, so a reader opening it sees
a hundred bodies named by timestamp. Publishing that would be worse than publishing nothing.

What is being prepared instead, from the current assembly: a full-assembly STEP with every
component named as in the manifest above and the scan removed; a hand subassembly and a single
finger subassembly as separate STEP files, since the finger is the unit to understand first;
and the Fusion native `.f3d` files with parametric history, which are the preferred form for
modification under CERN-OHL-S-2.0 and the reason the STEP files alone were never the whole
answer. Purchased parts will appear as simple envelopes so the assembly opens complete without
redistributing anyone else's models. These will be attached to the `v1.0.0` release rather than
committed, to keep the repository clone small.

### Purchased parts, and where their CAD comes from

Vendor and community models are not redistributed here. To complete the assembly on your own
machine, take them from the source:

| Part | Source for the model |
| --- | --- |
| Dynamixel XC330-M181-T | ROBOTIS e-Manual, product page downloads |
| Teensy 4.1 | PJRC publishes dimensions; community STEP models exist on GitHub |
| GC9A01 1.28" round display | Module vendor, varies by supplier |
| BNO085 breakout, AS5600 board | Breakout vendor, or model the outline from the datasheet |
| MR84-2Z bearing, 2 x 5 x 2.5 bearing | Any bearing manufacturer's catalogue, standard sizes |
| MyoWare 2.0 | SparkFun |
