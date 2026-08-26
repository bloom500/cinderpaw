/**
 * CoworkTranscriptPanel — the agent-to-agent conversation, drawn as what it
 * actually is: a group chat.
 *
 * The first version drew "exchange cards": a header row with two ids and an
 * arrow, then the request and the reply stacked inside a bordered box. That
 * is a log entry with a picture of a conversation on it. Someone reading this
 * panel asks the same three questions they ask of any chat — who said what,
 * in what order, and is anyone still typing — so it is a chat.
 *
 * The visual language is the app's own `MessageItem`, not a new one: the same
 * `rounded-2xl` bubble with a `BubbleTail` curl, the same brand fill and right
 * alignment for the human, the same muted tabular meta line. The one thing
 * group chat adds is what two-party chat never needed — every speaker gets a
 * bubble and a name, because "no bubble means the assistant" stops working the
 * moment there are three of them.
 *
 * Everything shown is real: text from the mailbox rows, names from the roster,
 * the clock from when the running state actually began. Nothing here is an
 * animation standing in for telemetry.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { BubbleTail } from './BubbleTail';
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

/**
 * What to call an agent on screen. The roster name when the sidecar sent one,
 * otherwise the id trimmed to something readable — ids are machine selectors
 * and nobody named their teammate "demo-agent-atlas".
 */
function displayName(id: string, name?: string): string {
  if (id === 'human') return 'You';
  const label = name?.trim() || id.split(':').pop() || id;
  return label.length > 20 ? `${label.slice(0, 19)}…` : label;
}

function hhmmss(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Only after a beat: a timer on every row the instant it appears is a
 *  fidget. Same threshold as the call telemetry widgets. */
const TIMER_AFTER_MS = 2_000;

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // One second is the resolution a person reads; faster is a fidget.
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, []);
  const ms = now - since;
  if (ms < TIMER_AFTER_MS) return null;
  const s = Math.floor(ms / 1000);
  return (
    <span className="tabular-nums">
      {s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}
    </span>
  );
}

