// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The documentation's search: what a question means, and which pages answer it.
//
// Material for MkDocs writes every page and section into search/search_index.json. This reads it into MiniSearch
// (MIT, vendor/minisearch.js), a full-text engine that ranks with BM25, and adds what makes a question in plain words
// find its page, without any model:
//
//   - Question words go ("how do I", "what is", "where can I"), and so do words that carry no meaning ("the", "a").
//   - Words are reduced to their stem, in the index and in the question alike, so "configuring", "configured" and
//     "configuration" are one word, and "cities" is "city".
//   - DSTNS's own words have their equivalents: "speed" finds the tick rate, "delete" finds reset, "city" finds places.
//     An equivalent counts for less than the word typed.
//   - A word still being typed matches as a prefix; a longer one forgives a typo (one letter in five).
//   - Code is found as written and in parts: "api.port", "tick_rate" and "tickRate" are also "api", "port", "tick".
//   - A page answers when it has most of what was asked: every word for a question of one or two, most of them for a
//     longer one; the more it has, the higher it ranks. Titles count four times what text does, and pages that set
//     search.boost in their front matter count for more.
//
// search-ui.js draws the results. window.DSTNSSearch.pages(query) gives them in the shape it draws; until the index
// has loaded, it draws Material's own.
(function () {
  "use strict";
  if (!window.MiniSearch) return;

  var STOP = new Set(("a an and are as at be been being but by can could did do does doing done for from had has have " +
    "having he her here hers him his i if in into is it its itself just me might more most my no nor not of off on once " +
    "only or other our ours out over own same she should so some such than that the their theirs them then there these " +
    "they this those through to too under until up very was we were what when where which while who whom why will with " +
    "would you your yours yourself about above after again against all am any because before below between both during " +
    "each few further how let lets want need like please thing things way get got make using use everything anything " +
    "something stuff whole").split(" "));
  // Phrasings that only say a question is being asked.
  var ASKING = /^(?:how\s+(?:do|can|should|would|does|could)\s+(?:i|you|we|one)\s+|how\s+to\s+|what(?:'s|\s+is|\s+are|\s+does|\s+do)?\s+|where\s+(?:is|are|do|can|does)(?:\s+(?:i|you|we))?\s+|why\s+(?:does|is|do|did|are|can't|won't)?\s*|when\s+(?:does|is|do|should)?\s*|which\s+|can\s+(?:i|you|we)\s+|is\s+(?:it|there)\s+|are\s+there\s+|show\s+me\s+|tell\s+me\s+(?:about\s+)?|i\s+(?:want|need|would\s+like)\s+to\s+|explain\s+|help\s+(?:me\s+)?(?:with\s+)?)/;

  // DSTNS's words and what else they are called. Keys and values are as typed; they are stemmed when used.
  var RELATED = {
    speed: ["tick", "rate", "playback", "fast"], fast: ["speed", "performance"], slow: ["speed", "performance", "lag"],
    change: ["set", "configure", "edit"], set: ["change", "configure"], configure: ["configuration", "setting", "set"],
    setting: ["configuration", "config", "option"], config: ["configuration", "setting"], option: ["setting", "flag"],
    start: ["launch", "run", "begin"], launch: ["start", "launcher"], run: ["start", "launch"], begin: ["start"],
    stop: ["terminate", "end", "quit"], quit: ["stop", "exit"], end: ["stop", "complete"], kill: ["stop", "terminate"],
    delete: ["remove", "reset", "clear"], remove: ["delete", "reset"], clear: ["reset", "delete"], reset: ["clear", "delete"],
    install: ["installation", "setup", "build"], setup: ["install", "installation", "first"], build: ["building", "compile"],
    error: ["errors", "failure", "troubleshooting"], fail: ["failure", "error", "troubleshooting"], problem: ["troubleshooting", "error"],
    broken: ["troubleshooting", "error"], issue: ["troubleshooting", "limitation"], bug: ["troubleshooting", "security"],
    city: ["place", "country", "catalogue"], cities: ["place", "catalogue"], place: ["city", "country"], country: ["place", "city"],
    location: ["place", "city"], where: ["place"], map: ["osm", "openstreetmap", "district"], osm: ["openstreetmap", "map"],
    engine: ["core", "simulation"], legacy: ["core-legacy"], port: ["host", "address", "8090"], address: ["host", "port"],
    docker: ["container", "image", "compose"], container: ["docker", "image"], api: ["endpoint", "route", "http"],
    endpoint: ["route", "api"], route: ["endpoint", "path"], app: ["application", "webfabric"], plugin: ["application", "webfabric"],
    ai: ["mcp", "model", "assistant"], llm: ["model", "mcp"], model: ["narration", "mcp"], chatgpt: ["mcp", "model"], claude: ["mcp", "skill"],
    seed: ["deterministic", "reproducibility"], same: ["deterministic", "reproducibility"], random: ["seed", "rng"],
    jump: ["seek", "time"], seek: ["jump", "time"], rewind: ["seek", "checkpoint"], time: ["clock", "seek"], pause: ["playback"],
    weather: ["rain", "storm", "flood"], rain: ["weather", "storm"], flood: ["flooding", "weather"], storm: ["weather", "rain"],
    traffic: ["congestion", "demand", "flow"], jam: ["congestion", "queue"], crash: ["incident", "collision"], accident: ["incident"],
    light: ["signal"], signal: ["light", "phase"], bus: ["transit", "stop"],
    shortcut: ["keyboard", "key"], key: ["keyboard", "shortcut", "token"], hotkey: ["keyboard", "shortcut"],
    log: ["logs", "logging"], version: ["release", "changelog"], release: ["changelog", "version"], new: ["changelog", "release"],
    save: ["export", "saved"], export: ["save", "download", "report"], download: ["export", "fastboot"], pdf: ["report"],
    test: ["testing", "tests"], security: ["token", "permission", "credential"], password: ["credential", "token", "security"],
    login: ["credential", "token"], permission: ["capability", "grant"], token: ["credential", "operator"],
    memory: ["resource", "ram"], cpu: ["resource", "processor"], disk: ["resource", "reset"], space: ["disk", "reset"],
    graph: ["knowledge"], screen: ["terminal", "interface"], ui: ["interface", "observer"], window: ["terminal", "observer"],
    fastboot: ["fast", "boot"], demo: ["presentation", "film"], film: ["start-up", "presentation"], idempotent: ["repeat", "retry"]
  };

  function fold(s) { return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
  // A light English stemmer: the same in the index and the question, which is all that matters.
  function stem(w) {
    if (w.length <= 3 || /[\d._\-/]/.test(w)) return w;
    if (/ies$/.test(w) && w.length > 4) w = w.slice(0, -3) + "y";
    else if (/sses$/.test(w)) w = w.slice(0, -2);
    else if (/[^su]s$/.test(w)) w = w.slice(0, -1);
    if (/eed$/.test(w)) return w;
    var cut = w.length > 5 && /ing$/.test(w) ? 3 : w.length > 4 && /ed$/.test(w) && /[aeiouy]/.test(w.slice(0, -2)) ? 2 : 0;
    if (cut) { w = w.slice(0, -cut); if (/([^aeioulsz])\1$/.test(w)) w = w.slice(0, -1); }
    if (w.length > 7 && /ations?$/.test(w)) w = w.replace(/ations?$/, "");
    else if (w.length > 6 && /ly$/.test(w)) w = w.slice(0, -2);
    if (w.length > 4 && /e$/.test(w)) w = w.slice(0, -1);
    return w;
  }
  // Words, and code as written and in parts: api.port is api.port, api and port; tickRate is tickrate, tick and rate.
  function tokens(text) {
    var out = [];
    String(text).split(/[^\p{L}\p{N}._\-]+/u).forEach(function (raw) {
      raw = raw.replace(/^[._\-]+|[._\-]+$/g, "");
      if (!raw) return;
      var parts = raw.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s._\-]+/).filter(Boolean);
      if (parts.length > 1) out.push(raw);
      Array.prototype.push.apply(out, parts);
    });
    return out;
  }
  function term(t) {
    t = fold(t);
    if (!t || STOP.has(t)) return null;
    return stem(t);
  }
  function text(html) {
    var d = document.createElement("div");
    d.innerHTML = String(html || "");
    return (d.textContent || "").replace(/\s+/g, " ").trim();
  }

  var engine = null, docs = [], byPage = new Map(), waiting = [], failed = false;

  function root() {
    var logo = document.querySelector('[data-md-component="logo"]');
    try { return new URL(logo.getAttribute("href"), location.href); } catch (e) { return new URL("/", location.href); }
  }
  function load() {
    if (engine || failed) return;
    failed = true; // until it has loaded; a second call while loading does nothing
    fetch(new URL("search/search_index.json", root())).then(function (r) { return r.json(); }).then(function (index) {
      docs = index.docs.map(function (d, i) {
        var page = d.location.split("#")[0];
        // The change log mentions everything; it answers a question about a change, not about how a thing works.
        var boost = (d.boost || 1) * (/^changelog\//.test(page) ? 0.35 : 1);
        return { id: i, location: d.location, page: page, section: d.location.indexOf("#") >= 0, title: text(d.title), text: text(d.text), boost: boost };
      });
      docs.forEach(function (d) { if (!d.section) byPage.set(d.page, d); });
      docs.forEach(function (d) { var p = byPage.get(d.page); d.pageTitle = p ? p.title : d.title; });
      engine = new window.MiniSearch({
        fields: ["title", "pageTitle", "text"],
        tokenize: tokens,
        processTerm: term,
        searchOptions: { boost: { title: 4, pageTitle: 1.5, text: 1 }, bm25: { k: 1.2, b: 0.85, d: 0.5 } }
      });
      engine.addAll(docs);
      failed = false;
      waiting.splice(0).forEach(function (f) { f(); });
    }).catch(function (e) { failed = true; if (window.console) console.warn("search index:", e); });
  }

  // What a question asks for: its words, each with the words that mean the same.
  function understand(query) {
    var q = fold(query).replace(/[?!.]+\s*$/, "").trim(), before;
    do { before = q; q = q.replace(ASKING, ""); } while (q !== before);
    var typing = !/\s$/.test(query), groups = [];
    tokens(q).forEach(function (w, i, all) {
      var t = term(w);
      if (!t || groups.some(function (g) { return g.term === t; })) return;
      var related = (RELATED[fold(w)] || RELATED[t] || []).map(term).filter(function (r) { return r && r !== t; });
      groups.push({ word: w, term: t, related: related, last: i === all.length - 1 });
    });
    return { groups: groups, typing: typing };
  }

  function search(query) {
    var q = understand(query);
    if (!q.groups.length) return [];
    var weight = new Map(), owner = new Map(), list = [];
    q.groups.forEach(function (g, gi) {
      if (!weight.has(g.term)) { weight.set(g.term, 1); list.push(g.term); }
      owner.set(g.term, (owner.get(g.term) || []).concat(gi));
      g.related.forEach(function (r) {
        if (!weight.has(r)) { weight.set(r, 0.55); list.push(r); }
        if (weight.get(r) < 1) owner.set(r, (owner.get(r) || []).concat(gi));
      });
    });
    // A word the index does not have, most likely misspelt: its beginning stands for it, as a prefix, for less.
    q.groups.forEach(function (g, gi) {
      if (g.term.length < 7 || engine.search(g.term, { tokenize: function (x) { return [x]; }, processTerm: function (x) { return x; } }).length) return;
      var head = g.term.slice(0, Math.max(5, Math.ceil(g.term.length * 0.6)));
      if (!weight.has(head)) { weight.set(head, 0.5); list.push(head); }
      owner.set(head, (owner.get(head) || []).concat(gi));
      g.head = head;
    });
    var original = new Set(q.groups.map(function (g) { return g.term; }));
    q.groups.forEach(function (g) { if (g.head) original.add(g.head); });
    var lastTerm = q.groups[q.groups.length - 1].term;
    var found = engine.search(list.join(" "), {
      tokenize: function (s) { return s.split(" "); },
      processTerm: function (t) { return t; },
      prefix: function (t) { return original.has(t) && (t.length >= 4 || (q.typing && t === lastTerm && t.length >= 2)); },
      fuzzy: function (t) { return original.has(t) && t.length >= 5 ? 0.2 : false; },
      boostTerm: function (t) { return weight.get(t) || 1; },
      boostDocument: function (id, t, stored) { return docs[id].boost * (docs[id].section ? 1 : 1.15); }
    });
    // Most of the question must be there: all of one or two words, three in five of more.
    var total = q.groups.length, need = total <= 2 ? total : Math.ceil(total * 0.6);
    var scored = found.map(function (r) {
      var covered = new Set();
      r.queryTerms.forEach(function (t) { (owner.get(t) || []).forEach(function (gi) { covered.add(gi); }); });
      return { r: r, covered: covered.size, score: r.score * Math.pow(covered.size / total, 1.5) };
    });
    var kept = scored.filter(function (s) { return s.covered >= need; });
    // Nothing has all of it: the best partial answers, rather than nothing.
    if (!kept.length) kept = scored.filter(function (s) { return s.covered >= Math.max(1, need - 1); });
    kept.sort(function (a, b) { return b.score - a.score; });
    return kept.map(function (s) { return { doc: docs[s.r.id], score: s.score, terms: new Set(s.r.terms) }; });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  // A few words around the first that matched, with each match marked.
  function excerpt(body, terms, length) {
    if (!body) return "";
    var words = body.split(/(\s+)/), at = -1;
    var hit = function (w) { return tokens(w).some(function (t) { var p = term(t); return p && terms.has(p); }); };
    for (var i = 0; i < words.length; i++) if (words[i].trim() && hit(words[i])) { at = i; break; }
    var start = at < 0 ? 0 : Math.max(0, at - 16), out = "", size = 0;
    for (var j = start; j < words.length && size < length; j++) {
      var w = words[j];
      out += w.trim() && hit(w) ? "<mark>" + esc(w) + "</mark>" : esc(w);
      size += w.length;
    }
    return (start > 0 ? "… " : "") + out.trim() + (size >= length ? " …" : "");
  }
  function marked(title, terms) {
    return title.split(/(\s+)/).map(function (w) { return w.trim() && tokens(w).some(function (t) { var p = term(t); return p && terms.has(p); }) ? "<mark>" + esc(w) + "</mark>" : esc(w); }).join("");
  }

  // Pages, best first, each with the sections inside it that answer: the shape search-ui.js draws.
  function pages(query) {
    var hits = search(query), order = [], byHref = new Map(), base = root();
    hits.forEach(function (h) {
      var key = h.doc.page, entry = byHref.get(key);
      if (!entry) {
        var page = byPage.get(key) || h.doc;
        entry = { href: new URL(key, base).href, title: page.title, titleHtml: "", teaserHtml: "", sections: [], score: 0, terms: new Set(), page: page };
        byHref.set(key, entry); order.push(entry);
      }
      h.terms.forEach(function (t) { entry.terms.add(t); });
      // A page ranks by its best answer, and a little for a few more: a long page does not win by being long.
      entry.hits = (entry.hits || 0) + 1;
      entry.score += entry.hits === 1 ? h.score : entry.hits <= 4 ? h.score * 0.12 : 0;
      if (h.doc.section) {
        if (entry.sections.length < 12) entry.sections.push({ href: new URL(h.doc.location, base).href, titleHtml: marked(h.doc.title, h.terms), teaserHtml: excerpt(h.doc.text, h.terms, 150) });
      }
    });
    order.forEach(function (e) {
      e.titleHtml = marked(e.title, e.terms);
      e.teaserHtml = excerpt(e.page.text, e.terms, 170);
    });
    order.sort(function (a, b) { return b.score - a.score; });
    return order.slice(0, 30);
  }

  window.DSTNSSearch = {
    ready: function () { return !!engine; },
    onReady: function (f) { if (engine) f(); else waiting.push(f); },
    load: load,
    pages: pages,
    understand: understand
  };
  // The index loads the first time the search field is used, so a page that never searches never fetches it.
  document.addEventListener("focusin", function (e) { if (e.target && e.target.classList && e.target.classList.contains("md-search__input")) load(); });
})();
