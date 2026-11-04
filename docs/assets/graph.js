// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The knowledge graph: every file, class, function and page of DSTNS and how they connect, as graphify read the
// repository when the documentation was built (hooks/graph.py). The positions come with the data, so the page draws at
// once; this script pans, zooms, searches in plain words, filters and explains.
(function () {
  "use strict";

  // ---- palette and words -------------------------------------------------------------------------------------------
  var COLOURS = {
    Core: "#4fd6ea", Fabric: "#a78bfa", Daemon: "#f5b942", LaunchKit: "#f87171", WebKit: "#34d399",
    docs: "#93c5fd", tests: "#94a3b8", tools: "#fb923c", config: "#e879f9", scripts: "#fbbf24", docker: "#38bdf8",
    Other: "#cbd5e1", Concepts: "#f472b6",
  };
  var AREA_NAMES = { Core: "Core engine", Fabric: "Fabric and WebFabric", Daemon: "Daemons", LaunchKit: "Launcher", WebKit: "Observer", docs: "Documentation", tests: "Tests", tools: "Tools", config: "Configuration", scripts: "Scripts", docker: "Containers", Other: "Other files", Concepts: "Concepts" };
  var SORT_NAMES = { file: "File", class: "Class", function: "Function", section: "Section", document: "Document", concept: "Concept", other: "Symbol" };
  var SORT_PLURAL = { file: "Files", class: "Classes", function: "Functions", section: "Doc sections", document: "Documents", concept: "Concepts", other: "Symbols" };
  // Which way an edge reads, and what to call each end of it.
  var GROUPS = [
    { key: "contains", out: ["contains", "defines", "method"], outName: "Contains", inName: "Inside", icon: "box" },
    { key: "calls", out: ["calls", "indirect_call"], outName: "Calls", inName: "Called by", icon: "call" },
    { key: "imports", out: ["imports", "imports_from", "dynamic_import", "re_exports"], outName: "Depends on", inName: "Used by", icon: "import" },
    { key: "inherits", out: ["inherits", "implements"], outName: "Builds on", inName: "Built on by", icon: "inherit" },
    { key: "references", out: ["references", "rationale_for"], outName: "Refers to", inName: "Referred to by", icon: "ref" },
  ];
  var OPERATORS = ["in:", "type:", "file:", "community:", "rel:"];

  // Plain-language search, in the page: no model, no server. Words are split as code names are (camelCase, snake_case,
  // paths), lightly stemmed, widened by a thesaurus of DSTNS's own terms, matched with a little tolerance for typos, and
  // ranked by how rare and where they are. A few question shapes are understood as relations.
  var STOP = new Set("a an the of in on at to for from by with and or is are was were be been being does do did how what where which who whom whose that this these those it its into about show find me list all any get give tell please there their them they my our your i we you can could should would will just".split(" "));
  var THESAURUS = {
    seek: ["jump", "rewind", "skip", "seekby", "seekto"], jump: ["seek"], rewind: ["seek"], skip: ["seek"],
    map: ["osm", "topology", "network", "road", "edge"], road: ["edge", "street", "lane"], street: ["road", "edge"],
    weather: ["rain", "storm", "flood", "dws", "wendland"], rain: ["weather", "storm"], flood: ["weather", "drain"],
    signal: ["phase", "green", "light", "cycle"], light: ["signal"], traffic: ["congestion", "queue", "vehicle"],
    incident: ["accident", "closure", "crash"], accident: ["incident"], crash: ["incident"],
    launcher: ["cli", "tui", "console", "launchkit", "shell"], cli: ["launcher", "console"], terminal: ["tui", "launcher"],
    observer: ["ui", "webkit", "frontend", "browser", "app"], ui: ["observer", "interface"], frontend: ["observer"],
    fabric: ["api", "route", "endpoint", "http"], api: ["fabric", "route", "endpoint"], endpoint: ["route", "api"],
    daemon: ["watcher", "rcs", "queue"], watcher: ["daemon"], alert: ["daemon", "notification"],
    test: ["spec", "check", "expect"], setting: ["config", "option", "preference"], config: ["setting", "option"],
    security: ["auth", "token", "hmac", "signature", "verify"], auth: ["security", "token"], token: ["auth", "security"],
    report: ["pdf", "export"], export: ["report", "sumo"], film: ["boot", "particle", "scene", "animation"],
    boot: ["film", "start", "splash", "fastboot"], animation: ["motion", "spring", "film"], spring: ["motion"],
    seed: ["rng", "random", "philox"], random: ["rng", "seed"], route: ["path", "astar", "dijkstra"], path: ["route"],
    world: ["scenario", "seed", "regenerate"], regenerate: ["world", "regen"], news: ["narration", "narrator"],
    notification: ["capsule", "alert", "news"], panel: ["deck", "drawer", "fluid"], search: ["find", "query"],
    graph: ["node", "edge", "knowledge"], camera: ["view", "focus", "zoom"], zoom: ["camera", "scale"],
  };
  var AREA_WORDS = { core: "Core", engine: "Core", simulation: "Core", fabric: "Fabric", webfabric: "Fabric", api: "Fabric", daemon: "Daemon", daemons: "Daemon", launcher: "LaunchKit", launchkit: "LaunchKit", cli: "LaunchKit", observer: "WebKit", webkit: "WebKit", ui: "WebKit", frontend: "WebKit", docs: "docs", documentation: "docs", tests: "tests", test: "tests", tools: "tools", config: "config", configuration: "config" };
  var SORT_WORDS = { function: "function", functions: "function", method: "function", methods: "function", class: "class", classes: "class", struct: "class", structs: "class", type: "class", types: "class", file: "file", files: "file", module: "file", modules: "file", source: "file", sources: "file", doc: "section", docs: "section", page: "section", pages: "section", section: "section", sections: "section", guide: "section", concept: "concept", concepts: "concept" };

  function stem(w) {
    if (w.length > 5 && /ies$/.test(w)) return w.slice(0, -3) + "y";
    if (w.length > 5 && /(ing|ed)$/.test(w)) return w.replace(/(ing|ed)$/, "");
    if (w.length > 4 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
    return w;
  }
  function words(text) {
    return String(text)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }
  function distance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    var prev = [], cur;
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    var before = null;
    for (var i = 1; i <= a.length; i++) {
      cur = [i];
      var best = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], before[j - 2] + 1);
        best = Math.min(best, cur[j]);
      }
      if (best > limit) return limit + 1;
      before = prev;
      prev = cur;
    }
    return prev[b.length];
  }

  // ---- small helpers -----------------------------------------------------------------------------------------------
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    }
    (children || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  var PATHS = {
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
    github: '<path d="M9 19c-4 1.3-4-2-6-2.5M15 21v-3.4a3 3 0 0 0-.8-2.3c2.8-.3 5.8-1.4 5.8-6.3a4.9 4.9 0 0 0-1.3-3.4 4.6 4.6 0 0 0-.1-3.4s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.4 5.4 2.7 5.4 2.7a4.6 4.6 0 0 0-.1 3.4A4.9 4.9 0 0 0 4 9.5c0 4.9 3 6 5.8 6.3a3 3 0 0 0-.8 2.2V21"/>',
    filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>', link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    class: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
    function: '<path d="M9 20c2 0 2.5-2 3-5l1.2-6c.5-2.5 1.2-4 3.3-4M8 11h7"/>',
    section: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M9 9h6M9 13h6"/>',
    document: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/>',
    concept: '<circle cx="12" cy="10" r="5"/><path d="M10 17h4M10.5 20h3"/>',
    other: '<path d="M8 7l-4 5 4 5M16 7l4 5-4 5"/>',
    box: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
    call: '<path d="M5 12h12M13 7l5 5-5 5"/>', import: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
    inherit: '<path d="M6 4v8a4 4 0 0 0 4 4h8M14 12l4 4-4 4"/>', ref: '<path d="M7 7h10v10H7z" /><path d="M10 10h4M10 14h4"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  };
  function icon(name, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) + '" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (PATHS[name] || "") + "</svg>";
  }

  function start(root) {
    if (!root || root.dataset.ready) return;
    root.dataset.ready = "1";
    var status = root.querySelector(".dg-status");
    fetch(root.dataset.src || "data.json", { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        if (data.missing) throw new Error("This build has no graph: " + data.missing + ".");
        status.remove();
        view(root, data);
      })
      .catch(function (error) { status.textContent = "The graph could not be loaded. " + error.message; status.classList.add("dg-error"); });
  }

  function view(root, data) {
    var N = data.nodes, count = N.id.length, E = data.edges, edgeCount = E.length / 3;
    var sorts = data.sorts || ["other"];
    var areaOf = function (i) { return data.areas[N.area[i]]; };
    var sortOf = function (i) { return N.sort ? sorts[N.sort[i]] : "other"; };
    var fileOf = function (i) { return data.files[N.file[i]] || ""; };
    var colourOf = function (i) { return COLOURS[areaOf(i)] || "#cbd5e1"; };
    var commName = {}; data.communities.forEach(function (c) { commName[c.id] = c.name; });
    var adjacency = new Array(count);
    for (var a = 0; a < count; a++) adjacency[a] = [];
    for (var e = 0; e < edgeCount; e++) { adjacency[E[e * 3]].push(e); adjacency[E[e * 3 + 1]].push(e); }

    // ---- the search index: each word once, and where it is ----
    var index = new Map(), prefix = new Map();
    function add(token, node, weight) {
      var t = stem(token), list = index.get(t);
      if (!list) { list = new Map(); index.set(t, list); var p = t.slice(0, 2); if (!prefix.has(p)) prefix.set(p, []); prefix.get(p).push(t); }
      list.set(node, Math.max(list.get(node) || 0, weight));
    }
    var lower = new Array(count);
    for (var n0 = 0; n0 < count; n0++) {
      lower[n0] = N.label[n0].toLowerCase();
      words(N.label[n0]).forEach(function (w) { add(w, n0, 3); });
      add(lower[n0].replace(/[^a-z0-9]/g, ""), n0, 3.5);
      words(fileOf(n0)).forEach(function (w) { add(w, n0, 1.1); });
      words(commName[N.community[n0]] || "").forEach(function (w) { add(w, n0, 0.7); });
    }
    var idf = function (t) { var list = index.get(t); return list ? Math.log(1 + count / list.size) : 0; };
    function expand(word) {
      var t = stem(word), out = [[t, 1]];
      var related = THESAURUS[t] || THESAURUS[word] || [];
      related.forEach(function (s) { out.push([stem(s), 0.8]); });
      if (t.length >= 4) {
        var candidates = prefix.get(t.slice(0, 2)) || [];
        // A word that starts one in the index: "regen" finds "regenerate".
        candidates.forEach(function (c) { if (c !== t && c.indexOf(t) === 0) out.push([c, 0.7]); });
        // A typo: only for a word that is neither in the index nor in the thesaurus, and less than either.
        if (!index.has(t) && !related.length) {
          var limit = t.length >= 8 ? 2 : 1, near = 0;
          candidates.concat(prefix.get(t[0] + (t[2] || "")) || []).forEach(function (c) { if (near < 6 && distance(t, c, limit) <= limit) { out.push([c, 0.45]); near++; } });
        }
      }
      return out;
    }
    /** What a question means: words, and what it asks for (a kind, a part, a relation round a subject). */
    function understand(text) {
      var q = { words: [], in: [], sort: [], file: [], community: [], rel: [], relation: null };
      var rest = text.replace(/(\w+):("[^"]*"|\S+)/g, function (all, op, v) {
        v = v.replace(/^"|"$/g, "").toLowerCase();
        op = op.toLowerCase();
        if (op === "type" || op === "kind") q.sort.push(SORT_WORDS[v] || v);
        else if (q[op] && op !== "words") q[op].push(v);
        else return all;
        return " ";
      });
      // Matched without regard to case, but the subject keeps its own, so seekBy still splits into seek and by.
      var original = rest.replace(/[?.!]+$/, "").trim(), s = original.toLowerCase(), m;
      var keep = function (found) { return found ? original.substr(s.lastIndexOf(found), found.length) : found; };
      if ((m = /^(?:who|what|which(?: \w+)?)?\s*(?:calls|uses|invokes)\s+(.+)$/.exec(s)) || (m = /^(?:callers|users) of\s+(.+)$/.exec(s))) q.relation = { dir: "in", group: "calls", subject: m[1] };
      else if ((m = /^what (?:does|do)\s+(.+?)\s+(?:call|use|invoke)$/.exec(s)) || (m = /^callees of\s+(.+)$/.exec(s))) q.relation = { dir: "out", group: "calls", subject: m[1] };
      else if ((m = /^(?:who|what|which(?: \w+)?)?\s*(?:imports|depends on|needs|includes)\s+(.+)$/.exec(s)) || (m = /^(?:dependents|importers) of\s+(.+)$/.exec(s))) q.relation = { dir: "in", group: "imports", subject: m[1] };
      else if ((m = /^what (?:does|do)\s+(.+?)\s+(?:import|depend on|need|include)$/.exec(s)) || (m = /^(?:dependencies|imports) of\s+(.+)$/.exec(s))) q.relation = { dir: "out", group: "imports", subject: m[1] };
      else if ((m = /^what(?:'s| is)? (?:in|inside)\s+(.+)$/.exec(s)) || (m = /^(?:contents|members) of\s+(.+)$/.exec(s))) q.relation = { dir: "out", group: "contains", subject: m[1] };
      else if ((m = /^where (?:is|are)\s+(.+?)(?: defined| declared)?$/.exec(s))) s = m[1];
      if (q.relation) { q.relation.subject = keep(q.relation.subject); s = ""; }
      var tokens = s.split(/\s+/).filter(Boolean);
      for (var i = 0; i < tokens.length; i++) {
        var w = tokens[i];
        if ((w === "in" || w === "inside" || w === "from") && AREA_WORDS[tokens[i + 1]]) { q.in.push(AREA_WORDS[tokens[i + 1]].toLowerCase()); i++; continue; }
        if (w === "the" && AREA_WORDS[tokens[i + 1]] && (tokens[i - 1] === "in" || tokens[i - 1] === "inside")) continue;
        if (SORT_WORDS[w] && tokens.length > 1) { q.sort.push(SORT_WORDS[w]); continue; }
        if (STOP.has(w)) continue;
        q.words = q.words.concat(words(w));
      }
      // "in the launcher": the article was kept as a stop word above; read the part after it too.
      for (var j = 0; j < tokens.length - 2; j++) if ((tokens[j] === "in" || tokens[j] === "inside") && tokens[j + 1] === "the" && AREA_WORDS[tokens[j + 2]]) {
        var area = AREA_WORDS[tokens[j + 2]].toLowerCase();
        if (q.in.indexOf(area) < 0) q.in.push(area);
        q.words = q.words.filter(function (x) { return x !== tokens[j + 2]; });
      }
      return q;
    }
    function passes(i, q) {
      if (!shownNode[i]) return false;
      if (q.in.length && !q.in.some(function (v) { return areaOf(i).toLowerCase().indexOf(v) === 0 || (AREA_NAMES[areaOf(i)] || "").toLowerCase().indexOf(v) >= 0; })) return false;
      if (q.sort.length && q.sort.indexOf(sortOf(i)) < 0) return false;
      if (q.file.length && !q.file.every(function (v) { return fileOf(i).toLowerCase().indexOf(v) >= 0; })) return false;
      if (q.community.length && !q.community.every(function (v) { return (commName[N.community[i]] || "").toLowerCase().indexOf(v) >= 0; })) return false;
      if (q.rel.length && !adjacency[i].some(function (k) { return q.rel.some(function (v) { return data.relations[E[k * 3 + 2]].indexOf(v) === 0; }); })) return false;
      return true;
    }
    function rank(q, among, limit) {
      var score = new Map();
      if (!q.words.length) {
        (among ? Array.from(among) : Array.from({ length: count }, function (_, i) { return i; })).forEach(function (i) { if (passes(i, q)) score.set(i, 1 + Math.log(1 + N.degree[i])); });
      } else {
        // Short queries need every word; a sentence needs most of them, and more is better.
        var need = q.words.length <= 2 ? q.words.length : Math.ceil(q.words.length * 0.6), covered = new Map();
        q.words.forEach(function (word) {
          var got = new Map();
          expand(word).forEach(function (pair) {
            var list = index.get(pair[0]); if (!list) return;
            var weight = idf(pair[0]) * pair[1];
            list.forEach(function (field, node) { got.set(node, Math.max(got.get(node) || 0, field * weight)); });
          });
          got.forEach(function (v, node) { score.set(node, (score.get(node) || 0) + v); covered.set(node, (covered.get(node) || 0) + 1); });
        });
        score.forEach(function (v, node) { var c = covered.get(node); if (c < need) score.delete(node); else score.set(node, v * (c / q.words.length)); });
        var whole = q.words.join("");
        score.forEach(function (v, node) {
          if (!passes(node, q) || (among && !among.has(node))) { score.delete(node); return; }
          var flat = lower[node].replace(/[^a-z0-9]/g, "");
          score.set(node, v + (flat === whole ? 30 : flat.indexOf(whole) === 0 ? 12 : 0) + Math.log(1 + N.degree[node]) * 0.4);
        });
      }
      var out = [];
      score.forEach(function (v, node) { out.push([v, node]); });
      out.sort(function (x, y) { return y[0] - x[0]; });
      return limit ? out.slice(0, limit) : out;
    }
    /** The best node for a name: the subject of a question about relations. What depends on what is said of files,
     * so a class or function asked about there stands for the file it is in. */
    function subjectOf(text, group, dir) {
      var blank = function (w) { return { words: w, in: [], sort: [], file: [], community: [], rel: [] }; };
      var found = rank(blank(words(text)), null, 8);
      // A name not in the graph as written: its most telling word, the rarest, stands for it.
      if (!found.length) words(text).filter(function (w) { return !STOP.has(w); }).sort(function (x, y) { return idf(stem(y)) - idf(stem(x)); }).some(function (w) { found = rank(blank([w]), null, 8); return found.length; });
      var stand = function (node) {
        if (group === "imports" && sortOf(node) !== "file" && fileOf(node)) for (var i = 0; i < count; i++) if (sortOf(i) === "file" && N.file[i] === N.file[node]) return i;
        return node;
      };
      // Of the likely ones, the first the question has an answer for.
      for (var k = 0; k < found.length; k++) { var node = stand(found[k][1]); if (around(node, group, dir).size) return node; }
      return found.length ? stand(found[0][1]) : -1;
    }
    function around(node, group, dir) {
      var g = GROUPS.find(function (x) { return x.key === group; }), set = new Set();
      adjacency[node].forEach(function (k) {
        if (g.out.indexOf(data.relations[E[k * 3 + 2]]) < 0) return;
        if (dir === "out" && E[k * 3] === node) set.add(E[k * 3 + 1]);
        if (dir === "in" && E[k * 3 + 1] === node) set.add(E[k * 3]);
      });
      return set;
    }

    // ---- state ----
    var state = { areas: new Set(data.areas), sorts: new Set(sorts), relations: new Set(data.relations), folder: "", minDegree: 0, labels: true, curves: true, onlyMatches: false, selected: -1, hover: -1, depth: 1 };
    var shownNode = new Uint8Array(count), shownEdge = new Uint8Array(edgeCount), near = new Uint8Array(count), matched = new Uint8Array(count), matching = false;

    // ---- the page ----
    var canvas = el("canvas", { class: "dg-canvas", "aria-label": "The knowledge graph. Use the search to find a node.", role: "img" });
    var input = el("input", { class: "dg-search-input", type: "search", placeholder: "Ask or search: who calls seek, functions in the launcher, NextWorld…", "aria-label": "Search the graph in plain words", autocomplete: "off", spellcheck: "false" });
    var results = el("div", { class: "dg-results", hidden: true });
    var hints = el("div", { class: "dg-hints" }, OPERATORS.map(function (op) {
      return el("button", { type: "button", class: "dg-hint", text: op, onclick: function () { input.value = (input.value.trim() + " " + op).trim(); input.focus(); search(); } });
    }));
    var brand = el("div", { class: "dg-brand" }, [el("div", { class: "dg-title" }, [el("strong", { text: "Knowledge graph" }), el("span", { class: "dg-counts", text: count.toLocaleString() + " nodes · " + edgeCount.toLocaleString() + " edges · " + data.communities.length + " communities" })])]);
    var repo = el("a", { class: "dg-button dg-repo", href: "https://github.com/" + data.repo + "/tree/" + data.commit, target: "_blank", rel: "noopener", title: "The source this graph was built from", html: icon("github") + "<span>" + data.repo + "</span><code>" + data.commit.slice(0, 7) + "</code>" });
    var filterButton = el("button", { class: "dg-button", type: "button", "aria-expanded": "true", "aria-controls": "dg-filters", html: icon("filter") + "<span>Filters</span>" });
    var skill = el("a", { class: "dg-button dg-skill", href: "../downloads/dstns-graph-skill.zip", download: "dstns-graph-skill.zip", title: "A Claude skill that asks this graph: where things are, what calls what, what depends on what", html: icon("import") + "<span>Claude skill</span>" });
    var searchBox = el("div", { class: "dg-search" }, [el("span", { class: "dg-search-icon", html: icon("search") }), input, results]);
    var top = el("div", { class: "dg-top" }, [brand, searchBox, hints, el("div", { class: "dg-top-actions" }, [filterButton, skill, repo])]);
    var filters = el("aside", { class: "dg-panel dg-filters", id: "dg-filters", "aria-label": "Filters" });
    var details = el("aside", { class: "dg-panel dg-details", "aria-label": "Selected node", hidden: true });
    var zoomIn = el("button", { class: "dg-icon", type: "button", "aria-label": "Zoom in", html: icon("plus") }), zoomOut = el("button", { class: "dg-icon", type: "button", "aria-label": "Zoom out", html: icon("minus") }), fitButton = el("button", { class: "dg-icon", type: "button", "aria-label": "Show everything", html: icon("fit") });
    var controls = el("div", { class: "dg-controls" }, [zoomIn, zoomOut, fitButton]);
    var tip = el("div", { class: "dg-tip", hidden: true });
    root.append(canvas, top, filters, details, controls, tip);

    // ---- filters ----
    function tally(list, of) { var c = {}; list.forEach(function (v) { c[v] = 0; }); for (var i = 0; i < count; i++) c[of(i)] = (c[of(i)] || 0) + 1; return c; }
    var areaCount = tally(data.areas, areaOf), sortCount = tally(sorts, sortOf);
    var relCount = {}; data.relations.forEach(function (r) { relCount[r] = 0; }); for (e = 0; e < edgeCount; e++) relCount[data.relations[E[e * 3 + 2]]]++;
    var boxes = [];
    function group(title, list, set, label, n, mark) {
      var box = el("fieldset", { class: "dg-group" }, [el("legend", {}, [el("span", { text: title }), el("button", { type: "button", class: "dg-all", text: "All", onclick: function () { var on = set.size !== list.length; list.forEach(function (v) { if (on) set.add(v); else set.delete(v); }); sync(); refilter(); } })])]);
      list.forEach(function (v) {
        if (!n[v]) return;
        var check = el("input", { type: "checkbox", checked: set.has(v) });
        check.addEventListener("change", function () { if (check.checked) set.add(v); else set.delete(v); refilter(); });
        boxes.push({ check: check, set: set, value: v });
        box.appendChild(el("label", { class: "dg-option" }, [check, mark ? mark(v) : null, el("span", { text: label(v) }), el("small", { text: n[v].toLocaleString() })]));
      });
      return box;
    }
    function sync() { boxes.forEach(function (b) { b.check.checked = b.set.has(b.value); }); }
    var swatch = function (v) { return el("i", { class: "dg-swatch", style: "--c:" + (COLOURS[v] || "#cbd5e1") }); };
    var sortMark = function (v) { return el("span", { class: "dg-kind-icon plain", html: icon(v, 14) }); };
    var PRESETS = [
      { name: "Everything", apply: function () { state.areas = new Set(data.areas); state.sorts = new Set(sorts); } },
      { name: "Code", apply: function () { state.areas = new Set(data.areas.filter(function (x) { return x !== "docs" && x !== "Concepts"; })); state.sorts = new Set(["file", "class", "function"]); } },
      { name: "Docs", apply: function () { state.areas = new Set(["docs", "Concepts", "Other"]); state.sorts = new Set(sorts); } },
      { name: "No tests", apply: function () { state.areas = new Set(data.areas.filter(function (x) { return x !== "tests"; })); } },
    ];
    var folder = el("input", { class: "dg-field", type: "search", placeholder: "Core/src, WebKit/src/webfabric…", "aria-label": "Only under a folder", spellcheck: "false" });
    folder.addEventListener("input", function () { state.folder = folder.value.trim().toLowerCase(); refilter(); });
    var degree = el("input", { type: "range", min: "0", max: "30", value: "0", "aria-label": "Fewest connections a node needs to be shown" });
    var degreeValue = el("output", { text: "Any" });
    degree.addEventListener("input", function () { state.minDegree = Number(degree.value); degreeValue.textContent = state.minDegree ? state.minDegree + "+" : "Any"; refilter(); });
    function toggle(label, key, after) {
      var c = el("input", { type: "checkbox", checked: state[key] });
      c.addEventListener("change", function () { state[key] = c.checked; if (after) after(); else draw(); });
      return el("label", { class: "dg-option dg-switch" }, [c, el("span", { text: label })]);
    }
    function rebuildPanel() {
      boxes = [];
      filters.replaceChildren(
        el("div", { class: "dg-group" }, [el("div", { class: "dg-legend", text: "Views" }), el("div", { class: "dg-presets", role: "group", "aria-label": "Views" }, PRESETS.map(function (p) {
          return el("button", { type: "button", class: "dg-chip", text: p.name, onclick: function () { p.apply(); rebuildPanel(); refilter(); } });
        }))]),
        group("What it is", sorts, state.sorts, function (v) { return SORT_PLURAL[v] || v; }, sortCount, sortMark),
        group("Part of DSTNS", data.areas, state.areas, function (v) { return AREA_NAMES[v] || v; }, areaCount, swatch),
        el("div", { class: "dg-group" }, [el("div", { class: "dg-legend", text: "Only under a folder" }), folder]),
        group("Connections", data.relations, state.relations, function (v) { return v.replace(/_/g, " "); }, relCount, null),
        el("div", { class: "dg-group" }, [el("div", { class: "dg-legend", text: "Show" }), el("label", { class: "dg-range" }, [el("span", { text: "Connections" }), degree, degreeValue]), toggle("Names on the map", "labels"), toggle("Curved links", "curves"), toggle("Only what the search finds", "onlyMatches", refilter)]),
      );
    }
    rebuildPanel();
    filterButton.addEventListener("click", function () { var open = filters.hidden; filters.hidden = !open; filterButton.setAttribute("aria-expanded", String(open)); });
    if (window.innerWidth < 900) { filters.hidden = true; filterButton.setAttribute("aria-expanded", "false"); }

    function refilter() {
      for (var i = 0; i < count; i++) shownNode[i] = state.areas.has(areaOf(i)) && state.sorts.has(sortOf(i)) && N.degree[i] >= state.minDegree && (!state.folder || fileOf(i).toLowerCase().indexOf(state.folder) === 0) && (!state.onlyMatches || !matching || matched[i]) ? 1 : 0;
      for (var k = 0; k < edgeCount; k++) shownEdge[k] = shownNode[E[k * 3]] && shownNode[E[k * 3 + 1]] && state.relations.has(data.relations[E[k * 3 + 2]]) ? 1 : 0;
      neighbourhood();
      draw();
    }

    // ---- camera ----
    var dpr = 1, W = 0, H = 0, cam = { x: 0, y: 0, s: 1 }, goal = null;
    var sortedX = N.x.slice().sort(function (p, q) { return p - q; }), sortedY = N.y.slice().sort(function (p, q) { return p - q; });
    var at = function (list, q) { return list[Math.min(list.length - 1, Math.max(0, Math.round(q * (list.length - 1))))]; };
    var minX = at(sortedX, 0.01), maxX = at(sortedX, 0.99), minY = at(sortedY, 0.01), maxY = at(sortedY, 0.99);
    function fitView(x0, x1, y0, y1, pad) {
      var left = filters.hidden ? 0 : filters.offsetWidth + 24, right = details.hidden ? 0 : details.offsetWidth + 24, topRoom = top.offsetHeight + 24;
      var w = Math.max(80, W - left - right), h = Math.max(80, H - topRoom - 24);
      var s = Math.min(w / Math.max(1, x1 - x0), h / Math.max(1, y1 - y0)) / (pad || 1.1);
      return { s: Math.min(s, 6), x: (x0 + x1) / 2 - (left - right) / 2 / s, y: (y0 + y1) / 2 - (topRoom - 24) / 2 / s };
    }
    function glide(to) {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { cam = to; draw(); return; }
      goal = { from: { x: cam.x, y: cam.y, s: cam.s }, to: to, t0: performance.now() };
      draw();
    }
    var frame = 0;
    function draw() {
      if (frame) return;
      frame = requestAnimationFrame(function (now) {
        frame = 0;
        if (goal) {
          var t = Math.min(1, (now - goal.t0) / 700), k = 1 - Math.pow(1 - t, 3);
          var ls = Math.log(goal.from.s) + (Math.log(goal.to.s) - Math.log(goal.from.s)) * k;
          cam = { x: goal.from.x + (goal.to.x - goal.from.x) * k, y: goal.from.y + (goal.to.y - goal.from.y) * k, s: Math.exp(ls) };
          if (t >= 1) goal = null; else draw();
        }
        paint();
      });
    }
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = root.clientWidth; H = root.clientHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      draw();
    }
    var toScreen = function (x, y) { return [(x - cam.x) * cam.s + W / 2, (y - cam.y) * cam.s + H / 2]; };
    var toWorld = function (sx, sy) { return [(sx - W / 2) / cam.s + cam.x, (sy - H / 2) / cam.s + cam.y]; };

    var CELL = 12, grid = new Map();
    for (var g0 = 0; g0 < count; g0++) { var key = Math.floor(N.x[g0] / CELL) + "," + Math.floor(N.y[g0] / CELL); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(g0); }
    var radius = function (i) { return 1.4 + Math.sqrt(N.degree[i]) * 0.55; };
    var dot = function (i) { return Math.max(1.1, radius(i) * Math.min(cam.s, 2.4) * 0.9); };
    function nodeAt(sx, sy) {
      var w = toWorld(sx, sy), best = -1, bestD = Infinity, reach = Math.max(6 / cam.s, 3);
      var cx = Math.floor(w[0] / CELL), cy = Math.floor(w[1] / CELL), span = Math.ceil(reach / CELL);
      for (var gx = cx - span; gx <= cx + span; gx++) for (var gy = cy - span; gy <= cy + span; gy++) {
        var list = grid.get(gx + "," + gy); if (!list) continue;
        for (var k = 0; k < list.length; k++) { var n = list[k]; if (!shownNode[n]) continue; var d = Math.hypot(N.x[n] - w[0], N.y[n] - w[1]) - radius(n); if (d < bestD && d < reach) { bestD = d; best = n; } }
      }
      return best;
    }

    // ---- painting ----
    var ctx = canvas.getContext("2d"), css = getComputedStyle(root);
    function link(p, q) {
      ctx.moveTo(p[0], p[1]);
      if (!state.curves) { ctx.lineTo(q[0], q[1]); return; }
      // A gentle arc, bending the same way for the same pair, so bundles read as flows rather than a mesh.
      var mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2, dx = q[0] - p[0], dy = q[1] - p[1];
      ctx.quadraticCurveTo(mx - dy * 0.14, my + dx * 0.14, q[0], q[1]);
    }
    function pill(x, y, w, h) { var r = h / 2; ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill(); }
    function paint() {
      var fg = css.getPropertyValue("--dg-fg").trim() || "#edf1f4", line = css.getPropertyValue("--dg-line").trim() || "rgba(180,220,240,0.10)", accent = css.getPropertyValue("--dg-accent").trim() || "#4fd6ea";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      var centre = state.selected >= 0 ? state.selected : state.hover;
      var focus = centre >= 0, dim = function (i) { return focus ? !near[i] : matching && !matched[i]; };
      var x0 = toWorld(0, 0), x1 = toWorld(W, H);
      var inView = function (i, m) { return N.x[i] > x0[0] - m && N.x[i] < x1[0] + m && N.y[i] > x0[1] - m && N.y[i] < x1[1] + m; };
      ctx.fillStyle = css.getPropertyValue("--dg-island").trim() || "rgba(79,214,234,0.035)";
      data.communities.forEach(function (c) { if (c.r * cam.s < 2) return; var p = toScreen(c.x, c.y); ctx.beginPath(); ctx.arc(p[0], p[1], c.r * cam.s, 0, Math.PI * 2); ctx.fill(); });
      ctx.lineWidth = Math.max(0.35, Math.min(1, cam.s * 0.25));
      ctx.strokeStyle = line;
      ctx.globalAlpha = focus || matching ? 0.4 : 1;
      ctx.beginPath();
      for (var k = 0; k < edgeCount; k++) {
        if (!shownEdge[k]) continue;
        var s = E[k * 3], t = E[k * 3 + 1];
        if (!inView(s, 40) && !inView(t, 40)) continue;
        link(toScreen(N.x[s], N.y[s]), toScreen(N.x[t], N.y[t]));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (focus) {
        ctx.strokeStyle = accent; ctx.lineWidth = 1.3; ctx.beginPath();
        for (var f = 0; f < edgeCount; f++) {
          if (!shownEdge[f] || !near[E[f * 3]] || !near[E[f * 3 + 1]]) continue;
          if (state.depth === 1 && E[f * 3] !== centre && E[f * 3 + 1] !== centre) continue;
          link(toScreen(N.x[E[f * 3]], N.y[E[f * 3]]), toScreen(N.x[E[f * 3 + 1]], N.y[E[f * 3 + 1]]));
        }
        ctx.stroke();
      }
      var byArea = {};
      for (var i = 0; i < count; i++) { if (!shownNode[i] || !inView(i, 10)) continue; (byArea[N.area[i]] = byArea[N.area[i]] || []).push(i); }
      Object.keys(byArea).forEach(function (area) {
        ctx.fillStyle = COLOURS[data.areas[area]] || "#cbd5e1";
        byArea[area].forEach(function (n) {
          var p = toScreen(N.x[n], N.y[n]);
          ctx.globalAlpha = dim(n) ? 0.16 : 0.94;
          ctx.beginPath(); ctx.arc(p[0], p[1], dot(n), 0, Math.PI * 2); ctx.fill();
        });
      });
      ctx.globalAlpha = 1;
      if (matching && !focus) {
        ctx.strokeStyle = accent; ctx.lineWidth = 1.4;
        for (var mm = 0; mm < count; mm++) if (matched[mm] && shownNode[mm] && inView(mm, 10)) { var mp = toScreen(N.x[mm], N.y[mm]); ctx.beginPath(); ctx.arc(mp[0], mp[1], dot(mm) + 2.5, 0, Math.PI * 2); ctx.stroke(); }
      }
      if (focus) { var c = toScreen(N.x[centre], N.y[centre]); ctx.strokeStyle = fg; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(c[0], c[1], dot(centre) + 4, 0, Math.PI * 2); ctx.stroke(); }
      if (!state.labels) return;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      var taken = [];
      var free = function (x, y, w, h) { for (var j = 0; j < taken.length; j++) { var b = taken[j]; if (x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]) return false; } taken.push([x, y, w, h]); return true; };
      if (cam.s < 1.6 && !focus) {
        ctx.font = "600 12px Inter, system-ui, sans-serif";
        data.communities.slice().sort(function (p, q) { return q.r - p.r; }).forEach(function (cm) {
          var p = toScreen(cm.x, cm.y); if (p[0] < -100 || p[0] > W + 100 || p[1] < -40 || p[1] > H + 40 || cm.r * cam.s < 13) return;
          var w = ctx.measureText(cm.name).width + 18;
          if (!free(p[0] - w / 2, p[1] - 11, w, 22)) return;
          ctx.fillStyle = css.getPropertyValue("--dg-label-bg").trim() || "rgba(7,19,28,0.72)"; pill(p[0] - w / 2, p[1] - 11, w, 22);
          ctx.fillStyle = fg; ctx.fillText(cm.name, p[0], p[1] + 0.5);
        });
      }
      if (cam.s >= 1.3 || focus || matching) {
        ctx.font = "11px Inter, system-ui, sans-serif";
        var order = [];
        for (var n = 0; n < count; n++) if (shownNode[n] && inView(n, 0) && (cam.s >= 1.3 || near[n] || matched[n])) order.push(n);
        order.sort(function (p, q) { return (near[q] - near[p]) || (matched[q] - matched[p]) || (N.degree[q] - N.degree[p]); });
        var drawn = 0;
        for (var o = 0; o < order.length && drawn < 260; o++) {
          var m = order[o], pt = toScreen(N.x[m], N.y[m]), text = N.label[m], tw = ctx.measureText(text).width;
          var y = pt[1] + dot(m) + 10;
          if (!free(pt[0] - tw / 2 - 3, y - 8, tw + 6, 16)) continue;
          ctx.globalAlpha = dim(m) ? 0.3 : 0.92;
          ctx.fillStyle = m === centre ? accent : fg;
          ctx.fillText(text, pt[0], y); drawn++;
        }
        ctx.globalAlpha = 1;
      }
    }

    function neighbourhood() {
      near.fill(0);
      var centre = state.selected >= 0 ? state.selected : state.hover;
      if (centre < 0) return;
      var frontier = [centre]; near[centre] = 1;
      for (var d = 0; d < state.depth; d++) {
        var next = [];
        frontier.forEach(function (v) { adjacency[v].forEach(function (k) { if (!shownEdge[k]) return; var o = E[k * 3] === v ? E[k * 3 + 1] : E[k * 3]; if (!near[o]) { near[o] = 1; next.push(o); } }); });
        frontier = next;
      }
    }

    // ---- the side panel: what it is, where it is, what it holds, what it uses and what uses it ----
    function sourceUrl(i) { var f = fileOf(i); return f ? "https://github.com/" + data.repo + "/blob/" + data.commit + "/" + f + (N.line[i] ? "#L" + N.line[i] : "") : null; }
    function where(i) { var f = fileOf(i); return f ? f.split("/").pop() + (N.line[i] ? ":" + N.line[i] : "") : AREA_NAMES[areaOf(i)] || ""; }
    function row(o) {
      var url = sourceUrl(o);
      return el("li", { class: "dg-row" }, [
        el("button", { type: "button", class: "dg-row-main", title: fileOf(o) + (N.line[o] ? ", line " + N.line[o] : ""), onclick: function () { select(o, true); } }, [
          el("span", { class: "dg-kind-icon", style: "--c:" + colourOf(o), html: icon(sortOf(o), 14) }),
          el("span", { class: "dg-row-name", text: N.label[o] }),
          el("small", { class: "dg-row-where", text: where(o) }),
        ]),
        url ? el("a", { class: "dg-row-open", href: url, target: "_blank", rel: "noopener", "aria-label": "Open " + N.label[o] + " on GitHub", title: "Open the source at this line", html: icon("external", 14) }) : null,
      ]);
    }
    function section(title, iconName, list, open) {
      var sorted = list.slice().sort(function (p, q) { return (fileOf(p) === fileOf(q) ? (N.line[p] || 1e9) - (N.line[q] || 1e9) : fileOf(p).localeCompare(fileOf(q))) || N.label[p].localeCompare(N.label[q]); });
      var shown = 12, ul = el("ul", { class: "dg-rows" }), more = el("button", { type: "button", class: "dg-more" });
      function fill() {
        ul.replaceChildren.apply(ul, sorted.slice(0, shown).map(row));
        more.hidden = sorted.length <= shown;
        more.textContent = "Show " + Math.min(40, sorted.length - shown) + " more of " + (sorted.length - shown);
      }
      more.addEventListener("click", function () { shown += 40; fill(); });
      fill();
      return el("details", { class: "dg-section", open: open }, [el("summary", {}, [el("span", { class: "dg-section-icon", html: icon(iconName, 14) }), el("span", { class: "dg-section-title", text: title }), el("small", { text: String(list.length) })]), ul, more]);
    }
    function select(i, move) {
      state.selected = i; state.hover = -1;
      neighbourhood();
      if (i < 0) { details.hidden = true; history.replaceState(null, "", location.pathname + location.search); draw(); return; }
      history.replaceState(null, "", "#node=" + encodeURIComponent(N.id[i]));
      details.replaceChildren();
      var file = fileOf(i), url = sourceUrl(i), sections = [];
      GROUPS.forEach(function (g) {
        var out = [], inn = [];
        adjacency[i].forEach(function (k) {
          if (!shownEdge[k] || g.out.indexOf(data.relations[E[k * 3 + 2]]) < 0) return;
          if (E[k * 3] === i) out.push(E[k * 3 + 1]); else inn.push(E[k * 3]);
        });
        if (out.length) sections.push(section(g.outName, g.icon, Array.from(new Set(out)), sections.length < 3));
        if (inn.length) sections.push(section(g.inName, g.icon, Array.from(new Set(inn)), sections.length < 3));
      });
      var copy = el("button", { class: "dg-button", type: "button", html: icon("link") + "<span>Copy link</span>", onclick: function () { if (navigator.clipboard) navigator.clipboard.writeText(location.href); copy.querySelector("span").textContent = "Copied"; setTimeout(function () { copy.querySelector("span").textContent = "Copy link"; }, 1400); } });
      var depth = el("div", { class: "dg-seg", role: "radiogroup", "aria-label": "How far around it" }, [1, 2, 3].map(function (d) {
        return el("button", { type: "button", role: "radio", "aria-checked": String(state.depth === d), text: d === 1 ? "Neighbours" : d + " steps", onclick: function () { state.depth = d; select(i, false); } });
      }));
      var crumbs = file ? file.split("/") : [];
      details.append(
        el("header", { class: "dg-head" }, [
          el("span", { class: "dg-head-icon", style: "--c:" + colourOf(i), html: icon(sortOf(i), 20) }),
          el("div", { class: "dg-head-text" }, [el("h2", { text: N.label[i] }), el("p", { text: (SORT_NAMES[sortOf(i)] || "Node") + " · " + (AREA_NAMES[areaOf(i)] || areaOf(i)) })]),
          el("button", { class: "dg-icon dg-close", type: "button", "aria-label": "Close", html: icon("close"), onclick: function () { select(-1); } }),
        ]),
        file ? el("a", { class: "dg-source", href: url, target: "_blank", rel: "noopener", title: "Open the source on GitHub" }, [
          el("span", { class: "dg-crumbs" }, crumbs.map(function (c, k) { return el("span", { class: k === crumbs.length - 1 ? "dg-crumb last" : "dg-crumb", text: c }); })),
          N.line[i] ? el("span", { class: "dg-line", text: "line " + N.line[i] }) : null,
          el("span", { class: "dg-source-open", html: icon("external", 14) }),
        ]) : null,
        el("div", { class: "dg-stats" }, [
          el("span", { class: "dg-stat" }, [el("strong", { text: String(N.degree[i]) }), " connections"]),
          el("button", { class: "dg-stat dg-stat-link", type: "button", title: "Show its community", onclick: function () { focusCommunity(N.community[i]); } }, [el("span", { class: "dg-swatch", style: "--c:" + colourOf(i) }), commName[N.community[i]]]),
        ]),
        el("div", { class: "dg-actions" }, [depth, copy]),
        sections.length ? el("div", { class: "dg-sections" }, sections) : el("p", { class: "dg-empty", text: "Nothing connects to it with the filters as they are." }),
      );
      details.hidden = false;
      if (move) { var span = 60 / Math.max(cam.s, 0.8); var to = fitView(N.x[i] - span, N.x[i] + span, N.y[i] - span, N.y[i] + span, 1); to.s = Math.max(cam.s, 2.2); glide(to); }
      draw();
    }
    function focusCommunity(c) {
      var cm = data.communities.find(function (x) { return x.id === c; }); if (!cm) return;
      glide(fitView(cm.x - cm.r, cm.x + cm.r, cm.y - cm.r, cm.y + cm.r, 1.25));
    }

    // ---- search ----
    var hits = [], active = -1;
    function search() {
      var text = input.value.trim();
      results.replaceChildren(); hits = []; active = -1; matched.fill(0); matching = false;
      if (!text) { results.hidden = true; if (state.onlyMatches) refilter(); else draw(); return; }
      var q = understand(text), found, said = [];
      if (q.relation) {
        var subject = subjectOf(q.relation.subject, q.relation.group, q.relation.dir), g = GROUPS.find(function (x) { return x.key === q.relation.group; });
        found = subject < 0 ? [] : rank(q, around(subject, q.relation.group, q.relation.dir));
        said.push((q.relation.dir === "out" ? g.outName : g.inName) + " " + (subject < 0 ? "“" + q.relation.subject + "”" : N.label[subject]));
      } else found = rank(q, null);
      if (q.sort.length) said.push(q.sort.map(function (s) { return SORT_PLURAL[s] || s; }).join(", "));
      if (q.in.length) said.push("in " + q.in.map(function (x) { var k = data.areas.find(function (y) { return y.toLowerCase() === x; }); return AREA_NAMES[k] || x; }).join(", "));
      if (q.file.length) said.push("in files named " + q.file.join(", "));
      found.forEach(function (f) { matched[f[1]] = 1; });
      matching = found.length > 0;
      hits = found.slice(0, 50).map(function (x) { return x[1]; });
      if (said.length) results.appendChild(el("div", { class: "dg-understood", html: icon("spark", 14) + "<span>" + said.map(function (s) { return "<b>" + s.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</b>"; }).join(" · ") + "</span>" }));
      var list = el("ul", { role: "listbox", class: "dg-hit-list", "aria-label": "Results" });
      if (!hits.length) list.appendChild(el("li", { class: "dg-none", text: "Nothing matches. A filter may be hiding it, or try other words." }));
      hits.forEach(function (i, k) {
        list.appendChild(el("li", { role: "option", id: "dg-hit-" + k, "aria-selected": "false", onmousedown: function (ev) { ev.preventDefault(); choose(k); } }, [
          el("span", { class: "dg-kind-icon", style: "--c:" + colourOf(i), html: icon(sortOf(i), 14) }),
          el("span", { class: "dg-hit-label", text: N.label[i] }),
          el("small", { text: fileOf(i) ? fileOf(i) + (N.line[i] ? ":" + N.line[i] : "") : commName[N.community[i]] }),
        ]));
      });
      results.appendChild(list);
      results.appendChild(el("div", { class: "dg-count", text: found.length > hits.length ? hits.length + " of " + found.length.toLocaleString() + " shown, all ringed on the map" : found.length + (found.length === 1 ? " match" : " matches") + (found.length ? ", ringed on the map" : "") }));
      results.hidden = false;
      if (state.onlyMatches) refilter(); else draw();
    }
    function choose(k) { if (hits[k] === undefined) return; results.hidden = true; input.blur(); select(hits[k], true); }
    function mark(k) {
      active = Math.max(0, Math.min(hits.length - 1, k));
      results.querySelectorAll("[role=option]").forEach(function (o, j) { o.setAttribute("aria-selected", String(j === active)); if (j === active) o.scrollIntoView({ block: "nearest" }); });
      input.setAttribute("aria-activedescendant", "dg-hit-" + active);
    }
    var pending = 0;
    input.addEventListener("input", function () { clearTimeout(pending); pending = setTimeout(search, 90); });
    input.addEventListener("focus", function () { if (input.value.trim()) results.hidden = false; });
    input.addEventListener("blur", function () { setTimeout(function () { results.hidden = true; }, 140); });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown") { ev.preventDefault(); mark(active + 1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); mark(active - 1); }
      else if (ev.key === "Enter") { ev.preventDefault(); clearTimeout(pending); search(); choose(active < 0 ? 0 : active); }
      else if (ev.key === "Escape") { input.value = ""; search(); input.blur(); }
    });
    document.addEventListener("keydown", function (ev) {
      if (!document.body.contains(root)) return;
      if (ev.key === "/" && document.activeElement !== input && !/input|textarea/i.test(document.activeElement.tagName)) { ev.preventDefault(); input.focus(); }
      else if (ev.key === "Escape" && document.activeElement !== input) select(-1);
    });

    // ---- pointer ----
    var drag = null, moved = false, pinch = null;
    canvas.addEventListener("pointerdown", function (ev) { canvas.setPointerCapture(ev.pointerId); drag = { x: ev.clientX, y: ev.clientY, cx: cam.x, cy: cam.y }; moved = false; goal = null; });
    canvas.addEventListener("pointermove", function (ev) {
      var r = canvas.getBoundingClientRect(), sx = ev.clientX - r.left, sy = ev.clientY - r.top;
      if (drag) {
        if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 3) moved = true;
        cam.x = drag.cx - (ev.clientX - drag.x) / cam.s; cam.y = drag.cy - (ev.clientY - drag.y) / cam.s; draw(); return;
      }
      var n = nodeAt(sx, sy);
      if (n !== state.hover && state.selected < 0) { state.hover = n; neighbourhood(); draw(); }
      canvas.style.cursor = n >= 0 ? "pointer" : "grab";
      if (n >= 0) {
        tip.hidden = false;
        tip.replaceChildren(el("span", { class: "dg-kind-icon", style: "--c:" + colourOf(n), html: icon(sortOf(n), 13) }), el("b", { text: N.label[n] }), el("small", { text: where(n) }));
        tip.style.transform = "translate(" + Math.min(sx + 14, W - 300) + "px," + (sy + 14) + "px)";
      } else tip.hidden = true;
    });
    canvas.addEventListener("pointerup", function (ev) {
      var r = canvas.getBoundingClientRect();
      if (drag && !moved) select(nodeAt(ev.clientX - r.left, ev.clientY - r.top), false);
      drag = null;
    });
    canvas.addEventListener("pointerleave", function () { tip.hidden = true; if (state.selected < 0 && state.hover >= 0) { state.hover = -1; neighbourhood(); draw(); } });
    function zoomAt(sx, sy, factor) {
      var w = toWorld(sx, sy);
      cam.s = Math.max(0.05, Math.min(12, cam.s * factor));
      cam.x = w[0] - (sx - W / 2) / cam.s; cam.y = w[1] - (sy - H / 2) / cam.s;
      draw();
    }
    canvas.addEventListener("wheel", function (ev) {
      ev.preventDefault(); goal = null;
      var r = canvas.getBoundingClientRect();
      if (ev.ctrlKey || Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0018)));
      else { cam.x += ev.deltaX / cam.s; cam.y += ev.deltaY / cam.s; draw(); }
    }, { passive: false });
    canvas.addEventListener("touchstart", function (ev) { if (ev.touches.length === 2) { drag = null; pinch = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY); } }, { passive: true });
    canvas.addEventListener("touchmove", function (ev) {
      if (ev.touches.length !== 2 || !pinch) return;
      var d = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY), r = canvas.getBoundingClientRect();
      zoomAt((ev.touches[0].clientX + ev.touches[1].clientX) / 2 - r.left, (ev.touches[0].clientY + ev.touches[1].clientY) / 2 - r.top, d / pinch); pinch = d;
    }, { passive: true });
    zoomIn.addEventListener("click", function () { glide({ x: cam.x, y: cam.y, s: Math.min(12, cam.s * 1.6) }); });
    zoomOut.addEventListener("click", function () { glide({ x: cam.x, y: cam.y, s: Math.max(0.05, cam.s / 1.6) }); });
    fitButton.addEventListener("click", function () { glide(fitView(minX, maxX, minY, maxY)); });

    // ---- start ----
    new ResizeObserver(resize).observe(root);
    new MutationObserver(function () { css = getComputedStyle(root); draw(); }).observe(document.body, { attributes: true, attributeFilter: ["data-md-color-scheme"] });
    resize();
    refilter();
    cam = fitView(minX, maxX, minY, maxY);
    var wanted = /node=([^&]+)/.exec(location.hash), asked = /[?&]q=([^&]+)/.exec(location.search);
    var found0 = wanted ? N.id.indexOf(decodeURIComponent(wanted[1])) : -1;
    if (found0 >= 0) select(found0, true);
    if (asked) { input.value = decodeURIComponent(asked[1].replace(/\+/g, " ")); search(); }
    draw();
  }

  function boot() { start(document.getElementById("dstns-graph")); }
  if (window.document$ && window.document$.subscribe) window.document$.subscribe(boot);
  else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