function Avatar({ id, name }: { id: string; name?: string }) {
  const label = displayName(id, name);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center size-6 rounded-full',
        'text-2xs font-semibold text-white select-none',
        avatarColor(id),
      )}
      // The id stays reachable on hover: the name is for the person, the id is
      // what they would quote in a bug report.
      title={name ? `${name} (${id})` : id}
    >
      {(label[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** One line in the conversation. Derived from exchanges — see `toMessages`. */
interface TranscriptMessage {
  key: string;
  authorId: string;
  authorName?: string;
  text: string;
  at: number;
  /** The human speaks on the right, exactly as in the app's own chat. */
  side: 'left' | 'right';
  failed: boolean;
}

/**
 * Flatten exchanges into a conversation.
 *
 * An exchange is a request and its reply; a conversation is those laid end to
 * end. Approvals are NOT messages — they are the system interrupting to ask
 * the human something — so they stay out of this and get their own row.
 */
export function toMessages(exchanges: CoworkExchange[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const e of exchanges) {
    if (e.kind === 'approval') continue;
    if (e.requestText) {
      out.push({
        key: `${e.id}:req`,
        authorId: e.fromAgentId,
        authorName: e.fromName,
        text: e.requestText,
        at: e.at,
        side: e.fromAgentId === 'human' ? 'right' : 'left',
        failed: false,
      });
    }
    if (e.responseText) {
      out.push({
        key: `${e.id}:res`,
        authorId: e.toAgentId,
        authorName: e.toName,
        text: e.responseText,
        at: e.at,
        side: e.toAgentId === 'human' ? 'right' : 'left',
        failed: e.status === 'error',
      });
    }
  }
  return out;
}

function Bubble({ m, showAuthor }: { m: TranscriptMessage; showAuthor: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const right = m.side === 'right';
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16 }}
      className={cn('flex w-full gap-1.5', right ? 'justify-end' : 'justify-start')}
    >
      {/* The avatar column keeps its width on a continued run, so consecutive
          bubbles from one speaker stay aligned instead of stepping sideways. */}
      {!right && (
        <span className="w-6 shrink-0">
          {showAuthor && <Avatar id={m.authorId} name={m.authorName} />}
        </span>
      )}
      <div className={cn('flex flex-col gap-0.5 max-w-[82%]', right && 'items-end')}>
        {showAuthor && (
          <span className="px-1 text-2xs font-medium text-text-secondary">
            {displayName(m.authorId, m.authorName)}
          </span>
        )}
        <div
          className={cn(
            'relative rounded-2xl px-3 py-2 shadow-sm',
            right
              ? 'rounded-br-none bg-brand text-bg-primary'
              : m.failed
                ? 'rounded-bl-none border border-error/40 bg-error/10 text-text-primary'
                : 'rounded-bl-none border border-border-default bg-bg-surface text-text-primary',
          )}
        >
          <BubbleTail
            className={cn(
              'absolute bottom-0',
              right
                ? 'right-[-11px] text-brand'
                : 'left-[-11px] -scale-x-100 text-bg-surface',
            )}
          />
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            title={expanded ? 'collapse' : 'expand'}
            className={cn(
              'block w-full text-left text-xs leading-relaxed whitespace-pre-wrap break-words cursor-pointer',
              !expanded && 'line-clamp-6',
            )}
          >
            {m.text}
          </button>
        </div>
        <span className="px-1 text-2xs text-text-muted tabular-nums select-none">
          {hhmmss(m.at)}
        </span>
      </div>
      {right && <span className="w-6 shrink-0" />}
    </motion.li>
  );
}

/**
 * The typing row — the answer to "is anyone actually working on this".
 *
 * A pulsing dot says "something". This says who, and for how long, which is
 * the question a person watching a panel of silent bubbles actually has.
 */
function TypingRow({ e }: { e: CoworkExchange }) {
  const who = displayName(e.toAgentId, e.toName);
  return (
    <li className="flex w-full gap-1.5 justify-start">
      <Avatar id={e.toAgentId} name={e.toName} />
      <span className="flex items-center gap-2 rounded-2xl rounded-bl-none border border-border-default bg-bg-surface px-3 py-2">
        <span className="flex gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 rounded-full bg-text-muted animate-bounce"
              style={{ animationDelay: `${i * 140}ms` }}
            />
          ))}
        </span>
        <span className="flex flex-col gap-0.5 text-2xs text-text-muted">
          <span>
            {who} is working
            {e.startedAt !== undefined && (
              <>
                {' · '}
                <Elapsed since={e.startedAt} />
              </>
            )}
          </span>
          {/* What they are actually doing. "Working" answers whether anything
              is happening; the tool names answer what — which is the half a
              person needs to tell a slow turn from a stuck one. */}
          {e.tools && e.tools.length > 0 && (
            <span className="flex flex-wrap gap-1">
              {e.tools.map((t, i) => (
                <span
                  key={`${t.name}:${i}`}
                  className={cn(
                    'rounded px-1 py-px border tabular-nums',
                    t.done
                      ? 'border-border-subtle text-text-muted'
                      : 'border-brand/40 bg-brand/10 text-text-secondary',
                  )}
                >
                  {t.name.replace(/_/g, ' ')}
                </span>
              ))}
            </span>
          )}
        </span>
      </span>
    </li>
  );
}

