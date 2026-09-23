import { useState } from 'react';
import { useSettings } from '@/stores/settings';
import { cn } from '@/lib/utils';
import { RsiEngineStatusPanel } from './RsiEngineStatusPanel';
import { CinderpawDreamsPanel } from './CinderpawDreamsPanel';

/**
 * Everything Cinderpaw does to get better on its own, in one place. It used to
 * share the Agent tab with the agent list and desktop control, five cards deep,
 * so a person looking for "who am I talking to" scrolled past an engine.
 */
export function LearningTab() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-text-primary">Learning</h2>
        <p className="text-sm text-text-muted">
          Cinderpaw practices by itself to get better at helping you. Here you see
          what it is doing and decide what it may spend.
        </p>
      </header>

      <SpendLimit />
      <RsiEngineStatusPanel />
      <CinderpawDreamsPanel />
    </div>
  );
}

/**
 * USD spend cap for the passive RSI background engine. Default $0 = local-only:
 * the free local engine self-improves forever and never spends; any paid cloud
 * spend halts. Raise it to allow bounded cloud spend.
 */
function SpendLimit() {
  const settings    = useSettings((s) => s.settings);
  const setRsiBudget = useSettings((s) => s.setRsiBudget);
  const [busy, setBusy] = useState(false);

  const budget = settings?.rsi_max_cost_usd ?? 0;

  const PRESETS = [
    { label: 'Free only ($0)', value: 0 },
    { label: '$1',  value: 1 },
    { label: '$5',  value: 5 },
    { label: '$20', value: 20 },
  ] as const;

  const setPreset = async (value: number) => {
    if (busy || !settings) return;
    setBusy(true);
    try { await setRsiBudget(value); } catch { /* rolled back */ } finally { setBusy(false); }
  };

  return (
    <div className="rounded-md border border-border-subtle bg-bg-surface p-4 space-y-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">Spending limit</p>
        <p className="text-xs text-text-muted mt-0.5">
          Practicing with a model on your computer is free. Practicing with a
          cloud model costs money. Pick the most it may spend.
          <span className="text-text-secondary"> $0 means it never spends money.</span>
        </p>
      </div>
      <div className="flex gap-1 rounded-md border border-border-subtle p-1">
        {PRESETS.map(({ label, value }) => (
          <button
            key={value}
            type="button"
            disabled={busy || !settings}
            onClick={() => void setPreset(value)}
            className={cn(
              'flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50',
              budget === value ? 'bg-brand text-on-brand' : 'text-text-secondary hover:bg-bg-hover',
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
