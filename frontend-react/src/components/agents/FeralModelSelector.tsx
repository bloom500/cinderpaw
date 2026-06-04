import { useEffect, useState } from 'react';
import { ChevronDown, Cloud, Cpu, Loader2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useFeralStore } from '@/stores/feral';
import { tauri, type ByokProvider } from '@/lib/tauri';

const OLLAMA_BASE_URL = 'http://localhost:11434';

export function FeralModelSelector() {
  const modelConfig = useFeralStore((s) => s.modelConfig);
  const switching   = useFeralStore((s) => s.switching);
  const setModel    = useFeralStore((s) => s.setModel);

  const [ollamaModels, setOllamaModels]       = useState<string[]>([]);
  const [cloudProviders, setCloudProviders]   = useState<ByokProvider[]>([]);
  const [open, setOpen]                       = useState(false);

  useEffect(() => {
    if (!open) return;
    // Fetch available Ollama models and enabled BYOK providers when the menu opens.
    void tauri.raw.listOllamaModels(OLLAMA_BASE_URL)
      .then(setOllamaModels)
      .catch(() => setOllamaModels([]));
    void tauri.raw.getByokSettings()
      .then((ps) => setCloudProviders(ps.filter((p) => p.enabled && p.has_api_key && !!p.default_model)))
      .catch(() => setCloudProviders([]));
  }, [open]);

  const label = switching
    ? 'Switching…'
    : modelConfig?.display_name ?? 'Select model';

  const hasOllama = ollamaModels.length > 0;
  const hasCloud  = cloudProviders.length > 0;

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 h-6 px-2 rounded text-xs font-medium
                     text-text-secondary bg-bg-secondary hover:bg-bg-hover
                     transition-colors outline-none border border-border-subtle
                     disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={switching}
        >
          {switching
            ? <Loader2 size={11} className="animate-spin shrink-0" />
            : <Cpu size={11} className="shrink-0 text-text-muted" />
          }
          <span className="truncate max-w-[180px]">{label}</span>
          <ChevronDown size={10} className="shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        {hasOllama && (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-text-muted">
              <Cpu size={11} /> Ollama (local)
            </DropdownMenuLabel>
            {ollamaModels.map((m) => (
              <DropdownMenuItem
                key={m}
                onClick={() =>
                  void setModel({ source: 'ollama', model: m, baseUrl: OLLAMA_BASE_URL })
                }
                className="flex items-center gap-2"
              >
                <span className="text-text-primary">{m}</span>
                {modelConfig?.model === m && modelConfig.provider === 'ollama' && (
                  <span className="ml-auto text-xs text-brand">active</span>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {hasCloud && (
          <>
            {hasOllama && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-text-muted">
              <Cloud size={11} /> Cloud (BYOK)
            </DropdownMenuLabel>
            {cloudProviders.map((p) => {
              const modelId = p.default_model ?? '';
              const isActive =
                modelConfig?.model === modelId && modelConfig.provider === p.id;
              return (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() =>
                    void setModel({ source: 'byok', providerId: p.id, model: modelId })
                  }
                  className="flex flex-col items-start gap-0.5"
                >
                  <div className="flex w-full items-center">
                    <span className="text-text-primary">{p.name}</span>
                    {isActive && (
                      <span className="ml-auto text-xs text-brand">active</span>
                    )}
                  </div>
                  <span className="text-xs text-text-muted">{modelId}</span>
                </DropdownMenuItem>
              );
            })}
          </>
        )}

        {!hasOllama && !hasCloud && (
          <DropdownMenuItem disabled className="text-text-muted text-xs">
            No models found — start Ollama or add a cloud key in Settings
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
