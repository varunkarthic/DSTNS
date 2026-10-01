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
