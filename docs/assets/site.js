// Small site-wide behaviour.
//
// 1. A "back to top" button on every page. It appears once the page has been scrolled
// about a screen down and stays until the reader is back near the top, rather than
// only while scrolling upwards. The button lives on <body>, so it survives instant
// navigation; its visibility is re-evaluated after each page change.
(function () {
  var button = null;
  function make() {
    if (button && document.body.contains(button)) return button;
    button = document.createElement("button");
    button.type = "button";
    button.className = "dstns-top";
    button.setAttribute("aria-label", "Back to top");
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg><span>Top</span>';
    button.addEventListener("click", function () {
      var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
      var skip = document.querySelector(".md-skip") || document.querySelector(".md-header");
      if (skip && skip.focus) { try { skip.focus({ preventScroll: true }); } catch (e) { /* older browsers */ } }
    });
    document.body.appendChild(button);
    return button;
  }
  var ticking = false;
  function update() {
    ticking = false;
    var b = make();
    var show = window.scrollY > Math.min(600, window.innerHeight * 0.6);
    b.classList.toggle("is-visible", show);
    b.tabIndex = show ? 0 : -1;
  }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(update); } }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  if (document.readyState !== "loading") update();
  else document.addEventListener("DOMContentLoaded", update);
  // Material's instant navigation exposes an observable of page loads.
  if (window.document$ && window.document$.subscribe) window.document$.subscribe(function () { setTimeout(update, 0); });
})();

// 2. Long identifiers in table cells (configuration keys, error codes, paths) may break
//    only after a dot, underscore, slash or hyphen, never in the middle of a word.
(function () {
  // A dot is a break point only when a longer word follows it, so file extensions
  // such as ".cpp" stay attached to the name.
  var SEP = /([_\/-]|\.(?=[^.]{5,}))/;
  function soften() {
    var codes = document.querySelectorAll(".md-typeset table:not([class]) td code");
    Array.prototype.forEach.call(codes, function (code) {
      if (code.dataset.soft || code.children.length || code.textContent.length < 16) return;
      code.dataset.soft = "1";
      var parts = code.textContent.split(SEP);
      code.textContent = "";
      parts.forEach(function (part) {
        code.appendChild(document.createTextNode(part));
        if (part.length === 1 && /[._\/-]/.test(part)) code.appendChild(document.createElement("wbr"));
      });
    });
  }
  if (document.readyState !== "loading") soften();
  else document.addEventListener("DOMContentLoaded", soften);
  if (window.document$ && window.document$.subscribe) window.document$.subscribe(soften);
})();

// 3. Search highlights on the page a result opened. They show where the match is for
//    about four seconds, then fade away so reading is not cluttered; Escape or a click
//    dismisses them at once. The ?h= term is dropped from the address so a reload or a
//    shared link does not bring them back.
(function () {
  var timer = null, fading = null;
  function marks() { return document.querySelectorAll("mark[data-md-highlight]"); }
  function unwrap() {
    Array.prototype.forEach.call(marks(), function (m) {
      var parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });
    document.documentElement.classList.remove("dstns-hl-fading");
    // Only now drop the term from the address: Material reads it to place the highlights.
    stripTerm();
  }
  function fade() {
    clearTimeout(timer); timer = null;
    if (!marks().length || fading) return;
    document.documentElement.classList.add("dstns-hl-fading");
    fading = setTimeout(function () { fading = null; unwrap(); }, 1300);
  }
  function stripTerm() {
    try {
      var url = new URL(location.href);
      if (url.searchParams.has("h")) {
        url.searchParams.delete("h");
        history.replaceState(history.state, "", url.pathname + url.search + url.hash);
      }
    } catch (e) { /* leave the address alone */ }
  }
  // Material inserts the highlights a moment after the page renders, so watch for them
  // rather than looking once.
  function arm() {
    if (timer || fading || !marks().length) return;
    timer = setTimeout(function () { timer = null; fade(); }, 4000);
  }
  function start() {
    clearTimeout(timer); timer = null;
    clearTimeout(fading); fading = null;
    document.documentElement.classList.remove("dstns-hl-fading");
    arm();
  }
  var queued = false;
  new MutationObserver(function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; arm(); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("keydown", function (e) {
    var search = document.getElementById("__search");
    if (e.key === "Escape" && !(search && search.checked)) fade();
  });
  document.addEventListener("click", function (e) {
    if (!(e.target.closest && e.target.closest(".md-search"))) fade();
  });
  if (document.readyState !== "loading") setTimeout(start, 0);
  else document.addEventListener("DOMContentLoaded", function () { setTimeout(start, 0); });
  if (window.document$ && window.document$.subscribe) window.document$.subscribe(function () { setTimeout(start, 0); });
})();
