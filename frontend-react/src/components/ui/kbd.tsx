import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';

/**
 * The modifier as this machine names it. A hint that says ⌘ on Windows teaches
 * a key the keyboard does not have, and the listener accepts either anyway
 * (useGlobalHotkeys reads metaKey || ctrlKey).
 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

/**
 * Which keys are down right now, shared by every `Kbd` on screen.
 *
 * One listener for the whole app rather than one per hint: the sidebar alone
 * draws several, the command palette draws one per row, and a `keydown`
 * listener per row is a listener count that grows with the search results.
 *
 * Its whole job is the moment you hold Ctrl and the shortcuts on screen light
 * up — which is how somebody learns a shortcut without opening a help page.
 */
const pressed = new Set<string>();
const listeners = new Set<() => void>();
let attached = false;

/** Normalised so `Control` from the event matches `Ctrl` on the cap. */
function normalise(k: string): string {
  const key = k.toLowerCase();
  if (key === 'control') return 'ctrl';
  if (key === 'meta' || key === 'os') return '⌘';
  if (key === ' ') return 'space';
  return key;
}

function notify() {
  for (const l of listeners) l();
}

function attach() {
  if (attached || typeof window === 'undefined') return;
  attached = true;
  window.addEventListener('keydown', (e) => {
    pressed.add(normalise(e.key));
    notify();
  });
  window.addEventListener('keyup', (e) => {
    pressed.delete(normalise(e.key));
    notify();
  });
  // A held key whose keyup lands in another window never comes back up —
  // alt-tabbing while holding Ctrl would leave every cap stuck down until the
  // next press. Losing focus releases everything, which is the truth: this
  // window is not receiving those keys any more.
  window.addEventListener('blur', () => {
    if (pressed.size === 0) return;
    pressed.clear();
    notify();
  });
}

function subscribe(onChange: () => void) {
  attach();
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** A snapshot cheap enough to compare by value: the set's size plus its keys. */
function snapshot(): string {
  return [...pressed].sort().join('+');
}

function useHeldKeys(): string {
  // The server snapshot is "nothing held", which is also the right answer
  // during a test render and before the first event.
  return useSyncExternalStore(subscribe, snapshot, () => '');
}

/**
 * A keyboard shortcut, drawn as keys: `<Kbd keys={[MOD, 'K']} />`.
 *
 * Drawn as a cap with an edge rather than a flat outline, and it presses when
 * the real key does. That is the only reason the extra border exists: a cap
 * that never moves does not need a bottom edge, and a flat chip cannot show
 * you that the modifier you are holding is the right one.
 */
export function Kbd({ keys, className }: { keys: string[]; className?: string }) {
  const held = useHeldKeys();
  const down = new Set(held ? held.split('+') : []);

  return (
    <span className={cn('ml-auto inline-flex items-center gap-0.5', className)} aria-label={keys.join('+')}>
      {keys.map((k) => {
        const isDown = down.has(normalise(k));
        return (
          <kbd
            key={k}
            // The edge is a bottom border, so "pressed" is that border
            // collapsing and the cap dropping by the same pixel it loses. Any
            // other way of doing this moves the row around it.
            className={cn(
              'min-w-5 rounded border border-border-default bg-bg-elevated px-1 text-center font-sans text-2xs leading-4 text-text-muted',
              'transition-[transform,border-width,background-color,color] duration-75',
              isDown
                ? 'translate-y-px border-b border-brand bg-brand/15 text-brand'
                : 'border-b-2',
              // Somebody who asked their system to stop moving things gets the
              // colour change and no travel. `motion-reduce` is the one that
              // works here: this is a CSS transition, not a Framer animation,
              // so the root MotionConfig does not reach it.
              'motion-reduce:transition-none motion-reduce:translate-y-0',
            )}
          >
            {k}
          </kbd>
        );
      })}
    </span>
  );
}
