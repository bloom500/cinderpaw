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
import { Copy, Check, Star, GripVertical } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { cn } from '@/lib/utils';
import { BubbleTail } from './BubbleTail';
import { Markdown } from '@/lib/markdown';
import { tauri } from '@/lib/tauri';
import {
  useCoworkTranscript,
  threadExchanges,
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

function Avatar({
  id,
  name,
  size = 'inline',
  className,
}: {
  id: string;
  name?: string;
  /** `head` is the collapsed chat head: one avatar filling the whole circle. */
  size?: 'inline' | 'head';
  className?: string;
}) {
  const label = displayName(id, name);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full',
        'font-semibold text-white select-none',
        size === 'head' ? 'size-full text-lg' : 'size-6 text-2xs',
        avatarColor(id),
        className,
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

function Bubble({ m, showAuthor, pinned, onTogglePin }: { m: TranscriptMessage; showAuthor: boolean; pinned?: boolean; onTogglePin?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const right = m.side === 'right';
  // "show more" was printed under EVERY bubble, including one-word replies,
  // where clicking it changed nothing on screen. A control that does nothing
  // teaches the person that controls here do nothing. It appears only when
  // the six-line clamp is actually hiding something — measured, because the
  // clamp counts rendered lines and no character count can predict those.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // Only meaningful while clamped; once expanded the answer is already yes.
    if (!expanded) setClipped(el.scrollHeight - el.clientHeight > 2);
  }, [m.text, expanded]);
  const onCopy = async () => {
    try {
      await writeText(m.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <motion.li
      id={`cowork-msg-${m.key}`}
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
      <div className={cn('flex flex-col gap-0.5 max-w-[94%]', right && 'items-end')}>
        {showAuthor && (
          <span className="px-1 text-2xs font-medium text-text-secondary">
            {displayName(m.authorId, m.authorName)}
          </span>
        )}
        <div
          className={cn(
            'relative rounded-2xl px-3.5 py-2.5 shadow-sm',
            right
              ? 'rounded-br-none bg-brand text-bg-primary'
              : m.failed
                ? 'rounded-bl-none border border-error/40 bg-error/10 text-text-primary'
                : 'rounded-bl-none border border-border-default bg-bg-surface text-text-primary',
          )}
        >
          {/* `text-brand` is deliberately NOT the fill: the text token is a
              lighter orange tuned for words on glass (tailwind.config.ts), so
              using it here drew the curl in a different colour from the bubble
              it belongs to — a stray bright hook floating off the corner.
              The tail is part of the SHAPE, so it takes the fill's own var. */}
          <BubbleTail
            className={cn(
              'absolute bottom-0',
              right
                ? 'right-[-11px] text-[color:var(--brand)]'
                : 'left-[-11px] -scale-x-100 text-bg-surface',
            )}
          />
          {/* Selectable text: the whole bubble no longer swallows mouse
              selection. Click the "expand" control to toggle line-clamp. */}
          <div
            ref={bodyRef}
            className={cn(
              'w-full text-[13px] leading-relaxed break-words select-text',
              'prose prose-xs max-w-none prose-p:my-1 prose-pre:my-1 prose-ul:my-1 prose-ol:my-1 prose-table:text-xs',
              'prose-table:block prose-table:overflow-x-auto prose-table:whitespace-nowrap',
              right ? 'prose-invert' : 'prose-neutral dark:prose-invert',
              // 6 lines in a narrow panel clamped almost every message into a
              // square slab of brand colour. 14 lets a normal paragraph
              // through whole and keeps "show more" for the ones that are
              // genuinely long.
              !expanded && 'line-clamp-[14]',
            )}
          >
            <Markdown>{m.text}</Markdown>
          </div>
          {(clipped || expanded) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="self-start text-2xs text-text-muted hover:text-text-secondary underline decoration-dotted cursor-pointer"
            >
              {expanded ? 'show less' : 'show more'}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-1 px-1">
          <button
            type="button"
            onClick={onCopy}
            aria-label="Copy message"
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs transition-colors cursor-pointer',
              copied
                ? 'bg-success/20 border-success/30 text-success'
                : 'bg-bg-elevated border-border-subtle text-text-muted hover:text-text-secondary hover:border-brand/30',
            )}
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {copied ? 'Copied!' : 'Copy'}
          </button>
          {onTogglePin && (
            <button
              type="button"
              onClick={onTogglePin}
              aria-label={pinned ? 'Unpin' : 'Pin'}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs transition-colors cursor-pointer',
                pinned
                  ? 'bg-warning/20 border-warning/30 text-warning'
                  : 'bg-bg-elevated border-border-subtle text-text-muted hover:text-warning hover:border-warning/30',
              )}
            >
              <Star size={10} fill={pinned ? 'currentColor' : 'none'} />
              {pinned ? 'Pinned' : 'Pin'}
            </button>
          )}
          <span className="text-2xs text-text-muted tabular-nums select-none" title={hhmmss(m.at)}>
            {hhmmss(m.at)}
          </span>
        </div>
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
        onClick={() => void tauri.cinderpawAgent.coworkStop(e.toAgentId).catch(() => {})}
        className="self-center rounded-full border border-border-default px-2 py-0.5 text-2xs
                   text-text-muted hover:text-error hover:border-error/40 cursor-pointer"
        title={`Stop ${who}`}
      >
        Stop
      </button>
    </li>
  );
}

