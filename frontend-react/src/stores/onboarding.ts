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
  setAgentName: (name) => set({ agentName: name.trim() || 'Feral' }),

  skip: () =>
    set({
      active: false,
      skipped: true,
      completedAt: Date.now(),
      hasOnboardedBefore: true,
    }),

  finish: async () => {
    const s = get();
    set({
      active: false,
      skipped: false,
      completedAt: Date.now(),
      hasOnboardedBefore: true,
    });
    // Persist to disk so the next launch knows to skip the wizard.
    try {
      await persistOnboarding({
        completed: true,
        completedAt: Date.now(),
        userName: s.userName,
        agentName: s.agentName || 'Feral',
      });
    } catch (err) {
      // Non-fatal: the in-memory state is already updated.
      console.error('[onboarding] failed to persist:', err);
    }
  },

  loadPersisted: async () => {
    try {
      const record = await loadPersistedOnboarding();
      if (record?.completed) {
        set({
          hasOnboardedBefore: true,
          userName: record.userName ?? '',
          agentName: record.agentName ?? 'Feral',
          completedAt: record.completedAt ?? null,
        });
        return true;
      }
    } catch (err) {
      console.warn('[onboarding] loadPersisted failed:', err);
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
