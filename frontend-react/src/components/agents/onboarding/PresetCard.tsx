import type { AgentConfig } from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { TOOL_LABELS, PRESET_DESCRIPTIONS } from '../agentUtils';

/** Friendly avatar per preset — falls back to the generic robot. */
const PRESET_EMOJI: Record<string, string> = {
  'Research Assistant': '🔎',
  'Code Helper':        '💻',
  'File Organizer':     '🗂️',
  'Web Scraper':        '🌐',
};

interface Props {
  preset: AgentConfig | 'scratch';
  selected: boolean;
  onSelect: () => void;
}

export function PresetCard({ preset, selected, onSelect }: Props) {
  const isScratch = preset === 'scratch';
  const name = isScratch ? 'Start from scratch' : preset.name;
  const emoji = isScratch ? '✨' : (PRESET_EMOJI[preset.name] ?? '🤖');
  const description = isScratch
    ? 'Build your own helper — a blank canvas, no pre-picked tools.'
    : (PRESET_DESCRIPTIONS[preset.name] ?? 'A pre-configured agent template.');
  const tools: string[] = isScratch ? [] : preset.tools;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'w-full text-left rounded-xl border p-4 transition-all',
        selected
          ? 'border-brand bg-brand/5 ring-1 ring-brand/40'
          : 'border-border-subtle bg-bg-surface hover:bg-bg-hover hover:border-brand/30',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none mt-0.5" aria-hidden="true">{emoji}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-text-primary">{name}</span>
            {selected && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-brand text-white shrink-0">
                ✓ Selected
              </span>
            )}
          </div>
          <p className="text-xs text-text-muted leading-relaxed">{description}</p>
          {tools.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
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
        </div>
      </div>
    </button>
  );
}
