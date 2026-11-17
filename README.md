<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-light.svg">
  <img alt="DSTNS" src="docs/assets/wordmark-dark.svg" width="300">
</picture>

<br><br>

**Deterministic Spatiotemporal Transport Network Simulator**

A seed chooses a real district of a real city. DSTNS simulates a whole day there,<br>
and you watch it, change it, and build on it.

<br>

[![CI](https://github.com/varunkarthic/DSTNS/actions/workflows/ci.yml/badge.svg?branch=v3)](https://github.com/varunkarthic/DSTNS/actions/workflows/ci.yml)
[![Documentation](https://img.shields.io/badge/docs-v3-0c7fa3)](https://dstns.readthedocs.io/v3/)
[![Licence](https://img.shields.io/badge/licence-AGPL--3.0--or--later-2fbf8f)](LICENSE)
[![Container](https://img.shields.io/badge/container-ghcr.io-5b9cf0?logo=docker&logoColor=white)](https://github.com/varunkarthic/DSTNS/pkgs/container/dstns)

<br>

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/observer-light.png">
  <img src="docs/assets/screenshots/observer.png" alt="The DSTNS observer, showing a simulated day in a district of a city" width="100%">
</picture>

**[Quick start](https://dstns.readthedocs.io/v3/getting-started/quick-start/)** ·
**[Documentation](https://dstns.readthedocs.io/v3/)** ·
**[Knowledge graph](https://dstns.readthedocs.io/v3/graph/)** ·
**[Changelog](CHANGELOG.md)**

</div>

<br>

## Overview

Give DSTNS a number. It resolves to a district in one of 379 cities in 126 countries, on every inhabited continent, downloads that district's streets from OpenStreetMap, and runs a full day of traffic, signals, demand, weather, flooding and incidents on one clock.

**The same seed, configuration, map and build always give the same day**, on any machine. You can pause it, step through it, jump back and forward in time, and export a report of what happened.

- **A real simulation.** Signals are snapped to real junctions and coordinated in green waves. Demand comes from the schools, offices and homes that are really there, and differs between weekdays and weekends. Storms cross the district and flood its low roads, and queues from collisions spread back up the road.
- **A live observer.** A map with telemetry, notifications, Time Control and an Auto Focus camera that follows what matters. It has light and dark themes, palettes for colour vision, and keyboard shortcuts you can change.
- **Open to your programs.** Through **Fabric**, an HTTP API with 152 documented paths, and **WebFabric**, which lets your applications add panels and map layers to the observer.
- **Ready for AI.** An MCP server makes every API route a tool for AI clients. It is closed by default.
- **Two engines, one contract.** **core-ng**, the engine, runs every world; **core-legacy**, the engine DSTNS had
  before it, stays installed for comparison and makes the same world from the same seed, bit for bit.

## Quick start

On macOS or Linux, from source:

```bash
git clone https://github.com/varunkarthic/DSTNS.git && cd DSTNS
./launcher
```

Or with Docker, with nothing else to install:

```bash
docker run -d --name dstns -p 127.0.0.1:8090:8090 \
  -v dstns-maps:/app/data/maps -v dstns-logs:/app/logs \
  -e DSTNS_SEED=382923 ghcr.io/varunkarthic/dstns:stable
```

Then open **http://localhost:8090**.

> [!NOTE]
> The first launch builds the launcher (about a minute, with a progress bar), checks the machine, and walks you through a short setup. The first run then downloads its city's district from OpenStreetMap, which takes up to a minute. After that, the next world is prepared while the current one runs.

Building from source needs a C++20 compiler, CMake 3.22, SQLite, zlib and libcurl headers, Node 20 and Rust 1.89. On Windows, use WSL 2. Nothing needs Python. See [Requirements](https://dstns.readthedocs.io/v3/getting-started/requirements/).

## The launcher

<img src="docs/assets/screenshots/launcher.png" alt="The DSTNS launcher's dashboard in a terminal" width="100%">

One program checks your machine, builds what is needed, and runs everything. Its dashboard shows live readings of the engine, the simulation, the next world and the system. The menu is in four sections: **Simulation**, **Set up**, **Inspect** and **Help**.

```bash
./launcher start --seed 382923 --day-type weekend --speed 3   # a weekend in one district, at 3×
./launcher start --seed 42 --save-seed demo                   # keep a configuration
./launcher start --saved-seed demo                            # run it again
./launcher demo                                               # the start-up film on a loop
```

- **Your own applications start with a run.** The day begins only once they are all ready.
- **A shell-style console.** Pipes, `&&`, `json` to look inside any state, and `set` to change any setting.
- **Plain words.** A local model can turn a request into a command for you to check and run.
- **Advanced Security.** Touch ID or your password can be required before the launcher can be changed.

- **Where worlds are, ticked from a list.** Configuration, Engine, Places lists every country with its code and number
  of cities: Space chooses one, `-` leaves one out. From any shell: `./launcher engine add IN AE`, `engine add -PK`,
  `engine del all`.
- **Every supported city, to look up and keep.** Tools, Supported cities filters all 379 and saves them as CSV;
  `./launcher cities india` and `./launcher countries` do the same in a shell.
- **Every tool's output can be exported**, and `./launcher reset` frees what builds and tests leave behind (often
  gigabytes), saying how much.

<table>
<tr>
<td width="50%"><img src="docs/assets/screenshots/launcher-places.png" alt="Places in the launcher: a list of countries with their codes and number of cities, to tick"></td>
<td width="50%"><img src="docs/assets/screenshots/launcher-cities.png" alt="Tools, Supported cities: every city with its country, code and ID, filtered"></td>
</tr>
</table>

```bash
./launcher version                 # the launcher, server, API, observer and each engine
./launcher engine                  # the engines and their policy
./launcher engine add IN, AE       # worlds only in India and the UAE
./launcher engine add -IN          # anywhere but India
./launcher engine del all          # anywhere in the world again
./launcher cities export cities.csv
```

More in the [launcher guide](https://dstns.readthedocs.io/v3/guide/operator-cli/), the [engines guide](https://dstns.readthedocs.io/v3/guide/engines/) and the [console guide](https://dstns.readthedocs.io/v3/guide/console/).

## Engines

| Engine | Version | Channel | State | What it is |
|---|---|---|---|---|
| **core-ng** | 1.2.2 | stable | the default; it cannot be disabled | The engine. Its own world selection, compiler, physics tick, checkpoints and lifecycle tables, on a common layer it shares with nothing engine-specific. 28% faster per tick than 3.13.0 at 50×50 |
| **core-legacy** | the build's | stable | disabled by default | The engine DSTNS had before core-ng, frozen. Enable it to compare: both make the same world, hash for hash |

- **Selection policies.** `urban-crfg-v3` (every seed's city as engine 3.0 chose it), `urban-geo-v1` (countries or
  cities from those 181) and `urban-geo-v2` (the same rules over 379 cities; what the launcher uses on core-ng). A
  policy never changes meaning: new cities come with a new policy, so recorded seeds keep their cities.
- **No city twice in a session**, while the policy allows another. Regenerate goes somewhere new until every allowed
  city has been shown.
- **An alpha or beta engine's run waits for a person to accept the risk**, in the observer or with `--accept-risk`.
  A new version of the running engine is announced once in the notifications.

See [Engines](https://dstns.readthedocs.io/v3/guide/engines/) and [Engine governance](https://dstns.readthedocs.io/v3/design/engine-governance/).

## Fabric and WebFabric

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/fabric-white.png">
    <img alt="Fabric" src="docs/assets/brand/fabric-black.png" height="36">
  </picture>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/webfabric-white.png">
    <img alt="WebFabric" src="docs/assets/brand/webfabric-black.png" height="36">
  </picture>
</p>

**Fabric** is the layer everything reaches the engine through: 152 documented paths over HTTP and JSON, described in OpenAPI 3.1. **WebFabric** lets your programs become part of the observer. A program registers itself and declares what it wants to show as data, and the observer draws it in its own design.

```python
token = post("/api/v1/fabric/apps", {
    "id": "org.example.planner", "name": "Planner", "version": "1.0.0",
    "capabilities": ["ui.panels", "ui.overlays", "ui.camera"],
})["data"]["token"]

# A route along real roads, with buses that stop at red signals.
put("/api/v1/fabric/apps/org.example.planner/ui/line", {"slot": "overlay", "features": [
    {"type": "path", "id": "bus-1", "nodes": route, "style": "flow", "drive": True, "count": 3},
]})
```

An application can:

- add panels, a sidebar and notifications, using 29 widgets;
- draw markers, routes and moving vehicles on the map;
- with a person's permission, direct the view and turn layers on or off;
- follow the simulation's events and timers.

A person always decides. Tokens are hashed, requests can be signed, and the audit log is a hash chain.

To start building, see the [Fabric API](https://dstns.readthedocs.io/v3/api/fabric-api/), [WebFabric](https://dstns.readthedocs.io/v3/components/webfabric/) and its [planner template](https://dstns.readthedocs.io/v3/components/webfabric/#templates), and [security](https://dstns.readthedocs.io/v3/api/security/).

## AI ready

The **MCP Handler** lets an AI client call DSTNS through the Model Context Protocol. Every API route is a tool, and so are starting and stopping runs. No agent is included. It is closed by default, and you choose whether a client may read, change things, or start runs.

```bash
./launcher config set mcp.enabled on
./launcher mcp client-config          # what to add to your MCP client
```

See the [MCP guide](https://dstns.readthedocs.io/v3/guide/mcp/).

## The knowledge graph

<img src="docs/assets/screenshots/graph.png" alt="The knowledge graph: a sidebar with search and the parts of DSTNS, the map of the code, and a card for SimulationEngine" width="100%">

The [Graph](https://dstns.readthedocs.io/v3/graph/) page maps every file, class, function and page of DSTNS, and how they connect. It is rebuilt from the source with every documentation build. You can:

- search it in plain words, such as `what calls snapshot` or `functions in the launcher`;
- see one part of DSTNS on its own;
- open anything on GitHub at its exact line.

The same graph answers `./launcher graph`, the MCP Handler and a downloadable Claude skill.

## Reports

<img src="docs/assets/screenshots/report-cover.png" alt="The cover of a DSTNS report: the run's own map softening toward the city's name" width="300" align="right">

Export any run as a PDF in six parts: at a glance, the city, traffic, disruptions, how it ran, and reference. It opens with the day in one sentence, the figures that matter, and numbered findings. Each statement is labelled as observed, derived or interpretation.

The cover is drawn from the run itself: its streets, how busy each one is, and even the hour.

See [Reports](https://dstns.readthedocs.io/v3/guide/reports/).

<br clear="right">

## More

| | |
|---|---|
| **Fast starts** | While a world runs, the next one is prepared in another city. `./launcher fastboot download` keeps every city on disk. See [Fast Boot](https://dstns.readthedocs.io/v3/guide/fast-boot/) |
| **Daemons** | Watchers inside the server for resources, memory, disk and stalled runs, and a cache handler. See [Daemons](https://dstns.readthedocs.io/v3/guide/daemons/) |
| **Reproducibility** | The same seed, configuration, map bytes and build give the same results. See the [limits](https://dstns.readthedocs.io/v3/concepts/reproducibility/) |
| **State machines** | Every lifecycle, with its states and transitions, is in [State machines](https://dstns.readthedocs.io/v3/design/state-machines/) |
| **Tests** | 45 engine and HTTP suites (golden fixtures prove core-ng and core-legacy identical, and `dstns_core_ng_alone` builds core-ng with no core-legacy code), 107 launcher tests and 513 observer tests. `./scripts/test.sh` runs them all |
| **Performance** | A 50×50 grid ticks in about 240 µs on an Apple M4, 2.9 times what the fastest playback needs. See [Performance](https://dstns.readthedocs.io/v3/deployment/performance/) |
| **Deployment** | Containers, a TLS gateway, logging and upgrades. See [Deployment](https://dstns.readthedocs.io/v3/deployment/) |

## Security

DSTNS is a single-operator tool. It listens on loopback only, refuses cross-site and DNS-rebinding requests, and has no user accounts, so anyone who can reach the port can read the run. To expose it beyond one machine, put an authenticating gateway in front of it. To report a suspected vulnerability privately, see [SECURITY.md](SECURITY.md).

## Versions

Engine **3.13.3** (core-ng **1.2.2**) · Launcher **3.14.1** · Observer **3.8.0** · API contract **1.13**. `./launcher version`, `./build/dstns_server --version` and `/api/v1/system/info` report what is running. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

DSTNS is for research, teaching, algorithm integration and demonstrations. It is not calibrated or certified for controlling real traffic.

## Licence

Copyright © 2026 Varun Karthic. DSTNS is free software under the [GNU Affero General Public License v3.0 or later](LICENSE). If you offer a modified DSTNS over a network, you must offer its source to its users. It is provided as is, and it does not take outside contributions.

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL 1.0.
