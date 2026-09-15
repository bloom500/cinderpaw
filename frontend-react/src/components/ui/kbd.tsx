import { cn } from '@/lib/utils';

/**
 * The modifier as this machine names it. A hint that says ⌘ on Windows teaches
 * a key the keyboard does not have, and the listener accepts either anyway
 * (useGlobalHotkeys reads metaKey || ctrlKey).
 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** A keyboard shortcut, drawn as keys: `<Kbd keys={[MOD, 'K']} />`. */
export function Kbd({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cn('ml-auto inline-flex items-center gap-0.5', className)} aria-label={keys.join('+')}>
      {keys.map((k) => (
        <kbd
          key={k}
          className="min-w-5 rounded border border-border-default bg-bg-elevated px-1 text-center font-sans text-2xs leading-4 text-text-muted"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
