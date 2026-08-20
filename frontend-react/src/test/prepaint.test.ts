/**
 * Regression cover for `public/feral-prepaint.js`.
 *
 * The bug this exists for: the script is a BLOCKING script in <head>, so it
 * runs before <body> is parsed. It used to look up `#feral-startup` and
 * `#root` at top level and bail when both were null — which was always. The
 * theme still applied (that runs earlier), so a cold start looked perfect:
 * correct colours, no white flash. But the startup surface was never
 * dismissed. It stayed on top of the mounted application at full opacity,
 * swallowing every click including the window controls, so the app could not
 * be used and could not be closed.
 *
 * It shipped across three commits and was only found by running the app.
 * These tests reproduce the real execution order — script first, DOM after —
 * so that ordering can never silently regress again.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
// Vite's ?raw loads the shipped file itself, so the test can never drift
// onto a copy of the script.
import SCRIPT from '../../public/feral-prepaint.js?raw';

/** Run the prepaint script in the current jsdom document. */
function runPrepaint(): void {
  // eslint-disable-next-line no-new-func
  new Function(SCRIPT)();
}

/** Simulate React mounting into #root. */
function mountReact(): void {
  const root = document.getElementById('root')!;
  const app = document.createElement('div');
  app.textContent = 'app';
  root.appendChild(app);
}

function writeStartupMarkup(): void {
  document.body.innerHTML = `
    <div id="root"></div>
    <div id="feral-startup"><div class="feral-startup-wordmark">FERAL</div></div>
  `;
}

describe('feral-prepaint', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useRealTimers();
  });

  test('stamps the theme before the DOM exists', () => {
    // The whole reason the script is blocking and in <head>.
    localStorage.setItem('feral-ui', JSON.stringify({ state: { theme: 'light' } }));
    runPrepaint();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  test('falls back to dark when the persisted theme is corrupt', () => {
    localStorage.setItem('feral-ui', '{not json');
    runPrepaint();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  test('dismisses the startup surface when React mounts AFTER the script ran', async () => {
    // The real order: script executes with an empty document, <body> is
    // parsed afterwards, React mounts later still. This is the case that was
    // broken — the script found nothing to observe and gave up silently.
    expect(document.getElementById('root')).toBeNull();
    runPrepaint();

    writeStartupMarkup();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(document.documentElement.classList.contains('feral-ready')).toBe(false);

    mountReact();
    await vi.waitFor(() =>
      expect(document.documentElement.classList.contains('feral-ready')).toBe(true),
    );
  });

  test('dismisses immediately when React already mounted', async () => {
    // A fast mount can beat DOMContentLoaded; the surface must not linger.
    writeStartupMarkup();
    mountReact();
    runPrepaint();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() =>
      expect(document.documentElement.classList.contains('feral-ready')).toBe(true),
    );
  });

  test('removes the surface from the DOM once the fade is done', async () => {
    runPrepaint();
    writeStartupMarkup();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    mountReact();

    await vi.waitFor(
      () => expect(document.getElementById('feral-startup')).toBeNull(),
      { timeout: 3000 },
    );
  });

  test('keeps the surface up when React never mounts', async () => {
    // Deliberate: a boot failure must show the Feral surface, not a blank
    // window. The safety-net poll checks the same condition as the observer,
    // so it must not dismiss on a timer alone.
    runPrepaint();
    writeStartupMarkup();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await new Promise((r) => setTimeout(r, 800));
    expect(document.documentElement.classList.contains('feral-ready')).toBe(false);
    expect(document.getElementById('feral-startup')).not.toBeNull();
  });
});
