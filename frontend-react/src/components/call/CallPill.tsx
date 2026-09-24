import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronUp, Mic, MicOff, PhoneOff, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CallPillState } from '@/lib/callPill';

/** What the pill says while a tool runs, by the tool's kind. */
const WORK_VERB: Record<NonNullable<CallPillState['work']>['kind'], string> = {
  agent: 'Cinder is working',
  browser: 'Browsing',
  files: 'Reading files',
  terminal: 'Running a command',
  memory: 'Remembering',
  desktop: 'Using your desktop',
  artifact: 'Writing',
  generic: 'Working',
};

/**
 * The call pill's page: rendered alone in the `call-pill` window (see
 * `main.tsx`), over a transparent background. It owns nothing: every press is
 * an event to the main window, and everything it shows arrives from there.
 *
 * Left, the transcript: what you said, then what the agent answered, one line
 * each. Right, three controls: mute the microphone, stop the answer, end the
 * call. A click anywhere else brings the app back.
 *
 * When the agent asks a question, the tear drop leaves the pill, falls, and
 * opens into the question; an answer (a press here, or the next spoken
 * sentence in the app) sends it back up into the pill. One element carries
 * both shapes (`layoutId`), so the fall and the opening are one motion, not
 * a card popping in under a pill.
 */
const PILL_W = 560;
const PILL_H = 64;
/** Room below the pill for the question; the window grows to it and back. */
const CARD_ROOM = 300;

/**
 * One spring for the shape (400/30: the values every good Dynamic Island
 * recreation lands on by experiment). The fall starts first; the opening
 * follows 120 ms behind it, so the eye reads "drop, then unfold" instead of
 * a rectangle growing. On the way back the opening closes first, then the
 * drop rises.
 */
const shape = { type: 'spring', stiffness: 400, damping: 30 } as const;
const OPEN = { y: shape, x: shape, rotate: shape, width: { ...shape, delay: 0.12 }, height: { ...shape, delay: 0.12 }, borderRadius: { ...shape, delay: 0.12 } };
const CLOSE = { width: shape, height: shape, borderRadius: shape, y: { ...shape, delay: 0.1 }, x: { ...shape, delay: 0.1 }, rotate: { ...shape, delay: 0.1 } };
/** Where the drop rests in the pill (its 12 px slot), and where the card hangs. */
const DROP_AT = { x: 0, y: 0, width: 12, height: 12, rotate: -45, borderRadius: '50% 50% 50% 0%' };
const CARD_AT = { x: -4, y: 46, width: PILL_W - 24, height: 'auto', rotate: 0, borderRadius: '4px 20px 20px 20px' };

