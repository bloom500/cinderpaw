import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { Mic, MicOff, PhoneOff, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CallPillState } from '@/lib/callPill';

/**
 * The call pill's page: rendered alone in the `call-pill` window (see
 * `main.tsx`), over a transparent background. It owns nothing: every press is
 * an event to the main window, and everything it shows arrives from there.
 *
 * Left, the transcript: what you said, then what the agent answered, one line
 * each. Right, three controls: mute the microphone, stop the answer, end the
 * call. A click anywhere else brings the app back.
 */
export function CallPill() {
  const [s, setS] = useState<CallPillState | null>(null);

  useEffect(() => {
    const off = listen<CallPillState>('call-pill://state', (e) => setS(e.payload));
    // Mounted after the call began: ask for the state instead of waiting for
    // the next change.
    void emit('call-pill://hello');
    return () => { void off.then((f) => f()); };
  }, []);

  const phase = s?.phase ?? 'connecting';
  const status =
    phase === 'speaking' ? 'Cinder is speaking'
      : phase === 'thinking' ? 'Thinking'
        : phase === 'reconnecting' ? 'Reconnecting'
          : phase === 'connecting' ? 'Connecting'
            : s?.muted ? 'Muted' : 'Listening';
  const line = s?.said || s?.heard || '';
  const yours = Boolean(s && !s.said && s.heard);
  const btn = 'flex size-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-bg-hover';

  return (
    <div className="flex h-screen w-screen items-start justify-center bg-transparent p-1">
      <div
        role="status"
        aria-label={`Voice call: ${status}`}
        className="flex h-14 w-full items-center gap-3 rounded-full border border-border-default bg-popover pl-4 pr-2 text-text-primary shadow-lg"
        onClick={() => { void emit('call-pill://open'); }}
      >
        {/* The tear drop: the microphone. It pulses while you are being heard. */}
        <span
          aria-hidden
          className={cn(
            'size-3 shrink-0 rounded-[50%_50%_50%_0] rotate-[-45deg]',
            s?.muted ? 'bg-text-muted/40' : phase === 'listening' ? 'animate-pulse bg-brand' : 'bg-brand/70',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-text-muted">{status}</div>
          <div className={cn('truncate text-sm leading-tight', yours ? 'italic text-text-muted' : 'text-text-primary')}>
            {line || 'Say something'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
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
    </div>
  );
}
