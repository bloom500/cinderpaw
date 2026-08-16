/* Feral pre-paint.
 *
 * Runs BEFORE the React module (plain blocking script in <head> — no
 * defer/async) and before any external stylesheet arrives, so the first
 * paint is theme-correct and never the old white frame.
 *
 * Jobs:
 *   1. Read the persisted theme from the same `feral-ui` key the zustand
 *      store uses (`{ state: { theme: 'dark' | 'light' | 'system' } }`),
 *      resolve `system` against the OS preference, and stamp `data-theme`
 *      on <html> before first paint.
 *   2. Observe #root; when React mounts real content, fade the startup
 *      surface out (CSS owns the fade via `html.feral-ready`) and then
 *      remove it from accessibility and pointer flow.
 *
 * Same-origin by design: the Tauri CSP is `script-src 'self'`, so this
 * file is served from the application's own origin. No inline script is
 * used anywhere. If the store is missing or corrupt, the fallback is dark,
 * which matches the store's default.
 */
(function () {
  'use strict';

  var THEME_KEY = 'feral-ui';
  var FALLBACK_THEME = 'dark';
  /* Must stay >= the `transition: opacity` duration in index.html. */
  var FADE_MS = 500;

  function readThemePref() {
    try {
      var raw = window.localStorage.getItem(THEME_KEY);
      if (!raw) return FALLBACK_THEME;
      var parsed = JSON.parse(raw);
      var pref = parsed && parsed.state && parsed.state.theme;
      if (pref === 'light' || pref === 'dark' || pref === 'system') return pref;
      return FALLBACK_THEME;
    } catch (_err) {
      return FALLBACK_THEME;
    }
  }

  function resolveTheme(pref) {
    if (pref !== 'system') return pref;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  var resolved = resolveTheme(readThemePref());
  var rootEl = document.documentElement;
  rootEl.setAttribute('data-theme', resolved);
  /* Native widgets (selects, checkboxes, scrollbars) follow the theme too. */
  rootEl.style.colorScheme = resolved;

  var startup = document.getElementById('feral-startup');
  var appRoot = document.getElementById('root');
  if (!startup || !appRoot) return;

  var dismissed = false;
  function dismissStartup() {
    if (dismissed) return;
    dismissed = true;
    startup.setAttribute('aria-hidden', 'true');
    rootEl.classList.add('feral-ready');
    window.setTimeout(function () {
      if (startup.parentNode) startup.parentNode.removeChild(startup);
    }, FADE_MS);
  }

  if (appRoot.childElementCount > 0) {
    dismissStartup();
  } else {
    var observer = new MutationObserver(function () {
      if (appRoot.childElementCount > 0) {
        observer.disconnect();
        dismissStartup();
      }
    });
    observer.observe(appRoot, { childList: true });
  }
})();