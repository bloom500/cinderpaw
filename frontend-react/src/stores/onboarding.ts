/**
 * useOnboarding — first-run wizard state.
 *
 * The wizard is intentionally short: the user picks a name for themselves
 * and a name for their agent. Everything else (workspace, model choice,
 * tool permissions) is the agent's job to figure out — exposing it in
 * onboarding would overwhelm a first-time user.
 *
 * Persistence: on `finish()` or `skip()`, the state is written to
 * `~/.feral/onboarding.json` via the Tauri fs API. On next launch the
 * file is read and the wizard is hidden when `completed === true`.
 *
 * The user/agent names are also written there and consumed by the
 * agent-side system prompt (USER block — see FeralAgent/system-prompt
 * integration). The user can re-open the wizard from Settings to
 * rename themselves or the agent.
 */

import { create } from 'zustand';

export interface OnboardingState {
  active: boolean;
  step: number;
  /** The user's chosen display name. Used by the agent to address them. */
  userName: string;
  /** The user's chosen name for the agent. Used by the agent for self-reference. */
  agentName: string;
  /** True if the user explicitly dismissed the wizard without completing. */
  skipped: boolean;
  /** Epoch ms when the wizard finished or was skipped. Null = still pending. */
  completedAt: number | null;
  /** True when the persisted record says "this user has already onboarded". */
  hasOnboardedBefore: boolean;
  /** Total number of steps in the wizard (used by progress bar + next/prev). */
  totalSteps: number;

  start: () => void;
  next: () => void;
  prev: () => void;
  setUserName: (name: string) => void;
  setAgentName: (name: string) => void;
  skip: () => void;
  finish: () => Promise<void>;
  /** Programmatically re-open the wizard (e.g. from Settings → "Show welcome"). */
  reopen: () => void;
  /** Load the persisted record from disk and decide whether to show the wizard. */
  loadPersisted: () => Promise<boolean>;
}

const DEFAULTS = {
  userName: '',
  agentName: 'Feral',
  hasOnboardedBefore: false,
  skipped: false,
  completedAt: null,
  active: false,
  step: 0,
  // Welcome → Personalize → Showcase → Done
  totalSteps: 4,
} as const;

export const useOnboarding = create<OnboardingState>((set, get) => ({
  ...DEFAULTS,

  start: () => set({ active: true, step: 0, completedAt: null, skipped: false }),

  reopen: () => set({ active: true, step: 0 }),

  next: () =>
    set((s) => ({
      step: Math.min(s.step + 1, s.totalSteps - 1),
    })),

  prev: () =>
    set((s) => ({
      step: Math.max(0, s.step - 1),
    })),

  setUserName: (name) => set({ userName: name.trim() }),
  // Note: we do NOT fall back to "Feral" on empty input here — the user
  // must be able to fully clear the field to retype. The "Feral" default
  // is applied at the use sites (Preview, DoneStep, agent prompt) via
  // `agentName.trim() || "Feral"`. Storing the raw value also means a
  // half-typed name ("F") doesn't get clobbered to "Feral".
  setAgentName: (name) => set({ agentName: name.trim() }),

  skip: () =>
    set({
      active: false,
      skipped: true,
      completedAt: Date.now(),
      hasOnboardedBefore: true,
    }),

  finish: async () => {
    const s = get();
    const record: PersistedOnboarding = {
      completed: true,
      completedAt: Date.now(),
      userName: s.userName,
      agentName: s.agentName || 'Feral',
    };
    // Update in-memory state FIRST so the UI closes the wizard immediately,
    // regardless of how long the disk write takes (or whether it succeeds).
    set({
      active: false,
      skipped: false,
      completedAt: record.completedAt,
      hasOnboardedBefore: true,
    });
    // Persist to localStorage synchronously — this is the source of truth
    // for the next launch. If this fails, the in-memory state is correct
    // for the current session but a WebView reload would re-show the wizard.
    writeLocal(record);
    // Best-effort: also write to the on-disk file for cross-platform
    // inspectability. Failure here is non-fatal (the wizard is closed and
    // localStorage already has the record).
    try {
      await persistOnboarding(record);
    } catch (err) {
      console.warn('[onboarding] file write skipped (localStorage has it):', err);
    }
  },

  loadPersisted: async () => {
    // Step 1: localStorage (sync, always works, no permissions). If the
    // user has completed onboarding in this WebView before, this returns
    // the record and we never even need to touch the file system.
    const local = readLocal();
    if (local?.completed) {
      set({
        hasOnboardedBefore: true,
        userName: local.userName ?? '',
        agentName: local.agentName ?? 'Feral',
        completedAt: local.completedAt ?? null,
      });
      return true;
    }

    // Step 2: try the on-disk file (best-effort). This is for users who
    // either cleared localStorage or want the record visible to other
    // apps. The fs plugin requires a Tauri capability; if it's missing
    // this call throws and we fall through to the "not onboarded" state.
    try {
      const record = await loadPersistedOnboarding();
      if (record?.completed) {
        set({
          hasOnboardedBefore: true,
          userName: record.userName ?? '',
          agentName: record.agentName ?? 'Feral',
          completedAt: record.completedAt ?? null,
        });
        // Backfill localStorage so the next launch doesn't have to touch
        // the fs again.
        writeLocal(record);
        return true;
      }
    } catch (err) {
      // File read failed (no capability, missing dir, malformed JSON).
      // The wizard will show — that's the safe default.
      console.warn('[onboarding] file load failed (will show wizard):', err);
    }
    set({ hasOnboardedBefore: false });
    return false;
  },
}));

// ---------------------------------------------------------------------------
// Persistence — Tauri fs API
// ---------------------------------------------------------------------------

import { writeTextFile, readTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { readLocal as readLocalRec, writeLocal as writeLocalRec } from './onboardingPersistence';

export interface PersistedOnboarding {
  completed: boolean;
  completedAt: number;
  userName: string;
  agentName: string;
}

async function ensureFeralDir(): Promise<string> {
  // Resolve the user's home dir then ensure ~/.feral/ exists.
  const home = await homeDir();
  const sep = home.includes('\\') ? '\\' : '/';
  const feralDir = home.endsWith(sep) ? `${home}.feral` : `${home}${sep}.feral`;
  if (!(await exists(feralDir))) {
    try {
      await mkdir(feralDir, { recursive: true });
    } catch (err) {
      // mkdir may fail if the dir already exists (race) — that's fine.
      if (!(await exists(feralDir))) throw err;
    }
  }
  return feralDir;
}

// Convenience wrappers around the localStorage helpers. Inlined here so
// the store file is the single source of truth for the persistence flow.
function readLocal(): PersistedOnboarding | null { return readLocalRec(); }
function writeLocal(record: PersistedOnboarding): void { writeLocalRec(record); }

async function persistOnboarding(record: PersistedOnboarding): Promise<void> {
  const dir = await ensureFeralDir();
  const sep = dir.includes('\\') ? '\\' : '/';
  const path = `${dir}${sep}onboarding.json`;
  await writeTextFile(path, JSON.stringify(record, null, 2));
}

async function loadPersistedOnboarding(): Promise<PersistedOnboarding | null> {
  const home = await homeDir();
  const sep = home.includes('\\') ? '\\' : '/';
  const path = `${home}${sep}.feral${sep}onboarding.json`;
  if (!(await exists(path))) return null;
  try {
    const raw = await readTextFile(path);
    return JSON.parse(raw) as PersistedOnboarding;
  } catch {
    return null;
  }
}
