/**
 * Onboarding persistence — localStorage + optional Tauri fs.
 *
 * The wizard needs to know "has this user already onboarded?" in <1s
 * after app start (before the React shell paints). Two persistence
 * options:
 *
 *   1. localStorage (primary)
 *      - Synchronous, available immediately on mount
 *      - No Tauri permissions required
 *      - Works in dev mode AND after WebView reload (Ctrl+R)
 *      - Trade-off: lives in the WebView's data dir, not visible
 *        to other apps; can be cleared by the user
 *
 *   2. Tauri fs (`~/.feral/onboarding.json`, secondary)
 *      - Cross-platform, inspectable, durable across reinstalls
 *      - Requires plugin-fs registered in tauri.conf.json capabilities
 *      - Async, may fail silently in dev mode without the capability
 *
 * The order on `loadPersisted` is: localStorage first (synchronous,
 * always works). If that's empty, try the file (for users who set up
 * the capability AND want the file-based record). On `finish` we
 * write both: localStorage is the source of truth, the file is best-effort.
 */

import type { PersistedOnboarding } from '@/stores/onboarding';

const STORAGE_KEY = 'feral.onboarding';

export function readLocal(): PersistedOnboarding | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedOnboarding;
    if (parsed?.completed === true) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function writeLocal(record: PersistedOnboarding): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // localStorage may be full or disabled (private mode). We accept the
    // failure silently — the in-memory store still has the state, and
    // the file-write (best-effort) may also succeed.
  }
}

export function clearLocal(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
