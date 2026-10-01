// The search field prompts "Start typing to search" while it is open and says
// "Search" while it is collapsed. Delegated, so it survives instant navigation.
(function () {
  var open = "Start typing to search", closed = "Search";
  function set(e, text) {
    var t = e.target;
    if (t && t.classList && t.classList.contains("md-search__input")) t.setAttribute("placeholder", text);
  }
  document.addEventListener("focusin", function (e) { set(e, open); });
  document.addEventListener("focusout", function (e) { set(e, closed); });
})();
