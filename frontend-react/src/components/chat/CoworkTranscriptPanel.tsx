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

/** Seconds included on purpose: several A2A exchanges land inside one
 *  minute, and without them every card in a burst reads as the same time. */
function hhmmss(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
      {(shortName(id)[0] ?? '?').toUpperCase()}
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
          aria-expanded={expanded}
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
          ? 'border-error/30 bg-error/5'
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
          <span className="rounded bg-warning/15 border border-warning/40 px-1 text-micro">
            {e.approvalClass}
          </span>
        )}
        <span className="ml-auto tabular-nums">{hhmmss(e.at)}</span>
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

const COLLAPSED_KEY = 'cowork-panel-collapsed';

/** Reading site data THROWS in a private window or with storage blocked —
 *  a remembered panel state is not worth taking the whole panel down. */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** How close to the bottom still counts as "following the live feed". */
const FOLLOW_SLACK_PX = 48;

export function CoworkTranscriptPanel() {
  const exchanges = useCoworkTranscript((s) => s.exchanges);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Whether the reader is still pinned to the newest exchange. Scrolling up
   *  to read an older one means they are not, and yanking them back down
   *  every time an agent speaks makes the history unreadable on exactly the
   *  traffic this panel exists to show. */
  const following = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [exchanges.length, collapsed]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    following.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  };

  const toggleCollapsed = () => {
    // Persist OUTSIDE the updater: React may invoke an updater more than once
    // (StrictMode does, in dev), and a state updater that writes to storage is
    // a side effect in a function contracted to be pure.
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // Storage unavailable — the panel still toggles, it just will not
      // remember. Never a reason to fail the interaction.
    }
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
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="max-h-[420px] overflow-y-auto px-2 pb-2"
        >
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
