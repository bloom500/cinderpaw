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

  skip: () => {
    const completedAt = Date.now();
    set({
      active: false,
      skipped: true,
      completedAt,
      hasOnboardedBefore: true,
    });
    const s = get();
    void persistAsync({
      completed: true,
      completedAt,
      userName: s.userName,
      agentName: s.agentName || 'Feral',
    });
  },

  // (no helper functions below — the persistence layer lives in
  // onboardingPersistence.ts and is invoked through the actions above.)

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
    // Persist to BOTH localStorage (sync) and the Tauri command
    // (async, survives uninstall + auto-updates). The function is
    // idempotent — calling it twice writes the same record.
    void persistAsync(record);
  },

  loadPersisted: async () => {
    // Try the layered persistence: localStorage first (sync, no I/O,
    // always available), then the Tauri command (async, survives
    // uninstall + auto-updates because the record lives in ~/).
    const record = await loadPersistedAsync();
    if (record?.completed) {
      set({
        hasOnboardedBefore: true,
        userName: record.userName ?? '',
        agentName: record.agentName ?? 'Feral',
        completedAt: record.completedAt ?? null,
      });
      return true;
    }
    set({ hasOnboardedBefore: false });
    return false;
  },
}));

// ---------------------------------------------------------------------------
// Persistence — localStorage + Tauri command (see onboardingPersistence.ts)
// ---------------------------------------------------------------------------

import { loadPersistedAsync, persistAsync } from './onboardingPersistence';

export interface PersistedOnboarding {
  completed: boolean;
  completedAt: number;
  userName: string;
  agentName: string;
}

// (All persistence I/O lives in ./onboardingPersistence.ts. This file
// only declares the store actions.)
