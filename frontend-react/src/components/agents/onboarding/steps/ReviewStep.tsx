import { AlertCircle } from 'lucide-react';
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
  const templateLabel = isScratch ? 'Custom' : (preset as AgentConfig).name;

  return (
    <div className="space-y-6 text-center">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-text-primary tracking-tight">Looks good?</h2>
        <p className="text-sm text-text-muted">Review before saving.</p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-surface p-4 space-y-3 text-left">
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-muted">Name</span>
          <span className="text-sm font-medium text-text-primary">{name}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-muted">Template</span>
          <span className="text-sm text-text-primary">{templateLabel}</span>
        </div>
        {tools.length > 0 && (
          <div className="flex items-start justify-between gap-4">
            <span className="text-xs text-text-muted shrink-0">Tools</span>
            <div className="space-y-0.5 text-right">
              {tools.map((t) => (
                <div key={t} className="text-xs text-text-secondary">
                  {TOOL_LABELS[t]?.label ?? t}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {saveError && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
          <AlertCircle size={13} className="text-red-400 shrink-0 mt-0.5" />
          <p className="text-sm text-red-400">Couldn't save your agent — please try again.</p>
        </div>
      )}
    </div>
  );
}
