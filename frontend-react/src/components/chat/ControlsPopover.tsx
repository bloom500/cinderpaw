import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useModel, type InferParamsUI } from '@/stores/model';
import { useUI } from '@/stores/ui';
import { useFeralStore } from '@/stores/feral';
import { activeContextWindow } from '@/lib/contextWindow';

function ParamRow({
  label,
  value,
  min,
  max,
  step,
  decimals,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals: number;
  onChange: (v: number) => void;
}) {
  // Free-typing draft: the field accepts any intermediate text ("", "0.",
  // "20") and commits the clamped value on blur or Enter. The previous
  // per-keystroke validation re-formatted the controlled value mid-edit,
  // which made the field effectively impossible to type into.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = decimals === 0 ? parseInt(draft, 10) : parseFloat(draft);
    if (!isNaN(v)) onChange(Math.min(max, Math.max(min, v)));
    setDraft(null);
  };
  return (
    <div className="mb-4 last:mb-0">
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-xs text-text-secondary">{label}</span>
        <input
          type="number"
          value={draft ?? (decimals === 0 ? String(value) : value.toFixed(decimals))}
          min={min}
          max={max}
          step={step}
          className="w-16 text-right text-xs bg-transparent border-none outline-none text-text-primary [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = decimals === 0 ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
          onChange(v);
        }}
        className="w-full h-1 rounded-full appearance-none bg-border-subtle cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-text-secondary [&::-webkit-slider-thumb]:cursor-pointer"
      />
    </div>
  );
}

const ROWS: Array<{
  key: keyof InferParamsUI;
  label: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  /** Local-only: cloud models expose temperature alone (their sampling stack is
   *  provider-fixed), so Top-P is hidden when the active target is cloud. */
  localOnly?: boolean;
}> = [
  { key: 'temperature', label: 'Temperature', min: 0,    max: 2,    step: 0.01,  decimals: 2 },
  { key: 'top_p',       label: 'Top-P',        min: 0.01, max: 1,    step: 0.01,  decimals: 2, localOnly: true },
];

/** Round n down to the nearest multiple of `step`, clamped to [min, max]. */
function snap(n: number, min: number, max: number, step: number): number {
  return Math.min(max, Math.max(min, Math.round(n / step) * step));
}

/**
 * Per-local-model context window. The ceiling is auto-detected from the loaded
 * model's real training window (`n_ctx_train`) — Qwen 64k, Gemma 32k, etc. —
 * so the slider only ever offers what the model can actually do.
 *
 * Gated on `isLocalActive`, NOT merely on `loaded`. A local GGUF often stays
 * resident as the offline fallback while a cloud model (MiniMax, …) is the
 * ACTIVE target — showing its context slider then let the user "raise MiniMax's
 * window" and silently reload the background local model instead. When the
 * active target is cloud we show the auto-managed note regardless of any
 * resident GGUF.
 */
function ContextWindowRow({ isLocalActive }: { isLocalActive: boolean }) {
  const loaded     = useModel((s) => s.loaded);
  const isLoading  = useModel((s) => s.isLoading);
  const chosenMap  = useModel((s) => s.contextByModel);
  const setContext = useModel((s) => s.setModelContext);
  const [draft, setDraft] = useState<number | null>(null);

  if (!isLocalActive || !loaded) {
    return (
        <p className="pt-3 border-t border-border-subtle text-[10px] text-text-muted leading-snug">
        Context window is auto-managed for cloud models. Load a local model to choose it.
      </p>
    );
  }

  const MIN = 2048;
  const STEP = 1024;
  const max = Math.max(MIN, loaded.n_ctx_train || loaded.ctx_len || MIN);
  const active = chosenMap[loaded.path] ?? loaded.ctx_len;
  const value = draft ?? snap(active, MIN, max, STEP);
  const dirty = value !== loaded.ctx_len;

  return (
    <div className="pt-3 border-t border-border-subtle">
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-xs text-text-secondary">Context window</span>
        <span className="text-xs text-text-primary tabular-nums">
          {(value / 1024).toFixed(0)}k / {(max / 1024).toFixed(0)}k
        </span>
      </div>
      <input
        type="range"
        min={MIN} max={max} step={STEP}
        value={value}
        disabled={isLoading}
        onChange={(e) => setDraft(Number(e.target.value))}
        className="w-full h-1 rounded-full appearance-none bg-border-subtle cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-text-secondary [&::-webkit-slider-thumb]:cursor-pointer disabled:opacity-50"
      />
      <p className="text-[10px] text-text-muted mt-1.5 leading-snug">
        Auto-detected from {loaded.name}. Bigger = longer memory but more VRAM/RAM.
      </p>
      {dirty && (
        <button
          type="button"
          disabled={isLoading}
          onClick={() => { void setContext(loaded.path, value); setDraft(null); }}
          className="mt-2 px-2.5 py-1 rounded-md bg-bg-hover hover:bg-bg-active text-text-primary text-xs disabled:opacity-50 transition-colors"
        >
          {isLoading ? 'Reloading…' : `Apply ${(value / 1024).toFixed(0)}k & reload`}
        </button>
      )}
    </div>
  );
}

export function ControlsPopover() {
  const inferParams    = useModel((s) => s.inferParams);
  const setInferParams = useModel((s) => s.setInferParams);

  // Which model will actually serve the next request? Same rule as the context
  // ring: a resident local GGUF is only "active" when no cloud model is
  // selected. Cloud active → temperature only (Top-P + context are hidden).
  const isAgentMode = useUI((s) => s.inputMode) === 'agent';
  const loaded      = useModel((s) => s.loaded);
  const cloudModel  = useModel((s) => s.cloudModel);
  const feralConfig = useFeralStore((s) => s.modelConfig);
  const { isLocal } = activeContextWindow({ isAgentMode, feralConfig, cloudModel, loaded });
  const isLocalActive = isLocal && !!loaded;

  const rows = ROWS.filter((r) => isLocalActive || !r.localOnly);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center justify-center h-full px-2.5 text-text-muted hover:text-text-secondary transition-colors outline-none">
          <Settings2 size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-60">
        <p className="text-xs font-medium text-text-secondary mb-3">Controls</p>
        {rows.map(({ key, label, min, max, step, decimals }) => (
          <ParamRow
            key={key}
            label={label}
            value={inferParams[key]}
            min={min}
            max={max}
            step={step}
            decimals={decimals}
            onChange={(v) => setInferParams({ [key]: v })}
          />
        ))}
        <ContextWindowRow isLocalActive={isLocalActive} />
      </PopoverContent>
    </Popover>
  );
}
