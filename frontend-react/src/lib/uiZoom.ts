import { getCurrentWebview } from '@tauri-apps/api/webview';
import { readLocal, writeLocal } from '@/lib/utils';
import { useNotifications } from '@/stores/notifications';

/**
 * The whole window's size: Ctrl + / Ctrl - / Ctrl 0, kept across restarts.
 *
 * The webview's own zoom, not a CSS `zoom` on the page: that one scales
 * `100vh` too, so a full-height shell spilled past the bottom of the window.
 * Page zoom shrinks the layout viewport instead, the way a browser's does.
 * (28 Oct, his words: the UI is too small for him, Claude's size is right.)
 */
const KEY = 'cinderpaw.uiZoom';
const MIN = 0.8;
const MAX = 1.6;
const STEP = 0.1;

const clamp = (z: number) => Math.min(MAX, Math.max(MIN, Math.round(z * 10) / 10));

let zoom = clamp(Number(readLocal(KEY)) || 1);

/** CSS pixels times this = the window's logical pixels, which is what native
 *  views (the browser page) are placed in. */
export function uiZoom(): number {
  return zoom;
}

export async function setUiZoom(next: number, announce = true): Promise<void> {
  const before = zoom;
  zoom = clamp(next);
  try {
    await getCurrentWebview().setZoom(zoom);
  } catch (err) {
    // Saved only once the window really changed: before the permission was
    // granted, every press that did nothing was still saved, and the next
    // start opened at 160% (28 Oct).
    zoom = before;
    console.warn('[uiZoom] setZoom failed:', err);
    return;
  }
  writeLocal(KEY, String(zoom));
  if (!announce) return;
  // One notice, replaced on every press, so holding the key does not stack four.
  const n = useNotifications.getState();
  for (const t of n.toasts) if (t.title.startsWith('Size ')) n.dismiss(t.id);
  n.push('info', `Size ${Math.round(zoom * 100)}%`, zoom === 1 ? undefined : 'Ctrl 0 goes back to 100%.');
}

/** Ctrl + / Ctrl - / Ctrl 0 (and the numpad keys). True when the key was a zoom key. */
export function zoomKey(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  // `=` is the unshifted `+` key on most layouts; `+` arrives with Shift or from the numpad.
  if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') { void setUiZoom(zoom + STEP); return true; }
  if (e.key === '-' || e.code === 'NumpadSubtract') { void setUiZoom(zoom - STEP); return true; }
  if (e.key === '0' || e.code === 'Numpad0') { void setUiZoom(1); return true; }
  return false;
}
