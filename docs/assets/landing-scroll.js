// Landing page, large screens: one wheel flick moves between the first screen and the
// observer screenshot with a short eased scroll, instead of a long crawl. Everywhere
// else, and on phones, scrolling is left alone.
(function () {
  var busy = false;
  function ease(t) { return 1 - Math.pow(1 - t, 4); }
  function enabled() {
    return window.matchMedia("(min-width: 60em) and (min-height: 560px)").matches &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
      document.querySelector(".dstns-first") && document.querySelector(".dstns-shot");
  }
  function targetTop() {
    var shot = document.querySelector(".dstns-shot");
    var header = document.querySelector(".md-header");
    var offset = (header ? header.offsetHeight : 64) + 12;
    return Math.max(0, Math.round(shot.getBoundingClientRect().top + window.scrollY - offset));
  }
  function glide(to) {
    var from = window.scrollY, delta = to - from, start = null, duration = 520;
    if (Math.abs(delta) < 2) return;
    busy = true;
    document.documentElement.style.scrollSnapType = "none";
    function frame(now) {
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / duration);
      window.scrollTo(0, from + delta * ease(t));
      if (t < 1) requestAnimationFrame(frame);
      else setTimeout(function () { busy = false; document.documentElement.style.scrollSnapType = ""; }, 140);
    }
    requestAnimationFrame(frame);
  }
  window.addEventListener("wheel", function (e) {
    if (!enabled() || e.ctrlKey) return;
    if (document.body.contains(document.querySelector(".md-search__input:focus"))) return;
    if (busy) { e.preventDefault(); return; }
    var y = window.scrollY, shotTop = targetTop();
    if (e.deltaY > 8 && y < shotTop - 4) { e.preventDefault(); glide(shotTop); }
    else if (e.deltaY < -8 && y > 4 && y <= shotTop + 40) { e.preventDefault(); glide(0); }
  }, { passive: false });
})();
