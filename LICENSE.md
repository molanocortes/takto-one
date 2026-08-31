# Licensing

TAKTO ONE is released as open source. Software, hardware, and documentation are legally
different kinds of work, so each is licensed with the instrument written for it. This is
normal practice for open-hardware projects.

| What | Where | License |
| --- | --- | --- |
| Software, firmware, bridge, console | `firmware/`, `software/` | **Apache-2.0** ([text](LICENSES/Apache-2.0.txt)) |
| Hardware, mechanical CAD and PCB design | `cad/`, `electronics/` | **CERN-OHL-S-2.0** ([text](LICENSES/CERN-OHL-S-2.0.txt)) |
| Documentation and media | `docs/`, images, renders | **CC-BY-4.0** ([text](LICENSES/CC-BY-4.0.txt)) |

Third-party components keep their own terms. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

One carve-out worth naming here: the spool station geometry in `cad/` derives from the ORCA hand project (CC BY 4.0) and carries an attribution requirement, and `cad/third_party/` holds one ORCA file redistributed unmodified that stays under CC BY 4.0 rather than CERN-OHL-S-2.0. Details in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## What this means in practice

**Software (Apache-2.0).** Use it, modify it, ship it in a commercial product. You must keep
the copyright and license notices and state significant changes. Apache-2.0 also grants you an
express patent license from the contributors, which MIT does not.

**Hardware (CERN-OHL-S-2.0).** You may study, make, modify, and distribute the hardware. This
license is *strongly reciprocal*: if you distribute a modified design, or a product made from
one, you must make your modified design sources available under the same license. Build one,
improve it, sell it, but pass the improvements on.

**Documentation and media (CC-BY-4.0).** Reuse the guides, diagrams, and renders anywhere,
including commercially, with attribution.

## Attribution

> TAKTO ONE, Sebastian Molano, https://github.com/molanocortes/takto-one

Machine-readable citation metadata is in [`CITATION.cff`](CITATION.cff).

## Name and trademark

**TAKTO and TAKTO ONE are trademarks of Sebastian Molano.** They are asserted as unregistered
marks; no registration is claimed, and the (R) symbol is deliberately not used.

The licences above cover the files, not the name. Apache-2.0 expressly grants no trademark
rights (section 6), and CERN-OHL-S-2.0 does not license the licensor's marks either. That
separation is intentional and is the ordinary arrangement in open hardware: the design is
yours to use, the name stays attached to its origin.

Concretely:

- **You may** build the device, modify it, sell what you build, publish your derivative, and
  say accurately that it is *based on TAKTO ONE*, *derived from TAKTO ONE*, or *compatible
  with TAKTO ONE*.
- **Please do not** name your derivative TAKTO, adopt the name or its styling as the identity
  of your own product, or present your version in a way that suggests it is the original or
  is endorsed by the author.

The point is not to narrow what you may build, the licences above already settle that. It is
so that when someone says *a TAKTO*, it is clear whose design they mean, and so a fork's
problems do not land on the original's reputation. If a use is unclear, ask. The answer is
usually yes.

## Commercial licensing

The hardware licence above, CERN-OHL-S-2.0, is strongly reciprocal: if you distribute a modified
design, or a product built from one, you must make your modified sources available under the same
terms. That is deliberate, and for most people it is exactly the right arrangement.

If it does not work for you, **licensing on other terms is available.** If you want to build a
product on this hardware without publishing your modifications, or you need warranties,
indemnities or support that an open licence does not provide, open an issue or contact the
author and we can discuss terms. The same applies to the software.

Asking costs nothing and no one is refused a hearing.

## Text and data mining

The author reserves the rights referred to in Article 4(3) of Directive (EU) 2019/790 and
§ 44b(3) UrhG for **commercial** text and data mining, including the training of commercial
machine-learning models, on the TAKTO-authored material in this repository.

Text and data mining for scientific research, and by research organisations and cultural
heritage institutions, is expressly welcomed and is not restricted.

Commercial TDM licenses are available, open an issue or contact the author. This reservation
is a separate right under EU law and does not narrow the license grants above.

Copyright © 2026 Sebastian Molano.
