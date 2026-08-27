import { useMemo } from 'react';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { useModel } from '@/stores/model';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { activeContextWindow, estimateTokens, estimateRemaining } from '@/lib/contextWindow';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Separator } from '@/components/ui/separator';

const R = 8;
const C = 2 * Math.PI * R;

export function ContextRing() {
  const messages            = useChat((s) => s.messages);
  const livePromptTokens    = useChat((s) => s.livePromptTokens);
  const liveCompletionTokens = useChat((s) => s.liveCompletionTokens);
  const isStreaming         = useChat((s) => s.streamStatus) === 'streaming';
  const isAgentMode         = useUI((s) => s.inputMode) === 'agent';
  const loaded              = useModel((s) => s.loaded);
  const cloudModel          = useModel((s) => s.cloudModel);
  const cinderpawConfig         = useCinderpawStore((s) => s.modelConfig);

  const { used, ctxWindow, pct, modelName, remaining, isLive } = useMemo(() => {
    const { model, ctxWindow } = activeContextWindow({
      isAgentMode,
      cinderpawConfig,
      cloudModel,
      loaded,
    });

    // Real token usage: use live counts from backend when available.
    // For local models, livePromptTokens is the exact count from llama.cpp tokenization.
    // For cloud, livePromptTokens + liveCompletionTokens comes from the API usage field.
    // Agent mode now emits a real `usage` event per completion (router prompt +
    // completion tokens), wired through the live-session mirror — so the ring
    // reflects actual context consumption there too, instead of a rough estimate.
    const isLive = livePromptTokens !== null;
    const used = isLive
      ? (livePromptTokens! + (liveCompletionTokens ?? 0))
      : messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

    // `ctxWindow` is 0 when no model is loaded, and 0/0 is NaN — which then
    // flows into the ring's stroke-dashoffset and the percentage label, drawing
    // nothing and reading "NaN%".
    const pct = ctxWindow > 0 ? Math.min(1, used / ctxWindow) : 0;
    const remaining = estimateRemaining(ctxWindow, used, messages.length);
    return { used, ctxWindow, pct, modelName: model ?? 'Unknown', remaining, isLive };
  }, [messages, livePromptTokens, liveCompletionTokens, isAgentMode, cinderpawConfig, cloudModel, loaded]);

  if (messages.length === 0) return null;

  // `--c-red` and `--color-text-muted` do not exist — the tokens are `--error`
  // and `--text-muted` — so every branch fell through to its hardcoded fallback
  // and the ring was painted in Tailwind's red/amber/grey regardless of theme.
  // Against a warm brown palette that reads as a foreign element pasted on.
  const ringColor =
    pct >= 0.9 ? 'var(--error)'
    : pct >= 0.75 ? 'var(--warning)'
    : 'var(--text-muted)';

  const statusColor =
    pct >= 0.9 ? 'text-error'
    : pct >= 0.75 ? 'text-warning'
    : 'text-text-muted';

  const pctLabel = pct < 0.01 ? '<1' : Math.round(pct * 100).toString();

  const remainingLabel = remaining.showAsTokens
    ? `~${remaining.freeTokens.toLocaleString()} tokens left`
    : `~${remaining.msgsRemaining} msgs left`;

  const statusLabel = pct >= 0.9
    ? `Approaching limit · ${remainingLabel}`
    : `${pctLabel}% · ${remainingLabel}`;

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <div
          className="flex items-center shrink-0 text-text-muted cursor-default"
          aria-label={`Context: ~${used.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens (${pctLabel}%)`}
        >
          <svg width="18" height="18" viewBox="0 0 20 20" className="shrink-0">
            <circle cx="10" cy="10" r={R} fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
            <circle
              cx="10" cy="10" r={R}
              fill="none"
              stroke={ringColor}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - pct)}
              transform="rotate(-90 10 10)"
              style={{ transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease' }}
            />
            {/* Live activity: a comet arc orbits the ring while the agent/model
                generates, so context reads as actively loading even during
                thinking/tool phases when no visible content is growing yet. */}
            {isStreaming && (
              <g className="animate-spin" style={{ transformOrigin: '10px 10px', animationDuration: '0.9s' }}>
                <circle
                  cx="10" cy="10" r={R}
                  fill="none"
                  stroke={ringColor}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={`${C * 0.22} ${C * 0.78}`}
                />
              </g>
            )}
          </svg>
        </div>
      </HoverCardTrigger>

      <HoverCardContent side="top" align="end" className="w-52 p-3 text-xs">
        <p className="text-text-muted font-medium mb-2">Context Window</p>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <span className="text-text-muted">Model</span>
          <span className="text-text-primary truncate text-right">{modelName}</span>

          <span className="text-text-muted">Window</span>
          <span className="text-text-primary text-right">{ctxWindow.toLocaleString()} tokens</span>

          <span className="text-text-muted">Used</span>
          <span className="text-text-primary text-right">
            {isLive ? '' : '~'}{used.toLocaleString()} tokens
          </span>

          <span className="text-text-muted">Free</span>
          <span className="text-text-primary text-right">
            {isLive ? '' : '~'}{remaining.freeTokens.toLocaleString()} tokens
          </span>

          <span className="text-text-muted">Messages</span>
          <span className="text-text-primary text-right">{messages.length}</span>
        </div>

        <Separator className="my-2" />

        <p className={statusColor}>{statusLabel}</p>
        {!isLive && (
          <p className="text-text-muted mt-1 opacity-60">~ estimated</p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
