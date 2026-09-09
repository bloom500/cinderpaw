import { useCallback, useEffect, useRef, useState } from 'react';
import { CinderpawMascot, usePrefersReducedMotion } from './CinderpawMascot';
import { ToolCallStack } from './ToolCallStack';
import { atRest, boundsFrom, leanDegrees, squashFor, step, type Body } from './physics';
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

/** Move the pointer this far while holding it and you meant to pick it up, not
 *  to poke it. Small, because a poke is deliberately still, but not zero: a
 *  mouse drifts a pixel or two under a real finger. */
const DRAG_SLOP_PX = 4;
/** The creature's own width, so it cannot be dropped off the left of the
 *  composer or dragged out past the right of it. Keep in sync with `DISPLAY`
 *  in CinderpawMascot. */
const MASCOT_W = 48;
/** Only a fallback for the moment before the element has been measured. The
 *  real ceiling is the top of the window — see `boundsNow`. */
const LIFT_LIMIT_PX = 220;
/** Kept clear of every window edge, so it never sits half cut off. */
const EDGE_MARGIN_PX = 8;
/** How long the squash of a landing lasts. Short: this is the impact, not a
 *  pose, and anything slower reads as the creature melting. */
const SQUASH_MS = 130;
/** A frame longer than this is a tab that was in the background or a machine
 *  that stalled. Integrating it as one step teleports the creature through the
 *  floor, so the step is clamped instead. */
const MAX_FRAME_S = 1 / 30;

/**
 * Take or give back the pointer, without letting it end the drag if it fails.
 *
 * Capture is what keeps a fast drag attached to the creature when the cursor
 * outruns it. It is also the one call here that throws on its own: the spec
 * says `NotFoundError` for a pointer that is no longer active, which happens
 * routinely when a drag ends outside the window, and jsdom has no active
 * pointers at all. An exception from a nicety is not a reason to drop what the
 * person is holding.
 */
