import { AlertCircle, RefreshCw } from 'lucide-react';
import type { AgentConfig } from '@/lib/tauri';
import { PresetCard } from '../PresetCard';

interface Props {
  presets: AgentConfig[];
  loading: boolean;
  error: string | null;
  selected: AgentConfig | null | 'scratch';
  onSelect: (v: AgentConfig | 'scratch') => void;
  onRetry: () => void;
}

export function PickPresetStep({ presets, loading, error, selected, onSelect, onRetry }: Props) {
  return (
    <div className="space-y-6">
      <div className="text-center space-y-1">
        <h2 className="text-2xl font-bold text-text-primary tracking-tight">
          What will your agent do?
        </h2>
        <p className="text-sm text-text-muted">Pick a template or start from scratch.</p>
      </div>

      {loading && (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 rounded-lg bg-bg-hover animate-pulse" />
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="rounded-lg border border-error/30 bg-error/5 p-4 flex items-start gap-3">
          <AlertCircle size={14} className="text-error shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p className="text-sm text-error">Couldn't load templates.</p>
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
        <div className="space-y-2">
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
