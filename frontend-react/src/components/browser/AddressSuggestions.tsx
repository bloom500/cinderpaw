import { useEffect, useMemo, useState } from 'react';
import { Clock3, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { display, suggest, type HistoryEntry, type Suggestion } from '@/lib/browserHistory';

/**
 * The ranked places under an address field: title, address, and a mark on
 * the one the person has picked for these letters before. Keyboard first:
 * the field keeps the focus, the list only follows ArrowUp/ArrowDown, Enter
 * takes the highlighted one, Escape closes. The native <datalist> could not
 * show a title or a rank, which is the whole point.
 */
export function useAddressSuggestions(history: HistoryEntry[], input: string, open: boolean, bookmarked?: ReadonlySet<string>) {
  const items = useMemo(() => (open ? suggest(history, input, 6, Date.now(), bookmarked) : []), [history, input, open, bookmarked]);
  const [index, setIndex] = useState(-1);
  useEffect(() => { setIndex(-1); }, [input, open]);
  const move = (delta: number) => {
    if (!items.length) return;
    setIndex((i) => (i + delta + items.length + 1) % (items.length + 1) - 1);
  };
  const selected: Suggestion | null = index >= 0 ? items[index] ?? null : null;
  return { items, index, selected, move, setIndex };
}

export function AddressSuggestions({
  items, index, onPick, onHover, className,
}: {
  items: Suggestion[];
  index: number;
  onPick: (s: Suggestion) => void;
  onHover: (i: number) => void;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul
      role="listbox"
      aria-label="Places you have been"
      className={cn(
        'absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-xl border border-border-default bg-popover shadow-lg',
        className,
      )}
    >
      {items.map((s, i) => (
        <li
          key={s.url}
          role="option"
          aria-selected={i === index}
          // mousedown, not click: the field blurs on click and the list is
          // gone before the click lands.
          onMouseDown={(e) => { e.preventDefault(); onPick(s); }}
          onMouseEnter={() => onHover(i)}
          className={cn(
            'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs',
            i === index ? 'bg-bg-hover text-text-primary' : 'text-text-secondary',
          )}
        >
          {s.adaptive
            ? <Sparkles size={12} className="shrink-0 text-brand" aria-label="You usually pick this" />
            : <Clock3 size={12} className="shrink-0 text-text-muted" />}
          <span className="min-w-0 flex-1 truncate">
            {s.title && <span className="text-text-primary">{s.title}</span>}
            {s.title && <span className="text-text-muted"> · </span>}
            <span className="text-text-muted">{display(s.url)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