function capture(el: Element, pointerId: number, take: boolean) {
  try {
    if (take) el.setPointerCapture?.(pointerId);
    else if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture?.(pointerId);
  } catch {
    /* the drag works without it, just less well when the cursor gets ahead */
  }
}

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
      if (squashTimer.current !== null) window.clearTimeout(squashTimer.current);
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

  const poke = useCallback(() => {
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

  // ---- picked up, thrown, dropped -------------------------------------
  //
  // The whole point of a pet you can grab is that the result is yours, not a
  // canned animation: fling it and it flies, let go gently and it drops. So
  // the pointer writes velocity into a body and gravity does the rest, rather
  // than a `transition` playing the same arc every time.

  const wrapRef = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  /** Degrees of lean, and how flat it is right now. A rigid sprite has no
   *  other way to show that it has weight, and without them a drag is a
   *  picture sliding across the screen rather than something being carried. */
  const [lean, setLean] = useState(0);
  const [squash, setSquash] = useState(1);
  const squashTimer = useRef<number | null>(null);
  /** Live physics, and the pointer bookkeeping that feeds it. Refs, not state:
   *  these are written every animation frame and every pointer move, and none
   *  of those writes should cost a render of its own — `pos` is the one thing
   *  the screen needs and it is set once per frame. */
  const body = useRef<Body>({ x: 0, y: 0, vx: 0, vy: 0 });
  const grab = useRef<{ id: number; px: number; py: number; ox: number; oy: number; moved: boolean } | null>(null);
  const lastMove = useRef<{ t: number; x: number; y: number } | null>(null);
  const raf = useRef<number | null>(null);

  /**
   * The box it may not leave: the page's content area, not the window.
   *
   * `<main>` in AppShell is `absolute inset-0` with a `paddingLeft` that is
   * animated to the width of the side navigation, so its CONTENT box is
   * already exactly the room the page has — the full width of the app when the
   * nav is collapsed, and everything to the right of the nav when it is open.
   * Reading it here means the wall moves with the nav on its own, including
   * mid-animation, with nothing to keep in sync.
   *
   * The border box would be wrong: that is the whole window in both states,
   * which is how the creature ended up able to sit underneath the navigation.
   * The window is only the fallback, for a mount that has no `<main>` above it.
   *
   * Measured live on every frame rather than cached at grab time. The nav can
   * be collapsed mid-throw, the window is resizable, and the composer grows as
   * you type; a box measured once is wrong by the time the throw lands.
   */
  const boundsNow = useCallback((): { minX: number; maxX: number; minY: number } => {
    const el = wrapRef.current;
    if (!el) return { minX: -240, maxX: 240, minY: -LIFT_LIMIT_PX };
    const r = el.getBoundingClientRect();
    // Where the perch itself sits, with the current offset taken back out.
    const homeLeft = r.left - body.current.x;
    const homeTop = r.top - body.current.y;
    const w = r.width || MASCOT_W;

    const main = el.closest('main');
    let left = 0;
    let right = window.innerWidth;
    let top = 0;
    if (main) {
      const mr = main.getBoundingClientRect();
      const cs = window.getComputedStyle(main);
      left = mr.left + (parseFloat(cs.paddingLeft) || 0);
      right = mr.right - (parseFloat(cs.paddingRight) || 0);
      top = mr.top + (parseFloat(cs.paddingTop) || 0);
    }

    return boundsFrom(
      { left: homeLeft, top: homeTop, width: w },
      { left, right, top },
      EDGE_MARGIN_PX,
    );
  }, []);

  const stopFalling = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);

  const fall = useCallback(() => {
    stopFalling();
    let prev = performance.now();
    const frame = (now: number) => {
      const dt = Math.min((now - prev) / 1000, MAX_FRAME_S);
      prev = now;
      const { body: next, landed, impact } = step(body.current, dt, boundsNow());
      body.current = next;
      setPos({ x: next.x, y: next.y });
      setLean(leanDegrees(next.vx));
      if (landed && impact > 0) {
        const s = squashFor(impact);
        if (s < 1) {
          setSquash(s);
          if (squashTimer.current !== null) window.clearTimeout(squashTimer.current);
          squashTimer.current = window.setTimeout(() => setSquash(1), SQUASH_MS);
        }
      }
      if (landed && atRest(next)) {
        raf.current = null;
        setLean(0);
        // Shakes it off, which is also what tells you the drop is over.
        react('stretching', POKED_MS);
        return;
      }
      raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
  }, [boundsNow, react, stopFalling]);

  useEffect(() => stopFalling, [stopFalling]);

  const onDown = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      // Reduced motion keeps the poke and loses the throw: a creature arcing
      // across the composer under gravity is exactly the large, unrequested
      // movement the setting is about, even when the person started it.
      if (reduced) { poke(); return; }
      stopFalling();
      capture(e.currentTarget, e.pointerId, true);
      grab.current = {
        id: e.pointerId,
        px: e.clientX,
        py: e.clientY,
        ox: body.current.x,
        oy: body.current.y,
        moved: false,
      };
      lastMove.current = { t: performance.now(), x: e.clientX, y: e.clientY };
      body.current = { ...body.current, vx: 0, vy: 0 };
    },
    [poke, reduced, stopFalling],
  );

  const onMove = useCallback((e: React.PointerEvent<HTMLSpanElement>) => {
    const g = grab.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.px;
    const dy = e.clientY - g.py;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
    if (!g.moved) {
      g.moved = true;
      setHeld(true);
    }
    const b = boundsNow();
    const x = Math.min(b.maxX, Math.max(b.minX, g.ox + dx));
    // Held ABOVE the perch is negative, and it cannot be pushed below the
    // floor it is standing on.
    const y = Math.min(0, Math.max(-LIFT_LIMIT_PX, g.oy + dy));

    // Velocity comes from the pointer's own recent movement, so a flick
    // carries and a slow carry does not. Guarded against a zero interval:
    // two moves inside one millisecond would otherwise divide by zero and
    // launch the creature off the screen.
    const now = performance.now();
    const lm = lastMove.current;
    if (lm) {
      const dtS = (now - lm.t) / 1000;
      if (dtS > 0.004) {
        body.current.vx = (e.clientX - lm.x) / dtS;
        body.current.vy = (e.clientY - lm.y) / dtS;
        lastMove.current = { t: now, x: e.clientX, y: e.clientY };
      }
    }
    body.current.x = x;
    body.current.y = y;
    setPos({ x, y });
    // Leaning is what makes a carry feel like weight rather than a picture
    // being slid across the screen. It comes from the same velocity the throw
    // will use, so the lean you see while carrying is the lean it flies with.
    setLean(leanDegrees(body.current.vx));
  }, [boundsNow]);

  const onUp = useCallback((e: React.PointerEvent<HTMLSpanElement>) => {
    const g = grab.current;
    if (!g || g.id !== e.pointerId) return;
    grab.current = null;
    lastMove.current = null;
    capture(e.currentTarget, e.pointerId, false);
    // Never moved: that was a poke, and it should feel like one.
    if (!g.moved) { poke(); return; }
    setHeld(false);
    fall();
  }, [fall, poke]);

  const airborne = held || pos.y !== 0;

  return (
    <div
      ref={wrapRef}
      className="pointer-events-none absolute -top-[43px] left-5 z-10"
      // Position only. The lean and the squash go on the creature inside, so
      // the tool-call stack it carries stays upright and readable while the
      // creature itself is being swung around.
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
    >
      {/* Only the creature itself takes the pointer. The wrapper stays
          transparent to it so the composer underneath keeps every click it
          had, and `ToolCallStack` keeps its own buttons. */}
      <span
        className="pointer-events-auto inline-block touch-none"
        style={{
          cursor: held ? 'grabbing' : 'grab',
          // Squashed from the feet: a landing flattens a creature against the
          // ground it hit, it does not shrink it towards its own middle.
          transformOrigin: 'bottom center',
          transform: `rotate(${lean}deg) scaleY(${squash}) scaleX(${2 - squash})`,
          // The lean follows the pointer with no smoothing, because it IS the
          // pointer. Only the squash is eased, so a landing recovers instead of
          // snapping back.
          transition: squash === 1 ? `transform ${SQUASH_MS}ms ease-out` : 'none',
        }}
        onPointerEnter={() => setNoticed(true)}
        onPointerLeave={onLeave}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {/* Dangling and falling override everything, the agent's states
            included: whatever the turn is doing, a creature being held by the
            scruff is not calmly reading a file. */}
        <CinderpawMascot state={airborne ? 'surprised' : renderState} flip={false} />
      </span>
      <ToolCallStack
        events={useChat((s) => s.toolCallStream)}
        active={renderState !== 'idle'}
      />
    </div>
  );
}
