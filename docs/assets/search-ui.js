// Search field behaviour and a hierarchical results view.
//
// Material's search worker finds the matches; this script re-draws them:
//   Page            the document that matched, with the part of the docs it lives in
//     # Section     matches found inside that page, nested beneath it
// Each page carries an icon for how it matched (exact title, in the title, in the
// content), results can be filtered by part of the docs, and the arrow keys, Enter and
// Escape work on the drawn rows. If anything here fails, Material's own list is left
// visible, so search keeps working.
//
// Listeners are delegated on the document and the observer re-attaches itself, so it
// survives instant navigation.
(function () {
  var OPEN = "Start typing to search", CLOSED = "Search";
  var AREAS = [
    ["getting-started", "Getting started"], ["guide", "User guide"], ["concepts", "Concepts"],
    ["api", "API"], ["deployment", "Deployment"],
    ["troubleshooting", "Help"], ["faq", "Help"], ["glossary", "Help"]
  ];
  var ORDER = ["Getting started", "User guide", "Concepts", "API", "Deployment", "Help", "Reference"];
  var SECTIONS_SHOWN = 3;
  var ICON = {
    page: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    hash: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
    exact: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/>',
    title: '<path d="M5 6h14M12 6v13M9 19h6"/>',
    content: '<path d="M4 6h16M4 11h16M4 16h10"/>',
    more: '<path d="m9 6 6 6-6 6"/>'
  };
  var KIND = {
    exact: ["Exact", "The page title is exactly what you typed"],
    title: ["Title", "Your search appears in the page title"],
    content: ["Content", "Your search appears in the text of the page"]
  };
  var filter = "all", expanded = {}, active = -1;
  var observer = null, observed = null, queued = false;

  function field() { return document.querySelector(".md-search__input"); }
  function box() { return document.querySelector(".md-search"); }
  function isField(e) { return e.target && e.target.classList && e.target.classList.contains("md-search__input"); }
  function svg(name) { return '<svg class="dstns-ico" viewBox="0 0 24 24" aria-hidden="true">' + ICON[name] + "</svg>"; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function plain(el) { return (el && el.textContent || "").replace(/\s+/g, " ").trim(); }

  // While the field is open, hide every tab it would cover, even partly, so nothing is
  // left clipped behind it. The field grows to 30rem from the right edge of its slot.
  function clearTabs() {
    Array.prototype.forEach.call(document.querySelectorAll(".md-tabs__item.dstns-tab-out"), function (t) { t.classList.remove("dstns-tab-out"); });
  }
  function clearTabsSoon() { setTimeout(function () { var i = field(); if (!i || document.activeElement !== i) clearTabs(); }, 0); }
  function coverTabs() {
    var b = box();
    if (!b || !window.matchMedia("(min-width: 60em)").matches) { clearTabs(); return; }
    var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    var fieldLeft = b.getBoundingClientRect().right - 30 * rem;
    Array.prototype.forEach.call(document.querySelectorAll(".md-header .md-tabs__item"), function (item) {
      item.classList.toggle("dstns-tab-out", item.getBoundingClientRect().right > fieldLeft - 0.9 * rem);
    });
  }

  function syncEmpty() {
    var input = field(), b = box();
    if (input && b) b.setAttribute("data-empty", input.value.trim() === "" ? "true" : "false");
  }

  function siteRoot() {
    var logo = document.querySelector('[data-md-component="logo"]');
    try { return new URL(logo.getAttribute("href"), location.href).pathname.replace(/[^/]*$/, ""); }
    catch (e) { return "/"; }
  }
  function where(href) {
    var path = "";
    try { path = new URL(href, location.href).pathname; } catch (e) { return { area: "Reference", trail: [] }; }
    var root = siteRoot();
    if (path.indexOf(root) === 0) path = path.slice(root.length);
    var parts = path.split("/").filter(Boolean);
    var area = "Reference";
    for (var i = 0; i < AREAS.length; i++) if (AREAS[i][0] === parts[0]) area = AREAS[i][1];
    var folders = parts.slice(0, -1);
    if (area !== "Reference" && folders.length && folders[0] === parts[0]) folders = folders.slice(1);
    var trail = folders.map(function (s) {
      s = s.replace(/-/g, " ");
      return s.charAt(0).toUpperCase() + s.slice(1);
    });
    return { area: area, trail: trail };
  }

  // Read Material's own result list into plain data.
  function collect() {
    var list = document.querySelector(".md-search-result__list");
    if (!list) return null;
    var pages = [];
    Array.prototype.forEach.call(list.children, function (li) {
      var links = li.querySelectorAll("a.md-search-result__link");
      if (!links.length) return;
      var first = links[0];
      var h1 = first.querySelector("h1");
      if (!h1) return;
      var teaser = first.querySelector("p");
      var entry = {
        href: first.getAttribute("href"),
        titleHtml: h1.innerHTML,
        title: plain(h1),
        teaserHtml: teaser ? teaser.innerHTML : "",
        sections: []
      };
      for (var i = 1; i < links.length; i++) {
        var head = links[i].querySelector("h1, h2, h3");
        var p = links[i].querySelector("p");
        if (!head) continue;
        entry.sections.push({
          href: links[i].getAttribute("href"),
          titleHtml: head.innerHTML,
          teaserHtml: p ? p.innerHTML : ""
        });
      }
      pages.push(entry);
    });
    return pages;
  }

  function matchKind(title, query) {
    var t = title.toLowerCase();
    if (t === query) return "exact";
    if (query && t.indexOf(query) !== -1) return "title";
    return "content";
  }

  function render() {
    var output = document.querySelector(".md-search__output");
    var wrap = output && output.querySelector(".md-search__scrollwrap");
    var input = field();
    if (!output || !wrap || !input) return;
    var pages = collect();
    if (!pages) return;
    var query = input.value.trim().toLowerCase();

    pages.forEach(function (p) {
      var w = where(p.href);
      p.area = w.area;
      p.trail = w.trail;
      p.kind = matchKind(p.title, query);
    });

    var counts = { all: pages.length };
    pages.forEach(function (p) { counts[p.area] = (counts[p.area] || 0) + 1; });
    if (filter !== "all" && !counts[filter]) filter = "all";
    var shown = pages.filter(function (p) { return filter === "all" || p.area === filter; });

    var host = wrap.querySelector(".dstns-results");
    if (!host) {
      host = document.createElement("div");
      host.className = "dstns-results";
      wrap.appendChild(host);
    }
    var html = "";

    // Filter pills
    html += '<div class="dstns-filters" role="group" aria-label="Filter results">';
    function pill(key, label, n) {
      return '<button type="button" class="dstns-pill" data-filter="' + esc(key) + '" aria-pressed="' + (filter === key) + '">' +
        esc(label) + "<span>" + n + "</span></button>";
    }
    if (pages.length) {
      html += pill("all", "All", counts.all);
      ORDER.forEach(function (a) { if (counts[a]) html += pill(a, a, counts[a]); });
    }
    html += "</div>";

    // Summary line
    var summary;
    if (!pages.length) summary = "No results";
    else if (filter === "all") summary = pages.length + (pages.length === 1 ? " result" : " results");
    else summary = shown.length + " of " + pages.length + " results";
    html += '<div class="dstns-summary">' + summary + "</div>";

    if (!pages.length) {
      html += '<div class="dstns-empty"><p>Nothing matched <strong>' + esc(input.value.trim()) +
        '</strong>.</p><p>Try fewer or different words, or check the spelling.</p></div>';
    } else {
      html += '<ol class="dstns-list">';
      shown.forEach(function (p) {
        var k = KIND[p.kind];
        html += '<li class="dstns-page" data-kind="' + p.kind + '">';
        html += '<a class="dstns-link dstns-page__link" href="' + esc(p.href) + '">';
        html += '<span class="dstns-page__icon" title="' + esc(k[1]) + '">' + svg(p.kind === "exact" ? "exact" : "page") + "</span>";
        html += '<span class="dstns-page__body">';
        html += '<span class="dstns-page__head"><span class="dstns-page__title">' + p.titleHtml + "</span>" +
          '<span class="dstns-kind dstns-kind--' + p.kind + '" title="' + esc(k[1]) + '">' + svg(p.kind) + k[0] + "</span></span>";
        html += '<span class="dstns-crumb">' + [p.area].concat(p.trail).map(esc).join('<i aria-hidden="true">›</i>') + "</span>";
        if (p.teaserHtml) html += '<span class="dstns-teaser">' + p.teaserHtml + "</span>";
        html += "</span></a>";
        if (p.sections.length) {
          var open = !!expanded[p.href];
          var visible = open ? p.sections : p.sections.slice(0, SECTIONS_SHOWN);
          html += '<ul class="dstns-tree">';
          visible.forEach(function (s) {
            html += '<li class="dstns-section"><a class="dstns-link dstns-section__link" href="' + esc(s.href) + '">' +
              '<span class="dstns-section__icon">' + svg("hash") + "</span>" +
              '<span class="dstns-section__body"><span class="dstns-section__title">' + s.titleHtml + "</span>" +
              (s.teaserHtml ? '<span class="dstns-teaser">' + s.teaserHtml + "</span>" : "") +
              "</span></a></li>";
          });
          if (p.sections.length > SECTIONS_SHOWN) {
            html += '<li class="dstns-more"><button type="button" class="dstns-more__btn" data-expand="' + esc(p.href) + '" aria-expanded="' + open + '">' +
              svg("more") + (open ? "Show fewer" : "Show " + (p.sections.length - SECTIONS_SHOWN) + " more sections inside this page") + "</button></li>";
          }
          html += "</ul>";
        }
        html += "</li>";
      });
      html += "</ol>";
    }
    html += '<div class="dstns-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>' +
      '<span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>';

    host.innerHTML = html;
    box().classList.add("dstns-custom");
    active = -1;
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      attach();
      try { render(); } catch (err) { var b = box(); if (b) b.classList.remove("dstns-custom"); if (window.console) console.error(err); }
    });
  }

  function attach() {
    var target = document.querySelector(".md-search-result");
    if (!target || observed === target) return;
    if (observer) observer.disconnect();
    observed = target;
    observer = new MutationObserver(schedule);
    observer.observe(target, { childList: true, subtree: true, characterData: true });
  }

  function links() { return Array.prototype.slice.call(document.querySelectorAll(".dstns-results .dstns-link")); }
  function setActive(i) {
    var all = links();
    all.forEach(function (a) { a.classList.remove("dstns-active"); });
    if (!all.length) { active = -1; return; }
    active = (i + all.length) % all.length;
    all[active].classList.add("dstns-active");
    all[active].scrollIntoView({ block: "nearest" });
  }

  // Arrow keys and Enter act on the rows drawn here, ahead of Material's own handler.
  window.addEventListener("keydown", function (e) {
    if (!isField(e) || !box() || !box().classList.contains("dstns-custom")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopImmediatePropagation();
      setActive(active < 0 ? (e.key === "ArrowDown" ? 0 : -1) : active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      var all = links();
      var target = active >= 0 ? all[active] : all[0];
      if (target) { e.preventDefault(); e.stopImmediatePropagation(); target.click(); }
    }
  }, true);

  document.addEventListener("click", function (e) {
    var t = e.target.closest ? e.target : null;
    if (!t) return;
    var pillEl = t.closest(".dstns-pill");
    if (pillEl) { e.preventDefault(); filter = pillEl.getAttribute("data-filter"); render(); return; }
    var more = t.closest(".dstns-more__btn");
    if (more) { e.preventDefault(); var h = more.getAttribute("data-expand"); expanded[h] = !expanded[h]; render(); return; }
    if (t.closest(".md-search__icon")) setTimeout(function () { syncEmpty(); schedule(); }, 0);
  });
  // Keep focus in the search field when a filter or a "show more" button is pressed.
  document.addEventListener("mousedown", function (e) {
    if (e.target.closest && e.target.closest(".dstns-pill, .dstns-more__btn, .dstns-results")) e.preventDefault();
  });
  document.addEventListener("mouseover", function (e) {
    var a = e.target.closest && e.target.closest(".dstns-results .dstns-link");
    if (!a) return;
    var all = links(); var i = all.indexOf(a);
    if (i !== active) { all.forEach(function (x) { x.classList.remove("dstns-active"); }); a.classList.add("dstns-active"); active = i; }
  });
  document.addEventListener("focusin", function (e) {
    if (isField(e)) { e.target.setAttribute("placeholder", OPEN); syncEmpty(); coverTabs(); attach(); schedule(); }
  });
  document.addEventListener("focusout", function (e) { if (isField(e)) { e.target.setAttribute("placeholder", CLOSED); syncEmpty(); clearTabsSoon(); } });
  window.addEventListener("resize", function () { if (document.activeElement === field()) coverTabs(); });
  document.addEventListener("input", function (e) { if (isField(e)) { filter = "all"; expanded = {}; syncEmpty(); attach(); schedule(); } });
  document.addEventListener("keyup", function (e) { if (isField(e)) syncEmpty(); });

  if (document.readyState !== "loading") { syncEmpty(); attach(); }
  else document.addEventListener("DOMContentLoaded", function () { syncEmpty(); attach(); });
})();