/**
 * An approval is the system asking the human, not an agent speaking.
 *
 * And a question needs an answer where it is asked. Until now this row said
 * "Bolt needs your approval" and stopped there — the actual Approve/Deny pair
 * lived only on the mascot's tool-call bubble, which may be collapsed, may be
 * scrolled away, and on a fresh install is a widget the person has never
 * noticed. Somebody watching the panel that reported the request had no way to
 * answer it from the panel that reported it. Same store action as the mascot
 * bubble, so both routes detach the buttons and resolve identically.
 */
function ApprovalRow({ e }: { e: CoworkExchange }) {
  const who = displayName(e.fromAgentId, e.fromName);
  const pending = e.status === 'running';
  // The exchange id IS `approval:<requestId>` (see applyCoworkEvent). A row
  // that arrived some other way simply gets no buttons rather than a broken pair.
  const requestId = e.id.startsWith('approval:') ? e.id.slice('approval:'.length) : null;
  const [answered, setAnswered] = useState(false);
  const label = pending
    ? `${who} needs your approval`
    : e.status === 'error'
      ? `${who} was not approved`
      : `${who} was approved`;
  const answer = (approve: boolean) => {
    if (!requestId) return;
    setAnswered(true);
    useChat.getState().resolveCoworkApproval(requestId, approve);
  };
  return (
    <li className="flex w-full justify-center">
      <span
        className={cn(
          'flex max-w-[92%] flex-col items-center gap-1 rounded-2xl border px-2.5 py-1.5 text-2xs',
          pending
            ? 'border-warning/40 bg-warning/10 text-text-primary'
            : e.status === 'error'
              ? 'border-error/30 bg-error/5 text-text-secondary'
              : 'border-border-default bg-bg-surface text-text-secondary',
        )}
      >
        <span className="flex items-center gap-1.5">
          <span aria-hidden>🔐</span>
          {label}
          {e.approvalClass && <span className="font-medium">{e.approvalClass}</span>}
          {pending && e.startedAt !== undefined && (
            <span className="text-text-muted">
              <Elapsed since={e.startedAt} />
            </span>
          )}
        </span>
        {/* WHAT is being approved. A decision prompt without the subject of
            the decision is not a prompt, it is a coin flip. */}
        {e.requestText && (
          <span className="w-full break-words text-center font-mono text-text-secondary">
            {e.requestText}
          </span>
        )}
        {pending && requestId && !answered && (
          <span role="group" aria-label={`Approval request: ${e.requestText ?? e.approvalClass ?? who}`} className="flex items-center gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={() => answer(true)}
              className="rounded-full border border-brand/40 bg-brand/15 px-2.5 py-0.5 text-2xs
                         font-medium text-text-primary hover:bg-brand/25 cursor-pointer"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => answer(false)}
              className="rounded-full border border-error/40 bg-error/10 px-2.5 py-0.5 text-2xs
                         font-medium text-text-primary hover:bg-error/20 cursor-pointer"
            >
              Deny
            </button>
          </span>
        )}
        {answered && pending && <span className="text-text-muted">sending…</span>}
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
    // Also frozen once there is a draft in the box. `touched` alone only
    // caught an explicit change of the select — so while you typed, any
    // teammate who spoke moved `defaultTo`, and the half-written message was
    // silently readdressed to whoever talked last. You do not get to see that
    // happen: the select is a 10px control at the other end of the row.
    // Starting to type IS choosing a recipient.
    if (!touched.current && !text) setTo(defaultTo);
  }, [defaultTo, text]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await tauri.cinderpawAgent.coworkSendMessage(to, body, threadId ?? undefined);
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
          // Clear the last failure as soon as the person acts on it. A red
          // line that outlives the message it was about starts describing the
          // wrong send.
          onChange={(ev) => {
            setText(ev.target.value);
            if (error) setError(null);
          }}
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
/** Header + filter row + composer: the panel's height minus its scroll body. */
const PANEL_CHROME_PX = 132;
const PANEL_HEIGHT_KEY = 'cowork-panel-height';
export const PANEL_MIN_H = 200;
export const PANEL_MAX_H = 720;
const PANEL_DEFAULT_H = 440;
const PINNED_KEY = 'cowork-pinned-ids';
const PANEL_POS_KEY = 'cowork-panel-pos';
const PANEL_DEFAULT_POS = { top: 12, right: 12 };

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
/**
 * Keep the panel on the screen it is actually being drawn on.
 *
 * The position is absolute pixels from the top-right and it is remembered
 * forever. Move the window to a smaller display, unplug the second monitor,
 * or just resize — and a position that was valid yesterday puts the panel
 * entirely outside the viewport, where nothing can click it and nothing
 * brings it back, because the stored value keeps winning on every launch.
 * Clamping on read AND on resize means the panel can always be reached.
 */
function clampPos(p: { top: number; right: number }): { top: number; right: number } {
  const maxRight = Math.max(4, window.innerWidth - 80);
  const maxTop = Math.max(4, window.innerHeight - 80);
  return {
    top: Math.min(Math.max(4, p.top), maxTop),
    right: Math.min(Math.max(4, p.right), maxRight),
  };
}

function readPos(): { top: number; right: number } {
  try {
    const raw = localStorage.getItem(PANEL_POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { top: number; right: number };
      if (Number.isFinite(p.top) && Number.isFinite(p.right)) return clampPos(p);
    }
  } catch {}
  return PANEL_DEFAULT_POS;
}

/** How close to the bottom still counts as "following the live feed". */
const FOLLOW_SLACK_PX = 48;

/** Breathing room between the panel's bottom edge and the composer. */
const COMPOSER_GAP_PX = 12;

/**
 * The tallest the transcript body may be, given where the panel sits and where
 * the composer starts.
 *
 * This used to be `window.innerHeight - top - 88`. Two things were wrong with
 * it. The 88 was a guess at the height of a dock that grows with a multi-line
 * draft, an error notice and the greeting — so the panel overlapped the very
 * thing it was supposed to clear. And the guess was then fed through
 * `Math.min(MAX, thatNumber, Math.max(MIN, wanted))`, where the floor is inside
 * the `min` and loses to it: drag the panel low, or use a short window, and the
 * ceiling went under the floor and the body collapsed to a sliver — taking the
 * resize grip with it, so there was no way to drag it back. That is the bug
 * you cannot recover from, which is why the floor now wins last.
 */
export function maxBodyHeight(panelTop: number): number {
  const dock = document.querySelector('[data-chat-input-dock]') as HTMLElement | null;
  // The composer is the real limit; the viewport bottom is the fallback for
  // any host that renders this panel without one.
  const floorY = dock ? dock.getBoundingClientRect().top : window.innerHeight;
  const room = floorY - panelTop - PANEL_CHROME_PX - COMPOSER_GAP_PX;
  // Never below the floor: a ceiling that has gone negative is a window too
  // small for the panel, and the honest answer there is a scrollbar, not a
  // panel nobody can grab.
  return Math.max(PANEL_MIN_H, Math.min(PANEL_MAX_H, room));
}

export function CoworkTranscriptPanel() {
  const allExchanges = useCoworkTranscript((s) => s.exchanges);
  const activeThreadId = useCoworkTranscript((s) => s.activeThreadId);
  // ONLY this chat's teammate traffic. The store keeps every thread's, so
  // reopening a chat brings its own transcript back, but a chat that never
  // used cowork — including a brand-new one, where `activeThreadId` is null —
  // shows nothing at all.
  const exchanges = useMemo(
    () => threadExchanges(allExchanges, activeThreadId),
    [allExchanges, activeThreadId],
  );
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [width, setWidth] = useState(readWidth);
  const [height, setHeight] = useState(readHeight);
  const [pos, setPos] = useState(readPos);
  // Mirrors `pos` for the drag listeners, which are bound once and must not be
  // rebuilt mid-gesture just to see the current value.
  const posRef = useRef(pos);
  posRef.current = pos;
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const resizingWidth = useRef(false);
  const resizingHeight = useRef(false);
  const draggingPos = useRef(false);
  const dragStart = useRef<{ x: number; y: number; top: number; right: number } | null>(null);
  const didDrag = useRef(false);
  const [unread, setUnread] = useState(0);
  const prevLenRef = useRef(0);
  // Per-thread hydrate: panel appears only in threads that used cowork.
  // When switching threads, fetch that thread's mailbox rows; empty = hide.
  const convId = useConversations((s) => s.currentId);
  const chatSid = useChat((s) => s.sessionId);
  const currentId = convId ?? chatSid ?? null;
  useEffect(() => {
    // Point the transcript at this chat FIRST, so the previous one's bubbles
    // are gone on the same frame the conversation changes rather than lingering
    // until the mailbox answers — and so a new chat (no id yet) shows nothing.
    useCoworkTranscript.getState().setThread(currentId);
    if (!currentId) return;
    void tauri.cinderpawAgent.coworkHistory(currentId).catch(() => {});
  }, [currentId]);
  // Changing chats is not mail arriving.
  //
  // The badge counts how much `exchanges` grew, and `exchanges` is now this
  // thread's traffic — so opening a chat with seven exchanges after one with
  // two used to read as "5 new messages" about a conversation that happened
  // days ago. Reset the baseline when the thread changes, and count only what
  // arrives while you are actually on it.
  useEffect(() => {
    prevLenRef.current = exchanges.length;
    setUnread(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

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

  /** Pull the body back under the composer, wherever the panel is now. */
  const fitHeight = () => {
    const top = panelRef.current?.getBoundingClientRect().top ?? pos.top;
    const ceiling = maxBodyHeight(top);
    setHeight((h) => Math.max(PANEL_MIN_H, Math.min(ceiling, h)));
  };

  // A window that got smaller must not take the panel with it — and that
  // applies to its HEIGHT as much as its position. Only the position was being
  // clamped, so shrinking the window (or opening the app on a laptop screen
  // after using a monitor) left a remembered height lying across the composer,
  // permanently, with its resize grip somewhere below the bottom of the screen.
  // Runs once on mount too, for exactly that remembered-from-a-bigger-screen case.
  useEffect(() => {
    const onResize = () => {
      setPos((p) => clampPos(p));
      fitHeight();
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);

  // ESC to collapse.
  //
  // Click-outside used to collapse it too, and that was wrong: this is a
  // persistent transcript with a text box in it, not a modal. Glancing at the
  // chat behind it — or clicking anything at all while composing — threw the
  // half-typed message away and shut the panel. A panel you cannot look away
  // from is not a panel. ESC and the header ✕ close it; nothing else does.
  //
  // ESC is also ignored while the composer has focus, where the key already
  // means "abandon what I am typing" in every other text box on the machine.
  useEffect(() => {
    if (collapsed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      setCollapsed(true);
      // Same persistence as the ✕: two ways to close, one remembered result.
      try {
        localStorage.setItem(COLLAPSED_KEY, '1');
      } catch {}
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(PINNED_KEY);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(PINNED_KEY, JSON.stringify([...pinnedIds]));
    } catch {}
  }, [pinnedIds]);
  const togglePin = (key: string) =>
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
  const pinnedMessages = useMemo(() => messages.filter((m) => pinnedIds.has(m.key)), [messages, pinnedIds]);
  const displayMessages = useMemo(
    () => filteredMessages.filter((m) => !pinnedIds.has(m.key)),
    [filteredMessages, pinnedIds],
  );
  // A 1px-wide button per message used to live down the right edge as a
  // "minimap". Past a dozen messages that was a dozen-plus focusable targets
  // in the tab order — a keyboard user had to press Tab through every one to
  // get past the transcript — and they were 1px wide, so a mouse could not
  // reliably hit them either. The scrollbar is the minimap. Deleted.

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
          const wanted = e.clientY - top - PANEL_CHROME_PX;
          // Ceiling first, floor last — see `maxBodyHeight`. In the other
          // order a cramped window wins over the minimum and the panel
          // collapses to a strip with no grip on it.
          setHeight(Math.max(PANEL_MIN_H, Math.min(maxBodyHeight(top), wanted)));
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

  // Drag to reposition — header grip, persisted, snap to edges.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingPos.current || !dragStart.current) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag.current = true;
      setPos(clampPos({ top: dragStart.current.top + dy, right: dragStart.current.right - dx }));
    };
    const onUp = () => {
      if (!draggingPos.current) return;
      draggingPos.current = false;
      dragStart.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem(PANEL_POS_KEY, JSON.stringify(posRef.current));
      } catch {}
      // Keep didDrag true for the click that follows mouseup; toggle will clear it.
      if (didDrag.current) setTimeout(() => { didDrag.current = false; }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // Deliberately `[]`. This depended on `[pos]`, and `onMove` calls `setPos`
    // — so every frame of a drag tore down both window listeners and added
    // them again, sixty times a second, mid-gesture. The only thing `[pos]`
    // bought was a fresh `pos` for the persist in `onUp`; `posRef` gives that
    // without rebuilding the gesture underneath the hand holding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (didDrag.current) { didDrag.current = false; return; }
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
  // A reply belongs to the chat the panel is showing — that is what every
  // bubble in it was filed under, and it is the thread `cowork_send` would
  // have used from this conversation anyway.
  const lastThreadId = activeThreadId ?? (last?.threadId && last.threadId !== 'direct' ? last.threadId : null);

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
        onMouseDown={(e) => {
          didDrag.current = false;
          draggingPos.current = true;
          dragStart.current = { x: e.clientX, y: e.clientY, top: pos.top, right: pos.right };
          document.body.style.cursor = 'move';
          e.preventDefault();
        }}
        data-testid="cowork-bubble"
        aria-label="Open cowork transcript"
        aria-expanded={false}
        layoutId="cowork-panel"
        transition={{ type: 'spring', stiffness: 420, damping: 28 }}
        // `borderRadius` inline, and NOT via `rounded-full`, because this
        // element shares `layoutId` with the expanded panel. A shared layout
        // transition projects one box onto the other and scale-corrects it —
        // but it can only correct a radius it can read, and a Tailwind class
        // is not one. So the circle was drawn at the panel's rectangular
        // radius for the length of the morph, and `ring-2` (a box-shadow,
        // which follows border-radius) traced that rectangle: the square
        // around the bubble. The panel already animates its radius inline;
        // this is the other half of the same pair.
        style={{ top: pos.top, right: pos.right, borderRadius: 9999 }}
        initial={{ scale: 0.85, opacity: 0, borderRadius: 9999 }}
        animate={{ scale: 1, opacity: 1, borderRadius: 9999 }}
        exit={{ scale: 0.85, opacity: 0, borderRadius: 9999 }}
        className="absolute z-30 size-14 shadow-lg
                   flex items-center justify-center cursor-pointer
                   ring-2 ring-bg-elevated
                   hover:scale-105 active:scale-95 transition-transform"
      >
        {/* A chat head: the person you are talking to, filling the circle,
            the way every messenger draws one. The first version stacked two
            6px avatars on a brand-orange disc — at 48px across that is three
            competing shapes and no face. One teammate fills it; a second
            appears as a small overlap, and that is the whole hierarchy. */}
        {participants.length > 0 ? (
          <>
            <Avatar id={participants[0]![0]} name={participants[0]![1]} size="head" />
            {participants.length > 1 && (
              <Avatar
                id={participants[1]![0]}
                name={participants[1]![1]}
                className="absolute -bottom-0.5 -left-0.5 ring-2 ring-bg-elevated"
              />
            )}
          </>
        ) : (
          <span className="flex size-full items-center justify-center rounded-full bg-brand text-base font-semibold text-white">
            ◈
          </span>
        )}
        {/* Top right, red, over the edge of the head — the one place a person
            already looks for "how many". It used to sit bottom-right, where
            the eye does not go, sharing that corner with nothing while the
            "someone is working" dot sat top-right and collided with it on
            every busy turn. Now: count on top, activity underneath. */}
        {unread > 0 && (
          <span
            data-testid="cowork-unread-badge"
            aria-label={`${unread} unread message${unread === 1 ? '' : 's'}`}
            className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1.5 rounded-full
                       bg-error text-white text-2xs font-bold leading-none
                       flex items-center justify-center ring-2 ring-bg-elevated"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
        {working.length > 0 && unread === 0 && (
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full
                       bg-success ring-2 ring-bg-elevated animate-pulse"
          />
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
      style={{ width: `${width}px`, maxWidth: '42%', top: pos.top, right: pos.right }}
      initial={{ scale: 0.92, opacity: 0, borderRadius: 999 }}
      animate={{ scale: 1, opacity: 1, borderRadius: 16 }}
      exit={{ scale: 0.92, opacity: 0, borderRadius: 999 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30, layout: { duration: 0 } }}
      // z-30, not z-20: the chat input wrapper is z-20 AND comes later in the
      // DOM, so at the same level it painted its own panel straight over a
      // floating window the person had dragged there. Modals (z-40+) still
      // win, which is right — they are answering something.
      className="absolute z-30
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
        // Without this the control announces as its own contents — the avatar
        // initial glued to the participant list, "AAtlas" — which says who is
        // in the conversation and nothing about what the button does. The
        // collapsed bubble already names its action; this is the other half.
        aria-label="Collapse cowork transcript"
        className="flex items-center gap-2 px-3 py-2 text-2xs font-medium text-text-muted
                   hover:bg-bg-elevated cursor-pointer select-none"
      >
        <span
          onMouseDown={(e) => {
            didDrag.current = false;
            draggingPos.current = true;
            dragStart.current = { x: e.clientX, y: e.clientY, top: pos.top, right: pos.right };
            document.body.style.cursor = 'move';
            document.body.style.userSelect = 'none';
            e.preventDefault();
            e.stopPropagation();
          }}
          className="cursor-move p-1 -ml-1 text-text-muted hover:text-text-primary"
          title="Drag to move"
          aria-hidden
        >
          <GripVertical size={12} />
        </span>
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
      <div className="relative flex">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-testid="cowork-transcript-scroll"
          style={{ height: `${height}px`, maxHeight: '65vh' }}
          className="flex-1 overflow-y-auto thin-scrollbar px-2.5 pb-2.5"
        >
          {pinnedMessages.length > 0 && (
            <div className="mb-2 rounded-lg border border-warning/20 bg-warning/5 p-2">
              <div className="text-2xs font-medium text-warning mb-1.5 flex items-center gap-1">
                <Star size={10} fill="currentColor" /> Pinned
              </div>
              {/* A real list: Bubble renders an <li>, and an <li> whose parent
                  is a <div> is not a list item to a screen reader. */}
              <ul className="flex flex-col gap-1.5">
                {pinnedMessages.map((m) => (
                  <Bubble key={`pinned:${m.key}`} m={m} showAuthor pinned onTogglePin={() => togglePin(m.key)} />
                ))}
              </ul>
            </div>
          )}
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {displayMessages.map((m, i) => (
                <Bubble
                  key={m.key}
                  m={m}
                  pinned={pinnedIds.has(m.key)}
                  onTogglePin={() => togglePin(m.key)}
                  // Group-chat convention: the name appears once per run of
                  // consecutive messages from the same speaker, not on every
                  // bubble — repeating it turns a conversation into a table.
                  showAuthor={i === 0 || displayMessages[i - 1]?.authorId !== m.authorId}
                />
              ))}
            </AnimatePresence>
            {approvals.map((e) => (
              <ApprovalRow key={e.id} e={e} />
            ))}
            {working.map((e) => (
              <TypingRow key={`typing:${e.id}`} e={e} />
            ))}
            {/* A filter that matches nothing used to leave a blank rectangle,
                which reads as "the transcript is gone", not as "your search
                found nothing". Say which, and offer the way back. */}
            {(filterText.trim() || filterAgent) &&
              displayMessages.length === 0 &&
              pinnedMessages.length === 0 && (
                <li className="flex flex-col items-center gap-1.5 py-6 text-2xs text-text-muted">
                  <span>No messages match this filter.</span>
                  <button
                    type="button"
                    onClick={() => {
                      setFilterText('');
                      setFilterAgent(null);
                    }}
                    className="rounded-full border border-border-default px-2.5 py-0.5
                               text-text-secondary hover:border-brand/40 cursor-pointer"
                  >
                    Clear filter
                  </button>
                </li>
              )}
          </ul>
        </div>
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
