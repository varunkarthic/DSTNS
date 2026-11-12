---
name: dstns-graph
description: Answer questions about the DSTNS codebase from its knowledge graph before reading source. Use for where something lives, what a file, class or function contains, what calls it or what it calls, what a file depends on or is used by, and how two parts connect, in the engine (Core), Fabric and WebFabric, the daemons, the launcher (LaunchKit), the observer (WebKit), the documentation and the tests.
---

# DSTNS knowledge graph

DSTNS publishes a graph of every file, class, function and documentation section in the repository, and how they
connect (`contains`, `calls`, `imports`, `references`, `inherits` and others), with each node's file and line. It is
built by graphify's AST extraction from the repository as Git tracks it, and kept at `data/graph/dstns-graph.json`.
The same graph is drawn at <https://dstns.readthedocs.io/v3/graph/>.

Ask the graph first. It answers "where", "what calls" and "what depends on" in one step, with file and line, so read
only the source it points to.

## How to ask

Run the script in this skill's `scripts/` folder. It finds the graph in a DSTNS clone (from the current folder
upward), or downloads it once from the documentation. It needs only Python 3.

```bash
python3 scripts/graph.py search "functions in the launcher that save settings"
python3 scripts/graph.py show SimulationEngine          # what it is, where, and everything round it
python3 scripts/graph.py callers physics_step            # what calls it
python3 scripts/graph.py callees capsuleFrame            # what it calls
python3 scripts/graph.py deps next_world.cpp             # what a file depends on
python3 scripts/graph.py users motion.ts                 # what depends on a file
python3 scripts/graph.py members SimulationEngine        # what a class or file contains
python3 scripts/graph.py path SeekFilm SimulationEngine  # how two things connect
python3 scripts/graph.py stats                           # the graph's size and the commit it was built from
```

`search` takes plain words. It splits code names (`seekBy` is `seek` and `by`), allows small typos, widens DSTNS's
own terms (`rewind` also finds `seek`), and understands a type (`functions`, `classes`, `files`, `docs`) and a part
(`in the launcher`, `in core`, `in the observer`, `in fabric`, `in daemons`, `in docs`, `in tests`).

Each result line is the name, its type and `file:line`. `show` also prints a GitHub link to that line, at the commit
the graph was built from.

## Answering

1. Run the narrowest command that answers the question: `callers` for "who calls", `deps` for "what does it need",
   `show` for "what is", `search` when the name is not known.
2. Read the source only at the files and lines it gives, to confirm and to quote.
3. Say which file and line each part of the answer comes from.
4. The graph is as fresh as its commit (`stats`). If the code was changed since, check the source, and in a clone
   rebuild the graph with `python3 hooks/graph.py data/graph/dstns-graph.json` (needs `pip install graphifyy`).

## What the graph does not hold

- Calls the extractor could not resolve, such as some C++ calls between files: "no callers" is a hint, not proof.
  Search the source with `grep` to be sure.
- Run-time behaviour, configuration values and data. The documentation covers those.
