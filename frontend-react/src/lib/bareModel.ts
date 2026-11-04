import { create } from 'zustand';

/**
 * Dev-only "Bare model" switch: the next replies come from the chosen model
 * alone, with no Cinderpaw prompt, tools, memory or loop (the engine side is
 * CinderpawAgent/src/core/bare-turn.ts). For filming the model against the
 * same model inside Cinderpaw, from one app. Never in a release build: every
 * reader checks `import.meta.env.DEV` first.
 *
 * ponytail: one switch for the whole app, not per chat, and not saved; it is
 * off again after a restart, and every bare reply says so under it.
 */
export const useBareModel = create<{ on: boolean; toggle: () => void }>((set) => ({
  on: false,
  toggle: () => set((s) => ({ on: !s.on })),
}));

/** True only in a dev build with the switch on. */
export const bareModelOn = (): boolean => import.meta.env.DEV && useBareModel.getState().on;
