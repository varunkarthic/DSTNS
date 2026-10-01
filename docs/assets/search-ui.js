// Search field behaviour and result presentation.
//
//  - The placeholder reads "Start typing to search" while the field is open and
//    "Search" while it is collapsed; the results card is shown only once something
//    has been typed.
//  - Each result is labelled by how it matched (exact title, title, or content), by
//    the part of the documentation it lives in, and sections found inside a page are
//    shown as a tree beneath it.
//  - A row of filter pills narrows the results to one part of the documentation.
//
// Listeners are delegated on the document and the result observer re-attaches itself,
// so everything survives instant navigation.
(function () {
  var OPEN = "Start typing to search", CLOSED = "Search";
  var AREAS = [
    ["getting-started", "Getting started"], ["guide", "User guide"], ["concepts", "Concepts"],
    ["api", "API"], ["deployment", "Deployment"],
    ["troubleshooting", "Help"], ["faq", "Help"], ["glossary", "Help"]
  ];
  var ORDER = ["Getting started", "User guide", "Concepts", "API", "Deployment", "Help", "Reference"];
  var filter = "all";
  var observer = null, observed = null, queued = false, busy = false;

  function field() { return document.querySelector(".md-search__input"); }
  function box() { return document.querySelector(".md-search"); }
  function isField(e) { return e.target && e.target.classList && e.target.classList.contains("md-search__input"); }

  function syncEmpty() {
    var input = field(), b = box();
    if (input && b) b.setAttribute("data-empty", input.value.trim() === "" ? "true" : "false");
  }

  function siteRoot() {
    // The logo links to the site root and is refreshed on every instant navigation,
    // unlike the page configuration block, which still describes the first page.
    var logo = document.querySelector('[data-md-component="logo"]');
    try { return new URL(logo.getAttribute("href"), location.href).pathname.replace(/[^/]*$/, ""); }
    catch (e) { return "/"; }
  }
  function areaOf(href) {
    var path;
    try { path = new URL(href, location.href).pathname; } catch (e) { return "Reference"; }
    var root = siteRoot();
    if (path.indexOf(root) === 0) path = path.slice(root.length);
    var first = path.split("/")[0];
    for (var i = 0; i < AREAS.length; i++) if (AREAS[i][0] === first) return AREAS[i][1];
    return "Reference";
  }
  function text(el) { return (el && el.textContent || "").replace(/\s+/g, " ").trim(); }

  function ensureBar(output) {
    var bar = output.querySelector(".dstns-filters");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "dstns-filters";
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", "Filter results");
      bar.addEventListener("click", function (e) {
        var pill = e.target.closest && e.target.closest("[data-filter]");
        if (!pill) return;
        e.preventDefault();
        filter = pill.getAttribute("data-filter");
        schedule();
      });
      output.insertBefore(bar, output.firstChild);
    }
    return bar;
  }

  function enhance() {
    var output = document.querySelector(".md-search__output");
    var list = document.querySelector(".md-search-result__list");
    var meta = document.querySelector(".md-search-result__meta");
    var input = field();
    if (!output || !list || !meta || !input) return;
    busy = true;
    var query = input.value.trim().toLowerCase();
    var items = Array.prototype.slice.call(list.children);
    var counts = { all: 0 };

    items.forEach(function (li) {
      var link = li.querySelector(":scope > a.md-search-result__link");
      var h1 = li.querySelector(":scope > a h1");
      if (!link || !h1) return;
      var area = areaOf(link.getAttribute("href"));
      var title = text(h1).toLowerCase();
      var kind = title === query ? "exact" : (query && title.indexOf(query) !== -1 ? "title" : "content");
      li.setAttribute("data-area", area);
      li.setAttribute("data-kind", kind);
      var article = link.querySelector("article");
      if (article && !article.querySelector(".dstns-meta")) {
        var row = document.createElement("div");
        row.className = "dstns-meta";
        row.innerHTML = '<span class="dstns-area"></span><span class="dstns-badge"></span>';
        h1.parentNode.insertBefore(row, h1.nextSibling);
      }
      if (article) {
        var badge = article.querySelector(".dstns-badge");
        if (badge) {
          badge.setAttribute("data-kind", kind);
          badge.textContent = kind === "exact" ? "Exact match" : kind === "title" ? "In title" : "In content";
        }
        var ar = article.querySelector(".dstns-area");
        if (ar) ar.textContent = area;
      }
      var more = li.querySelector(":scope > details > summary > div");
      if (more) {
        var m = more.textContent.match(/(\d+)\s+more/);
        if (m) more.textContent = m[1] + (m[1] === "1" ? " match" : " matches") + " inside this page";
      }
      counts.all += 1;
      counts[area] = (counts[area] || 0) + 1;
    });

    if (filter !== "all" && !counts[filter]) filter = "all";
    var shown = 0;
    items.forEach(function (li) {
      var keep = filter === "all" || li.getAttribute("data-area") === filter;
      li.classList.toggle("dstns-hidden", !keep);
      if (keep) shown += 1;
    });

    var bar = ensureBar(output);
    var html = "";
    function pill(key, label, n) {
      return '<button type="button" class="dstns-pill" data-filter="' + key + '" aria-pressed="' +
        (filter === key) + '">' + label + '<span>' + n + "</span></button>";
    }
    html += pill("all", "All", counts.all);
    ORDER.forEach(function (a) { if (counts[a]) html += pill(a, a, counts[a]); });
    if (bar.getAttribute("data-html") !== html) { bar.innerHTML = html; bar.setAttribute("data-html", html); }
    bar.hidden = counts.all === 0;

    var label;
    if (counts.all === 0) label = "No results";
    else if (filter === "all") label = counts.all + (counts.all === 1 ? " result" : " results");
    else label = shown + " of " + counts.all + " results";
    if (meta.textContent !== label) meta.textContent = label;
    busy = false;
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; attach(); enhance(); });
  }

  function attach() {
    var target = document.querySelector(".md-search-result");
    if (!target) return;
    if (observed === target) return;
    if (observer) observer.disconnect();
    observed = target;
    observer = new MutationObserver(function () { if (!busy) schedule(); });
    observer.observe(target, { childList: true, subtree: true, characterData: true });
  }

  document.addEventListener("focusin", function (e) {
    if (isField(e)) { e.target.setAttribute("placeholder", OPEN); syncEmpty(); attach(); schedule(); }
  });
  document.addEventListener("focusout", function (e) { if (isField(e)) { e.target.setAttribute("placeholder", CLOSED); syncEmpty(); } });
  document.addEventListener("input", function (e) { if (isField(e)) { filter = "all"; syncEmpty(); attach(); schedule(); } });
  document.addEventListener("keyup", function (e) { if (isField(e)) syncEmpty(); });
  document.addEventListener("click", function (e) {
    if (e.target && e.target.closest && e.target.closest(".md-search__icon")) setTimeout(function () { syncEmpty(); schedule(); }, 0);
  });
  if (document.readyState !== "loading") { syncEmpty(); attach(); }
  else document.addEventListener("DOMContentLoaded", function () { syncEmpty(); attach(); });
})();
