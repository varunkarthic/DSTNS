# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Build the knowledge graph the documentation's Graph page draws.

Every build reads the repository as Git tracks it with graphify (AST extraction: no model, no key, the same graph for
the same files), lays the graph out here, communities first and then each community's own nodes, and writes one
compact file, graph/data.json, beside the page. The page draws positions it is given, so it has nothing to work out
when it opens, and keeps the file in the browser's cache under the build's version.

Read the Docs and CI install graphify from docs/requirements.txt, and a build there that cannot make the graph fails.
Elsewhere a build without graphify uses the copy kept in the repository, data/graph/dstns-graph.json, which the
Knowledge graph workflow keeps current and a clone therefore has. `mkdocs serve` builds the graph once for
the files as they are, and again only when they change.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from mkdocs.config.defaults import MkDocsConfig
except ImportError:  # run as a script, to write the repository's copy
    MkDocsConfig = dict  # type: ignore[misc,assignment]

log = logging.getLogger("mkdocs.hooks.graph")

REPO = "varunkarthic/DSTNS"
# The parts of DSTNS a node can belong to, by the folder its file is in. Anything else is "Other".
AREAS = ["Core", "Fabric", "Daemon", "LaunchKit", "WebKit", "docs", "tests", "tools", "config", "scripts", "docker"]
_cache: dict[str, dict] = {}


def _required() -> bool:
    return bool(os.environ.get("READTHEDOCS")) or bool(os.environ.get("CI")) or os.environ.get("DSTNS_DOCS_GRAPH") == "required"


def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


def _graphify() -> list[str] | None:
    found = shutil.which("graphify")
    if found:
        return [found]
    try:
        import graphify  # noqa: F401

        return [sys.executable, "-m", "graphify"]
    except ImportError:
        return None


# ---- layout ------------------------------------------------------------------------------------------------------


def _forces(n: int, edges: list[tuple[int, int, float]], seed: int, iterations: int, gravity: float = 0.0):
    """Fruchterman-Reingold on a unit square: neighbours pull, everything pushes, and gravity keeps what nothing holds
    from drifting off. Dense, so for a few hundred nodes."""
    import numpy as np

    rng = np.random.RandomState(seed)
    pos = rng.rand(n, 2)
    if n == 1:
        return pos * 0
    k = 1 / math.sqrt(n)
    s = np.array([a for a, _, _ in edges], dtype=int)
    t = np.array([b for _, b, _ in edges], dtype=int)
    w = np.array([c for _, _, c in edges], dtype=float)
    heat = 0.12
    for _ in range(iterations):
        delta = pos[:, None, :] - pos[None, :, :]
        dist = np.maximum(np.sqrt((delta**2).sum(-1)), 1e-3)
        move = ((k * k / dist**2)[:, :, None] * delta).sum(1)
        if len(s):
            d = pos[s] - pos[t]
            length = np.maximum(np.sqrt((d**2).sum(-1)), 1e-3)
            pull = (length / k * w)[:, None] * d
            np.add.at(move, s, -pull)
            np.add.at(move, t, pull)
        if gravity:
            move -= (pos - 0.5) * gravity
        size = np.maximum(np.sqrt((move**2).sum(-1)), 1e-9)
        pos += move / size[:, None] * np.minimum(size, heat)[:, None]
        heat *= 0.985
    pos -= pos.mean(0)
    return pos


