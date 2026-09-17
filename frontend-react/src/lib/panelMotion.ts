/**
 * Tell the glass a side panel is moving.
 *
 * `html.panel-moving` switches the app pane's backdrop to its no-displacement
 * form (globals.css) for the length of a slide. A counter, not a boolean: the
 * Artifacts panel can close while the Browser panel opens, and the class must
 * stay until the last one has settled.
 */
let moving = 0;

export function panelMotionStart(): void {
  moving += 1;
  document.documentElement.classList.add('panel-moving');
}

export function panelMotionEnd(): void {
  moving = Math.max(0, moving - 1);
  if (moving === 0) document.documentElement.classList.remove('panel-moving');
}

/** For a panel that unmounts: mark now, clear after the exit has had time to run. */
export function panelMotionExit(durationMs = 220): void {
  panelMotionStart();
  window.setTimeout(panelMotionEnd, durationMs);
}
