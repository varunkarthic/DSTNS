# License

DSTNS is free software, licensed under the **GNU Affero General Public License,
version 3 or later** (AGPL-3.0-or-later).

Copyright © 2026 Varun Karthic.

## How the licence is applied

A licence needs three things: the licence text, a statement of who holds the
copyright, and a notice attached to the work. DSTNS provides each, in the layered way
the [GNU project](https://www.gnu.org/licenses/gpl-howto.html), the
[SPDX](https://spdx.dev) standard and the [REUSE](https://reuse.software)
specification recommend.

| Where | What it does |
|---|---|
| [`LICENSE`](https://github.com/varunkarthic/DSTNS/blob/main/LICENSE) | The **unmodified** AGPL-3.0 text. It must stay verbatim, so it names the Free Software Foundation as its own author. The placeholder `Copyright (C) <year> <name of author>` near its end is the licence's *template* for authors to copy, not a field to fill in |
| [`COPYRIGHT`](https://github.com/varunkarthic/DSTNS/blob/main/COPYRIGHT) | States the holder (Copyright (C) 2026 Varun Karthic), the licence notice, and the third-party data and tools |
| Every source file | A two-line header: `SPDX-License-Identifier: AGPL-3.0-or-later` and `Copyright (C) 2026 Varun Karthic`. This keeps the licence and holder attached to a file copied out of the repository |
| `package.json` files, README, About card | Declare the licence for package managers, readers and users of the running program |
| `GET /api/v1/system/source` | The network source offer that AGPL section 13 requires |

The header is enforced: `scripts/license-headers.py --check` runs in CI and fails if
any source file lacks it, and `--fix` adds it. New files get the header from the same
script.

!!! note "Copyright exists without a notice"
    Copyright arises automatically when a work is created; a notice is not required
    for it to apply. The notices above remove any doubt about who the holder is and
    on what terms the work may be used, which is what lets others rely on the licence.

!!! info "Not legal advice"
    This page describes how the project applies its licence. It is not legal advice.
    For questions about ownership, relicensing or employer or institution claims,
    consult a lawyer.

## What the licence means in practice

- You may use, study, change and share DSTNS.
- If you distribute it, modified or not, you must do so under the same licence
  and provide the source.
- **If you let people use a modified DSTNS over a network** (for example, host
  the observer for others), you must offer them the source of the version you
  run. DSTNS does this for the unmodified program through
  `GET /api/v1/system/source` and the About card; keep that offer accurate if
  you change the code.

The full text is in [`LICENSE`](https://github.com/varunkarthic/DSTNS/blob/main/LICENSE)
and the notice in [`COPYRIGHT`](https://github.com/varunkarthic/DSTNS/blob/main/COPYRIGHT).

## Third-party components

| Component | Licence | Used for |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) data | ODbL 1.0 | Every road network; credit "© OpenStreetMap contributors" |
| [nlohmann/json](https://github.com/nlohmann/json) | MIT | JSON in the core |
| [cpp-httplib](https://github.com/yhirose/cpp-httplib) | MIT | The HTTP server |
| [SQLite](https://sqlite.org/) | Public domain | The runtime journal |
| [zlib](https://zlib.net/) | zlib | Response compression |
| [React](https://react.dev/) | MIT | The observer |
| [Vite](https://vitejs.dev/), [Vitest](https://vitest.dev/) | MIT | Building and testing the observer |
| [jsPDF](https://github.com/parallax/jsPDF) | MIT | PDF reports |
| [Inter](https://rsms.me/inter/), [JetBrains Mono](https://www.jetbrains.com/lp/mono/), [Space Grotesk](https://floriankarsten.github.io/space-grotesk/) | SIL OFL 1.1 | Typefaces |
| [Textual](https://github.com/Textualize/textual), [Rich](https://github.com/Textualize/rich) | MIT | The launcher's terminal interface (installed on first use, not bundled) |
| [Eclipse SUMO](https://eclipse.dev/sumo/) (optional, not bundled by default) | EPL-2.0 | Microscopic cross-check |

## Using and modifying DSTNS

You may run, study, change and redistribute DSTNS under the AGPL. If you redistribute a
modified copy, or let others use it over a network, keep the licence and the copyright and
SPDX notices in every file, mark your changes, and offer your users the corresponding
source. A file you add may carry your own copyright line.

The project does not take outside contributions, so there is no contributor agreement. If
you publish your own fork, you decide how contributions to it are handled and under what
terms.

## Data

OpenStreetMap data, including the district bundled at
`data/fixtures/real_network.osm.xml`, is © OpenStreetMap contributors under the
[Open Database Licence 1.0](https://opendatacommons.org/licenses/odbl/1-0/). It is data,
not part of the program, and the AGPL does not apply to it. Maps downloaded at run time
carry a manifest recording their source, licence, query and checksum.