export function CallPill() {
  const [s, setS] = useState<CallPillState | null>(null);
  /** Why nothing arrives, when nothing arrives: said on the pill, not in a log nobody opens. */
  const [fault, setFault] = useState<string | null>(null);

  useEffect(() => {
    const off = listen<CallPillState>('call-pill://state', (e) => setS(e.payload))
      .catch((e) => { setFault(`Cannot listen: ${String(e)}`); return () => {}; });
    // Mounted after the call began: ask for the state instead of waiting for
    // the next change.
    void emit('call-pill://hello').catch((e) => setFault(`Cannot reach the app: ${String(e)}`));
    return () => { void off.then((f) => f()); };
  }, []);

  // Alt+F4 on the pill (it takes the focus when a button on it is pressed)
  // closed it, and with the app hidden behind it there was no pill, no
  // window and no tray icon left: the app looked quit and was not. A close
  // asked of the pill brings the app back instead; the host's own close
  // (`call_pill_close`) destroys the window and never asks.
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const off = getCurrentWindow().onCloseRequested((e) => {
      e.preventDefault();
      void emit('call-pill://open');
    });
    return () => { void off.then((f) => f()); };
  }, []);

  const ask = s?.ask ?? null;
  // The window is exactly the pill; the card needs the room under it. It is
  // given before the drop falls and taken back once the drop is home again
  // (the exit spring is ~400 ms), so nothing is ever clipped mid-motion.
  useEffect(() => {
    // Only a real host window can be resized: the tests and a browser preview have none.
    if (!('__TAURI_INTERNALS__' in window)) return;
    const win = getCurrentWindow();
    if (ask) { void win.setSize(new LogicalSize(PILL_W, PILL_H + CARD_ROOM)).catch(() => {}); return; }
    const t = window.setTimeout(() => { void win.setSize(new LogicalSize(PILL_W, PILL_H)).catch(() => {}); }, 450);
    return () => window.clearTimeout(t);
  }, [ask]);

  const phase = s?.phase ?? 'connecting';
  const work = s?.work ?? null;
  // A running clock is the difference between "working" and "stuck".
  const [, tick] = useState(0);
  useEffect(() => {
    if (!work) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [work]);
  const secs = work ? Math.max(0, Math.round((Date.now() - work.startedAt) / 1000)) : 0;
  const status = fault ? fault :
    ask ? 'Cinder is asking'
      : work ? `${WORK_VERB[work.kind]} · ${secs}s`
      : phase === 'speaking' ? 'Cinder is speaking'
        : phase === 'thinking' ? 'Thinking'
          : phase === 'reconnecting' ? 'Reconnecting'
            : phase === 'connecting' ? 'Connecting'
              : s?.muted ? 'Muted' : 'Listening';
  const line = (work && !s?.said ? work.subject : '') || s?.said || s?.heard || '';
  const yours = Boolean(s && !s.said && s.heard && !work);
  const btn = 'flex size-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-bg-hover';

  return (
    <div className="relative flex h-screen w-screen flex-col items-stretch bg-transparent">
      <div
        role="status"
        aria-label={`Voice call: ${status}`}
        // No shadow and no margin: the window is exactly the pill, and a shadow
        // clipped at the window edge drew a dark rectangle around it (21 Sep).
        className="flex h-16 w-full shrink-0 items-center gap-3 rounded-full bg-popover pl-4 pr-2 text-text-primary"
        onClick={() => { void emit('call-pill://open'); }}
      >
        {/* The tear drop: the microphone. It pulses while you are being heard,
            and while a question is open it is away, down in the card. */}
        <span aria-hidden className="size-3 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-micro font-medium uppercase tracking-wide text-text-muted">{status}</div>
          <div className={cn('truncate text-sm leading-tight', yours ? 'italic text-text-muted' : 'text-text-primary')}>
            {line || 'Say something'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            aria-label="Open Cinderpaw"
            title="Open Cinderpaw"
            onClick={() => { void emit('call-pill://open'); }}
            className={cn(btn, 'text-text-muted')}
          >
            <ChevronUp size={16} />
          </button>
          <button
            type="button"
            aria-label={s?.muted ? 'Unmute microphone' : 'Mute microphone'}
            aria-pressed={Boolean(s?.muted)}
            disabled={s ? !s.canMute : true}
            title={s && !s.canMute ? 'This call engine has no microphone switch' : undefined}
            onClick={() => { void emit('call-pill://mute', { muted: !s?.muted }); }}
            className={cn(btn, s?.muted && 'bg-bg-active text-brand', 'disabled:opacity-40')}
          >
            {s?.muted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          <button
            type="button"
            aria-label="Stop the answer"
            disabled={phase !== 'speaking' && phase !== 'thinking'}
            onClick={() => { void emit('call-pill://interrupt'); }}
            className={cn(btn, 'disabled:opacity-40')}
          >
            <Square size={14} />
          </button>
          <button
            type="button"
            aria-label="End call"
            onClick={() => { void emit('call-pill://end'); }}
            className={cn(btn, 'bg-error text-white hover:opacity-90')}
          >
            <PhoneOff size={16} />
          </button>
        </div>
      </div>

      {/* The drop, and the question: ONE element. In the pill it is the 12 px
          tear drop (the microphone). When the agent asks, it falls out of its
          slot and unfolds into the card; an answer folds it back and it rises
          home. No second node, no crossfade: a transform-based shape change on
          a single layer, which is what stays smooth over a transparent window. */}
      <motion.div
        initial={false}
        animate={ask ? CARD_AT : DROP_AT}
        transition={ask ? OPEN : CLOSE}
        role={ask ? 'dialog' : undefined}
        aria-hidden={!ask}
        aria-label={ask?.question.question}
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', top: 26, left: 16, transformOrigin: '50% 50%', willChange: 'transform, width, height' }}
        className={cn(
          'overflow-hidden text-text-primary',
          ask ? 'bg-popover shadow-lg' : s?.muted ? 'bg-text-muted/40' : phase === 'listening' ? 'animate-pulse bg-brand' : 'bg-brand/70',
        )}
      >
        <AnimatePresence>
          {ask && (
            <motion.div
              key={ask.id}
              className="px-5 pb-4 pt-4"
              style={{ width: PILL_W - 24 }}
              initial={{ opacity: 0, scale: 0.96, filter: 'blur(8px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)', transition: { delay: 0.2, duration: 0.24, ease: [0.2, 0, 0, 1] } }}
              exit={{ opacity: 0, scale: 0.96, filter: 'blur(8px)', transition: { duration: 0.12 } }}
            >
              {ask.question.header && (
                <div className="mb-1 text-micro font-medium uppercase tracking-wide text-brand">{ask.question.header}</div>
              )}
              <div className="mb-3 text-sm leading-snug">{ask.question.question}</div>
              {ask.questions > 1 ? (
                <button
                  type="button"
                  onClick={() => { void emit('call-pill://open'); }}
                  className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:opacity-90"
                >
                  {ask.questions} questions: open Cinderpaw to answer
                </button>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {ask.question.options.map((o, i) => (
                    <motion.button
                      key={o.label}
                      type="button"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0, transition: { delay: 0.26 + i * 0.04, duration: 0.18 } }}
                      whileTap={{ scale: 0.97 }}
                      title={o.description}
                      onClick={() => { void emit('call-pill://answer', { id: ask.id, selected: [o.label] }); }}
                      className={cn(
                        'rounded-full px-4 py-2 text-sm font-medium transition-colors',
                        o.recommended ? 'bg-brand text-brand-foreground hover:opacity-90' : 'bg-bg-hover hover:bg-bg-active',
                      )}
                    >
                      {o.label}
                    </motion.button>
                  ))}
                </div>
              )}
              <div className="mt-3 text-micro text-text-muted">Or just say it.</div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
