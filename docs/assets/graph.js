// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The knowledge graph: every file, class, function and page of DSTNS and how they connect, as graphify read the
// repository when the documentation was built (hooks/graph.py). The positions come with the data, so the page draws at
// once; this script pans, zooms, searches in plain words, filters and explains.
(function () {
  "use strict";

  // ---- palette and words -------------------------------------------------------------------------------------------
  var COLOURS = {
    Core: "#22b8cf", Fabric: "#8b7cf6", Daemon: "#e8a93a", LaunchKit: "#ef6b6b", WebKit: "#2fbf8f",
    docs: "#5b9cf0", tests: "#8a99a8", tools: "#f08a4b", config: "#d46fe0", scripts: "#d9b23a", docker: "#2aa3e0",
    Other: "#a9b6c2", Concepts: "#ec6fae",
  };
  var AREA_NAMES = { Core: "Core engine", Fabric: "Fabric and WebFabric", Daemon: "Daemons", LaunchKit: "Launcher", WebKit: "Observer", docs: "Documentation", tests: "Tests", tools: "Tools", config: "Configuration", scripts: "Scripts", docker: "Containers", Other: "Other files", Concepts: "Ideas" };
  var SORT_NAMES = { file: "File", class: "Class", function: "Function", section: "Doc section", document: "Document", concept: "Idea", other: "Symbol" };
  var SORT_PLURAL = { file: "Files", class: "Classes", function: "Functions", section: "Doc sections", document: "Documents", concept: "Ideas", other: "Symbols" };
  var SORT_ORDER = ["class", "file", "function", "section", "document", "concept", "other"];
  var SORT_BONUS = { class: 1.6, file: 1.2, function: 0.9, section: 0.7, document: 0.7, concept: 0.3, other: 0 };
  // Which way a link reads, and what to call each end of it, in plain words.
  var GROUPS = [
    { key: "contains", out: ["contains", "defines", "method", "declares", "case_of"], outName: "Contains", inName: "Inside", icon: "box", name: "Holds", outSays: "What is inside", inSays: "What holds" },
    { key: "calls", out: ["calls", "indirect_call"], outName: "Calls", inName: "Called by", icon: "call", name: "Calls", outSays: "What is called by", inSays: "What calls" },
    { key: "imports", out: ["imports", "imports_from", "dynamic_import", "re_exports"], outName: "Depends on", inName: "Used by", icon: "import", name: "Depends on", outSays: "What is needed by", inSays: "What depends on" },
    { key: "inherits", out: ["inherits", "implements"], outName: "Builds on", inName: "Built on by", icon: "inherit", name: "Builds on", outSays: "What is built on by", inSays: "What builds on" },
    { key: "references", out: ["references", "rationale_for"], outName: "Mentions", inName: "Mentioned by", icon: "ref", name: "Mentions", outSays: "What is mentioned by", inSays: "What mentions" },
  ];
  var groupOfRel = {};
  GROUPS.forEach(function (g) { g.out.forEach(function (r) { groupOfRel[r] = g.key; }); });
  var EXAMPLES = ["Where is the simulation engine?", "What calls seek", "Functions in the launcher", "Docs about weather", "What is inside App.tsx"];

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
  var SORT_WORDS = { function: "function", functions: "function", method: "function", methods: "function", class: "class", classes: "class", struct: "class", structs: "class", type: "class", types: "class", file: "file", files: "file", module: "file", modules: "file", source: "file", sources: "file", doc: "section", docs: "section", page: "section", pages: "section", section: "section", sections: "section", guide: "section", concept: "concept", concepts: "concept", idea: "concept", ideas: "concept" };

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
  var escapeHtml = function (s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };

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
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>', link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
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
    palette: '<circle cx="12" cy="12" r="8.5"/><circle cx="8.5" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="15.5" cy="10" r="1.2"/><path d="M12 20.5a2.5 2.5 0 0 1 0-5h1.5a2 2 0 0 0 2-2"/>',
    help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7M12 17h.01"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', history: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5M4 4v4.5h4.5M12 8v4l3 2"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', enter: '<path d="M19 6v5a3 3 0 0 1-3 3H6M10 10l-4 4 4 4"/>', group: '<circle cx="8" cy="9" r="3.5"/><circle cx="16" cy="9" r="3.5"/><circle cx="12" cy="16" r="3.5"/>',
  };
  function icon(name, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) + '" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (PATHS[name] || "") + "</svg>";
  }
  var quiet = function () { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem("dstns-graph-" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem("dstns-graph-" + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

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
    var colourOf = function (i) { return COLOURS[areaOf(i)] || "#a9b6c2"; };
    var relOf = function (k) { return data.relations[E[k * 3 + 2]]; };
    var groupOf = function (k) { return groupOfRel[relOf(k)] || "other"; };
    var commName = {}; data.communities.forEach(function (c) { commName[c.id] = c.name; });
    var adjacency = new Array(count);
    for (var a = 0; a < count; a++) adjacency[a] = [];
    for (var e = 0; e < edgeCount; e++) { adjacency[E[e * 3]].push(e); adjacency[E[e * 3 + 1]].push(e); }

    // A member's name is shown as itself, with what it belongs to beside it: "snapshot()" of "SimulationEngine".
    var shortName = new Array(count), owner = new Array(count);
    for (var s0 = 0; s0 < count; s0++) {
      var label = N.label[s0], cut = -1, sort0 = sortOf(s0);
      if (sort0 !== "file" && sort0 !== "section" && sort0 !== "document") {
        cut = label.lastIndexOf("::");
        if (cut > 0) { shortName[s0] = label.slice(cut + 2); owner[s0] = label.slice(0, cut); continue; }
        var dot = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*\(?\)?)$/.exec(label);
        if (dot) { shortName[s0] = dot[2]; owner[s0] = dot[1]; continue; }
      }
      // A method graphify names from inside its class (".prepare()") is shown by its own name.
      shortName[s0] = sort0 !== "file" && /^\.[A-Za-z_$]/.test(label) ? label.slice(1) : label; owner[s0] = "";
    }

    // ---- the search index: each word once, and where it is ----
    var index = new Map(), prefix = new Map();
    function add(token, node, weight) {
      var t = stem(token), list = index.get(t);
      if (!list) { list = new Map(); index.set(t, list); var p = t.slice(0, 2); if (!prefix.has(p)) prefix.set(p, []); prefix.get(p).push(t); }
      list.set(node, Math.max(list.get(node) || 0, weight));
    }
    var flatShort = new Array(count), flatFull = new Array(count);
    for (var n0 = 0; n0 < count; n0++) {
      // A file named with part of its path, where two share a name, is still found by its name alone.
      flatShort[n0] = (sortOf(n0) === "file" && fileOf(n0) ? fileOf(n0).split("/").pop() : shortName[n0]).toLowerCase().replace(/[^a-z0-9]/g, "");
      flatFull[n0] = N.label[n0].toLowerCase().replace(/[^a-z0-9]/g, "");
      words(shortName[n0]).forEach(function (w) { add(w, n0, 3); });
      // What a member belongs to counts, but less than its own name, so a class is found before its hundred methods.
      words(owner[n0]).forEach(function (w) { add(w, n0, 1.3); });
      add(flatShort[n0], n0, 3.5);
      words(fileOf(n0)).forEach(function (w) { add(w, n0, 1.1); });
      words(commName[N.community[n0]] || "").forEach(function (w) { add(w, n0, 0.6); });
    }
    var idf = function (t) { var list = index.get(t); return list ? Math.log(1 + count / list.size) : 0; };
    function expand(word, typing) {
      var t = stem(word), out = [[t, 1]];
      var related = THESAURUS[t] || THESAURUS[word] || [];
      related.forEach(function (s) { out.push([stem(s), 0.8]); });
      // A word still being typed, or one that starts a longer one in the index: "regen" finds "regenerate".
      if (t.length >= (typing ? 2 : 4)) {
        var candidates = prefix.get(word.slice(0, 2)) || [], seen = 0;
        candidates.forEach(function (c) { if (c !== t && c.indexOf(word) === 0 && seen++ < 60) out.push([c, typing ? 0.9 : 0.7]); });
        // A typo: only for a word that is neither in the index nor in the thesaurus, and less than either.
        if ((!typing || seen === 0) && !index.has(t) && !related.length) {
          var limit = t.length >= 8 ? 2 : 1, near = 0;
          candidates.concat(prefix.get(t[0] + (t[2] || "")) || []).forEach(function (c) { if (near < 6 && distance(t, c, limit) <= limit) { out.push([c, 0.45]); near++; } });
        }
      }
      return out;
    }
    /** What a question means: words, and what it asks for (a kind, a part, a relation round a subject). */
    function understand(text) {
      var q = { words: [], in: [], sort: [], file: [], relation: null, typing: !/\s$/.test(text) };
      var rest = text.replace(/\b(in|type|kind|file):("[^"]*"|\S+)/gi, function (all, op, v) {
        v = v.replace(/^"|"$/g, "").toLowerCase();
        op = op.toLowerCase();
        if (op === "type" || op === "kind") q.sort.push(SORT_WORDS[v] || v);
        else q[op].push(op === "in" ? (AREA_WORDS[v] || v).toLowerCase() : v);
        return " ";
      });
      // Matched without regard to case, but the subject keeps its own, so seekBy still splits into seek and by.
      var original = rest.replace(/[?.!]+\s*$/, "").trim(), s = original.toLowerCase(), m;
      var keep = function (found) { return found ? original.substr(s.lastIndexOf(found), found.length) : found; };
      if ((m = /^(?:who|what|which(?: \w+)?)?\s*(?:calls|uses|invokes|runs)\s+(.+)$/.exec(s)) || (m = /^(?:callers|users) of\s+(.+)$/.exec(s))) q.relation = { dir: "in", group: "calls", subject: m[1] };
      else if ((m = /^what (?:does|do)\s+(.+?)\s+(?:call|use|invoke|run)$/.exec(s)) || (m = /^callees of\s+(.+)$/.exec(s))) q.relation = { dir: "out", group: "calls", subject: m[1] };
      else if ((m = /^(?:who|what|which(?: \w+)?)?\s*(?:imports|depends on|needs|includes)\s+(.+)$/.exec(s)) || (m = /^(?:dependents|importers) of\s+(.+)$/.exec(s))) q.relation = { dir: "in", group: "imports", subject: m[1] };
      else if ((m = /^what (?:does|do)\s+(.+?)\s+(?:import|depend on|need|include)$/.exec(s)) || (m = /^(?:dependencies|imports) of\s+(.+)$/.exec(s))) q.relation = { dir: "out", group: "imports", subject: m[1] };
      else if ((m = /^what(?:'s| is| are)? (?:in|inside)\s+(.+)$/.exec(s)) || (m = /^(?:contents|members) of\s+(.+)$/.exec(s))) q.relation = { dir: "out", group: "contains", subject: m[1] };
      else if ((m = /^where (?:is|are|do|does)\s+(.+?)(?: defined| declared| live| lives| kept)?$/.exec(s))) s = m[1];
      if (q.relation) { q.relation.subject = keep(q.relation.subject); s = ""; q.typing = false; }
      var tokens = s.split(/\s+/).filter(Boolean);
      for (var i = 0; i < tokens.length; i++) {
        var w = tokens[i];
        if ((w === "in" || w === "inside" || w === "from") && AREA_WORDS[tokens[i + 1]]) { q.in.push(AREA_WORDS[tokens[i + 1]].toLowerCase()); i++; continue; }
        if ((w === "in" || w === "inside" || w === "from") && tokens[i + 1] === "the" && AREA_WORDS[tokens[i + 2]]) { q.in.push(AREA_WORDS[tokens[i + 2]].toLowerCase()); i += 2; continue; }
        if (w === "about" && tokens.length > 2) continue;
        if (SORT_WORDS[w] && tokens.length > 1) { q.sort.push(SORT_WORDS[w]); continue; }
        if (STOP.has(w)) continue;
        q.words = q.words.concat(words(w));
      }
      return q;
    }
    function passes(i, q) {
      if (!shownNode[i]) return false;
      if (q.in.length && !q.in.some(function (v) { return areaOf(i).toLowerCase().indexOf(v) === 0 || (AREA_NAMES[areaOf(i)] || "").toLowerCase().indexOf(v) >= 0; })) return false;
      if (q.sort.length && q.sort.indexOf(sortOf(i)) < 0 && !(q.sort.indexOf("section") >= 0 && sortOf(i) === "document")) return false;
      if (q.file.length && !q.file.every(function (v) { return fileOf(i).toLowerCase().indexOf(v) >= 0; })) return false;
      return true;
    }
    function rank(q, among, limit) {
      var score = new Map();
      if (!q.words.length) {
        (among ? Array.from(among) : Array.from({ length: count }, function (_, i) { return i; })).forEach(function (i) { if (passes(i, q)) score.set(i, 1 + Math.log(1 + N.degree[i]) + (SORT_BONUS[sortOf(i)] || 0)); });
      } else {
        // Short queries need every word; a sentence needs most of them, and more is better.
        var need = q.words.length <= 2 ? q.words.length : Math.ceil(q.words.length * 0.6), covered = new Map();
        q.words.forEach(function (word, wi) {
          var got = new Map();
          expand(word, q.typing && wi === q.words.length - 1).forEach(function (pair) {
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
          var bonus = flatShort[node] === whole || flatFull[node] === whole ? 30 : flatShort[node].indexOf(whole) === 0 ? 12 : flatFull[node].indexOf(whole) === 0 ? 8 : 0;
          score.set(node, v + bonus + (SORT_BONUS[sortOf(node)] || 0) + Math.log(1 + N.degree[node]) * 0.4);
        });
      }
      var out = [];
      score.forEach(function (v, node) { out.push([v, node]); });
      out.sort(function (x, y) { return y[0] - x[0]; });
      // Variety: each further result from the same file counts a little less, so one file does not fill the list.
      var perFile = new Map();
      out.forEach(function (r) { var f = fileOf(r[1]); if (!f) return; var c = perFile.get(f) || 0; perFile.set(f, c + 1); r[0] *= Math.pow(0.93, c); });
      out.sort(function (x, y) { return y[0] - x[0]; });
      return limit ? out.slice(0, limit) : out;
    }
    /** The best node for a name: the subject of a question about relations. What depends on what is said of files,
     * so a class or function asked about there stands for the file it is in. */
    function subjectOf(text, group, dir) {
      var blank = function (w) { return { words: w, in: [], sort: [], file: [] }; };
      var found = rank(blank(words(text)), null, 40);
      // Calls are between functions, and dependencies between files: those come first.
      var want = group === "calls" ? ["function", "other", "class"] : group === "imports" ? ["file"] : null;
      if (want) found = found.filter(function (f) { return want.indexOf(sortOf(f[1])) >= 0; }).concat(found.filter(function (f) { return want.indexOf(sortOf(f[1])) < 0; }));
      // A name not in the graph as written: its most telling word, the rarest, stands for it.
      if (!found.length) words(text).filter(function (w) { return !STOP.has(w); }).sort(function (x, y) { return idf(stem(y)) - idf(stem(x)); }).some(function (w) { found = rank(blank([w]), null, 8); return found.length; });
      var stand = function (node) {
        if (group === "imports" && sortOf(node) !== "file" && fileOf(node)) for (var i = 0; i < count; i++) if (sortOf(i) === "file" && N.file[i] === N.file[node]) return i;
        return node;
      };
      // Of the likely ones, the first the question has an answer for: only those nearly as good as the best, so a
      // looser match never answers for the name asked about.
      var best = found.reduce(function (m, f) { return Math.max(m, f[0]); }, 0);
      for (var k = 0; k < found.length; k++) { if (found[k][0] < best * 0.6) continue; var node = stand(found[k][1]); if (around(node, group, dir).size) return node; }
      return found.length ? stand(found[0][1]) : -1;
    }
    function around(node, group, dir) {
      var set = new Set();
      adjacency[node].forEach(function (k) {
        if (groupOf(k) !== group) return;
        if (dir === "out" && E[k * 3] === node) set.add(E[k * 3 + 1]);
        if (dir === "in" && E[k * 3 + 1] === node) set.add(E[k * 3]);
      });
      return set;
    }

    // ---- state ----
    var ALL_GROUPS = GROUPS.map(function (g) { return g.key; }).concat(["other"]);
    var fresh = function () { return { areas: new Set(data.areas), sorts: new Set(sorts), groups: new Set(ALL_GROUPS), folder: "", minDegree: 0 }; };
    var state = Object.assign(fresh(), { labels: store.get("labels", true), curves: store.get("curves", true), selected: -1, hover: -1, depth: 1 });
    var shownNode = new Uint8Array(count), shownEdge = new Uint8Array(edgeCount), near = new Uint8Array(count), matched = new Uint8Array(count), matching = false, shownCount = count;
    var version = 0; // changes whenever what the base layer draws changes

    // ---- the page ----
    var canvas = el("canvas", { class: "dg-canvas", "aria-label": "The knowledge graph. Use the search to find something, or choose a dot.", role: "img" });
    var input = el("input", { class: "dg-search-input", type: "search", placeholder: "Search the code and docs, or ask: what calls seek?", "aria-label": "Search the graph in plain words", autocomplete: "off", spellcheck: "false", role: "combobox", "aria-expanded": "false", "aria-controls": "dg-results", "aria-autocomplete": "list" });
    var clear = el("button", { class: "dg-clear", type: "button", "aria-label": "Clear the search", hidden: true, html: icon("close", 14) });
    var results = el("div", { class: "dg-results", id: "dg-results", hidden: true });
    var searchBox = el("div", { class: "dg-search" }, [el("span", { class: "dg-search-icon", html: icon("search", 18) }), input, clear, el("kbd", { class: "dg-key", text: "/" }), results]);

    var brand = el("div", { class: "dg-brand" }, [
      el("strong", { text: "Knowledge graph" }),
      el("span", { class: "dg-counts" }, [el("b", { class: "dg-shown", text: count.toLocaleString() }), " items · " + edgeCount.toLocaleString() + " links"]),
    ]);
    var repo = el("a", { class: "dg-button dg-repo", href: "https://github.com/" + data.repo + "/tree/" + data.commit, target: "_blank", rel: "noopener", title: "The source this graph was built from, at commit " + data.commit.slice(0, 7), html: icon("github") + "<span>" + data.repo.split("/").pop() + "</span><code>" + data.commit.slice(0, 7) + "</code>" });
    var skill = el("a", { class: "dg-button", href: "../downloads/dstns-graph-skill.zip", download: "dstns-graph-skill.zip", title: "A Claude skill that asks this graph: where things are, what calls what, what depends on what", html: icon("download") + "<span>Claude skill</span>" });
    var actions = el("div", { class: "dg-actions-top" }, [skill, repo]);

    var dockButton = function (name, label, iconName) { return el("button", { type: "button", class: "dg-dock-btn", "aria-label": label, title: label, "data-panel": name, html: icon(iconName, 18) }); };
    var filterBtn = dockButton("filters", "Filters", "filter"), keyBtn = dockButton("key", "Colours", "palette"), helpBtn = dockButton("help", "How to use it", "help");
    var zoomIn = dockButton("", "Zoom in", "plus"), zoomOut = dockButton("", "Zoom out", "minus"), fitButton = dockButton("", "Show everything", "fit");
    var badge = el("span", { class: "dg-badge", hidden: true });
    filterBtn.appendChild(badge);
    var dock = el("nav", { class: "dg-dock", "aria-label": "Graph tools" }, [filterBtn, keyBtn, helpBtn, el("i", { class: "dg-dock-sep" }), zoomIn, zoomOut, fitButton]);
    var sheet = el("aside", { class: "dg-sheet", "aria-label": "Graph tools", hidden: true });
    var details = el("aside", { class: "dg-details", "aria-label": "About the chosen item", hidden: true });
    var tip = el("div", { class: "dg-tip", hidden: true, "aria-hidden": "true" });
    var hint = el("div", { class: "dg-hint", text: "Drag to move · scroll to zoom · choose a dot to see what it is" });
    var live = el("div", { class: "dg-live", "aria-live": "polite" });
    root.append(canvas, el("div", { class: "dg-top" }, [brand, searchBox, actions]), dock, sheet, details, tip, hint, live);

    // ---- filters, colours and help: one sheet beside the dock ----
    function tally(list, of) { var c = {}; list.forEach(function (v) { c[v] = 0; }); for (var i = 0; i < count; i++) c[of(i)] = (c[of(i)] || 0) + 1; return c; }
    var areaCount = tally(data.areas, areaOf), sortCount = tally(sorts, sortOf);
    var groupCount = {}; ALL_GROUPS.forEach(function (g) { groupCount[g] = 0; }); for (e = 0; e < edgeCount; e++) groupCount[groupOf(e)]++;
    var VIEWS = [
      { name: "Everything", areas: data.areas, sorts: sorts },
      { name: "Code", areas: data.areas.filter(function (x) { return x !== "docs" && x !== "Concepts"; }), sorts: ["file", "class", "function"] },
      { name: "Docs", areas: ["docs", "Concepts", "Other"], sorts: sorts },
    ];
    var same = function (set, list) { return set.size === list.length && list.every(function (v) { return set.has(v); }); };
    var openSheet = "";
    function chip(text, on, onclick, mark, n) {
      return el("button", { type: "button", class: "dg-chip", "aria-pressed": String(on), onclick: onclick }, [mark || null, el("span", { text: text }), n != null ? el("small", { text: n.toLocaleString() }) : null]);
    }
    function flip(set, v) { if (set.has(v)) set.delete(v); else set.add(v); refilter(); renderSheet(); }
    function section(title, body, aside) { return el("section", { class: "dg-sheet-section" }, [el("div", { class: "dg-sheet-title" }, [el("span", { text: title }), aside || null]), body]); }
    var folder = el("input", { class: "dg-field", type: "search", placeholder: "For example Core/src or WebKit/src", "aria-label": "Only inside a folder", spellcheck: "false" });
    folder.addEventListener("input", function () { state.folder = folder.value.trim().toLowerCase().replace(/^\.?\//, ""); refilter(); });
    function renderFilters() {
      var view = el("div", { class: "dg-seg", role: "radiogroup", "aria-label": "What to show" }, VIEWS.map(function (v) {
        var on = same(state.areas, v.areas) && same(state.sorts, v.sorts);
        return el("button", { type: "button", role: "radio", "aria-checked": String(on), text: v.name, onclick: function () { state.areas = new Set(v.areas); state.sorts = new Set(v.sorts); refilter(); renderSheet(); } });
      }));
      var kinds = el("div", { class: "dg-chips" }, SORT_ORDER.filter(function (v) { return sortCount[v]; }).map(function (v) {
        return chip(SORT_PLURAL[v], state.sorts.has(v), function () { flip(state.sorts, v); }, el("span", { class: "dg-chip-icon", html: icon(v, 13) }), sortCount[v]);
      }));
      var parts = el("div", { class: "dg-chips" }, data.areas.filter(function (v) { return areaCount[v]; }).map(function (v) {
        return chip(AREA_NAMES[v] || v, state.areas.has(v), function () { flip(state.areas, v); }, el("i", { class: "dg-dot", style: "--c:" + (COLOURS[v] || "#a9b6c2") }), areaCount[v]);
      }));
      var links = el("div", { class: "dg-chips" }, ALL_GROUPS.filter(function (g) { return groupCount[g]; }).map(function (g) {
        var G = GROUPS.find(function (x) { return x.key === g; });
        return chip(G ? G.name : "Other links", state.groups.has(g), function () { flip(state.groups, g); }, el("span", { class: "dg-chip-icon", html: icon(G ? G.icon : "link", 13) }), groupCount[g]);
      }));
      var degree = el("input", { type: "range", min: "0", max: "20", value: String(state.minDegree), "aria-label": "Hide items with fewer links than this" });
      var degreeSays = el("output", { text: state.minDegree ? "At least " + state.minDegree + " links" : "Showing all" });
      degree.addEventListener("input", function () { state.minDegree = Number(degree.value); degreeSays.textContent = state.minDegree ? "At least " + state.minDegree + " links" : "Showing all"; refilter(); });
      var toggle = function (text, key) {
        var c = el("input", { type: "checkbox", role: "switch", checked: state[key] });
        c.addEventListener("change", function () { state[key] = c.checked; store.set(key, c.checked); version++; draw(); });
        return el("label", { class: "dg-switch" }, [el("span", { text: text }), c]);
      };
      return [
        el("header", { class: "dg-sheet-head" }, [el("strong", { text: "Filters" }), el("span", { class: "dg-sheet-count", text: shownCount.toLocaleString() + " of " + count.toLocaleString() + " shown" })]),
        section("Show", view),
        section("Kinds of thing", kinds),
        section("Parts of DSTNS", parts),
        section("Only inside a folder", folder),
        section("Kinds of link", links),
        section("Quiet items", el("label", { class: "dg-range" }, [degree, degreeSays])),
        section("On the map", el("div", { class: "dg-switches" }, [toggle("Names", "labels"), toggle("Curved links", "curves")])),
        el("button", { type: "button", class: "dg-button dg-reset", disabled: isFresh(), html: icon("history", 15) + "<span>Reset filters</span>", onclick: function () { Object.assign(state, fresh()); folder.value = ""; refilter(); renderSheet(); } }),
      ];
    }
    function renderKey() {
      return [
        el("header", { class: "dg-sheet-head" }, [el("strong", { text: "What the colours mean" })]),
        el("p", { class: "dg-sheet-note", text: "Each dot is one file, class, function or page. Its colour is the part of DSTNS it belongs to; a bigger dot has more links. Choose a colour to see only that part, and choose it again to see everything." }),
        el("ul", { class: "dg-key-list" }, data.areas.filter(function (v) { return areaCount[v]; }).map(function (v) {
          var solo = state.areas.size === 1 && state.areas.has(v);
          return el("li", {}, [el("button", { type: "button", "aria-pressed": String(solo), onclick: function () { state.areas = solo ? new Set(data.areas) : new Set([v]); refilter(); renderSheet(); } }, [
            el("i", { class: "dg-dot", style: "--c:" + (COLOURS[v] || "#a9b6c2") }), el("span", { text: AREA_NAMES[v] || v }), el("small", { text: areaCount[v].toLocaleString() }),
          ])]);
        })),
        el("div", { class: "dg-sheet-title" }, [el("span", { text: "Shapes" })]),
        el("ul", { class: "dg-key-list dg-key-kinds" }, SORT_ORDER.filter(function (v) { return sortCount[v]; }).map(function (v) {
          return el("li", {}, [el("span", { class: "dg-key-kind" }, [el("span", { class: "dg-chip-icon", html: icon(v, 14) }), el("span", { text: SORT_PLURAL[v] })])]);
        })),
      ];
    }
    function renderHelp() {
      var row = function (keys, says) { return el("li", {}, [el("span", { class: "dg-keys" }, keys.map(function (k) { return el("kbd", { text: k }); })), el("span", { text: says })]); };
      return [
        el("header", { class: "dg-sheet-head" }, [el("strong", { text: "How to use it" })]),
        el("p", { class: "dg-sheet-note", text: "This is a map of DSTNS's source and documentation. Things that work together sit close together, and a line between two dots means one uses, calls, holds or mentions the other." }),
        el("ol", { class: "dg-steps" }, [
          el("li", { text: "Search in plain words: a name, a topic, or a question such as “what calls seek”." }),
          el("li", { text: "Choose a result or a dot. The card on the right says what it is, where it is, and what it is linked to." }),
          el("li", { text: "Open it on GitHub at the exact line, or follow a link in the card to the next thing." }),
        ]),
        el("div", { class: "dg-sheet-title" }, [el("span", { text: "Try" })]),
        el("div", { class: "dg-chips" }, EXAMPLES.map(function (x) { return el("button", { type: "button", class: "dg-chip", text: x, onclick: function () { ask(x); } }); })),
        el("div", { class: "dg-sheet-title" }, [el("span", { text: "Keys" })]),
        el("ul", { class: "dg-key-list dg-help-keys" }, [row(["/"], "Search"), row(["↑", "↓"], "Move through the results"), row(["↵"], "Open the highlighted result"), row(["Esc"], "Close the card or the search"), row(["+", "−"], "Zoom"), row(["0"], "Show everything")]),
      ];
    }
    function isFresh() { var f = fresh(); return state.folder === "" && state.minDegree === 0 && same(state.areas, data.areas) && same(state.sorts, sorts) && state.groups.size === f.groups.size; }
    function renderSheet() {
      [filterBtn, keyBtn, helpBtn].forEach(function (b) { b.setAttribute("aria-expanded", String(b.dataset.panel === openSheet)); b.classList.toggle("on", b.dataset.panel === openSheet); });
      var changed = !isFresh();
      badge.hidden = !changed;
      if (typeof legend !== "undefined") legend.hidden = !!openSheet;
      if (!openSheet) { sheet.classList.remove("open"); sheet.hidden = true; return; }
      var scroll = sheet.scrollTop, hadFocus = document.activeElement === folder;
      var focused = sheet.contains(document.activeElement) && document.activeElement.tagName === "BUTTON" ? document.activeElement.textContent : null;
      sheet.replaceChildren.apply(sheet, openSheet === "filters" ? renderFilters() : openSheet === "key" ? renderKey() : renderHelp());
      // A chip pressed from the keyboard keeps the focus once the sheet is drawn again.
      if (focused) Array.prototype.some.call(sheet.querySelectorAll("button"), function (b) { if (b.textContent === focused) { b.focus({ preventScroll: true }); return true; } });
      sheet.setAttribute("aria-label", openSheet === "filters" ? "Filters" : openSheet === "key" ? "What the colours mean" : "How to use it");
      sheet.hidden = false;
      sheet.scrollTop = scroll;
      if (hadFocus) folder.focus();
      requestAnimationFrame(function () { sheet.classList.add("open"); });
    }
    // What the colours mean, always at hand at the foot of the map while no sheet is open; it opens the full key.
    var legend = el("button", { type: "button", class: "dg-legend", "aria-label": "What the colours mean", title: "What the colours mean" },
      data.areas.filter(function (v) { return areaCount[v]; }).sort(function (p, q) { return areaCount[q] - areaCount[p]; }).slice(0, 6).map(function (v) {
        return el("span", { class: "dg-legend-item" }, [el("i", { class: "dg-dot", style: "--c:" + (COLOURS[v] || "#a9b6c2") }), el("span", { text: AREA_NAMES[v] || v })]);
      }));
    legend.addEventListener("click", function () { toggleSheet("key"); });
    root.appendChild(legend);
    function toggleSheet(name) {
      var was = openSheet;
      openSheet = openSheet === name ? "" : name;
      if (was && openSheet && was !== openSheet) sheet.classList.remove("open");
      renderSheet();
    }
    [filterBtn, keyBtn, helpBtn].forEach(function (b) { b.addEventListener("click", function () { toggleSheet(b.dataset.panel); }); });

    function refilter() {
      shownCount = 0;
      for (var i = 0; i < count; i++) { shownNode[i] = state.areas.has(areaOf(i)) && state.sorts.has(sortOf(i)) && N.degree[i] >= state.minDegree && (!state.folder || fileOf(i).toLowerCase().indexOf(state.folder) === 0) ? 1 : 0; shownCount += shownNode[i]; }
      for (var k = 0; k < edgeCount; k++) shownEdge[k] = shownNode[E[k * 3]] && shownNode[E[k * 3 + 1]] && state.groups.has(groupOf(k)) ? 1 : 0;
      root.querySelector(".dg-shown").textContent = shownCount.toLocaleString();
      var countLine = sheet.querySelector(".dg-sheet-count");
      if (countLine) countLine.textContent = shownCount.toLocaleString() + " of " + count.toLocaleString() + " shown";
      badge.hidden = isFresh();
      neighbourhood();
      if (input.value.trim()) search(true);
      version++;
      draw();
    }

    // ---- camera ----
    var dpr = 1, W = 0, H = 0, cam = { x: 0, y: 0, s: 1 }, goal = null;
    var sortedX = N.x.slice().sort(function (p, q) { return p - q; }), sortedY = N.y.slice().sort(function (p, q) { return p - q; });
    var at = function (list, q) { return list[Math.min(list.length - 1, Math.max(0, Math.round(q * (list.length - 1))))]; };
    var minX = at(sortedX, 0.01), maxX = at(sortedX, 0.99), minY = at(sortedY, 0.01), maxY = at(sortedY, 0.99);
    function fitView(x0, x1, y0, y1, pad) {
      var left = dock.offsetWidth + 24 + (sheet.hidden ? 0 : sheet.offsetWidth + 12), right = details.hidden ? 0 : details.offsetWidth + 24, topRoom = 84;
      var w = Math.max(80, W - left - right - 24), h = Math.max(80, H - topRoom - 48);
      var s = Math.min(w / Math.max(1, x1 - x0), h / Math.max(1, y1 - y0)) / (pad || 1.1);
      return { s: Math.min(s, 6), x: (x0 + x1) / 2 - (left - right) / 2 / s, y: (y0 + y1) / 2 - (topRoom - 48) / 2 / s };
    }
    function glide(to) {
      if (quiet()) { cam = to; version++; draw(); return; }
      goal = { from: { x: cam.x, y: cam.y, s: cam.s }, to: to, t0: performance.now() };
      draw();
    }
    var frame = 0, clock = 0;
    function draw() {
      if (frame) return;
      frame = requestAnimationFrame(function (now) {
        frame = 0;
        clock = now;
        if (goal) {
          var t = Math.min(1, (now - goal.t0) / 720), k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
          var ls = Math.log(goal.from.s) + (Math.log(goal.to.s) - Math.log(goal.from.s)) * k;
          cam = { x: goal.from.x + (goal.to.x - goal.from.x) * k, y: goal.from.y + (goal.to.y - goal.from.y) * k, s: Math.exp(ls) };
          if (t >= 1) goal = null;
        }
        paint();
        // The chosen item's links flow and its ring breathes; nothing else moves, and nothing does under reduced motion.
        if (goal || (state.selected >= 0 && !quiet() && !document.hidden)) draw();
      });
    }
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = root.clientWidth; H = root.clientHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      base.width = canvas.width; base.height = canvas.height;
      version++;
      draw();
    }
    var toScreen = function (x, y) { return [(x - cam.x) * cam.s + W / 2, (y - cam.y) * cam.s + H / 2]; };
    var toWorld = function (sx, sy) { return [(sx - W / 2) / cam.s + cam.x, (sy - H / 2) / cam.s + cam.y]; };

    var CELL = 12, grid = new Map();
    for (var g0 = 0; g0 < count; g0++) { var key = Math.floor(N.x[g0] / CELL) + "," + Math.floor(N.y[g0] / CELL); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(g0); }
    var radius = function (i) { return 1.4 + Math.sqrt(N.degree[i]) * 0.55; };
    var dot = function (i) { return Math.max(1.2, radius(i) * Math.min(cam.s, 2.4) * 0.9); };
    function nodeAt(sx, sy) {
      var w = toWorld(sx, sy), best = -1, bestD = Infinity, reach = Math.max(7 / cam.s, 3);
      var cx = Math.floor(w[0] / CELL), cy = Math.floor(w[1] / CELL), span = Math.ceil(reach / CELL);
      for (var gx = cx - span; gx <= cx + span; gx++) for (var gy = cy - span; gy <= cy + span; gy++) {
        var list = grid.get(gx + "," + gy); if (!list) continue;
        for (var k = 0; k < list.length; k++) { var n = list[k]; if (!shownNode[n]) continue; var d = Math.hypot(N.x[n] - w[0], N.y[n] - w[1]) - radius(n); if (d < bestD && d < reach) { bestD = d; best = n; } }
      }
      return best;
    }
    // Each community is tinted by the part of DSTNS most of it belongs to.
    var tint = {};
    (function () {
      var tallyBy = {};
      for (var i = 0; i < count; i++) { var c = N.community[i]; var t = tallyBy[c] || (tallyBy[c] = {}); t[N.area[i]] = (t[N.area[i]] || 0) + 1; }
      Object.keys(tallyBy).forEach(function (c) { var best = -1, most = 0; Object.keys(tallyBy[c]).forEach(function (a) { if (tallyBy[c][a] > most) { most = tallyBy[c][a]; best = a; } }); tint[c] = COLOURS[data.areas[best]] || "#a9b6c2"; });
    })();

    // ---- painting: a base layer, drawn again only when the view changes, and a light layer over it every frame ----
    var ctx = canvas.getContext("2d"), base = document.createElement("canvas"), bctx = base.getContext("2d"), css = getComputedStyle(root), drawnVersion = -1, drawnCam = "";
    var colour = function (name, fallback) { return css.getPropertyValue(name).trim() || fallback; };
    function link(c, p, q) {
      c.moveTo(p[0], p[1]);
      if (!state.curves) { c.lineTo(q[0], q[1]); return; }
      // A gentle arc, bending the same way for the same pair, so bundles read as flows rather than a mesh.
      var mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2, dx = q[0] - p[0], dy = q[1] - p[1];
      c.quadraticCurveTo(mx - dy * 0.14, my + dx * 0.14, q[0], q[1]);
    }
    function pill(c, x, y, w, h) { var r = h / 2; c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
    var centreOf = function () { return state.selected >= 0 ? state.selected : state.hover; };
    function paintBase() {
      var halo = colour("--dg-bg", "#eef1f4");
      var c = bctx, fg = colour("--dg-fg", "#16242e"), line = colour("--dg-line", "rgba(16,32,44,0.10)"), grain = colour("--dg-grain", "rgba(16,32,44,0.08)"), labelBg = colour("--dg-label-bg", "rgba(255,255,255,0.9)");
      var islandAlpha = Number(colour("--dg-island-alpha", "0.07")), accent = colour("--dg-accent", "#086578");
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      // A dot grid that moves with the map, so a pan reads as a pan.
      var step = 28 * Math.pow(2, Math.round(Math.log2(1 / Math.max(cam.s, 0.05)) )) * cam.s;
      if (step < 14) step *= 2;
      var ox = ((W / 2 - cam.x * cam.s) % step + step) % step, oy = ((H / 2 - cam.y * cam.s) % step + step) % step;
      c.fillStyle = grain;
      for (var gx = ox; gx < W; gx += step) for (var gy = oy; gy < H; gy += step) c.fillRect(gx - 0.75, gy - 0.75, 1.5, 1.5);
      var centre = centreOf(), focus = centre >= 0, dim = function (i) { return focus ? !near[i] : matching && !matched[i]; };
      var x0 = toWorld(0, 0), x1 = toWorld(W, H);
      var inView = function (i, m) { return N.x[i] > x0[0] - m && N.x[i] < x1[0] + m && N.y[i] > x0[1] - m && N.y[i] < x1[1] + m; };
      data.communities.forEach(function (cm) {
        var r = cm.r * cam.s; if (r < 3) return;
        var p = toScreen(cm.x, cm.y); if (p[0] + r < 0 || p[0] - r > W || p[1] + r < 0 || p[1] - r > H) return;
        var g = c.createRadialGradient(p[0], p[1], r * 0.1, p[0], p[1], r);
        g.addColorStop(0, tint[cm.id] || "#a9b6c2"); g.addColorStop(1, "transparent");
        c.globalAlpha = (focus || matching ? 0.5 : 1) * islandAlpha; c.fillStyle = g; c.beginPath(); c.arc(p[0], p[1], r, 0, Math.PI * 2); c.fill();
      });
      c.globalAlpha = focus || matching ? 0.35 : 1;
      c.lineWidth = Math.max(0.4, Math.min(1, cam.s * 0.25));
      c.strokeStyle = line;
      c.beginPath();
      for (var k = 0; k < edgeCount; k++) {
        if (!shownEdge[k]) continue;
        var s = E[k * 3], t = E[k * 3 + 1];
        if (!inView(s, 40) && !inView(t, 40)) continue;
        link(c, toScreen(N.x[s], N.y[s]), toScreen(N.x[t], N.y[t]));
      }
      c.stroke();
      c.globalAlpha = 1;
      var byArea = {};
      for (var i = 0; i < count; i++) { if (!shownNode[i] || !inView(i, 10)) continue; (byArea[N.area[i]] = byArea[N.area[i]] || []).push(i); }
      Object.keys(byArea).forEach(function (area) {
        c.fillStyle = COLOURS[data.areas[area]] || "#a9b6c2";
        byArea[area].forEach(function (n) {
          var p = toScreen(N.x[n], N.y[n]);
          c.globalAlpha = dim(n) ? 0.14 : 0.95;
          c.beginPath(); c.arc(p[0], p[1], dot(n), 0, Math.PI * 2); c.fill();
        });
      });
      c.globalAlpha = 1;
      if (matching && !focus) {
        c.strokeStyle = accent; c.lineWidth = 1.5;
        for (var mm = 0; mm < count; mm++) if (matched[mm] && shownNode[mm] && inView(mm, 10)) { var mp = toScreen(N.x[mm], N.y[mm]); c.beginPath(); c.arc(mp[0], mp[1], dot(mm) + 3, 0, Math.PI * 2); c.stroke(); }
      }
      if (!state.labels) return;
      c.textAlign = "center"; c.textBaseline = "middle";
      var taken = [];
      var free = function (x, y, w, h) { for (var j = 0; j < taken.length; j++) { var b = taken[j]; if (x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]) return false; } taken.push([x, y, w, h]); return true; };
      // Close up, or round a chosen item, things are named; further out, communities are.
      if (cam.s >= 1.3 || focus || matching) {
        c.font = "500 11px Inter, system-ui, sans-serif";
        var order = [];
        for (var n = 0; n < count; n++) if (shownNode[n] && inView(n, 0) && (cam.s >= 1.3 ? !focus || near[n] : near[n] || matched[n])) order.push(n);
        order.sort(function (p, q) { return (q === centre) - (p === centre) || (near[q] - near[p]) || (matched[q] - matched[p]) || (N.degree[q] - N.degree[p]); });
        var drawn = 0;
        for (var o = 0; o < order.length && drawn < 160; o++) {
          var m = order[o], pt = toScreen(N.x[m], N.y[m]), text = shortName[m].length > 34 ? shortName[m].slice(0, 32) + "…" : shortName[m], tw = c.measureText(text).width;
          var y = pt[1] + dot(m) + 11;
          if (!free(pt[0] - tw / 2 - 9, y - 11, tw + 18, 22)) continue;
          c.globalAlpha = dim(m) ? 0.35 : 1;
          if (focus && near[m]) { c.fillStyle = labelBg; pill(c, pt[0] - tw / 2 - 6, y - 9, tw + 12, 18); c.fill(); }
          else {
            // A halo of the page's own colour, so a name stays legible over the dots and links beneath it.
            c.lineWidth = 3.5; c.lineJoin = "round"; c.strokeStyle = halo; c.strokeText(text, pt[0], y + 0.5);
          }
          c.fillStyle = m === centre ? accent : fg;
          c.fillText(text, pt[0], y + 0.5); drawn++;
        }
        c.globalAlpha = 1;
      }
      if (cam.s < 1.6 && !focus) {
        c.font = "600 12px Inter, system-ui, sans-serif";
        data.communities.slice().sort(function (p, q) { return q.r - p.r; }).forEach(function (cm) {
          var p = toScreen(cm.x, cm.y); if (p[0] < -100 || p[0] > W + 100 || p[1] < -40 || p[1] > H + 40 || cm.r * cam.s < 14) return;
          var name = cm.name.length > 28 ? cm.name.slice(0, 26) + "…" : cm.name, w = c.measureText(name).width + 20;
          if (!free(p[0] - w / 2, p[1] - 12, w, 24)) return;
          c.globalAlpha = matching ? 0.55 : 1;
          c.fillStyle = labelBg; pill(c, p[0] - w / 2, p[1] - 12, w, 24); c.fill();
          c.fillStyle = tint[cm.id] || fg; c.beginPath(); c.arc(p[0] - w / 2 + 11, p[1], 3, 0, Math.PI * 2); c.fill();
          c.fillStyle = fg; c.fillText(name, p[0] + 4, p[1] + 0.5);
        });
        c.globalAlpha = 1;
      }
    }
    function paint() {
      var camKey = cam.x + "," + cam.y + "," + cam.s;
      if (drawnVersion !== version || drawnCam !== camKey) { paintBase(); drawnVersion = version; drawnCam = camKey; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(base, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var centre = centreOf();
      if (centre < 0) return;
      var accent = colour("--dg-accent", "#086578"), fg = colour("--dg-fg", "#16242e"), moving = state.selected >= 0 && !quiet();
      // The links round it, drawn over the rest and flowing from what uses to what is used.
      ctx.lineWidth = 1.6; ctx.strokeStyle = accent;
      ctx.setLineDash(moving ? [6, 7] : []);
      ctx.lineDashOffset = moving ? -(clock / 45) % 13 : 0;
      ctx.beginPath();
      for (var f = 0; f < edgeCount; f++) {
        if (!shownEdge[f] || !near[E[f * 3]] || !near[E[f * 3 + 1]]) continue;
        if (state.depth === 1 && E[f * 3] !== centre && E[f * 3 + 1] !== centre) continue;
        link(ctx, toScreen(N.x[E[f * 3]], N.y[E[f * 3]]), toScreen(N.x[E[f * 3 + 1]], N.y[E[f * 3 + 1]]));
      }
      ctx.globalAlpha = 0.85; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      var c = toScreen(N.x[centre], N.y[centre]), r = dot(centre);
      ctx.fillStyle = colourOf(centre); ctx.beginPath(); ctx.arc(c[0], c[1], r + 1, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = fg; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(c[0], c[1], r + 4.5, 0, Math.PI * 2); ctx.stroke();
      if (moving) {
        // A ring that leaves it every two seconds and fades as it widens: where it is, at a glance.
        var phase = (clock % 2000) / 2000;
        ctx.globalAlpha = (1 - phase) * 0.6; ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(c[0], c[1], r + 5 + phase * 26, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    function neighbourhood() {
      near.fill(0);
      var centre = centreOf();
      if (centre < 0) return;
      var frontier = [centre]; near[centre] = 1;
      for (var d = 0; d < state.depth; d++) {
        var next = [];
        frontier.forEach(function (v) { adjacency[v].forEach(function (k) { if (!shownEdge[k]) return; var o = E[k * 3] === v ? E[k * 3 + 1] : E[k * 3]; if (!near[o]) { near[o] = 1; next.push(o); } }); });
        frontier = next;
      }
    }

    // ---- the card: what it is, where it is, and what it is linked to ----
    function sourceUrl(i) { var f = fileOf(i); return f ? "https://github.com/" + data.repo + "/blob/" + data.commit + "/" + f + (N.line[i] ? "#L" + N.line[i] : "") : null; }
    function where(i) { var f = fileOf(i); return f ? f.split("/").pop() + (N.line[i] ? ":" + N.line[i] : "") : AREA_NAMES[areaOf(i)] || ""; }
    function nameNode(i, words0) {
      var holder = el("span", { class: "dg-name" });
      if (owner[i]) holder.appendChild(el("span", { class: "dg-owner", text: owner[i] + (N.label[i].indexOf("::") > 0 ? "::" : ".") }));
      var name = el("span", { class: "dg-short" });
      var text = shortName[i], marks = (words0 || []).filter(function (w) { return w.length > 2; });
      // The words searched for are marked where they appear in the name.
      if (marks.length) name.innerHTML = escapeHtml(text).replace(new RegExp("(" + marks.map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|") + ")", "ig"), "<mark>$1</mark>");
      else name.textContent = text;
      holder.appendChild(name);
      return holder;
    }
    function row(o) {
      var url = sourceUrl(o);
      return el("li", { class: "dg-row" }, [
        el("button", { type: "button", class: "dg-row-main", title: N.label[o] + (fileOf(o) ? " — " + fileOf(o) + (N.line[o] ? ", line " + N.line[o] : "") : ""), onclick: function () { select(o, true); } }, [
          el("span", { class: "dg-kind", style: "--c:" + colourOf(o), html: icon(sortOf(o), 14) }),
          nameNode(o),
          el("small", { class: "dg-row-where", text: where(o) }),
        ]),
        url ? el("a", { class: "dg-row-open", href: url, target: "_blank", rel: "noopener", "aria-label": "Open " + N.label[o] + " on GitHub", title: "Open on GitHub", html: icon("external", 14) }) : null,
      ]);
    }
    var cardTab = "";
    function select(i, move) {
      state.selected = i; state.hover = -1;
      neighbourhood();
      version++;
      if (i < 0) { details.classList.remove("open"); details.hidden = true; history.replaceState(null, "", location.pathname + location.search); draw(); return; }
      history.replaceState(null, "", "#node=" + encodeURIComponent(N.id[i]));
      var file = fileOf(i), url = sourceUrl(i), tabs = [];
      GROUPS.forEach(function (g) {
        var out = new Set(), inn = new Set();
        adjacency[i].forEach(function (k) {
          if (!shownEdge[k] || groupOf(k) !== g.key) return;
          if (E[k * 3] === i) out.add(E[k * 3 + 1]); else inn.add(E[k * 3]);
        });
        if (out.size) tabs.push({ id: g.key + ">", name: g.outName, icon: g.icon, list: Array.from(out) });
        if (inn.size) tabs.push({ id: g.key + "<", name: g.inName, icon: g.icon, list: Array.from(inn) });
      });
      if (!tabs.some(function (t) { return t.id === cardTab; })) cardTab = tabs.length ? tabs[0].id : "";
      // One sentence first: what it is and where, in words.
      var kind = (SORT_NAMES[sortOf(i)] || "Item").toLowerCase(), part = AREA_NAMES[areaOf(i)] || areaOf(i);
      var sentence = "A " + kind + " in " + (part === "Ideas" ? "the ideas behind DSTNS" : "the " + part.charAt(0).toLowerCase() + part.slice(1)) + (file && sortOf(i) !== "file" ? ", in " + file.split("/").pop() + (N.line[i] > 1 ? " at line " + N.line[i] : "") : "") + ".";
      var SAYS = { "contains>": "holds", "contains<": "sits inside", "calls>": "calls", "calls<": "is called by", "imports>": "depends on", "imports<": "is used by", "inherits>": "builds on", "inherits<": "is built on by", "references>": "mentions", "references<": "is mentioned by" };
      var parts = tabs.slice(0, 3).map(function (t, k) { return SAYS[t.id] + " " + t.list.length.toLocaleString() + (k === 0 ? (t.list.length === 1 ? " thing" : " things") : ""); });
      if (parts.length) sentence += " It " + (parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0]) + ".";
      var list = el("ul", { class: "dg-rows" }), body = el("div", { class: "dg-tab-body" }, [list]);
      function fill() {
        var tab = tabs.find(function (t) { return t.id === cardTab; });
        list.replaceChildren(); body.querySelectorAll(".dg-more").forEach(function (b) { b.remove(); });
        if (!tab) return;
        var sorted = tab.list.slice().sort(function (p, q) { return (fileOf(p) === fileOf(q) ? (N.line[p] || 1e9) - (N.line[q] || 1e9) : fileOf(p).localeCompare(fileOf(q))) || N.label[p].localeCompare(N.label[q]); });
        var limit = 24;
        var put = function (n) { list.replaceChildren.apply(list, sorted.slice(0, n).map(row)); };
        put(limit);
        if (sorted.length > limit) {
          var more = el("button", { type: "button", class: "dg-more", text: "Show all " + sorted.length, onclick: function () { put(Math.min(sorted.length, 600)); more.remove(); } });
          body.appendChild(more);
        }
      }
      var tabRow = el("div", { class: "dg-tabs", role: "tablist", "aria-label": "Links" }, tabs.map(function (t) {
        return el("button", { type: "button", role: "tab", "aria-selected": String(t.id === cardTab), onclick: function (ev) { cardTab = t.id; tabRow.querySelectorAll("[role=tab]").forEach(function (b) { b.setAttribute("aria-selected", String(b === ev.currentTarget)); }); fill(); } }, [
          el("span", { class: "dg-tab-icon", html: icon(t.icon, 13) }), el("span", { text: t.name }), el("small", { text: t.list.length.toLocaleString() }),
        ]);
      }));
      fill();
      var copy = el("button", { class: "dg-icon-btn", type: "button", "aria-label": "Copy a link to this", title: "Copy a link to this", html: icon("copy", 16), onclick: function () {
        if (navigator.clipboard) navigator.clipboard.writeText(location.href);
        copy.innerHTML = icon("check", 16); copy.classList.add("done");
        setTimeout(function () { copy.innerHTML = icon("copy", 16); copy.classList.remove("done"); }, 1400);
      } });
      var depth = el("div", { class: "dg-seg dg-seg-small", role: "radiogroup", "aria-label": "How much to light round it" }, [[1, "Direct links"], [2, "2 steps"], [3, "3 steps"]].map(function (d) {
        return el("button", { type: "button", role: "radio", "aria-checked": String(state.depth === d[0]), text: d[1], onclick: function () { state.depth = d[0]; select(i, false); } });
      }));
      var crumbs = file ? file.split("/") : [];
      details.replaceChildren(
        el("header", { class: "dg-card-head" }, [
          el("span", { class: "dg-head-icon", style: "--c:" + colourOf(i), html: icon(sortOf(i), 22) }),
          el("div", { class: "dg-head-text" }, [
            owner[i] ? el("small", { class: "dg-head-owner", text: owner[i] }) : null,
            el("h2", { text: shortName[i] }),
            el("p", {}, [el("span", { text: SORT_NAMES[sortOf(i)] || "Item" }), el("i", { class: "dg-dot", style: "--c:" + colourOf(i) }), el("span", { text: part })]),
          ]),
          copy,
          el("button", { class: "dg-icon-btn", type: "button", "aria-label": "Close", title: "Close", html: icon("close", 16), onclick: function () { select(-1); } }),
        ]),
        el("p", { class: "dg-sentence", text: sentence }),
        file ? el("a", { class: "dg-source", href: url, target: "_blank", rel: "noopener" }, [
          el("span", { class: "dg-source-icon", html: icon("github", 18) }),
          el("span", { class: "dg-source-text" }, [el("b", { text: "Open on GitHub" + (N.line[i] > 1 ? " at line " + N.line[i] : "") }), el("span", { class: "dg-crumbs", text: crumbs.join(" / ") })]),
          el("span", { class: "dg-source-go", html: icon("external", 15) }),
        ]) : null,
        el("div", { class: "dg-card-row" }, [
          el("button", { class: "dg-group-link", type: "button", title: "Show its group on the map", onclick: function () { focusCommunity(N.community[i]); } }, [el("span", { html: icon("group", 14) }), el("span", { text: "Group: " + (commName[N.community[i]] || "—") })]),
        ]),
        tabs.length ? el("div", { class: "dg-card-links" }, [el("div", { class: "dg-card-links-head" }, [el("strong", { text: "Linked to" }), depth]), tabRow, body]) : el("p", { class: "dg-empty", text: "Nothing is linked to it with the filters as they are." }),
      );
      details.hidden = false;
      requestAnimationFrame(function () { details.classList.add("open"); });
      live.textContent = N.label[i] + ", " + (SORT_NAMES[sortOf(i)] || "item") + " in " + part;
      if (move) { var span = 60 / Math.max(cam.s, 0.8); var to = fitView(N.x[i] - span, N.x[i] + span, N.y[i] - span, N.y[i] + span, 1); to.s = Math.max(cam.s, 2.2); glide(to); }
      draw();
    }
    function focusCommunity(c) {
      var cm = data.communities.find(function (x) { return x.id === c; }); if (!cm) return;
      glide(fitView(cm.x - cm.r, cm.x + cm.r, cm.y - cm.r, cm.y + cm.r, 1.25));
    }

    // ---- search ----
    var hits = [], active = -1, lastQuery = null;
    function remember(text) { var recent = store.get("recent", []).filter(function (x) { return x !== text; }); recent.unshift(text); store.set("recent", recent.slice(0, 5)); }
    function ask(text) { input.value = text; openSheet = ""; renderSheet(); input.focus(); search(); }
    function suggestions() {
      results.replaceChildren();
      hits = []; active = -1;
      var recent = store.get("recent", []);
      var list = el("ul", { role: "listbox", class: "dg-hit-list", "aria-label": "Suggestions" });
      var put = function (text, iconName) {
        var k = hits.length; hits.push({ text: text });
        list.appendChild(el("li", { role: "option", id: "dg-hit-" + k, class: "dg-suggest", "aria-selected": "false", onmousedown: function (ev) { ev.preventDefault(); ask(text); } }, [el("span", { class: "dg-kind plain", html: icon(iconName, 14) }), el("span", { text: text })]));
      };
      if (recent.length) { list.appendChild(el("li", { class: "dg-hit-head", role: "presentation", text: "Recent" })); recent.forEach(function (t) { put(t, "history"); }); }
      list.appendChild(el("li", { class: "dg-hit-head", role: "presentation", text: "Try asking" }));
      EXAMPLES.forEach(function (t) { put(t, "spark"); });
      results.appendChild(list);
      showResults(true);
    }
    function showResults(on) { results.hidden = !on; input.setAttribute("aria-expanded", String(on)); searchBox.classList.toggle("open", on); }
    function search(silent) {
      var text = input.value;
      clear.hidden = !text;
      matched.fill(0); matching = false;
      if (!text.trim()) { lastQuery = null; version++; draw(); if (document.activeElement === input && !silent) suggestions(); else showResults(false); return; }
      results.replaceChildren(); hits = []; active = -1;
      var q = understand(text), found, said = "", subject = -1;
      lastQuery = q;
      if (q.relation) {
        subject = subjectOf(q.relation.subject, q.relation.group, q.relation.dir);
        var g = GROUPS.find(function (x) { return x.key === q.relation.group; });
        found = subject < 0 ? [] : rank(q, around(subject, q.relation.group, q.relation.dir));
        said = (q.relation.dir === "out" ? g.outSays : g.inSays) + " " + (subject < 0 ? "“" + q.relation.subject + "”" : N.label[subject]);
        if (!found.length) {
          // No answer the graph knows of: say so, and show what has that name instead.
          said = "The graph has no answer to that" + (subject >= 0 ? " for " + N.label[subject] : "") + ". Things named “" + q.relation.subject + "”:";
          q = { words: words(q.relation.subject), in: q.in, sort: q.sort, file: q.file, relation: null, typing: false };
          found = rank(q, null);
          subject = -1;
        }
      } else found = rank(q, null);
      var filters = [];
      if (q.sort.length) filters.push(q.sort.map(function (s) { return (SORT_PLURAL[s] || s).toLowerCase(); }).join(" and "));
      if (q.in.length) filters.push("in " + q.in.map(function (x) { var k = data.areas.find(function (y) { return y.toLowerCase() === x; }); return "the " + (AREA_NAMES[k] || x).toLowerCase(); }).join(" or "));
      if (q.file.length) filters.push("in files named " + q.file.join(", "));
      if (!said && filters.length) said = "Only " + filters.join(", ");
      else if (said && filters.length) said += ", only " + filters.join(", ");
      found.forEach(function (f) { matched[f[1]] = 1; });
      matching = found.length > 0;
      version++;
      if (said) results.appendChild(el("div", { class: "dg-understood" }, [el("span", { html: icon("spark", 14) }), el("span", { text: said }), subject >= 0 ? el("button", { type: "button", class: "dg-understood-go", text: "Open it", onmousedown: function (ev) { ev.preventDefault(); closeSearch(); select(subject, true); } }) : null]));
      var list = el("ul", { role: "listbox", class: "dg-hit-list", "aria-label": "Results" });
      var option = function (i, top) {
        var k = hits.length; hits.push({ node: i });
        // The handlers read the option's place when they run: "Show more" can move it.
        return el("li", { role: "option", id: "dg-hit-" + k, class: top ? "dg-top-hit" : "", "aria-selected": "false", onmousedown: function (ev) { ev.preventDefault(); choose(Number(ev.currentTarget.id.slice(7))); }, onmousemove: function (ev) { var at0 = Number(ev.currentTarget.id.slice(7)); if (active !== at0) mark(at0, true); } }, [
          el("span", { class: "dg-kind", style: "--c:" + colourOf(i), html: icon(sortOf(i), top ? 18 : 14) }),
          el("span", { class: "dg-hit-text" }, [nameNode(i, q.words), el("small", { text: (top ? (SORT_NAMES[sortOf(i)] || "Item") + " · " + (AREA_NAMES[areaOf(i)] || "") + " · " : "") + (fileOf(i) ? fileOf(i) + (N.line[i] ? ":" + N.line[i] : "") : commName[N.community[i]] || "") })]),
          top ? el("kbd", { class: "dg-enter", html: icon("enter", 13) }) : null,
        ]);
      };
      if (!found.length) {
        list.appendChild(el("li", { class: "dg-none", role: "presentation" }, [el("strong", { text: "Nothing found" }), el("span", { text: isFresh() ? "Try fewer words, another name, or one of the questions in Help." : "A filter may be hiding it. Reset the filters, or try other words." })]));
      } else {
        list.appendChild(el("li", { class: "dg-hit-head", role: "presentation", text: q.relation ? "Answer" : "Best match" }));
        list.appendChild(option(found[0][1], true));
        // The rest, grouped by what they are, a few of each, best groups first.
        var groups = {}, orderOf = [];
        found.slice(1, 160).forEach(function (f) { var s = sortOf(f[1]); if (!groups[s]) { groups[s] = []; orderOf.push(s); } groups[s].push(f[1]); });
        orderOf.forEach(function (s) {
          var members = groups[s], shown = members.slice(0, 5);
          list.appendChild(el("li", { class: "dg-hit-head", role: "presentation" }, [el("span", { text: SORT_PLURAL[s] || s }), el("small", { text: members.length >= 159 ? "many" : String(members.length) })]));
          shown.forEach(function (i) { list.appendChild(option(i, false)); });
          if (members.length > shown.length) {
            var more = el("li", { class: "dg-hit-more", role: "presentation" }, [el("button", { type: "button", tabindex: "-1", text: "Show " + (members.length - shown.length) + " more " + (SORT_PLURAL[s] || "").toLowerCase(), onmousedown: function (ev) {
              ev.preventDefault();
              var after = more;
              members.slice(5, 40).forEach(function (i) { var li = option(i, false); after.parentNode.insertBefore(li, after); });
              more.remove();
              renumber();
            } })]);
            list.appendChild(more);
          }
        });
      }
      results.appendChild(list);
      results.appendChild(el("div", { class: "dg-results-foot" }, [
        el("span", { text: found.length ? found.length.toLocaleString() + (found.length === 1 ? " match" : " matches") + ", ringed on the map" : "" }),
        el("span", { class: "dg-keys" }, [el("kbd", { text: "↑" }), el("kbd", { text: "↓" }), " to move ", el("kbd", { text: "↵" }), " to open"]),
      ]));
      if (!silent) showResults(true);
      live.textContent = found.length ? found.length + " matches" : "Nothing found";
      draw();
    }
    // Options added by "Show more" take their place in the keyboard order.
    function renumber() {
      var next = [];
      results.querySelectorAll("[role=option]").forEach(function (li, k) {
        next.push(hits[Number(li.id.slice(7))]); li.id = "dg-hit-" + k;
      });
      hits = next;
    }
    function closeSearch() { showResults(false); input.blur(); }
    function choose(k) {
      var h = hits[k]; if (!h) return;
      if (h.text) { ask(h.text); return; }
      remember(input.value.trim());
      closeSearch();
      select(h.node, true);
    }
    function mark(k, fromPointer) {
      if (!hits.length) return;
      active = (k + hits.length) % hits.length;
      results.querySelectorAll("[role=option]").forEach(function (o, j) { o.setAttribute("aria-selected", String(j === active)); if (j === active && !fromPointer) o.scrollIntoView({ block: "nearest" }); });
      input.setAttribute("aria-activedescendant", "dg-hit-" + active);
    }
    var pending = 0;
    input.addEventListener("input", function () { clearTimeout(pending); pending = setTimeout(search, 70); });
    input.addEventListener("focus", function () { if (input.value.trim()) { search(); } else suggestions(); });
    input.addEventListener("blur", function () { setTimeout(function () { if (document.activeElement !== input) showResults(false); }, 120); });
    clear.addEventListener("click", function () { input.value = ""; input.focus(); search(); });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown") { ev.preventDefault(); if (results.hidden) search(); mark(active + 1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); mark(active - 1); }
      else if (ev.key === "Enter") { ev.preventDefault(); clearTimeout(pending); if (!lastQuery || active < 0) search(); choose(active < 0 ? (hits[0] && hits[0].text ? -1 : 0) : active); }
      else if (ev.key === "Escape") { ev.preventDefault(); if (input.value) { input.value = ""; search(); } else closeSearch(); }
    });
    document.addEventListener("keydown", function (ev) {
      if (!document.body.contains(root)) return;
      var typing = /input|textarea|select/i.test(document.activeElement.tagName);
      if (ev.key === "/" && !typing) { ev.preventDefault(); input.focus(); }
      else if (ev.key === "Escape" && !typing) { if (state.selected >= 0) select(-1); else if (openSheet) toggleSheet(openSheet); }
      else if (!typing && !ev.metaKey && !ev.ctrlKey && (ev.key === "+" || ev.key === "=")) zoomIn.click();
      else if (!typing && !ev.metaKey && !ev.ctrlKey && ev.key === "-") zoomOut.click();
      else if (!typing && !ev.metaKey && !ev.ctrlKey && ev.key === "0") fitButton.click();
    });

    // ---- pointer ----
    var drag = null, moved = false, pinch = null;
    canvas.addEventListener("pointerdown", function (ev) { canvas.setPointerCapture(ev.pointerId); drag = { x: ev.clientX, y: ev.clientY, cx: cam.x, cy: cam.y }; moved = false; goal = null; tip.hidden = true; });
    canvas.addEventListener("pointermove", function (ev) {
      var r = canvas.getBoundingClientRect(), sx = ev.clientX - r.left, sy = ev.clientY - r.top;
      if (drag) {
        if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 3) { moved = true; canvas.classList.add("dragging"); }
        cam.x = drag.cx - (ev.clientX - drag.x) / cam.s; cam.y = drag.cy - (ev.clientY - drag.y) / cam.s; draw(); return;
      }
      var n = nodeAt(sx, sy);
      if (n !== state.hover) { state.hover = n; if (state.selected < 0) { neighbourhood(); version++; draw(); } }
      canvas.style.cursor = n >= 0 ? "pointer" : "";
      if (n >= 0) {
        tip.replaceChildren(el("span", { class: "dg-kind", style: "--c:" + colourOf(n), html: icon(sortOf(n), 13) }), el("span", { class: "dg-tip-text" }, [el("b", { text: shortName[n] }), el("small", { text: (SORT_NAMES[sortOf(n)] || "") + " · " + where(n) })]));
        tip.hidden = false;
        var tw = tip.offsetWidth;
        tip.style.transform = "translate(" + Math.min(sx + 16, W - tw - 12) + "px," + Math.min(sy + 16, H - 60) + "px)";
      } else tip.hidden = true;
    });
    canvas.addEventListener("pointerup", function (ev) {
      var r = canvas.getBoundingClientRect();
      canvas.classList.remove("dragging");
      if (drag && !moved) { var n = nodeAt(ev.clientX - r.left, ev.clientY - r.top); if (n >= 0 || state.selected >= 0) select(n, false); }
      drag = null;
    });
    canvas.addEventListener("pointerleave", function () { tip.hidden = true; if (state.hover >= 0) { state.hover = -1; if (state.selected < 0) { neighbourhood(); version++; draw(); } } });
    function zoomAt(sx, sy, factor) {
      var w = toWorld(sx, sy);
      cam.s = Math.max(0.05, Math.min(12, cam.s * factor));
      cam.x = w[0] - (sx - W / 2) / cam.s; cam.y = w[1] - (sy - H / 2) / cam.s;
      draw();
    }
    canvas.addEventListener("wheel", function (ev) {
      ev.preventDefault(); goal = null; tip.hidden = true;
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
    new MutationObserver(function () { css = getComputedStyle(root); version++; draw(); }).observe(document.body, { attributes: true, attributeFilter: ["data-md-color-scheme"] });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) draw(); });
    resize();
    refilter();
    renderSheet();
    var wanted = /node=([^&]+)/.exec(location.hash), asked = /[?&]q=([^&]+)/.exec(location.search);
    var found0 = wanted ? N.id.indexOf(decodeURIComponent(wanted[1])) : -1;
    // The welcome opens first, so the whole graph is framed beside it rather than behind it.
    if (!store.get("welcomed", false) && found0 < 0 && !asked) { openSheet = "help"; renderSheet(); store.set("welcomed", true); }
    cam = fitView(minX, maxX, minY, maxY);
    if (found0 >= 0) select(found0, true);
    if (asked) { input.value = decodeURIComponent(asked[1].replace(/\+/g, " ")); search(true); }
    version++;
    draw();
  }

  function boot() { start(document.getElementById("dstns-graph")); }
  if (window.document$ && window.document$.subscribe) window.document$.subscribe(boot);
  else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
