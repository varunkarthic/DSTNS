---
name: dstns-graph
description: Answer questions about the DSTNS codebase from its knowledge graph before reading source. Use for where something lives, what a file, class or function contains, what calls it or what it calls, what a file depends on or is used by, which tests and documentation cover it, and how two parts connect, across the engine (Core: common, core-ng, core-legacy), Fabric and WebFabric, the daemons, the launcher (LaunchKit), the observer (WebKit), the documentation and the tests. Also for orienting in an unfamiliar part of DSTNS before a change.
---

# DSTNS knowledge graph

DSTNS publishes a graph of every file, class, function and documentation section in the repository, and how they
connect, each with its file and line. graphify builds it from the repository as Git tracks it, and it is kept at
`data/graph/dstns-graph.json`; a workflow rebuilds it on every push. The same graph is drawn at
<https://dstns.readthedocs.io/v3-core-ng/graph/>.

**Ask the graph first.** It answers "where", "what calls", "what depends on" and "what tests this" in one step, with
file and line, so you read only the source it points to instead of searching the tree.

## Quick start

The script is `scripts/graph.py`, Python 3 and the standard library only. It finds the graph in a DSTNS clone (from
the current folder upward), or downloads it once from the documentation and keeps it beside itself.

```bash
python3 scripts/graph.py ask "what calls sha256"          # any question in plain words
python3 scripts/graph.py show SimulationEngine              # what it is, where, and everything round it
python3 scripts/graph.py tests Seed128                      # the tests that exercise it
```

## Commands

| Command | Answers | Example |
|---|---|---|
| `ask QUESTION` | Any question below, in plain words; prints how it read it | `ask "what does select_location call"` |
| `search WORDS` | Things by name or topic, ranked; understands a type and a part | `search functions in the launcher that save settings` |
| `show NAME` | What it is, its file and line, a GitHub link, and every kind of link round it | `show EngineGate` |
| `callers NAME` | What calls a function | `callers sha256` |
| `callees NAME` | What a function calls | `callees select_location` |
| `deps FILE` | What a file imports or includes | `deps engine.cpp` |
| `users FILE` | What imports or includes a file | `users engine.hpp` |
| `members NAME` | What a class or file contains | `members SimulationEngine` |
| `path A B` | The shortest chain of links from A to B | `path select_location SimulationEngine` |
| `tests NAME` | Tests linked to it within two steps, nearest first | `tests Seed128` |
| `docs NAME` | Documentation sections linked to it, or about it | `docs "engine governance"` |
| `file PATH` | Everything in a file, by line (a path or its end) | `file core-ng/src/selection.cpp` |
| `areas` | The parts of DSTNS and how many items each has | `areas` |
| `stats` | The graph's size, and the commit it was built from | `stats` |

Options: `--json` prints any answer as JSON (each item with `name`, `type`, `part`, `where`, `url` and `test`);
`--limit N` changes how many it lists (20 by default); `--graph FILE` reads another graph.

### How `ask` reads a question

| You ask | It runs |
|---|---|
| "what calls X", "who uses X", "callers of X" | `callers X` |
| "what does X call", "what does X use" | `callees X` |
| "what depends on X", "who includes X" | `users X` |
| "what does X depend on", "what does X include" | `deps X` |
| "what is inside X", "members of X" | `members X` |
| "where is X", "what is X", "show X" | `show X` |
| "tests for X", "what tests cover X" | `tests X` |
| "docs about X", "documentation for X" | `docs X` |
| "how does X connect to Y" | `path X Y` |
| anything else | `search` |

Names are matched as people write them: `the simulation engine` finds `SimulationEngine`, `seekBy` is `seek` and
`by`, a small typo is forgiven, and DSTNS's own words are widened (`rewind` also finds `seek`). When a name belongs
both to code and to a test helper, the code is chosen.

### Reading the output

Each line is a name, its type (`function`, `class`, `file`, `section`, `concept`, `other`) and `file:line`;
`[test]` marks an item in a test file. `show` adds a GitHub link to that line at the commit the graph was built
from. Relations, as `show` lists them:

| Relation | Means |
|---|---|
| `contains` | A file holds a class or function; a class holds a method; a page holds a section |
| `calls` | One function calls another (where the extractor could resolve it) |
| `imports` | A file includes or imports another |
| `inherits` | A class builds on or implements another |
| `references` | Code or a page names another thing |
| `(from)` | The same relation, seen from the other end: `calls (from)` is what calls it |

## Answering a question about DSTNS

1. **Orient.** If the part is unfamiliar, read [references/architecture.md](references/architecture.md): what each
   folder holds and its entry points.
2. **Ask narrowly.** Use the command that answers the question directly (`callers` for "who calls", `deps` for "what
   does it need", `tests` for "how is it checked", `show` for "what is it"), and `search` only when the name is not
   known.
3. **Read only what it points to.** Open the files at the lines given, to confirm and to quote. Prefer the
   non-test results; use the `[test]` ones to see how something is exercised.
4. **Cite.** Say which file and line each part of the answer comes from.
5. **Check freshness.** `stats` gives the commit. If the code may have changed since, confirm in the source, and in
   a clone rebuild the graph: `python3 hooks/graph.py data/graph/dstns-graph.json` (needs `pip install graphifyy`).

Common tasks, step by step (finding where an API route is handled, tracing a setting from the launcher to the engine,
seeing what core-ng owns, finding the tests for a change, and others) are in
[references/recipes.md](references/recipes.md).

## What the graph does not hold

- **Some calls.** Calls the extractor could not resolve, notably C++ calls between files and calls through hooks
  (the host reaches each engine's `select`, `compile`, `step`, `capture` and `rewind` through
  `ScenarioCompiler::Hooks`): "no callers" is a hint, not proof. Search the source with `grep` to be sure.
- **Each HTTP route.** Routes are registered inline in `Fabric/src/routes_*.cpp`; the graph holds the file. Find a
  route with `grep`, then follow the engine method it calls.
- **Run-time behaviour, configuration values and data.** The documentation covers those; `docs NAME` finds the page.
- **Anything after its commit.** It describes the repository as it was built; see `stats`.
