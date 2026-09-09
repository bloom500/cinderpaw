import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How well the creature knows you, and nothing else.
 *
 * This is the tamagotchi half of the mascot: the agent states in
 * `useMascotState` say what is happening RIGHT NOW, and they are forgotten on
 * refresh. Nothing in the mascot survived a reload, so it reacted perfectly
 * and never remembered you. That is what this file adds, and it adds only
 * that.
 *
 * Three rules it will not break, because each of them is a way this kind of
 * mechanic normally goes wrong:
 *
 * 1. NO DECAY, NO NEEDS, NO DEATH. Every counter here only ever goes up. A pet
 *    that gets sad while you are away turns opening the app into a debt, and
 *    the person most punished by that is the one who installed it today and
 *    has nothing stored at all. Guilt is not attachment.
 * 2. TIER 0 IS THE PRODUCT. Every machine starts here, most people never leave
 *    it, and the creature has to be worth having on that first afternoon.
 *    Higher tiers are a reward for time already spent, never the version where
 *    the mascot finally becomes good.
 * 3. IT NEVER TALKS ABOUT ITSELF. No level, no meter, no "friendship +1"
 *    toast. If the tier is legible as a number it stops being a relationship
 *    and becomes a chore. It is only allowed to show in behaviour.
 */

export type BondTier = 0 | 1 | 2 | 3;

export interface Bond {
  /** Times it has been poked. */
  pokes: number;
  /** Times it has been picked up and let go. */
  throws: number;
  /** Times the app has been opened with the mascot on screen. */
  sessions: number;
  /** Agent turns that finished successfully while it was watching. */
  turns: number;
}

export const EMPTY_BOND: Bond = { pokes: 0, throws: 0, sessions: 0, turns: 0 };

const KEY = 'cinderpaw.bond.v1';
/** Set this to 0-3 to see a tier you have not earned. See `forcedTier`. */
const FORCE_KEY = 'cinderpaw.bond.force';

/**
 * Weighted so that working together counts for more than playing with it.
 *
 * A session and a finished turn are worth several pokes each, because poking
 * is free and repeatable: without the weighting the fastest way to a bond is
 * to sit and click the creature two hundred times, which is the opposite of
 * the thing being rewarded. Throws sit in between — they take a moment and
 * they are the part people show other people.
 */
export function score(b: Bond): number {
  return b.pokes + b.throws * 2 + b.sessions * 4 + b.turns * 3;
}

/** Thresholds, in `score` units. Roughly: a first session, a few days of real
 *  use, and then a fortnight of it. Deliberately slow — a tier reached in an
 *  afternoon is a progress bar, not a memory. */
const TIER_AT = [0, 25, 120, 400] as const;

export function tierFor(b: Bond): BondTier {
  const s = score(b);
  if (s >= TIER_AT[3]) return 3;
  if (s >= TIER_AT[2]) return 2;
  if (s >= TIER_AT[1]) return 1;
  return 0;
}

/**
 * Storage that is allowed to fail.
 *
 * `localStorage` throws rather than returning null in a browser set to block
 * site data, and it is simply absent while rendering outside a browser. A
 * mascot must not take the composer down with it, so every failure here means
 * the same thing as a fresh install: tier 0, which is a state the product is
 * already required to be good in.
 */
export function loadBond(): Bond {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY_BOND };
    const p = JSON.parse(raw) as Partial<Bond>;
    // Read field by field: a hand-edited or half-written value should cost the
    // one counter it broke, not the whole history.
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return { pokes: n(p.pokes), throws: n(p.throws), sessions: n(p.sessions), turns: n(p.turns) };
  } catch {
    return { ...EMPTY_BOND };
  }
}

export function saveBond(b: Bond): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(b));
  } catch {
    /* a creature that cannot remember you still has to work today */
  }
}

/**
 * A tier you asked for instead of one you earned.
 *
 * Tier 3 is a fortnight away by design, which makes it the one part of this
 * feature nobody can look at while building it — and a thing you cannot see
 * twice cannot be judged. `?bond=3` in the URL, or the `FORCE_KEY` item in
 * localStorage for the desktop build where there is no address bar to type in.
 * Returns null when nothing is forced, which is the normal case.
 */
export function forcedTier(): BondTier | null {
  const read = (v: string | null): BondTier | null => {
    if (v === null) return null;
    const n = Number(v);
    return n === 0 || n === 1 || n === 2 || n === 3 ? (n as BondTier) : null;
  };
  try {
    return (
      read(new URLSearchParams(window.location.search).get('bond')) ??
      read(window.localStorage.getItem(FORCE_KEY))
    );
  } catch {
    return null;
  }
}

/**
 * What the tier is actually allowed to change.
 *
 * Behaviour only, and only by choosing among poses that already exist. There
 * are 127 hand-drawn frames in `frames.ts`; a tier that needed its own frames
 * would mean four times that number kept consistent by hand, which is exactly
 * where sprite work rots. So a tier picks differently from the same set and
 * waits differently between them.
 */
export interface BondTraits {
  /** Pokes in one bout before being startled turns into being pleased. */
  pokesToSmitten: number;
  /** First touch of a bout. A stranger is startled; a friend says hello. */
  greeting: 'surprised' | 'wave';
  /** How long the smitten reaction holds, in ms. */
  smittenMs: number;
}

export function traitsFor(tier: BondTier): BondTraits {
  switch (tier) {
    case 3: return { pokesToSmitten: 1, greeting: 'wave', smittenMs: 2_600 };
    case 2: return { pokesToSmitten: 2, greeting: 'wave', smittenMs: 2_200 };
    case 1: return { pokesToSmitten: 3, greeting: 'surprised', smittenMs: 2_000 };
    default: return { pokesToSmitten: 3, greeting: 'surprised', smittenMs: 1_800 };
  }
}

/**
 * The bond, loaded once and written through on every change.
 *
 * The counters live in a ref and only the TIER is state, because the numbers
 * are not something the screen ever shows — re-rendering the creature because
 * a poke count went from 41 to 42 would be a render for nobody. The tier is
 * the only part anything downstream can see, and it changes a few times in a
 * creature's life.
 */
export function useBond(): { tier: BondTier; traits: BondTraits; remember: (of: keyof Bond) => void } {
  const bond = useRef<Bond>(EMPTY_BOND);
  const counted = useRef(false);
  const [tier, setTier] = useState<BondTier>(0);

  useEffect(() => {
    // Guarded because React's development double-mount would otherwise count
    // one opened app as two sessions.
    if (counted.current) return;
    counted.current = true;
    const b = loadBond();
    b.sessions += 1;
    bond.current = b;
    saveBond(b);
    setTier(forcedTier() ?? tierFor(b));
  }, []);

  const remember = useCallback((of: keyof Bond) => {
    const b = { ...bond.current, [of]: bond.current[of] + 1 };
    bond.current = b;
    saveBond(b);
    setTier(forcedTier() ?? tierFor(b));
  }, []);

  return { tier, traits: traitsFor(tier), remember };
}
