import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * One notice on screen at a time. On a first launch What's new, the Alpha
 * card, the update and the usage question each decided on their own to
 * appear, and four boxes fought for the same first look (Darius, 20 Oct;
 * Apple's rule: nothing competes for attention without a reason). The Alpha
 * card is gone since: the setup wizard's last screen says it once.
 *
 * Each notice asks for a turn. The turn goes to the most important one
 * waiting, in this order (agreed with him: an update may carry the fix for
 * the problem they have), and stays with it until it is closed: a card
 * someone is reading is never swapped for another. Toasts are not notices:
 * they answer something the person just did, and stay outside this.
 *
 * And none of them while the screen belongs to something else (Darius,
 * 31 Oct): the loading screen, or the first-run wizard. The update card drew
 * over both, because the notice column sits above them. A notice may still
 * win its turn meanwhile; it shows the moment the screen is free.
 */
export const ATTENTION_ORDER = ['whatsNew', 'update', 'usage'] as const;
export type AttentionSlot = (typeof ATTENTION_ORDER)[number];

interface Attention {
  waiting: AttentionSlot[];
  holder: AttentionSlot | null;
  /** The loading screen is up (index.html `#cinderpaw-startup`, z 50, under the notices' z 200). */
  startup: boolean;
  /** The first-run wizard is open, or about to open (OnboardingOrchestrator says which). */
  wizard: boolean;
  want: (slot: AttentionSlot, on: boolean) => void;
  setWizard: (on: boolean) => void;
}

/** The loading screen fades once the pre-paint script marks <html> ready, or is removed outright (small windows). */
function startupUp(): boolean {
  if (typeof document === 'undefined') return false;
  return !!document.getElementById('cinderpaw-startup') && !document.documentElement.classList.contains('cinderpaw-ready');
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
  startup: startupUp(),
  wizard: false,
  setWizard: (on) => set({ wizard: on }),
  want: (slot, on) => {
    const { waiting, holder } = get();
    const nextWaiting = on ? (waiting.includes(slot) ? waiting : [...waiting, slot]) : waiting.filter((s) => s !== slot);
    const kept = holder && nextWaiting.includes(holder) ? holder : null;
    set({ waiting: nextWaiting, holder: kept });
    if (!kept && nextWaiting.length) pickSoon();
  },
}));

if (startupUp()) {
  const watch = new MutationObserver(() => {
    if (startupUp()) return;
    watch.disconnect();
    useAttention.setState({ startup: false });
  });
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  watch.observe(document.body, { childList: true });
}

/** True while this notice may show. `wants` false, or unmounting, passes the turn on. */
export function useAttentionTurn(slot: AttentionSlot, wants: boolean): boolean {
  useEffect(() => {
    useAttention.getState().want(slot, wants);
    return () => useAttention.getState().want(slot, false);
  }, [slot, wants]);
  return useAttention((s) => wants && s.holder === slot && !s.startup && !s.wizard);
}
