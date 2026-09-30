import { useState } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import { tauri } from '@/lib/tauri';
import type { MemoryUsedItem } from '@/stores/chat';
import { cn } from '@/lib/utils';

type Status = 'idle' | 'busy' | 'done' | 'failed';

export function MemoryRow({ m }: { m: MemoryUsedItem }) {
  const [status, setStatus] = useState<Status>('idle');
  const forget = async () => {
    if (!m.forget) return;
    setStatus('busy');
    try {
      await tauri.raw.memoryForget(m.forget.from, m.forget.to, m.forget.relation);
      setStatus('done');
    } catch {
      setStatus('failed');
    }
  };
  const when = m.kind === 'past' && m.ts ? new Date(m.ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null;
  return (
    <li className="flex min-w-0 items-start gap-2.5 py-1.5">
      <span className="mt-0.5 shrink-0 rounded-full bg-bg-active px-1.5 text-micro font-medium text-brand">
        {m.kind === 'fact' ? 'Fact' : 'Past chat'}
      </span>
      <span className={cn('min-w-0 flex-1 text-sm', status === 'done' ? 'text-text-disabled line-through' : 'text-text-primary')}>
        {m.text}
        {when && <span className="ml-1.5 text-2xs text-text-disabled">{when}</span>}
      </span>
      {m.forget && (
        <button
          type="button"
          onClick={() => void forget()}
          disabled={status === 'busy' || status === 'done'}
          className="shrink-0 text-2xs text-text-muted hover:text-error disabled:hover:text-text-muted"
        >
          {status === 'done' ? 'Forgotten' : status === 'failed' ? 'Could not forget' : 'Forget'}
        </button>
      )}
    </li>
  );
}

/**
 * Memory Peek (spec 7.5): "3 memories used" under a reply, folded, listing only
 * the memories that were really put into that turn's context: the injected
 * block (`memoryUsed`, from the sidecar's `memory_used`) and what a `recall`
 * lookup came back with. A fact can be forgotten from here; a past chat
 * cannot. Nothing is drawn when nothing was used.
 */
export function MemoryPeek({ items }: { items: MemoryUsedItem[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-2xs text-text-muted hover:text-text-secondary"
      >
        <Brain size={14} />
        {items.length} {items.length === 1 ? 'memory' : 'memories'} used
        <ChevronDown size={12} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="mt-1.5 rounded-xl border border-border-subtle bg-bg-surface px-3 py-1">
          {items.map((m, i) => <MemoryRow key={`${m.kind}-${i}`} m={m} />)}
        </ul>
      )}
    </div>
  );
}
