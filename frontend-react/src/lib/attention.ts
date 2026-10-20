import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * One notice on screen at a time. On a first launch What's new, the Alpha
 * card, the update and the usage question each decided on their own to
 * appear, and four boxes fought for the same first look (Darius, 20 Oct;
 * Apple's rule: nothing competes for attention without a reason).
 *
 * Each notice asks for a turn. The turn goes to the most important one
 * waiting, in this order (his), and stays with it until it is closed: a card
 * someone is reading is never swapped for another. Toasts are not notices:
 * they answer something the person just did, and stay outside this.
 */
export const ATTENTION_ORDER = ['whatsNew', 'alpha', 'update', 'usage'] as const;
export type AttentionSlot = (typeof ATTENTION_ORDER)[number];

interface Attention {
  waiting: AttentionSlot[];
  holder: AttentionSlot | null;
  want: (slot: AttentionSlot, on: boolean) => void;
}

const first = (waiting: AttentionSlot[]) => ATTENTION_ORDER.find((s) => waiting.includes(s)) ?? null;

// The turn is handed out a microtask later, not on the spot: notices mounted in
// the same render register one after another, and the most important of them
// must win, not the one that happened to be first in the tree.
let picking = false;
function pickSoon() {
  if (picking) return;
  picking = true;
  queueMicrotask(() => {
    picking = false;
    const { holder, waiting } = useAttention.getState();
    if (!holder) useAttention.setState({ holder: first(waiting) });
  });
}

export const useAttention = create<Attention>((set, get) => ({
  waiting: [],
  holder: null,
  want: (slot, on) => {
    const { waiting, holder } = get();
    const nextWaiting = on ? (waiting.includes(slot) ? waiting : [...waiting, slot]) : waiting.filter((s) => s !== slot);
    const kept = holder && nextWaiting.includes(holder) ? holder : null;
    set({ waiting: nextWaiting, holder: kept });
    if (!kept && nextWaiting.length) pickSoon();
  },
}));

/** True while this notice may show. `wants` false, or unmounting, passes the turn on. */
export function useAttentionTurn(slot: AttentionSlot, wants: boolean): boolean {
  useEffect(() => {
    useAttention.getState().want(slot, wants);
    return () => useAttention.getState().want(slot, false);
  }, [slot, wants]);
  return useAttention((s) => wants && s.holder === slot);
}
