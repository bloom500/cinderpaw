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
  /* Safety-net poll interval; the MutationObserver normally wins long
   * before the first tick. */
  var POLL_MS = 250;

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

  /* Everything below needs the DOM. This script is a BLOCKING script in
   * <head> — by design, so `data-theme` above is stamped before the first
   * paint — which means <body> has not been parsed yet and both lookups
   * return null at this point.
   *
   * That is exactly how this shipped broken: the original code looked the
   * elements up here and bailed on `if (!startup || !appRoot) return;`. The
   * theme still applied (it runs earlier), so there was no white flash and
   * the bug looked like success — but the observer was never attached, the
   * startup surface was never dismissed, and it sat on top of the mounted
   * app swallowing every click, including the window controls. The app was
   * unusable and could not even be closed.
   */
  function watchForMount() {
    var startup = document.getElementById('feral-startup');
    var appRoot = document.getElementById('root');
    /* Not parsed yet. Report failure so the caller keeps waiting instead of
     * giving up — giving up here is precisely the bug this file is fixing. */
    if (!startup || !appRoot) return false;

    var poll = 0;
    var dismissed = false;
    function dismissStartup() {
      if (dismissed) return;
      dismissed = true;
      if (poll) window.clearInterval(poll);
      startup.setAttribute('aria-hidden', 'true');
      rootEl.classList.add('feral-ready');
      window.setTimeout(function () {
        if (startup.parentNode) startup.parentNode.removeChild(startup);
      }, FADE_MS);
    }

    function mounted() {
      return appRoot.childElementCount > 0;
    }

    if (mounted()) {
      dismissStartup();
      return true;
    }

    var observer = new MutationObserver(function () {
      if (mounted()) {
        observer.disconnect();
        dismissStartup();
      }
    });
    observer.observe(appRoot, { childList: true });

    /* Belt and braces. The observer is the fast path; this is the promise
     * that a mounted app can NEVER be left under an unclickable overlay,
     * whatever goes wrong with the event. It checks the same condition, so
     * the deliberate behaviour is preserved: if React never mounts, the
     * startup surface stays up rather than revealing a blank window. */
    poll = window.setInterval(function () {
      if (mounted()) {
        observer.disconnect();
        dismissStartup();
      }
    }, POLL_MS);
    return true;
  }

  /* Try now, and if the document is not ready, try again when it is.
   * Deliberately NOT keyed on `document.readyState`: this script's whole
   * job is to run before the document exists, and any single moment we pick
   * can be the wrong one. Missing that moment used to leave the startup
   * surface permanently on top of the app, so the retry is unconditional. */
  if (!watchForMount()) {
    document.addEventListener('DOMContentLoaded', watchForMount);
  }
})();
