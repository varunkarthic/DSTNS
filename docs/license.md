# License

DSTNS is free software, licensed under the **GNU Affero General Public License,
version 3 or later** (AGPL-3.0-or-later).

Copyright © 2026 Varun Karthic.

## What that means in practice

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
| [@poppinss/cliui](https://github.com/poppinss/cliui) | MIT | The operator CLI |
| [Eclipse SUMO](https://eclipse.dev/sumo/) (optional, not bundled by default) | EPL-2.0 | Microscopic cross-check |
