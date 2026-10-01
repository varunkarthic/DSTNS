// Search field behaviour.
//  - The placeholder reads "Start typing to search" while the field is open and
//    "Search" while it is collapsed.
//  - The results card is shown only once something has been typed, so the prompt
//    lives in the field itself. The state is mirrored in a data attribute, which
//    keeps the layout correct in browsers without :has().
// Listeners are delegated on the document, so they survive instant navigation.
(function () {
  var OPEN = "Start typing to search", CLOSED = "Search";
  function field() { return document.querySelector(".md-search__input"); }
  function sync() {
    var input = field(), box = document.querySelector(".md-search");
    if (input && box) box.setAttribute("data-empty", input.value.trim() === "" ? "true" : "false");
  }
  function isField(e) { return e.target && e.target.classList && e.target.classList.contains("md-search__input"); }
  document.addEventListener("focusin", function (e) { if (isField(e)) { e.target.setAttribute("placeholder", OPEN); sync(); } });
  document.addEventListener("focusout", function (e) { if (isField(e)) { e.target.setAttribute("placeholder", CLOSED); sync(); } });
  document.addEventListener("input", function (e) { if (isField(e)) sync(); });
  document.addEventListener("click", function (e) {
    if (e.target && e.target.closest && e.target.closest(".md-search__icon")) setTimeout(sync, 0);
  });
  document.addEventListener("keyup", function (e) { if (isField(e)) sync(); });
  if (document.readyState !== "loading") sync(); else document.addEventListener("DOMContentLoaded", sync);
})();
