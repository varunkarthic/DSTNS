#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Ask DSTNS's knowledge graph: where something is, what it holds, what it calls and what calls it.

    python3 graph.py ask "what calls sha256"                 any question in plain words
    python3 graph.py search "functions in the launcher that save settings"
    python3 graph.py show SimulationEngine                   what it is, where, and everything round it
    python3 graph.py callers sha256        callees select_location
    python3 graph.py deps engine.cpp       users engine.hpp
    python3 graph.py members SimulationEngine
    python3 graph.py path select_location SimulationEngine
    python3 graph.py tests Seed128         docs "engine governance"
    python3 graph.py file Core/core-ng/src/selection.cpp
    python3 graph.py areas                 stats
    python3 graph.py --json callers sha256                   the same, as JSON

The graph is read from data/graph/dstns-graph.json in a DSTNS clone (found from here or the current folder upward),
or from --graph FILE, or downloaded once from the documentation and kept beside this script. Only the standard
library is used.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import urllib.request
from collections import deque
from pathlib import Path

ONLINE = "https://dstns.readthedocs.io/v3-core-ng/graph/data.json"
TEST_FILE = re.compile(r"(^|/)(tests?|__tests__|fixtures)/|\.test\.|_tests?\.|\.spec\.")
PART_NAMES = {"Core": "the engine (Core/common, Core/core-ng, Core/core-legacy, Core/engines)", "Fabric": "the HTTP API and WebFabric",
              "Daemon": "the daemons inside the server", "LaunchKit": "the launcher (Rust)", "WebKit": "the observer (React)",
              "docs": "the documentation", "tests": "the engine's and HTTP tests", "tools": "tools: benchmark, stress, release",
              "config": "configuration files and their schemas", "CoreAI": "the shared model layer"}
GROUPS = {
    "contains": ["contains", "defines", "method"],
    "calls": ["calls", "indirect_call"],
    "imports": ["imports", "imports_from", "dynamic_import", "re_exports"],
    "inherits": ["inherits", "implements"],
    "references": ["references", "rationale_for"],
}
STOP = set("a an the of in on at to for from by with and or is are was be does do did how what where which who that this these it its into about show find me list all any get tell".split())
SORT_WORDS = {"function": "function", "functions": "function", "method": "function", "methods": "function", "class": "class", "classes": "class", "struct": "class", "type": "class", "types": "class", "file": "file", "files": "file", "module": "file", "modules": "file", "doc": "section", "docs": "section", "page": "section", "pages": "section", "section": "section", "sections": "section"}
AREA_WORDS = {"core": "Core", "engine": "Core", "fabric": "Fabric", "api": "Fabric", "daemon": "Daemon", "daemons": "Daemon", "launcher": "LaunchKit", "cli": "LaunchKit", "observer": "WebKit", "ui": "WebKit", "webkit": "WebKit", "docs": "docs", "documentation": "docs", "tests": "tests", "tools": "tools", "config": "config"}
THESAURUS = {"seek": ["jump", "rewind", "skip"], "rewind": ["seek"], "jump": ["seek"], "map": ["osm", "topology", "network"], "weather": ["rain", "storm", "flood"], "signal": ["phase", "cycle"], "incident": ["accident", "closure"], "launcher": ["cli", "tui", "console"], "observer": ["ui", "webkit"], "fabric": ["api", "route", "endpoint"], "daemon": ["watcher", "rcs"], "setting": ["config", "option"], "security": ["auth", "token", "hmac"], "report": ["pdf", "export"], "film": ["boot", "particle", "scene"], "seed": ["rng", "random"], "world": ["scenario", "regenerate"]}


def words(text: str) -> list[str]:
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    return [w for w in re.split(r"[^a-z0-9]+", text.lower()) if w]


def stem(w: str) -> str:
    if len(w) > 5 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 5 and (w.endswith("ing") or w.endswith("ed")):
        return re.sub(r"(ing|ed)$", "", w)
    if len(w) > 4 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def find_graph(given: str | None) -> Path:
    if given:
        return Path(given)
    for start in (Path.cwd(), Path(__file__).resolve().parent):
        for folder in (start, *start.parents):
            candidate = folder / "data" / "graph" / "dstns-graph.json"
            if candidate.is_file():
                return candidate
    kept = Path(__file__).resolve().parent / "dstns-graph.json"
    if not kept.is_file():
        print(f"Downloading the graph from {ONLINE} …", file=sys.stderr)
        with urllib.request.urlopen(ONLINE, timeout=60) as response:
            kept.write_bytes(response.read())
    return kept


