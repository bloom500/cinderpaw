import { AlertCircle, RefreshCw } from 'lucide-react';
import type { AgentConfig } from '@/lib/tauri';
import { PresetCard } from '../PresetCard';

interface Props {
  presets: AgentConfig[];
  loading: boolean;
  error: string | null;
  selected: AgentConfig | null | 'scratch'; // null = nothing chosen yet
  onSelect: (v: AgentConfig | 'scratch') => void;
  onRetry: () => void;
}

export function PickPresetStep({ presets, loading, error, selected, onSelect, onRetry }: Props) {
  return (
    <div className="max-w-md mx-auto space-y-4 pt-2">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold text-text-primary">What kind of tasks do you want help with?</h2>
        <p className="text-xs text-text-muted">Pick a template or start with a blank agent.</p>
      </div>

      {loading && (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 rounded-lg bg-bg-hover animate-pulse" />
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 flex items-start gap-3">
          <AlertCircle size={14} className="text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p className="text-sm text-red-400">Couldn't load templates.</p>
            <button
              type="button"
              onClick={onRetry}
              className="text-xs text-text-muted hover:text-text-secondary inline-flex items-center gap-1"
            >
              <RefreshCw size={11} /> Try again
            </button>
          </div>
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-2.5">
          {presets.map((p) => (
            <PresetCard
              key={p.id ?? p.name}
              preset={p}
              selected={selected !== 'scratch' && selected?.name === p.name}
              onSelect={() => onSelect(p)}
            />
          ))}
          <PresetCard
            preset="scratch"
            selected={selected === 'scratch'}
            onSelect={() => onSelect('scratch')}
          />
        </div>
      )}
    </div>
  );
}