def _layout(nodes: list[dict], links: list[tuple[int, int]]):
    """Each node's x and y: communities placed by how much they share, each a disc sized by its nodes, then laid out."""
    import numpy as np

    by: dict[int, list[int]] = {}
    for i, node in enumerate(nodes):
        by.setdefault(node["community"], []).append(i)
    communities = sorted(by)
    index = {c: k for k, c in enumerate(communities)}
    shared: dict[tuple[int, int], float] = {}
    inside: dict[int, list[tuple[int, int]]] = {}
    for a, b in links:
        ca, cb = nodes[a]["community"], nodes[b]["community"]
        if ca == cb:
            inside.setdefault(ca, []).append((a, b))
        else:
            key = (min(index[ca], index[cb]), max(index[ca], index[cb]))
            shared[key] = shared.get(key, 0) + 1
    radius = np.array([6 * math.sqrt(len(by[c])) + 6 for c in communities])
    strongest = max(shared.values(), default=1)
    centre = _forces(len(communities), [(a, b, 0.2 + 0.8 * v / strongest) for (a, b), v in shared.items()], 7, 400, gravity=0.6) * 60 * math.sqrt(len(communities))
    # Discs that overlap push apart until none do: the map reads as islands.
    for _ in range(240):
        delta = centre[:, None, :] - centre[None, :, :]
        dist = np.maximum(np.sqrt((delta**2).sum(-1)), 1e-6)
        gap = radius[:, None] + radius[None, :] + 10 - dist
        np.fill_diagonal(gap, 0)
        push = np.where(gap > 0, gap / 2, 0)
        if not push.any():
            break
        centre += ((push / dist)[:, :, None] * delta).sum(1) * 0.5
    xy = np.zeros((len(nodes), 2))
    for c in communities:
        members = by[c]
        local = {m: k for k, m in enumerate(members)}
        pos = _forces(len(members), [(local[a], local[b], 1.0) for a, b in inside.get(c, [])], 11 + c, 160)
        extent = max(np.abs(pos).max(), 1e-6)
        xy[members] = pos / extent * radius[index[c]] * 0.92 + centre[index[c]]
    return xy, {c: (centre[index[c]], radius[index[c]]) for c in communities}


# ---- the graph ---------------------------------------------------------------------------------------------------


def _area(path: str) -> str:
    head = path.split("/", 1)[0] if path else ""
    return head if head in AREAS else ("Other" if path else "Concepts")


SORTS = ["file", "class", "function", "section", "document", "concept", "other"]


def _sort(node: dict) -> str:
    """What a node is, finer than graphify's kind: the search and the filters speak of files, classes and functions."""
    path, label, kind = node.get("source_file") or "", node.get("label") or "", node.get("file_type") or ""
    if node.get("_callable_class"):
        return "class"
    if node.get("_callable"):
        return "function"
    # A file is named by its name, or, where two files share one, by as much of its path as tells them apart.
    if path and (label == path or path.endswith("/" + label)):
        return "file"
    if kind == "document":
        return "section"
    if kind in ("concept", "rationale"):
        return "concept"
    # Some languages' extractors mark nothing callable (Rust's among them): the name says it.
    if kind == "code" and label.endswith(")"):
        return "function"
    if kind == "code" and re.fullmatch(r"[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*", label):
        return "class"
    return "other"


def _compact(graph: dict, commit: str, ref: str) -> dict:
    nodes, links = graph["nodes"], graph["links"]
    index = {node["id"]: i for i, node in enumerate(nodes)}
    pairs, kept = [], []
    for link in links:
        a, b = index.get(link["source"]), index.get(link["target"])
        if a is None or b is None or a == b:
            continue
        pairs.append((a, b))
        kept.append(link)
    xy, discs = _layout(nodes, pairs)
    files = sorted({n.get("source_file") or "" for n in nodes})
    file_index = {f: i for i, f in enumerate(files)}
    kinds = sorted({n.get("file_type") or "code" for n in nodes})
    relations = sorted({link.get("relation") or "related" for link in kept})
    areas = AREAS + ["Other", "Concepts"]
    degree = [0] * len(nodes)
    for a, b in pairs:
        degree[a] += 1
        degree[b] += 1
    names: dict[int, str] = {}
    for node in nodes:
        names.setdefault(node["community"], node.get("community_name") or f"Community {node['community']}")
    line = lambda n: int(str(n.get("source_location") or "L0").lstrip("L").split("-")[0] or 0) if str(n.get("source_location") or "").startswith("L") else 0  # noqa: E731
    return {
        "version": 1,
        "repo": REPO,
        "commit": commit,
        "ref": ref,
        "files": files,
        "kinds": kinds,
        "relations": relations,
        "areas": areas,
        "sorts": SORTS,
        "communities": [{"id": c, "name": names[c], "x": round(float(centre[0]), 1), "y": round(float(centre[1]), 1), "r": round(float(r), 1)} for c, (centre, r) in sorted(discs.items())],
        "nodes": {
            "id": [n["id"] for n in nodes],
            "label": [n.get("label") or n["id"] for n in nodes],
            "file": [file_index[n.get("source_file") or ""] for n in nodes],
            "line": [line(n) for n in nodes],
            "kind": [kinds.index(n.get("file_type") or "code") for n in nodes],
            "sort": [SORTS.index(_sort(n)) for n in nodes],
            "area": [areas.index(_area(n.get("source_file") or "")) for n in nodes],
            "community": [n["community"] for n in nodes],
            "degree": degree,
            "x": [round(float(p[0]), 1) for p in xy],
            "y": [round(float(p[1]), 1) for p in xy],
        },
        # Flat: source, target, relation, three numbers an edge.
        "edges": [v for (a, b), link in zip(pairs, kept) for v in (a, b, relations.index(link.get("relation") or "related"))],
    }


