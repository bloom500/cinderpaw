/**
 * Regression cover for `public/cinderpaw-prepaint.js`.
 *
 * The bug this exists for: the script is a BLOCKING script in <head>, so it
 * runs before <body> is parsed. It used to look up `#cinderpaw-startup` and
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
 *
 * EVERY test here runs under fake timers. The script schedules REAL
 * setTimeouts (the MIN_HOLD_MS presentation floor), and a pending one from a
 * previous test fires mid-way through the next one's assertions — a leaked
 * `cinderpaw-ready` class that looks exactly like the hold being broken. Fake
 * clocks per test make the hold deterministic and leak-free.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
// Vite's ?raw loads the shipped file itself, so the test can never drift
// onto a copy of the script.
import SCRIPT from '../../public/cinderpaw-prepaint.js?raw';

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
    <div id="cinderpaw-startup"><div class="cinderpaw-startup-bear"></div></div>
  `;
}

describe('cinderpaw-prepaint', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useFakeTimers();
  });

  test('stamps the theme before the DOM exists', () => {
    // The whole reason the script is blocking and in <head>.
    localStorage.setItem('cinderpaw-ui', JSON.stringify({ state: { theme: 'light' } }));
    runPrepaint();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  test('falls back to dark when the persisted theme is corrupt', () => {
    localStorage.setItem('cinderpaw-ui', '{not json');
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

    expect(document.documentElement.classList.contains('cinderpaw-ready')).toBe(false);

    mountReact();
    await vi.advanceTimersByTimeAsync(500);
    // Still inside MIN_HOLD_MS — the presentation floor, not a bug.
    expect(document.documentElement.classList.contains('cinderpaw-ready')).toBe(false);

    await vi.advanceTimersByTimeAsync(1500);
    expect(document.documentElement.classList.contains('cinderpaw-ready')).toBe(true);
  });

  test('dismisses when React already mounted, after the hold', async () => {
    // A fast mount can beat DOMContentLoaded; the surface must not linger
    // beyond the hold window.
    writeStartupMarkup();
    mountReact();
    runPrepaint();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.advanceTimersByTimeAsync(2000);
    expect(document.documentElement.classList.contains('cinderpaw-ready')).toBe(true);
  });

  test('removes the surface from the DOM once the fade is done', async () => {
    runPrepaint();
    writeStartupMarkup();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    mountReact();

    // Hold (1600) + fade (500) + slack.
    await vi.advanceTimersByTimeAsync(2500);
    expect(document.getElementById('cinderpaw-startup')).toBeNull();
  });

  test('keeps the surface up when React never mounts', async () => {
    // Deliberate: a boot failure must show the Cinderpaw surface, not a blank
    // window. The safety-net poll checks the same condition as the observer,
    // so it must not dismiss on a timer alone.
    runPrepaint();
    writeStartupMarkup();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.advanceTimersByTimeAsync(5000);
    expect(document.documentElement.classList.contains('cinderpaw-ready')).toBe(false);
    expect(document.getElementById('cinderpaw-startup')).not.toBeNull();
  });
});