class Graph:
    def __init__(self, path: Path):
        self.d = json.loads(path.read_text())
        n = self.d["nodes"]
        self.n = n
        self.count = len(n["id"])
        e = self.d["edges"]
        self.edges = [(e[i], e[i + 1], self.d["relations"][e[i + 2]]) for i in range(0, len(e), 3)]
        self.adj: list[list[int]] = [[] for _ in range(self.count)]
        for k, (s, t, _) in enumerate(self.edges):
            self.adj[s].append(k)
            self.adj[t].append(k)
        self.index: dict[str, dict[int, float]] = {}
        for i in range(self.count):
            for w in words(n["label"][i]):
                self._add(w, i, 3)
            self._add(re.sub(r"[^a-z0-9]", "", n["label"][i].lower()), i, 3.5)
            for w in words(self.file(i)):
                self._add(w, i, 1.1)

    def _add(self, token: str, node: int, weight: float) -> None:
        slot = self.index.setdefault(stem(token), {})
        slot[node] = max(slot.get(node, 0), weight)

    def file(self, i: int) -> str:
        return self.d["files"][self.n["file"][i]]

    def sort(self, i: int) -> str:
        return self.d["sorts"][self.n["sort"][i]] if "sort" in self.n else "other"

    def area(self, i: int) -> str:
        return self.d["areas"][self.n["area"][i]]

    def where(self, i: int) -> str:
        f, line = self.file(i), self.n["line"][i]
        return f"{f}:{line}" if f and line else f or self.area(i)

    def url(self, i: int) -> str:
        f, line = self.file(i), self.n["line"][i]
        return f"https://github.com/{self.d['repo']}/blob/{self.d['commit']}/{f}" + (f"#L{line}" if line else "") if f else ""

    def rank(self, query_words: list[str], sorts: list[str] = (), areas: list[str] = (), among: set[int] | None = None, limit: int = 20):
        score: dict[int, float] = {}
        covered: dict[int, int] = {}
        # Short queries need every word; a sentence needs most of them, and more is better.
        need = len(query_words) if len(query_words) <= 2 else math.ceil(len(query_words) * 0.6)
        for word in query_words:
            got: dict[int, float] = {}
            for term, weight in [(stem(word), 1.0)] + [(stem(s), 0.8) for s in THESAURUS.get(stem(word), [])]:
                slot = self.index.get(term)
                if not slot:
                    slot = {}
                    for token, nodes in self.index.items():
                        if len(term) >= 4 and token.startswith(term):
                            for node, v in nodes.items():
                                slot[node] = max(slot.get(node, 0), v * 0.7)
                if not slot:
                    continue
                idf = math.log(1 + self.count / len(slot))
                for node, field in slot.items():
                    got[node] = max(got.get(node, 0), field * idf * weight)
            for node, v in got.items():
                score[node] = score.get(node, 0) + v
                covered[node] = covered.get(node, 0) + 1
        score = {node: v * covered[node] / len(query_words) for node, v in score.items() if covered[node] >= need}
        if not query_words:
            score = {i: 1 + math.log(1 + self.n["degree"][i]) for i in (among if among is not None else range(self.count))}
        whole = "".join(query_words)
        out = []
        for node, v in score.items():
            if among is not None and node not in among:
                continue
            if sorts and self.sort(node) not in sorts:
                continue
            if areas and self.area(node) not in areas:
                continue
            flat = re.sub(r"[^a-z0-9]", "", self.n["label"][node].lower())
            out.append((v + (30 if flat == whole else 12 if whole and flat.startswith(whole) else 0) + math.log(1 + self.n["degree"][node]) * 0.4, node))
        return sorted(out, reverse=True)[:limit]

    def around(self, node: int, group: str, direction: str) -> set[int]:
        out = set()
        for k in self.adj[node]:
            s, t, rel = self.edges[k]
            if rel not in GROUPS[group]:
                continue
            if direction == "out" and s == node:
                out.add(t)
            if direction == "in" and t == node:
                out.add(s)
        return out

    def subject(self, text: str, group: str | None = None, direction: str = "in") -> int:
        # "the simulation engine" names SimulationEngine: words that only carry the sentence are left out.
        named = [w for w in words(text) if w not in STOP] or words(text)
        found = self.rank(named, limit=8)
        if not found:
            # A name not in the graph as written: its rarest word stands for it.
            for w in sorted((w for w in words(text) if w not in STOP), key=lambda w: len(self.index.get(stem(w), {}) or [0] * self.count)):
                found = self.rank([w], limit=8)
                if found:
                    break
        # The code itself before its tests: a test helper of the same name never answers for it.
        candidates = [node for _, node in found if not self.is_test(node)] + [node for _, node in found if self.is_test(node)]
        if group == "imports":
            candidates = [self.file_node(c) for c in candidates]
        if group:
            for c in candidates:
                if self.around(c, group, direction):
                    return c
        return candidates[0] if candidates else -1

    def is_test(self, node: int) -> bool:
        return bool(TEST_FILE.search(self.file(node) or ""))

    def item(self, i: int) -> dict:
        return {"name": self.n["label"][i], "type": self.sort(i), "part": self.area(i), "where": self.where(i), "url": self.url(i), "test": self.is_test(i)}

    def file_node(self, node: int) -> int:
        if self.sort(node) == "file" or not self.file(node):
            return node
        for i in range(self.count):
            if self.sort(i) == "file" and self.n["file"][i] == self.n["file"][node]:
                return i
        return node

    def line(self, i: int) -> str:
        return f"  {self.n['label'][i]:<42} {self.sort(i):<9} {self.where(i)}"


