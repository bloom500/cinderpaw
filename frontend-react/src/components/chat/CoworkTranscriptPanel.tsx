/**
 * CoworkTranscriptPanel — live chat-style rendering of REAL agent-to-agent
 * traffic (Agent Cowork). Fed exclusively by `cowork_event` payloads via
 * `useCoworkTranscript`; every bubble here is a message / handoff /
 * approval that actually happened in the mailbox, with the real text on
 * both sides of the exchange.
 *
 * Visual language borrowed from the voice-call tool widgets
 * (CallToolScreen): glass card, status dot, framer-motion entrances.
 * Renders NOTHING until the first cowork event arrives — zero agents
 * configured must mean zero new surfaces (USER FIRST).
 */

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  useCoworkTranscript,
  type CoworkExchange,
} from '@/stores/coworkTranscript';

const AVATAR_COLORS = [
  'bg-sky-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-rose-500',
  'bg-cyan-500',
] as const;

function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

/** Agent ids are machine selectors; the tail is enough to tell two apart. */
function shortName(id: string): string {
  const tail = id.split(':').pop() ?? id;
  return tail.length > 18 ? `${tail.slice(0, 17)}…` : tail;
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function StatusGlyph({ status }: { status: CoworkExchange['status'] }) {
  if (status === 'running') {
    return (
      <span
        className="inline-block size-2 rounded-full bg-brand animate-pulse"
        title="in progress"
      />
    );
  }
  return (
    <span
      className={cn('text-micro', status === 'done' ? 'text-success' : 'text-error')}
      aria-label={status}
    >
      {status === 'done' ? '✓' : '✕'}
    </span>
  );
}

function Avatar({ id }: { id: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center size-5 rounded-full text-micro font-semibold text-white select-none',
        avatarColor(id),
      )}
      title={id}
    >
      {(id[0] ?? '?').toUpperCase()}
    </span>
  );
}

function ExchangeBubble({
  side,
  authorId,
  text,
}: {
  side: 'left' | 'right';
  authorId: string;
  text: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={cn('flex w-full', side === 'right' ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'flex items-start gap-1.5 max-w-[92%]',
          side === 'right' && 'flex-row-reverse',
        )}
      >
        <Avatar id={authorId} />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'collapse' : 'expand'}
          className={cn(
            'text-left text-micro leading-snug whitespace-pre-wrap break-words rounded-lg px-2 py-1.5 border cursor-pointer',
            side === 'left'
              ? 'bg-bg-elevated border-border-default text-text-primary'
              : 'bg-brand/15 border-brand/40 text-text-primary',
            !expanded && 'line-clamp-4',
          )}
        >
          {text}
        </button>
      </div>
    </div>
  );
}

function ExchangeCard({ e }: { e: CoworkExchange }) {
  const kindMark =
    e.kind === 'handoff' ? '⇢' : e.kind === 'approval' ? '🔐' : '→';
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className={cn(
        'rounded-xl border p-2.5 flex flex-col gap-1.5',
        e.status === 'error'
          ? 'border-red-500/30 bg-red-500/5'
          : 'border-border-default bg-bg-elevated/60',
      )}
      data-testid={`cowork-exchange-${e.kind}`}
    >
      <div className="flex items-center gap-1.5 text-micro text-text-muted">
        <Avatar id={e.fromAgentId} />
        <span className="font-medium text-text-primary truncate">{shortName(e.fromAgentId)}</span>
        <span aria-hidden>{kindMark}</span>
        <Avatar id={e.toAgentId} />
        <span className="font-medium text-text-primary truncate">{shortName(e.toAgentId)}</span>
        {e.approvalClass && (
          <span className="rounded bg-amber-500/15 border border-amber-500/40 px-1 text-micro">
            {e.approvalClass}
          </span>
        )}
        <span className="ml-auto tabular-nums">{hhmm(e.at)}</span>
        <StatusGlyph status={e.status} />
      </div>
      {e.requestText && (
        <ExchangeBubble side="left" authorId={e.fromAgentId} text={e.requestText} />
      )}
      {e.responseText && (
        <ExchangeBubble side="right" authorId={e.toAgentId} text={e.responseText} />
      )}
    </motion.li>
  );
}

export function CoworkTranscriptPanel() {
  const exchanges = useCoworkTranscript((s) => s.exchanges);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('cowork-panel-collapsed') === '1');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest exchange visible as traffic streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [exchanges.length, collapsed]);

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      localStorage.setItem('cowork-panel-collapsed', v ? '0' : '1');
      return !v;
    });
  };

  // Fresh install / no cowork traffic ⇒ no surface at all. (After the hooks:
  // they must run unconditionally regardless of traffic.)
  if (exchanges.length === 0) return null;
  const anyRunning = exchanges.some((e) => e.status === 'running');

  return (
    <aside
      data-testid="cowork-transcript-panel"
      className="absolute right-3 top-3 z-20 w-[330px] max-w-[40%]
                 flex flex-col rounded-2xl border border-border-default
                 bg-bg-elevated/80 backdrop-blur-md shadow-lg overflow-hidden"
    >
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        className="flex items-center gap-2 px-3 py-2 text-2xs font-medium text-text-muted
                   hover:bg-bg-elevated cursor-pointer select-none"
      >
        <span aria-hidden>🤝</span>
        <span>Agent Cowork</span>
        <span
          className={cn(
            'inline-block size-1.5 rounded-full',
            anyRunning ? 'bg-brand animate-pulse' : 'bg-text-muted/40',
          )}
          title={anyRunning ? 'agents active' : 'idle'}
        />
        <span className="tabular-nums text-text-muted/70">{exchanges.length}</span>
        <span className="ml-auto" aria-hidden>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div ref={scrollRef} className="max-h-[420px] overflow-y-auto px-2 pb-2">
          <ul className="flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {exchanges.map((e) => (
                <ExchangeCard key={e.id} e={e} />
              ))}
            </AnimatePresence>
          </ul>
        </div>
      )}
    </aside>
  );
}
