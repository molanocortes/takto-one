# Third-party notices

The browser console includes Three.js revision 160 and its `GLTFLoader` and `BufferGeometryUtils` add-ons. These files retain their upstream notices and are distributed under the MIT License:

Copyright © 2010-2023 Three.js Authors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## ORCA hand, spool station geometry

The tendon spool station in this project derives from the **ORCA hand** by ORCA Dexterity, Inc.
(Soft Robotics Lab, ETH Zurich), published at
<https://github.com/orcahand/orcahand_hardware> and licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

- [`cad/stl/base_spool.stl`](cad/stl/base_spool.stl) is an **adaptation** of
  `orca_v1/ORCA_Spools/BaseSpool.stl`. It has been modified for TAKTO ONE.
- [`cad/third_party/orca/Ratchet.stl`](cad/third_party/orca/Ratchet.stl) is ORCA's
  `orca_v1/ORCA_Spools/Ratchet.stl`, redistributed **unmodified** and byte-identical. It stays
  under CC BY 4.0 and is **not** covered by this project's CERN-OHL-S-2.0 hardware licence. See
  [`cad/third_party/orca/README.md`](cad/third_party/orca/README.md).
- `cad/stl/spool_cover.stl` is TAKTO-authored and is **not** derived from ORCA's `SpoolCover.stl`.

Attribution, as CC BY 4.0 requires:

> ORCA hand, ORCA Dexterity, Inc., <https://www.orcahand.com>, licensed under CC BY 4.0.
> `base_spool` is modified from the original; the ratchet is used unmodified.

CC BY 4.0 permits an adaptation to be released under different terms, so the modified
`base_spool` is distributed under this project's CERN-OHL-S-2.0 hardware licence. The
attribution above is required regardless, and ORCA's own unmodified files remain CC BY 4.0.
The project is described in [arXiv:2504.04259](https://arxiv.org/abs/2504.04259).

Copyright © 2026 ORCA Dexterity, Inc.

The firmware expects Arduino libraries including Adafruit GFX. Those libraries are not vendored in this repository and remain subject to their own upstream licenses.

The film in `docs/media/` is scored with "The Theme" by Alex Jones and Xander Jones, obtained through the YouTube Audio Library. The track is used under that library's terms; it is not covered by this project's licences and is not relicensed by them.