def _build(root: Path) -> dict:
    command = _graphify()
    if not command:
        raise RuntimeError("graphify is not installed (pip install -r docs/requirements.txt)")
    tracked = [p for p in _git(root, "ls-files", "-z").split("\0") if p]
    key = hashlib.sha256()
    for path in tracked:
        file = root / path
        if file.is_file():
            key.update(path.encode())
            key.update(hashlib.sha256(file.read_bytes()).digest())
    digest = key.hexdigest()
    if digest in _cache:
        return _cache[digest]
    commit = os.environ.get("READTHEDOCS_GIT_COMMIT_HASH") or _git(root, "rev-parse", "HEAD").strip()
    ref = os.environ.get("READTHEDOCS_GIT_IDENTIFIER") or commit
    with tempfile.TemporaryDirectory(prefix="dstns-graph-") as scratch:
        copy = Path(scratch) / "DSTNS"
        for path in tracked:
            source = root / path
            if source.is_file() and not source.is_symlink():
                target = copy / path
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        subprocess.run([*command, "update", "."], cwd=copy, check=True, capture_output=True, text=True, timeout=900)
        graph = json.loads((copy / "graphify-out" / "graph.json").read_text())
    data = _compact(graph, commit, ref)
    data["key"] = digest[:16]
    _cache[digest] = data
    return data


def write(data: dict, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, separators=(",", ":")))


def _skill(root: Path, site: Path) -> None:
    """The Claude skill that asks this graph, as one download: skills/dstns-graph, less any graph it downloaded."""
    import zipfile

    folder = root / "skills" / "dstns-graph"
    if not folder.is_dir():
        return
    target = site / "downloads" / "dstns-graph-skill.zip"
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as bundle:
        for file in sorted(folder.rglob("*")):
            if file.is_file() and file.name != "dstns-graph.json" and "__pycache__" not in file.parts:
                bundle.write(file, Path("dstns-graph") / file.relative_to(folder))


def on_post_build(config: MkDocsConfig) -> None:
    root = Path(config["config_file_path"]).parent
    _skill(root, Path(config["site_dir"]))
    if os.environ.get("DSTNS_DOCS_GRAPH") == "off":
        return
    target = Path(config["site_dir"]) / "graph" / "data.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        data = _build(root)
    except Exception as error:  # noqa: BLE001: anything that stops the graph
        if _required():
            raise
        kept = root / "data" / "graph" / "dstns-graph.json"
        if kept.is_file():
            log.info("The knowledge graph was not built (%s); the repository's copy is used.", error)
            shutil.copy2(kept, target)
        else:
            log.info("The knowledge graph was not built (%s). Its page says so.", error)
            target.write_text(json.dumps({"version": 1, "missing": str(error)}))
        return
    write(data, target)
    log.info("Knowledge graph: %d nodes, %d edges, %d communities (%.1f MB)", len(data["nodes"]["id"]), len(data["edges"]) // 3, len(data["communities"]), target.stat().st_size / 1e6)


if __name__ == "__main__":
    # The copy kept in the repository, so a clone has the graph: python3 hooks/graph.py data/graph/dstns-graph.json
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "data/graph/dstns-graph.json")
    built = _build(Path(__file__).resolve().parent.parent)
    built.pop("key", None)
    write(built, out)
    print(f"{out}: {len(built['nodes']['id'])} nodes, {len(built['edges']) // 3} edges, {len(built['communities'])} communities")
