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
import { Copy, Check } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { cn } from '@/lib/utils';
import { BubbleTail } from './BubbleTail';
import { Markdown } from '@/lib/markdown';
import { tauri } from '@/lib/tauri';
import {
  useCoworkTranscript,
  type CoworkExchange,
} from '@/stores/coworkTranscript';
import { useConversations } from '@/stores/conversations';
import { useChat } from '@/stores/chat';

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
  const [copied, setCopied] = useState(false);
  const right = m.side === 'right';
  const onCopy = async () => {
    try {
      await writeText(m.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16 }}
      className={cn('group/bubble flex w-full gap-1.5', right ? 'justify-end' : 'justify-start')}
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
            'relative rounded-2xl px-3 py-2 shadow-sm group',
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
            onClick={onCopy}
            aria-label="Copy message"
            className="absolute -top-1 -right-1 p-1 rounded-md bg-bg-elevated border border-border-subtle shadow
                       opacity-0 group-hover/bubble:opacity-100 group-hover:opacity-100
                       transition-opacity text-text-muted hover:text-text-secondary cursor-pointer"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
          {/* Selectable text: the whole bubble no longer swallows mouse
              selection. Click the "expand" control to toggle line-clamp. */}
          <div
            className={cn(
              'w-full text-xs leading-relaxed break-words select-text',
              'prose prose-xs max-w-none prose-p:my-1 prose-pre:my-1 prose-ul:my-1 prose-ol:my-1 prose-table:text-xs',
              'prose-table:block prose-table:overflow-x-auto prose-table:whitespace-nowrap',
              right ? 'prose-invert' : 'prose-neutral dark:prose-invert',
              !expanded && 'line-clamp-6',
            )}
          >
            <Markdown>{m.text}</Markdown>
          </div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="self-start text-2xs text-text-muted hover:text-text-secondary underline decoration-dotted cursor-pointer"
          >
            {expanded ? 'show less' : 'show more'}
          </button>
        </div>
        <span
          title={hhmmss(m.at)}
          className="px-1 text-2xs text-text-muted tabular-nums select-none opacity-0 group-hover/bubble:opacity-100 transition-opacity"
        >
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
      {/* Stop reaches exactly this teammate: a cowork turn runs under the
          session `cowork:<agentId>`, so the existing stop path already
          addresses it. With turns running minutes long, "I misspoke, stop"
          had no answer at all before this. */}
      <button
        type="button"
        onClick={() => void tauri.feralAgent.coworkStop(e.toAgentId).catch(() => {})}
        className="self-center rounded-full border border-border-default px-2 py-0.5 text-2xs
                   text-text-muted hover:text-error hover:border-error/40 cursor-pointer"
        title={`Stop ${who}`}
      >
        Stop
      </button>
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


/**
 * Write to a teammate without going through the main agent.
 *
 * Darius: "sa vorbesc si eu direct cu ei, sa nu facem telefonul fara fir prin
 * agentul principal." He is right about the cost as well as the feel — routing
 * a message the person already typed through the main agent spends a whole
 * model turn retyping it, and lets the wording drift on the way.
 *
 * The recipient defaults to whoever spoke last, which is what a reply means in
 * a group chat; the picker is there for when it is not.
 */
function Composer({
  participants,
  defaultTo,
  threadId,
}: {
  participants: (readonly [string, string | undefined])[];
  defaultTo: string;
  threadId: string | null;
}) {
  const [to, setTo] = useState(defaultTo);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Follow the conversation when the user has not overridden the target.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setTo(defaultTo);
  }, [defaultTo]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await tauri.feralAgent.coworkSendMessage(to, body, threadId ?? undefined);
      setText('');
    } catch (err) {
      // On screen, not in a console: the message did not go, and the person
      // needs to know before they walk away expecting an answer.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-border-default px-2.5 py-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        {participants.length > 1 && (
          <select
            value={to}
            onChange={(ev) => {
              touched.current = true;
              setTo(ev.target.value);
            }}
            aria-label="Send to"
            className="rounded-md border border-border-default bg-bg-surface px-1.5 py-1
                       text-2xs text-text-secondary cursor-pointer"
          >
            {participants.map(([id, name]) => (
              <option key={id} value={id}>
                {displayName(id, name)}
              </option>
            ))}
          </select>
        )}
        <input
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) {
              ev.preventDefault();
              void send();
            }
          }}
          placeholder={`Message ${displayName(to, participants.find(([id]) => id === to)?.[1])}…`}
          className="flex-1 min-w-0 rounded-md border border-border-default bg-bg-surface px-2 py-1
                     text-xs text-text-primary placeholder:text-text-muted
                     focus:outline-none focus:ring-1 focus:ring-brand"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!text.trim() || sending}
          className="rounded-md bg-brand px-2 py-1 text-2xs font-medium text-bg-primary
                     disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
      {error && <span className="text-2xs text-error">{error}</span>}
    </div>
  );
}

