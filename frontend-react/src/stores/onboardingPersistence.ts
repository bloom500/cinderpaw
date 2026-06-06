/**
 * Onboarding persistence — localStorage + Tauri commands.
 *
 * The wizard needs to know "has this user already onboarded?" in <1s
 * after app start. Three storage layers, in priority order:
 *
 *   1. localStorage (synchronous, always works)
 *      - Survives: Ctrl+R, F5, Vite HMR
 *      - Dies on: uninstall, Tauri auto-update (WebView data dir wiped)
 *
 *   2. ~/.feral/onboarding.json via Tauri command (Rust std::fs)
 *      - Survives: everything localStorage does PLUS uninstall + reinstall
 *        and Tauri auto-updates (lives in the user's home dir, outside
 *        the app data dir)
 *      - Requires: the Tauri Rust shell running (not pure browser dev)
 *
 *   3. (deprecated) @tauri-apps/plugin-fs — kept as a no-op fallback so
 *      the function signature is stable. Not used because the plugin
 *      needs capability registration we don't want to maintain.
 *
 * The order on `loadPersisted` is: localStorage first (sync, always
 * works). If empty, try the Tauri command and backfill localStorage.
 * On `finish`, we write BOTH: localStorage is the source of truth for
 * the next launch, the Tauri command makes the record survive
 * uninstall + auto-update.
 */

import { invoke } from '@tauri-apps/api/core';
import type { PersistedOnboarding } from '@/stores/onboarding';

const STORAGE_KEY = 'feral.onboarding';

// Detect Tauri at runtime. In pure browser dev (Vite without Tauri shell)
// the __TAURI_INTERNALS__ object is absent — we skip the command calls
// and rely on localStorage only.
function isTauriAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window
  );
}

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
    // localStorage may be full or disabled (private mode). We accept
    // the failure silently — the in-memory store still has the state,
    // and the Tauri command may also succeed.
  }
}

async function readTauriCommand(): Promise<PersistedOnboarding | null> {
  if (!isTauriAvailable()) return null;
  try {
    const record = await invoke<{
      completed: boolean;
      completedAt: number;
      userName: string;
      agentName: string;
    } | null>('get_onboarding_record');
    if (record && record.completed) return record as PersistedOnboarding;
    return null;
  } catch (err) {
    // Tauri command failed (older app version, missing permission).
    // localStorage is the fallback.
    console.warn('[onboarding] tauri read failed:', err);
    return null;
  }
}

async function writeTauriCommand(record: PersistedOnboarding): Promise<boolean> {
  if (!isTauriAvailable()) return false;
  try {
    await invoke('set_onboarding_record', {
      record: {
        completed: record.completed,
        completedAt: record.completedAt,
        userName: record.userName,
        agentName: record.agentName,
      },
    });
    return true;
  } catch (err) {
    console.warn('[onboarding] tauri write failed (localStorage still has it):', err);
    return false;
  }
}

export async function loadPersistedAsync(): Promise<PersistedOnboarding | null> {
  // 1. localStorage (sync, no I/O, always available in WebView).
  const local = readLocal();
  if (local) return local;

  // 2. Tauri command (async, survives uninstall + auto-updates).
  const tauri = await readTauriCommand();
  if (tauri) {
    // Backfill localStorage so the next launch is faster.
    writeLocal(tauri);
    return tauri;
  }
  return null;
}

export async function persistAsync(record: PersistedOnboarding): Promise<void> {
  // localStorage is the source of truth for the current session. Write
  // it synchronously so even a sync error can't lose the record.
  writeLocal(record);
  // Tauri command is best-effort but critical for uninstall survival.
  await writeTauriCommand(record);
}
