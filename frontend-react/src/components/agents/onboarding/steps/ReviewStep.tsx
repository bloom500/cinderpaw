import { AlertCircle, Info } from 'lucide-react';
import type { AgentConfig } from '@/lib/tauri';
import { TOOL_LABELS } from '../../agentUtils';

interface Props {
  name: string;
  preset: AgentConfig | 'scratch' | null;
  saveError: string | null;
}

export function ReviewStep({ name, preset, saveError }: Props) {
  const isScratch = !preset || preset === 'scratch';
  const tools: string[] = isScratch ? [] : (preset as AgentConfig).tools;
  const templateLabel = isScratch ? 'Custom (no template)' : (preset as AgentConfig).name;

  return (
    <div className="max-w-md mx-auto space-y-5 pt-2">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold text-text-primary">Here's what your agent will look like</h2>
        <p className="text-xs text-text-muted">Review before saving. Editing will be available in a future update.</p>
      </div>

      <div className="rounded-lg border border-border-subtle bg-bg-surface p-4 space-y-3">
        {/* Name */}
        <div className="flex items-start justify-between gap-4">
          <span className="text-xs text-text-muted">Name</span>
          <span className="text-sm font-medium text-text-primary text-right">{name}</span>
        </div>

        {/* Template */}
        <div className="flex items-start justify-between gap-4">
          <span className="text-xs text-text-muted">Template</span>
          <span className="text-sm text-text-primary text-right">{templateLabel}</span>
        </div>

        {/* Tools */}
        <div className="flex items-start justify-between gap-4">
          <span className="text-xs text-text-muted shrink-0">Tools</span>
          {tools.length > 0 ? (
            <div className="space-y-1 text-right">
              {tools.map((t) => (
                <div key={t} className="text-xs text-text-secondary">
                  <span className="font-medium">{TOOL_LABELS[t]?.label ?? t}</span>
                  {TOOL_LABELS[t] && (
                    <span className="text-text-muted ml-1">— {TOOL_LABELS[t].description}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <span className="text-sm text-text-muted">None (tool configuration coming soon)</span>
          )}
        </div>
      </div>

      {/* Model note */}
      <div className="flex items-start gap-2 rounded-md bg-bg-hover p-3">
        <Info size={13} className="text-text-muted shrink-0 mt-0.5" />
        <p className="text-xs text-text-muted leading-relaxed">
          You'll need a local model loaded before running this agent.
          Head to the <span className="text-text-secondary font-medium">Models</span> tab to load one.
        </p>
      </div>

      {/* Save error */}
      {saveError && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3">
          <AlertCircle size={13} className="text-red-400 shrink-0 mt-0.5" />
          <p className="text-sm text-red-400">Couldn't save your agent — please try again.</p>
        </div>
      )}
    </div>
  );
}