const COLLAPSED_KEY = 'cowork-panel-collapsed';
const PANEL_WIDTH_KEY = 'cowork-panel-width';
const PANEL_MIN_W = 280;
const PANEL_MAX_W = 640;
const PANEL_DEFAULT_W = 360;
const PANEL_HEIGHT_KEY = 'cowork-panel-height';
const PANEL_MIN_H = 200;
const PANEL_MAX_H = 720;
const PANEL_DEFAULT_H = 440;

/** Reading site data THROWS in a private window or with storage blocked —
 *  a remembered panel state is not worth taking the whole panel down. */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}
function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(v) && v >= PANEL_MIN_W && v <= PANEL_MAX_W ? v : PANEL_DEFAULT_W;
  } catch {
    return PANEL_DEFAULT_W;
  }
}
function readHeight(): number {
  try {
    const v = Number(localStorage.getItem(PANEL_HEIGHT_KEY));
    return Number.isFinite(v) && v >= PANEL_MIN_H && v <= PANEL_MAX_H ? v : PANEL_DEFAULT_H;
  } catch {
    return PANEL_DEFAULT_H;
  }
}

/** How close to the bottom still counts as "following the live feed". */
const FOLLOW_SLACK_PX = 48;

export function CoworkTranscriptPanel() {
  const exchanges = useCoworkTranscript((s) => s.exchanges);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [width, setWidth] = useState(readWidth);
  const [height, setHeight] = useState(readHeight);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const resizingWidth = useRef(false);
  const resizingHeight = useRef(false);
  const [unread, setUnread] = useState(0);
  const prevLenRef = useRef(0);
  // Per-thread hydrate: panel appears only in threads that used cowork.
  // When switching threads, fetch that thread's mailbox rows; empty = hide.
  const currentId = useConversations((s) => s.currentId) ?? useChat((s) => s.sessionId);
  useEffect(() => {
    if (!currentId) return;
    void tauri.feralAgent.coworkHistory(currentId).catch(() => {});
  }, [currentId]);
  // Unread badge: when collapsed, new exchanges bump the count; expanding clears it.
  useEffect(() => {
    const len = exchanges.length;
    const prev = prevLenRef.current;
    if (len > prev && collapsed) {
      setUnread((n) => n + (len - prev));
    }
    if (!collapsed) setUnread(0);
    prevLenRef.current = len;
  }, [exchanges.length, collapsed]);

  // ESC to collapse + click outside to collapse when expanded.
  useEffect(() => {
    if (collapsed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCollapsed(true);
    };
    const onDown = (e: MouseEvent) => {
      const el = panelRef.current;
      if (el && !el.contains(e.target as Node)) setCollapsed(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [collapsed]);

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

  const [filterText, setFilterText] = useState('');
  const [filterAgent, setFilterAgent] = useState<string | null>(null);
  const filteredMessages = useMemo(() => {
    let m = messages;
    if (filterAgent) m = m.filter((x) => x.authorId === filterAgent);
    if (filterText.trim()) {
      const q = filterText.toLowerCase();
      m = m.filter((x) => x.text.toLowerCase().includes(q));
    }
    return m;
  }, [messages, filterText, filterAgent]);

  // Resize handles persistence (width from left edge, height from bottom edge).
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (resizingWidth.current) {
        const newW = window.innerWidth - e.clientX - 12;
        const clamped = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, newW));
        setWidth(clamped);
      }
      if (resizingHeight.current) {
        const panel = document.querySelector('[data-testid="cowork-transcript-panel"]') as HTMLElement | null;
        if (panel) {
          const top = panel.getBoundingClientRect().top;
          const newH = e.clientY - top - 36; // ~header height
          const clampedH = Math.min(PANEL_MAX_H, Math.max(PANEL_MIN_H, newH));
          setHeight(clampedH);
        }
      }
    };
    const onUp = () => {
      const wasResizing = resizingWidth.current || resizingHeight.current;
      if (!wasResizing) return;
      resizingWidth.current = false;
      resizingHeight.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        const el = document.querySelector('[data-testid="cowork-transcript-panel"]') as HTMLElement | null;
        if (el) {
          localStorage.setItem(PANEL_WIDTH_KEY, String(el.offsetWidth));
          const inner = el.querySelector('[data-testid="cowork-transcript-scroll"]') as HTMLElement | null;
          if (inner) localStorage.setItem(PANEL_HEIGHT_KEY, String(inner.offsetHeight));
        }
      } catch {}
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

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

  // Reply targets the last teammate who spoke — what a reply means in a group
  // chat — and stays in the thread the conversation is already in.
  const last = exchanges[exchanges.length - 1];
  const lastSpoken =
    last && last.toAgentId !== 'human' && last.toAgentId !== 'unknown'
      ? last.toAgentId
      : (participants[0]?.[0] ?? '');
  const lastThreadId = last?.threadId && last.threadId !== 'direct' ? last.threadId : null;

  const isEmpty = exchanges.length === 0;
  if (isEmpty) return null;

  // Collapsed = tiny liquid bubble, not a bar. Saves visual field; click to
  // morph into the full panel with a spring (border-radius 999→16).
  if (collapsed) {
    return (
      <motion.button
        // @ts-ignore — motion ref type
        ref={panelRef as any}
        type="button"
        onClick={toggleCollapsed}
        data-testid="cowork-bubble"
        aria-label="Open cowork transcript"
        aria-expanded={false}
        layoutId="cowork-panel"
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.85, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 28 }}
        className="absolute right-3 top-3 z-20 w-12 h-12 rounded-full bg-brand shadow-lg
                   flex items-center justify-center border border-brand/20
                   hover:scale-105 active:scale-95 cursor-pointer"
      >
        <span className="flex -space-x-1">
          {participants.slice(0, 2).map(([id, name]) => (
            <Avatar key={id} id={id} name={name} />
          ))}
          {participants.length === 0 && <span className="text-sm text-white font-semibold">◈</span>}
        </span>
        {working.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 size-3 rounded-full bg-brand border-2 border-white animate-pulse" />
        )}
        {unread > 0 && (
          <span className="absolute -bottom-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-error text-white text-2xs font-semibold flex items-center justify-center border-2 border-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </motion.button>
    );
  }

  return (
    <motion.aside
      // @ts-ignore — motion ref type
      ref={panelRef as any}
      layoutId="cowork-panel"
      data-testid="cowork-transcript-panel"
      style={{ width: `${width}px`, maxWidth: '42%' }}
      initial={{ scale: 0.92, opacity: 0, borderRadius: 999 }}
      animate={{ scale: 1, opacity: 1, borderRadius: 16 }}
      exit={{ scale: 0.92, opacity: 0, borderRadius: 999 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className="absolute right-3 top-3 z-20
                 flex flex-col rounded-2xl border border-border-default
                 bg-bg-elevated/80 backdrop-blur-md shadow-lg overflow-hidden"
      aria-label="Agent Cowork transcript"
    >
      {/* Resize handles — left edge (width) and bottom edge (height) */}
      <div
        onMouseDown={(e) => {
          resizingWidth.current = true;
          document.body.style.cursor = 'ew-resize';
          document.body.style.userSelect = 'none';
          e.preventDefault();
        }}
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-brand/20"
        aria-hidden
      />
      <div
        onMouseDown={(e) => {
          resizingHeight.current = true;
          document.body.style.cursor = 'ns-resize';
          document.body.style.userSelect = 'none';
          e.preventDefault();
        }}
        className="absolute left-0 right-0 bottom-0 h-1.5 cursor-ns-resize hover:bg-brand/20"
        aria-hidden
      />
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={true}
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
        <span className="ml-auto text-xs" aria-hidden>
          ✕
        </span>
      </button>
      {(participants.length > 1 || messages.length > 5) && (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border-subtle bg-bg-surface/50">
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Search…"
            className="flex-1 min-w-0 rounded-md border border-border-subtle bg-bg-elevated px-2 py-1 text-2xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-brand"
          />
          {participants.length > 1 && (
            <div className="flex gap-1 shrink-0">
              {participants.map(([id, name]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setFilterAgent((v) => (v === id ? null : id))}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-2xs border cursor-pointer',
                    filterAgent === id
                      ? 'bg-brand text-white border-brand'
                      : 'bg-bg-elevated text-text-muted border-border-subtle hover:border-brand/30',
                  )}
                  title={name ?? id}
                >
                  {displayName(id, name)}
                </button>
              ))}
            </div>
          )}
          {(filterText || filterAgent) && (
            <button
              type="button"
              onClick={() => { setFilterText(''); setFilterAgent(null); }}
              className="text-2xs text-text-muted hover:text-text-secondary cursor-pointer"
            >
              ✕
            </button>
          )}
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="cowork-transcript-scroll"
        style={{ height: `${height}px`, maxHeight: '65vh' }}
        className="overflow-y-auto px-2.5 pb-2.5"
      >
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {filteredMessages.map((m, i) => (
                <Bubble
                  key={m.key}
                  m={m}
                  // Group-chat convention: the name appears once per run of
                  // consecutive messages from the same speaker, not on every
                  // bubble — repeating it turns a conversation into a table.
                  showAuthor={i === 0 || filteredMessages[i - 1]?.authorId !== m.authorId}
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
      {participants.length > 0 && (
        <Composer
          participants={participants}
          defaultTo={lastSpoken}
          threadId={lastThreadId}
        />
      )}
    </motion.aside>
  );
}
