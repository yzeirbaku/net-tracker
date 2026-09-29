// Classic (non-module) script loaded as the first child of <body>, so the
// saved theme lands before first paint. Before this, the theme was only
// applied when the Settings view rendered: a light-theme user got the dark
// default on every cold open until they visited Settings.
//
// Also keeps <meta name="theme-color"> equal to the page's `--bg`, so the
// browser chrome (Android status bar, iOS Safari toolbar tint) matches the
// app instead of showing a dark bar over the light theme. `setTheme` in
// settings.js calls `window.applyThemeColor` to stay in step on a toggle.
(function () {
  var BG = { light: "#f3f1ea", dark: "#0d1117" };
  window.applyThemeColor = function (theme) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && BG[theme]) meta.setAttribute("content", BG[theme]);
  };
  var theme = "dark";
  try {
    var saved = localStorage.getItem("net-tracker.theme");
    if (saved === "light" || saved === "dark") theme = saved;
  } catch (e) { /* storage blocked — keep the dark default */ }
  document.body.dataset.theme = theme;
  window.applyThemeColor(theme);
})();
