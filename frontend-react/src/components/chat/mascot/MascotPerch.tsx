import { useCallback, useEffect, useRef, useState } from 'react';
import { CinderpawMascot, usePrefersReducedMotion } from './CinderpawMascot';
import { ToolCallStack } from './ToolCallStack';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import type { MascotState } from './frames';

/**
 * What the creature does when nobody is doing anything, and what it does when
 * somebody is.
 *
 * This used to be a 48-second scripted loop: idle → curious → run the width of
 * the composer → sleep → stretch → a random expressive beat → repeat, plus a
 * gaming detour every second cycle. Every step was a `setTimeout`, and that is
 * exactly why it stopped being seen. A loop that is the same length and the
 * same order every time is predictable, and the brain filters predictable
 * motion out within a few repetitions — the mascot was still moving and had
 * become wallpaper.
 *
 * What does not filter out is CONTINGENCY: motion caused by something the
 * person just did. It cannot be predicted, because it depends on them. So the
 * timers are down to one — a long quiet eventually puts it to sleep, which is
 * information rather than decoration — and the rest of the life is reaction.
 *
 * The first reaction is being touchable at all. Both this wrapper and the
 * canvas inside it carried `pointer-events: none`, so a cursor went straight
 * through the creature as if it were a ghost. Something you cannot poke is not
 * something that feels alive.
 */

/** Quiet for this long and it dozes off. Long on purpose: this is the only
 *  timed behaviour left, and it should read as "the app went quiet", not as an
 *  animation waiting for its turn. */
const SLEEP_AFTER_MS = 45_000;

/** How long a poke reaction holds before it hands the state back. */
const POKED_MS = 900;
const SMITTEN_MS = 1_800;

/** Pokes this close together are the same bout of attention, and enough of
 *  them in one bout turns being startled into being pleased. */
const POKE_BOUT_MS = 2_500;
const POKES_TO_SMITTEN = 3;

export function MascotPerch({ baseState }: { baseState: MascotState }) {
  // #24: user-facing kill switch (Settings → Appearance). Early-return keeps
  // the sleep timer below from even starting.
  const mascotEnabled = useUI((s) => s.mascotEnabled);
  if (!mascotEnabled) return null;
  return <MascotPerchInner baseState={baseState} />;
}

function MascotPerchInner({ baseState }: { baseState: MascotState }) {
  const [renderState, setRenderState] = useState<MascotState>(baseState);
  /** A reaction to something the person did. Outranks idle, never outranks the
   *  agent: see the resolve step below. */
  const [reaction, setReaction] = useState<MascotState | null>(null);
  /** The pointer is on it right now. Not a timed reaction: it lasts exactly as
   *  long as the cursor does, which is the point. */
  const [noticed, setNoticed] = useState(false);
  const [dozing, setDozing] = useState(false);
  const reactionTimer = useRef<number | null>(null);
  const pokes = useRef<{ count: number; last: number }>({ count: 0, last: 0 });

  /**
   * The OS setting already answered this question.
   *
   * `CinderpawMascot` honours `prefers-reduced-motion` by freezing its sprite
   * frames. The travel across the composer that used to run past that freeze
   * is gone entirely now, so what is left to honour is the doze: a creature
   * that changes pose on its own while nobody asked is the ambient motion the
   * setting is about. Reactions stay, because a reaction is something the
   * person started, which is the one kind of motion the setting does not ask
   * anyone to give up.
   */
  const reduced = usePrefersReducedMotion();

  const react = useCallback((state: MascotState, holdMs: number) => {
    if (reactionTimer.current !== null) window.clearTimeout(reactionTimer.current);
    setReaction(state);
    reactionTimer.current = window.setTimeout(() => {
      setReaction(null);
      reactionTimer.current = null;
    }, holdMs);
  }, []);

  // Cleared on unmount, so a reaction started a moment before the composer
  // goes away cannot land on a component that is no longer there.
  useEffect(
    () => () => {
      if (reactionTimer.current !== null) window.clearTimeout(reactionTimer.current);
    },
    [],
  );

  // The one timer left. It only runs while genuinely idle, and any turn, any
  // poke, or the pointer arriving cancels it by resetting the effect.
  useEffect(() => {
    setDozing(false);
    if (reduced || baseState !== 'idle' || reaction !== null || noticed) return;
    const t = window.setTimeout(() => setDozing(true), SLEEP_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [baseState, reaction, noticed, reduced]);

  // Resolve, in priority order. The agent's own state is INFORMATION — what it
  // is thinking, reading, calling — and a poke must not paint over it, so a
  // reaction only decorates an idle creature.
  useEffect(() => {
    if (baseState !== 'idle') setRenderState(baseState);
    else if (reaction) setRenderState(reaction);
    else if (noticed) setRenderState('curious');
    else if (dozing) setRenderState('sleep');
    else setRenderState('idle');
  }, [baseState, reaction, noticed, dozing]);

  const onLeave = useCallback(() => setNoticed(false), []);

  const onPoke = useCallback(() => {
    const now = Date.now();
    const p = pokes.current;
    p.count = now - p.last < POKE_BOUT_MS ? p.count + 1 : 1;
    p.last = now;
    if (p.count >= POKES_TO_SMITTEN) {
      p.count = 0;
      react('love', SMITTEN_MS);
    } else {
      react('surprised', POKED_MS);
    }
  }, [react]);

  return (
    <div className="pointer-events-none absolute -top-[43px] left-5 z-10">
      {/* Only the creature itself takes the pointer. The wrapper stays
          transparent to it so the composer underneath keeps every click it
          had, and `ToolCallStack` keeps its own buttons. */}
      <span
        className="pointer-events-auto inline-block cursor-pointer"
        onPointerEnter={() => setNoticed(true)}
        onPointerLeave={onLeave}
        onPointerDown={onPoke}
      >
        <CinderpawMascot state={renderState} flip={false} />
      </span>
      <ToolCallStack
        events={useChat((s) => s.toolCallStream)}
        active={renderState !== 'idle'}
      />
    </div>
  );
}