/** An approval is the system asking the human, not an agent speaking. */
function ApprovalRow({ e }: { e: CoworkExchange }) {
  const who = displayName(e.fromAgentId, e.fromName);
  const label =
    e.status === 'running'
      ? `${who} needs your approval`
      : e.status === 'error'
        ? `${who} was not approved`
        : `${who} was approved`;
  return (
    <li className="flex w-full justify-center">
      <span
        className={cn(
          'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs',
          e.status === 'running'
            ? 'border-warning/40 bg-warning/10 text-text-primary'
            : e.status === 'error'
              ? 'border-error/30 bg-error/5 text-text-secondary'
              : 'border-border-default bg-bg-surface text-text-secondary',
        )}
      >
        <span aria-hidden>🔐</span>
        {label}
        {e.approvalClass && <span className="font-medium">{e.approvalClass}</span>}
        {e.status === 'running' && e.startedAt !== undefined && (
          <span className="text-text-muted">
            <Elapsed since={e.startedAt} />
          </span>
        )}
      </span>
    </li>
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
  /** Whether the reader is still pinned to the newest message. Scrolling up
   *  to read an older one means they are not, and yanking them back down
   *  every time an agent speaks makes the history unreadable on exactly the
   *  traffic this panel exists to show. */
  const following = useRef(true);

  const messages = useMemo(() => toMessages(exchanges), [exchanges]);
  const approvals = useMemo(
    () => exchanges.filter((e) => e.kind === 'approval'),
    [exchanges],
  );
  const working = useMemo(
    () =>
      exchanges.filter(
        (e) => e.kind !== 'approval' && e.status === 'running' && !e.responseText,
      ),
    [exchanges],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, working.length, approvals.length, collapsed]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    following.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  };

  const toggleCollapsed = () => {
    // Persist OUTSIDE the updater: React may invoke an updater more than once
    // (StrictMode does, in dev) and it is contracted to be pure.
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // Storage unavailable — the panel still toggles, it just will not
      // remember. Never a reason to fail the interaction.
    }
  };

  // Everyone who has spoken, for the group-chat header. Built before the early
  // return so the hook order above stays unconditional.
  const participants = Array.from(
    new Map(
      exchanges
        .flatMap((e) => [
          [e.fromAgentId, e.fromName] as const,
          [e.toAgentId, e.toName] as const,
        ])
        .filter(([id]) => id !== 'human' && id !== 'unknown'),
    ),
  );

  // Fresh install / no cowork traffic ⇒ no surface at all.
  if (exchanges.length === 0) return null;

  return (
    <aside
      data-testid="cowork-transcript-panel"
      className="absolute right-3 top-3 z-20 w-[360px] max-w-[42%]
                 flex flex-col rounded-2xl border border-border-default
                 bg-bg-elevated/80 backdrop-blur-md shadow-lg overflow-hidden"
      aria-label="Agent Cowork transcript"
    >
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        className="flex items-center gap-2 px-3 py-2 text-2xs font-medium text-text-muted
                   hover:bg-bg-elevated cursor-pointer select-none"
      >
        {/* Faces first, like any group chat header. */}
        <span className="flex -space-x-1.5">
          {participants.slice(0, 3).map(([id, name]) => (
            <Avatar key={id} id={id} name={name} />
          ))}
        </span>
        <span className="text-text-secondary truncate">
          {participants.length > 0
            ? participants.map(([id, name]) => displayName(id, name)).join(', ')
            : 'Agent Cowork'}
        </span>
        {working.length > 0 && (
          <span
            className="size-1.5 rounded-full bg-brand animate-pulse"
            title="working"
          />
        )}
        <span className="ml-auto" aria-hidden>
          {collapsed ? '▸' : '▾'}
        </span>
      </button>
      {!collapsed && (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="max-h-[440px] overflow-y-auto px-2.5 pb-2.5"
        >
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {messages.map((m, i) => (
                <Bubble
                  key={m.key}
                  m={m}
                  // Group-chat convention: the name appears once per run of
                  // consecutive messages from the same speaker, not on every
                  // bubble — repeating it turns a conversation into a table.
                  showAuthor={i === 0 || messages[i - 1]?.authorId !== m.authorId}
                />
              ))}
            </AnimatePresence>
            {approvals.map((e) => (
              <ApprovalRow key={e.id} e={e} />
            ))}
            {working.map((e) => (
              <TypingRow key={`typing:${e.id}`} e={e} />
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
