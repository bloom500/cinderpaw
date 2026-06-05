import { useMemo } from 'react';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { useModel } from '@/stores/model';
import { useFeralStore } from '@/stores/feral';
import { contextWindowFor, estimateTokens, estimateRemaining } from '@/lib/contextWindow';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Separator } from '@/components/ui/separator';

const R = 8;
const C = 2 * Math.PI * R;

export function ContextRing() {
  const messages    = useChat((s) => s.messages);
  const isAgentMode = useUI((s) => s.inputMode) === 'agent';
  const loaded      = useModel((s) => s.loaded);
  const cloudModel  = useModel((s) => s.cloudModel);
  const feralConfig = useFeralStore((s) => s.modelConfig);

  const { used, ctxWindow, pct, modelName, remaining } = useMemo(() => {
    const used = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

    let model: string | undefined;
    let isLocal: boolean;
    if (isAgentMode) {
      model = feralConfig?.model;
      isLocal = feralConfig?.provider === 'openai_compatible' || feralConfig?.provider === 'ollama';
    } else if (cloudModel) {
      model = cloudModel.modelId;
      isLocal = false;
    } else {
      model = loaded?.name;
      isLocal = true;
    }

    const ctxWindow = contextWindowFor(model, isLocal);
    const pct = Math.min(1, used / ctxWindow);
    const remaining = estimateRemaining(ctxWindow, used, messages.length);
    return { used, ctxWindow, pct, modelName: model ?? 'Unknown', remaining };
  }, [messages, isAgentMode, feralConfig, cloudModel, loaded]);

  if (messages.length === 0) return null;

  const ringColor =
    pct >= 0.9 ? 'var(--c-red, #ef4444)'
    : pct >= 0.75 ? '#f59e0b'
    : 'var(--color-text-muted, #888)';

  const statusColor =
    pct >= 0.9 ? 'text-red-400'
    : pct >= 0.75 ? 'text-amber-400'
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
          <span className="text-text-primary text-right">~{used.toLocaleString()} tokens</span>

          <span className="text-text-muted">Free</span>
          <span className="text-text-primary text-right">~{remaining.freeTokens.toLocaleString()} tokens</span>

          <span className="text-text-muted">Messages</span>
          <span className="text-text-primary text-right">{messages.length}</span>
        </div>

        <Separator className="my-2" />

        <p className={statusColor}>{statusLabel}</p>
      </HoverCardContent>
    </HoverCard>
  );
}
