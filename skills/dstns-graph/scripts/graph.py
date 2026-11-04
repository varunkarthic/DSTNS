#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Ask DSTNS's knowledge graph: where something is, what it holds, what it calls and what calls it.

    python3 graph.py search "functions in the launcher that save settings"
    python3 graph.py show SimulationEngine
    python3 graph.py callers physics_step        callees capsuleFrame
    python3 graph.py deps next_world.cpp         users motion.ts
    python3 graph.py members SimulationEngine    path SeekFilm SimulationEngine
    python3 graph.py stats

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

ONLINE = "https://dstns.readthedocs.io/en/latest/graph/data.json"
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
        found = self.rank(words(text), limit=8)
        if not found:
            # A name not in the graph as written: its rarest word stands for it.
            for w in sorted((w for w in words(text) if w not in STOP), key=lambda w: len(self.index.get(stem(w), {}) or [0] * self.count)):
                found = self.rank([w], limit=8)
                if found:
                    break
        candidates = [node for _, node in found]
        if group == "imports":
            candidates = [self.file_node(c) for c in candidates]
        if group:
            for c in candidates:
                if self.around(c, group, direction):
                    return c
        return candidates[0] if candidates else -1

    def file_node(self, node: int) -> int:
        if self.sort(node) == "file" or not self.file(node):
            return node
        for i in range(self.count):
            if self.sort(i) == "file" and self.n["file"][i] == self.n["file"][node]:
                return i
        return node

    def line(self, i: int) -> str:
        return f"  {self.n['label'][i]:<42} {self.sort(i):<9} {self.where(i)}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Ask DSTNS's knowledge graph.")
    parser.add_argument("--graph", help="graph file (default: the clone's data/graph/dstns-graph.json)")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("command", choices=["search", "show", "callers", "callees", "deps", "users", "members", "path", "stats"])
    parser.add_argument("terms", nargs="*")
    args = parser.parse_args()
    g = Graph(find_graph(args.graph))
    text = " ".join(args.terms)

    if args.command == "stats":
        print(f"{g.count} nodes, {len(g.edges)} edges, {len(g.d['communities'])} communities, built from {g.d['repo']} at {g.d['commit'][:10]}")
        return 0
    if args.command == "search":
        tokens = text.lower().split()
        sorts = [SORT_WORDS[w] for w in tokens if w in SORT_WORDS]
        areas = [AREA_WORDS[tokens[i + 1]] for i, w in enumerate(tokens[:-1]) if w in ("in", "inside") and tokens[i + 1] in AREA_WORDS]
        areas += [AREA_WORDS[tokens[i + 2]] for i, w in enumerate(tokens[:-2]) if w in ("in", "inside") and tokens[i + 1] == "the" and tokens[i + 2] in AREA_WORDS]
        left = [w for t in tokens if t not in STOP and t not in SORT_WORDS and AREA_WORDS.get(t) not in areas for w in words(t)]
        found = g.rank(left, sorts, areas, limit=args.limit)
        print(f"{len(found)} found" + (f" ({', '.join(sorts)})" if sorts else "") + (f" in {', '.join(areas)}" if areas else ""))
        for _, node in found:
            print(g.line(node))
        return 0
    if args.command == "path":
        a, b = g.subject(args.terms[0]), g.subject(" ".join(args.terms[1:]))
        if a < 0 or b < 0:
            print("One of them is not in the graph.")
            return 1
        before = {a: None}
        queue = deque([a])
        while queue and b not in before:
            v = queue.popleft()
            for k in g.adj[v]:
                s, t, _ = g.edges[k]
                o = t if s == v else s
                if o not in before:
                    before[o] = (v, k)
                    queue.append(o)
        if b not in before:
            print("They are not connected.")
            return 1
        steps, v = [], b
        while before[v]:
            p, k = before[v]
            steps.append((p, g.edges[k][2], v))
            v = p
        for p, rel, v in reversed(steps):
            print(f"  {g.n['label'][p]} --{rel}--> {g.n['label'][v]}   ({g.where(v)})")
        return 0
    wanted = {"callers": ("calls", "in"), "callees": ("calls", "out"), "deps": ("imports", "out"), "users": ("imports", "in"), "members": ("contains", "out")}
    if args.command in wanted:
        group, direction = wanted[args.command]
        node = g.subject(text, group, direction)
        if node < 0:
            print(f"Nothing in the graph is called {text!r}.")
            return 1
        found = sorted(g.around(node, group, direction), key=lambda i: (g.file(i), g.n["line"][i]))
        print(f"{args.command} of {g.n['label'][node]} ({g.where(node)}): {len(found)}")
        for i in found[: args.limit * 3]:
            print(g.line(i))
        return 0
    node = g.subject(text)
    if node < 0:
        print(f"Nothing in the graph is called {text!r}.")
        return 1
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
