# The knowledge graph

The [Graph](../graph.md) page is a map of DSTNS: every file, class, function, document and section, and how they
connect, as the repository stood when this documentation was built. Use it to find where something lives, what calls
it, and what depends on it, without reading the source first.

![The knowledge graph, with a node chosen and its neighbours listed](../assets/screenshots/graph.png)

## What it shows

| On the map | What it is |
|---|---|
| A dot | One item: a source file, a class, a function or method, a document or one of its sections, or an idea |
| Its colour | The part of DSTNS it belongs to: the engine, Fabric, the daemons, the launcher, the observer, the documentation, tests, tools or configuration. **Explore** in the sidebar lists them, each with its share |
| Its size | How many links it has |
| A tinted cloud | A group: items that link more among themselves than to the rest, named after their most central member (a group named after a standard type, such as `string`, is left unnamed) |
| A line | A link: one item holds, calls, depends on, builds on or mentions the other |

## The page

| Where | What is there |
|---|---|
| The sidebar, on the left | The search, then three tabs. **Explore**: the parts of DSTNS with how much of it each is (choose one to see only it), questions to try, and the kinds of thing. **Filters**: what to show and hide, with a count of what is shown and **Reset**. **Guide**: how to use the page, the questions it understands, and its keys. At its foot, the Claude skill and the commit the graph was built from. The button beside the title hides it; **Search and explore** brings it back |
| The map | Drag, scroll or pinch. Names appear on the parts worth naming as you come closer |
| The controls, at the bottom right | Zoom out, zoom in, show everything, and names on the map on or off |
| The card, on the right | What the chosen item is, where, and what it is linked to |

On a phone the sidebar and the card open as sheets over the foot of the map, and the controls move to the top.

## Using it

| To… | Do this |
|---|---|
| Find something | Type in the search at the top of the sidebar, or press ++slash++ anywhere on the page. Results take the sidebar's place while the search is open. A name, a topic or a question all work: `SimulationEngine`, `docs about weather`, `what calls physics_step`, `what is inside App.tsx`. Results come as you type, a best match first and then the rest by kind, with the words you typed marked |
| Narrow a search | Say what you want in the words: `functions in the launcher`, `classes in core`, `files in the observer` |
| Read about an item | Choose it in the results or on the map. The card says what it is and where, in one sentence, opens the source on GitHub at its line, and lists what it is linked to by kind of link |
| See what it is linked to | The links flow along their lines from what uses to what is used. **Direct links**, **2 steps** or **3 steps** light more round it |
| Share it | The copy button in the card: the address names the item, and opens on it |
| Show less | **Filters** in the sidebar: everything, code or docs; kinds of thing; parts of DSTNS; one folder; kinds of link; and how many links an item needs to be shown |
| See only one part | Choose it in **Explore**; choose it again to see everything |
| Move and zoom | Drag, scroll or pinch; ++plus++ and ++minus++ zoom, and ++0++ shows everything, as the controls at the bottom right do |

## How it is built

Every documentation build makes the graph again, so the page always matches the source it documents:

1. `hooks/graph.py` copies the files Git tracks to a temporary folder, so nothing ignored or generated is read.
2. [graphify](https://github.com/safishamsi/graphify) reads them with its AST extraction (`graphify update`). It uses
   no language model and no key, and the same files always give the same graph.
3. The hook lays the graph out: the communities first, placed by how much they share and kept apart as discs, then
   each community's own nodes inside its disc. The browser is given the positions, so it has nothing to work out.
4. It writes one file, `graph/data.json`: names, files, lines, parts, communities, positions and connections as
   arrays, about a tenth of graphify's own `graph.json`. The page asks for it with `no-cache`, so a visit after the
   first reuses the browser's copy unless a build has changed it.

Read the Docs and CI install graphify from `docs/requirements.txt`, and a build there that cannot make the graph
fails. A local build without graphify uses the copy in the repository, `data/graph/dstns-graph.json`, which the
**Knowledge graph** workflow rebuilds and commits after every push that changes the source, so a clone always has a
recent graph for the launcher, its MCP Handler and the Claude skill. `DSTNS_DOCS_GRAPH=off` skips the graph;
`DSTNS_DOCS_GRAPH=required` makes a local build insist on making it.

## Asking it from Claude

<a class="md-button" href="../../downloads/dstns-graph-skill.zip" download>Download the Claude skill</a> and unpack it into a skills folder
(for Claude Code, `~/.claude/skills/`). It asks the same graph from the command line, in plain words or by
relation, and points at the file and line of each answer:

```bash
python3 scripts/graph.py search "functions in the launcher that save settings"
python3 scripts/graph.py callers physics_step
python3 scripts/graph.py deps next_world.cpp
```

Its source is `skills/dstns-graph/` in the repository. The launcher and its MCP Handler ask the graph in the same
way: see [the launcher](../guide/operator-cli.md#the-knowledge-graph).

## Locally

```bash
.venv-docs/bin/pip install -r docs/requirements.txt   # includes graphify
.venv-docs/bin/mkdocs serve                           # the Graph tab, built once for the files as they are
```

The same graph answers questions from the command line:

```bash
graphify update .                                    # graphify-out/graph.json, ignored by Git
graphify query "how does a seek reach the engine"
graphify path "SeekFilm" "SimulationEngine"
graphify explain "NextWorld"
```
