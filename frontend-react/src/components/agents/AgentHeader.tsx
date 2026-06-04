import { useNavigate } from 'react-router-dom';
import { Settings, Bot } from 'lucide-react';
import { useAgent } from '@/stores/agent';
import { FeralModelSelector } from './FeralModelSelector';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

export function AgentHeader() {
  const navigate = useNavigate();
  const current  = useAgent((s) => s.current);

  return (
    <div className="h-11 px-3 flex items-center gap-3 shrink-0 select-none">
      {/* Feral model selector replaces the local llama.cpp ModelPill —
          the Feral Agent uses Ollama/cloud inference, not GGUF files. */}
      <FeralModelSelector />

      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <Bot size={13} className="text-text-muted shrink-0" />
        <span
          data-tauri-drag-region
          className="text-sm text-text-secondary truncate cursor-move"
        >
          {current?.name ?? 'Agent'}
        </span>
      </div>

      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => navigate('/settings?cat=agent')}
              aria-label="Manage agents"
              className="p-1.5 rounded text-text-muted hover:bg-bg-hover hover:text-text-secondary transition-colors"
            >
              <Settings size={13} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Manage agent</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
