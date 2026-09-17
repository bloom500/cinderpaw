/**
 * Tell the glass a side panel is moving.
 *
 * `html.panel-moving` switches the app pane's backdrop to its no-displacement
 * form (globals.css) for the length of a slide. A counter, not a boolean: the
 * Artifacts panel can close while the Browser panel opens, and the class must
 * stay until the last one has settled.
 */
let moving = 0;
const settled = new Set<() => void>();

/**
 * Run `fn` once nothing is sliding any more, or now when nothing is.
 *
 * For work that must not happen DURING a slide. The built-in browser's page is
 * a native webview, and resizing it is a real window resize the page lays
 * itself out for: doing that in the middle of the nav's 200 ms slide stalled
 * both (17 Sep, the two-second sidebar). One resize after the slide is the
 * same end state for a fraction of the cost.
 */
export function onPanelMotionSettled(fn: () => void): void {
  if (moving === 0) {
    fn();
    return;
  }
  settled.add(fn);
}

export function panelMotionStart(): void {
  moving += 1;
  document.documentElement.classList.add('panel-moving');
}

export function panelMotionEnd(): void {
  moving = Math.max(0, moving - 1);
  if (moving > 0) return;
  document.documentElement.classList.remove('panel-moving');
  const waiting = [...settled];
  settled.clear();
  for (const fn of waiting) fn();
}

/** For a panel that unmounts: mark now, clear after the exit has had time to run. */
export function panelMotionExit(durationMs = 220): void {
  panelMotionStart();
  window.setTimeout(panelMotionEnd, durationMs);
}
