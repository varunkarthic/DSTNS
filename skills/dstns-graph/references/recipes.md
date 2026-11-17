# Recipes

Common questions about DSTNS, and the commands that answer them. Run them from this skill's folder, or anywhere in a
DSTNS clone.

## Where is an API route handled?

Routes are registered inline, one group to a file, by the last part of their path: `/api/v1/playback/seek` is
`post("seek", …)` in `Fabric/src/routes_playback.cpp`. The graph holds each routes file but not each route, so find
the route with `grep`, then follow the engine method it calls with the graph:

```bash
grep -n 'post("seek"' Fabric/src/routes_*.cpp               # the handler: engine_.seek(...)
python3 scripts/graph.py search seek in core                # SimulationEngine::seek and what serves it
python3 scripts/graph.py docs "playback seek"               # the endpoint's documentation
```

`docs/api/openapi.yaml` lists every path, and `docs/api/endpoints.md` describes each one.

## What does a launcher setting do, and where does it reach the engine?

```bash
python3 scripts/graph.py search "tick rate setting"     # the setting in LaunchKit/src/config.rs
python3 scripts/graph.py callers server_arguments       # how settings become the server's arguments
python3 scripts/graph.py docs configuration             # the documentation of every setting
```

Every setting is a `Field` in `LaunchKit/src/config.rs`, with its key, range, default and help. Settings that the
server reads travel as arguments or `DSTNS_*` variables (`server_arguments`, `server.rs`).

## What does core-ng own, and how does it differ from core-legacy?

```bash
python3 scripts/graph.py members compile.cpp            # core-ng's compile, part by part
python3 scripts/graph.py file core-ng/src/physics.cpp   # core-ng's tick
python3 scripts/graph.py file core-legacy/src/physics.cpp
python3 scripts/graph.py docs engines                   # the Engines guide and engine governance
```

Both make the same world from the same seed, bit for bit (`tests/unit/golden_tests.cpp`); core-ng arranges the work
in fewer passes and keeps checkpoints compressed.

## Which tests cover something I am changing?

```bash
python3 scripts/graph.py tests SimulationEngine
python3 scripts/graph.py tests select_location
python3 scripts/graph.py --json tests Seed128           # to filter or count
```

Engine and HTTP suites are listed in `CMakeLists.txt` (`DSTNS_HTTP_TESTS` for the HTTP ones). The launcher's tests are
`#[test]` functions beside the code in `LaunchKit/src`; the observer's are in `WebKit/tests`.

## What would a change to a header affect?

```bash
python3 scripts/graph.py users engine.hpp               # every file that includes it
python3 scripts/graph.py members SimulationEngine       # what the class holds
```

## How do two parts connect?

```bash
python3 scripts/graph.py path select_location SimulationEngine
python3 scripts/graph.py ask "how does EngineGate connect to SimulationEngine"
```

A path goes through any relation; read the files at each step to see what the link is.

## Where is an observer component, and what does it use?

```bash
python3 scripts/graph.py search "telemetry deck"
python3 scripts/graph.py deps TelemetryDeck.tsx
python3 scripts/graph.py search "components in the observer that draw the map"
```

## Where is something documented?

```bash
python3 scripts/graph.py docs "launch codes"
python3 scripts/graph.py search "docs about weather"
```

## Before answering

- Name the file and line for each claim.
- Treat "no callers" as unproven for C++ and for anything reached through hooks; confirm with `grep`.
- Check `stats` against the code you are looking at: the graph describes its commit.
