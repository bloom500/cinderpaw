import { useEffect, useState } from 'react';
import { ArrowRight, Check, ChevronDown, Loader2 } from 'lucide-react';
import { tauri, type MigrateFound } from '@/lib/tauri';
import { cn } from '@/lib/utils';

/**
 * "Coming from OpenClaw or Hermes Agent?" on the first onboarding board.
 *
 * Draws nothing unless one is installed on this machine, so a stranger never
 * sees it. What it brings and what it leaves are both listed, from the same
 * plan `cinderpaw migrate` prints (cinderpaw-core `migrate::preview`), and
 * nothing already in ~/.cinderpaw is replaced.
 */
export function ImportCard() {
  const [found, setFound] = useState<MigrateFound | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    tauri.raw.migratePreview().then((all) => setFound(all.find((f) => f.plan.willImport.length > 0) ?? null)).catch(() => {});
  }, []);

  if (!found) return null;
  const { willImport, notImported, conflicts } = found.plan;

  const bring = async () => {
    setState('busy');
    try {
      const done = await tauri.raw.migrateApply(found.root);
      setState('done');
      // Chat apps and scheduled tasks arrive off: two programs running one bot or one job fight over it.
      const off = done.some((w) => w.startsWith('chat: ') || w.startsWith('schedule: '))
        ? ` Chat apps and scheduled tasks came over turned off; turn them on in Connectors and Tasks once ${found.source} is stopped.`
        : '';
      setMessage(`Brought over ${done.length} item${done.length === 1 ? '' : 's'}. Your ${found.source} setup was only read, never changed.${off}`);
    } catch (e) {
      setState('failed');
      setMessage(typeof e === 'string' ? e : String(e));
    }
  };

  return (
    <div className="mt-8 rounded-2xl border border-border-default bg-bg-surface p-5">
      <p className="font-medium text-text-primary">Coming from {found.source}?</p>
      <p className="mt-1 text-sm text-text-secondary">
        I found it on this computer. I can bring over {found.summary}, so you do not start from zero.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {state === 'done' ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-success"><Check size={16} /> {message}</span>
        ) : (
          <button
            type="button"
            onClick={() => void bring()}
            disabled={state === 'busy'}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-on-brand hover:bg-brand/90 disabled:opacity-60"
          >
            {state === 'busy' ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />} Bring it over
          </button>
        )}
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-secondary">
          What exactly? <ChevronDown size={14} className={cn('transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {state === 'failed' && <p className="mt-3 text-sm text-error">Could not bring it over: {message}</p>}
      {open && (
        <div className="mt-4 space-y-3 text-sm">
          <List title="Brings" items={willImport.map((i) => (i.note ? `${i.what} (${i.note})` : i.what))} />
          {conflicts.length > 0 && <List title="Keeps yours" items={conflicts} />}
          {notImported.length > 0 && <List title="Leaves behind" items={notImported} />}
        </div>
      )}
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-text-secondary">{title} ({items.length})</p>
      <ul className="mt-1 max-h-40 overflow-y-auto pl-4 text-text-muted">
        {items.map((i) => <li key={i} className="list-disc break-words">{i}</li>)}
      </ul>
    </div>
  );
}
