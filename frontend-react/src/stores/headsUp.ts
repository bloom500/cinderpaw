import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

/** A "Something you should know" card from the agent's `heads_up` tool. */
export interface HeadsUp {
  id: string;
  title: string;
  detail: string;
  /** The evidence behind it, shown on "Learn more". */
  more?: string;
}

export type HeadsUpChoice = 'more' | 'knew' | 'dismiss';

interface HeadsUpState {
  /** The newest card per chat; a newer one replaces it. */
  bySession: Record<string, HeadsUp>;
  /** From a `tool_done` of `heads_up`: the card rides the tool's `data`. */
  show: (sessionId: string, result: unknown) => void;
  /** Tell the agent what the person chose; knew and dismiss close the card. */
  answer: (sessionId: string, choice: HeadsUpChoice) => void;
}

export const useHeadsUp = create<HeadsUpState>((set, get) => ({
  bySession: {},
  show: (sessionId, result) => {
    const card = (result as { data?: { headsUp?: HeadsUp } } | null)?.data?.headsUp;
    if (!sessionId || !card?.id || !card.title) return;
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: card } }));
  },
  answer: (sessionId, choice) => {
    const card = get().bySession[sessionId];
    if (!card) return;
    // Fire-and-forget: the agent never waits on this, and a closed app must
    // not leave the card stuck open.
    void invoke('cinderpaw_heads_up_answer', { sessionId, headsUpId: card.id, choice }).catch(() => {});
    if (choice !== 'more') {
      set((s) => {
        const rest = { ...s.bySession };
        delete rest[sessionId];
        return { bySession: rest };
      });
    }
  },
}));
