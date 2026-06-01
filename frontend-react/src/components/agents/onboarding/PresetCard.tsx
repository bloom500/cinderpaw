import type { AgentConfig } from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { TOOL_LABELS, PRESET_DESCRIPTIONS } from '../agentUtils';

interface Props {
  preset: AgentConfig | 'scratch';
  selected: boolean;
  onSelect: () => void;
}

export function PresetCard({ preset, selected, onSelect }: Props) {
  const isScratch = preset === 'scratch';
  const name = isScratch ? 'Start from scratch' : preset.name;
  const description = isScratch
    ? 'Build a custom agent with no pre-configured tools.'
    : (PRESET_DESCRIPTIONS[preset.name] ?? 'A pre-configured agent template.');
  const tools: string[] = isScratch ? [] : preset.tools;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full text-left rounded-lg border p-4 transition-colors space-y-2',
        selected
          ? 'border-brand bg-brand/5'
          : 'border-border-subtle bg-bg-surface hover:bg-bg-hover',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-text-primary">{name}</span>
        {selected && (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-brand text-white shrink-0">
            Selected
          </span>
        )}
      </div>
      <p className="text-xs text-text-muted">{description}</p>
      {tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tools.map((t) => (
            <span
              key={t}
              className="text-[11px] px-2 py-0.5 rounded-full bg-bg-hover text-text-muted border border-border-subtle"
            >
              {TOOL_LABELS[t]?.label ?? t}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