QUESTIONS = [
    (r"^(?:who|what|which)\s+(?:calls|uses|invokes|runs)\s+(.+)$", "callers"),
    (r"^(?:callers|users) of\s+(.+)$", "callers"),
    (r"^what (?:does|do)\s+(.+?)\s+(?:call|use|invoke|run)$", "callees"),
    (r"^(?:who|what|which)\s+(?:imports|depends on|needs|includes)\s+(.+)$", "users"),
    (r"^what (?:does|do)\s+(.+?)\s+(?:import|depend on|need|include)$", "deps"),
    (r"^what(?:'s| is| are)? (?:in|inside)\s+(.+)$", "members"),
    (r"^(?:where (?:is|are|do|does)|what is|show)\s+(.+?)(?: defined| declared| kept| live| lives)?$", "show"),
    (r"^(?:what )?tests? (?:for|of|cover(?:s|ing)?)\s+(.+)$", "tests"),
    (r"^(?:docs?|documentation) (?:for|about|on)\s+(.+)$", "docs"),
    (r"^how (?:does|do|is)\s+(.+?)\s+(?:connect(?:ed)? to|reach|relate to|get to)\s+(.+)$", "path"),
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Ask DSTNS's knowledge graph.", epilog="Commands: ask search show callers callees deps users members path tests docs file areas stats")
    parser.add_argument("--graph", help="graph file (default: the clone's data/graph/dstns-graph.json)")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--json", action="store_true", help="print the answer as JSON")
    parser.add_argument("command", choices=["ask", "search", "show", "callers", "callees", "deps", "users", "members", "path", "tests", "docs", "file", "areas", "stats"])
    parser.add_argument("terms", nargs="*")
    args = parser.parse_args()
    g = Graph(find_graph(args.graph))
    command, terms = args.command, list(args.terms)

    # A question in plain words becomes the command that answers it.
    if command == "ask":
        q = " ".join(terms).strip().rstrip("?.!").strip()
        for pattern, meaning in QUESTIONS:
            m = re.match(pattern, q, re.I)
            if m:
                command, terms = meaning, [x for x in m.groups() if x]
                if meaning == "path":
                    terms = [m.group(1), m.group(2)]
                break
        else:
            command, terms = "search", [q]
        if not args.json:
            print(f"Read as: {command} {' / '.join(terms)}")

    text = " ".join(terms)

    def emit(heading: str, nodes: list[int], extra: dict | None = None) -> int:
        if args.json:
            print(json.dumps({"answer": heading, **(extra or {}), "found": [g.item(i) for i in nodes]}, indent=1))
        else:
            print(heading)
            for i in nodes:
                print(g.line(i) + ("   [test]" if g.is_test(i) else ""))
        return 0

    if command == "stats":
        info = {"nodes": g.count, "edges": len(g.edges), "communities": len(g.d["communities"]), "repo": g.d["repo"], "commit": g.d["commit"]}
        print(json.dumps(info, indent=1) if args.json else f"{g.count} nodes, {len(g.edges)} edges, {len(g.d['communities'])} communities, built from {g.d['repo']} at {g.d['commit'][:10]}")
        return 0
    if command == "areas":
        counts: dict[str, int] = {}
        for i in range(g.count):
            counts[g.area(i)] = counts.get(g.area(i), 0) + 1
        rows = sorted(counts.items(), key=lambda kv: -kv[1])
        if args.json:
            print(json.dumps([{"part": k, "items": v, "is": PART_NAMES.get(k, "")} for k, v in rows], indent=1))
        else:
            for k, v in rows:
                print(f"  {k:<10} {v:>6}  {PART_NAMES.get(k, '')}")
        return 0
    if command == "search":
        tokens = text.lower().split()
        sorts = [SORT_WORDS[w] for w in tokens if w in SORT_WORDS]
        areas = [AREA_WORDS[tokens[i + 1]] for i, w in enumerate(tokens[:-1]) if w in ("in", "inside") and tokens[i + 1] in AREA_WORDS]
        areas += [AREA_WORDS[tokens[i + 2]] for i, w in enumerate(tokens[:-2]) if w in ("in", "inside") and tokens[i + 1] == "the" and tokens[i + 2] in AREA_WORDS]
        left = [w for t in tokens if t not in STOP and t not in SORT_WORDS and AREA_WORDS.get(t) not in areas for w in words(t)]
        found = [node for _, node in g.rank(left, sorts, areas, limit=args.limit)]
        return emit(f"{len(found)} found" + (f" ({', '.join(sorts)})" if sorts else "") + (f" in {', '.join(areas)}" if areas else ""), found)
    if command == "file":
        wanted = text.strip().lower()
        nodes = [i for i in range(g.count) if g.file(i) and (g.file(i).lower() == wanted or g.file(i).lower().endswith("/" + wanted) or g.file(i).lower().endswith(wanted))]
        nodes.sort(key=lambda i: (g.file(i), g.n["line"][i] or 0))
        if not nodes:
            print(f"No file in the graph matches {text!r}.")
            return 1
        return emit(f"{len({g.file(i) for i in nodes})} file(s), {len(nodes)} items", nodes[: args.limit * 5])
    if command == "path":
        if len(terms) < 2:
            print("path needs two names: path FROM TO")
            return 1
        a, b = g.subject(terms[0]), g.subject(" ".join(terms[1:]))
        if a < 0 or b < 0:
            print("One of them is not in the graph.")
            return 1
        before = {a: None}
        queue = deque([a])
        while queue and b not in before:
            v = queue.popleft()
            for k in g.adj[v]:
                s0, t, _ = g.edges[k]
                o = t if s0 == v else s0
                if o not in before:
                    before[o] = (v, k)
                    queue.append(o)
        if b not in before:
            print("They are not connected.")
            return 1
        steps, v = [], b
        while before[v]:
            p0, k = before[v]
            steps.append((p0, g.edges[k][2], v))
            v = p0
        steps.reverse()
        if args.json:
            print(json.dumps({"from": g.item(a), "to": g.item(b), "steps": [{"from": g.n["label"][p0], "relation": rel, "to": g.item(v)} for p0, rel, v in steps]}, indent=1))
        else:
            for p0, rel, v in steps:
                print(f"  {g.n['label'][p0]} --{rel}--> {g.n['label'][v]}   ({g.where(v)})")
        return 0
    if command in ("tests", "docs"):
        node = g.subject(text)
        if node < 0:
            print(f"Nothing in the graph is called {text!r}.")
            return 1
        # Within two steps, the tests (or the documentation) linked to it, nearest first.
        seen, frontier, found = {node}, [node], []
        for _ in range(2):
            nxt = []
            for v in frontier:
                for k in g.adj[v]:
                    s0, t, _ = g.edges[k]
                    o = t if s0 == v else s0
                    if o in seen:
                        continue
                    seen.add(o)
                    nxt.append(o)
                    if (command == "tests" and g.is_test(o)) or (command == "docs" and g.area(o) == "docs"):
                        found.append(o)
            frontier = nxt
        if command == "docs" and not found:
            found = [i for _, i in g.rank(words(text), areas=["docs"], limit=args.limit)]
        return emit(f"{command} for {g.n['label'][node]} ({g.where(node)}): {len(found)}", found[: args.limit])
    wanted = {"callers": ("calls", "in"), "callees": ("calls", "out"), "deps": ("imports", "out"), "users": ("imports", "in"), "members": ("contains", "out")}
    if command in wanted:
        group, direction = wanted[command]
        node = g.subject(text, group, direction)
        if node < 0:
            print(f"Nothing in the graph is called {text!r}.")
            return 1
        found = sorted(g.around(node, group, direction), key=lambda i: (g.is_test(i), g.file(i), g.n["line"][i] or 0))
        return emit(f"{command} of {g.n['label'][node]} ({g.where(node)}): {len(found)}", found[: args.limit * 3], {"subject": g.item(node)})
    node = g.subject(text)
    if node < 0:
        print(f"Nothing in the graph is called {text!r}.")
        return 1
    if args.json:
        links = {}
        for group in GROUPS:
            for direction in ("out", "in"):
                items = g.around(node, group, direction)
                if items:
                    links[group + ("" if direction == "out" else " (from)")] = sorted(g.n["label"][i] for i in items)
        print(json.dumps({**g.item(node), "connections": g.n["degree"][node], "links": links}, indent=1))
        return 0
    print(f"{g.n['label'][node]}  ({g.sort(node)}, {g.area(node)})")
    print(f"  source: {g.where(node)}  {g.url(node)}")
    print(f"  connections: {g.n['degree'][node]}")
    for group in GROUPS:
        for direction, name in (("out", group), ("in", f"{group} (from)")):
            items = g.around(node, group, direction)
            if items:
                print(f"  {name}: " + ", ".join(sorted(g.n["label"][i] for i in items)[:12]) + (" …" if len(items) > 12 else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
