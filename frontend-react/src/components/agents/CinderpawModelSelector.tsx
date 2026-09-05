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
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useNotifications } from '@/stores/notifications';
import { tauri, type ByokProvider, type ModelInfo } from '@/lib/tauri';

// Cinderpaw's own model engine exposes an Ollama/OpenAI-compatible API here. The
// agent must target THIS (not external Ollama on 11434) so it uses the model
// loaded in the Models tab. We route local models through the OpenAI-compatible
// path (/v1/chat/completions) — Cinderpaw's /api/chat emits SSE, which the agent's
// `ollama` provider (expecting NDJSON) cannot parse.
const CINDERPAW_API_BASE = 'http://localhost:11435';
// Sentinel provider id — the backend ignores it for the openai_compatible
// source (it keys off baseUrl), but the CinderpawModelSelection type requires one.
const LOCAL_PROVIDER_ID = 'cinderpaw-local';

export function CinderpawModelSelector() {
  const modelConfig   = useCinderpawStore((s) => s.modelConfig);
  const switching     = useCinderpawStore((s) => s.switching);
  const setModel      = useCinderpawStore((s) => s.setModel);
  const setModelError = useCinderpawStore((s) => s.setModelError);

  const [localModels, setLocalModels]         = useState<ModelInfo[]>([]);
  const [cloudProviders, setCloudProviders]   = useState<ByokProvider[]>([]);
  const [loadingModel, setLoadingModel]       = useState<string | null>(null);
  const [open, setOpen]                       = useState(false);

  useEffect(() => {
    if (!open) return;
    // List Cinderpaw's local GGUF models (with paths so we can load on select) and
    // enabled BYOK providers.
      // Embedding models are on disk but cannot hold a conversation, and
      // `bge-m3` sorts before every chat model on a normal install, so it was
      // the first row here and menus focus their first row on open. Opening the
      // picker looked like it had chosen the one model that can only ever
      // return vectors. `is_embedding` exists on ModelInfo for exactly this;
      // the Models tab and the download panel deliberately do not filter,
      // because deleting a file you cannot see is worse.
    void tauri.models.list()
      .then((all) => setLocalModels(all.filter((m) => !m.is_embedding)))
      .catch(() => setLocalModels([]));
    void tauri.raw.getByokSettings()
      .then((ps) => setCloudProviders(ps.filter((p) => p.enabled && p.has_api_key && !!p.default_model)))
      .catch(() => setCloudProviders([]));
  }, [open]);

  // Selecting a local model must also LOAD it into Cinderpaw's engine — otherwise
  // /v1/chat/completions has nothing in memory and returns an empty completion.
  // Load first (blocks until the model is resident), then point the agent at it.
  const selectLocal = async (m: ModelInfo) => {
    setLoadingModel(m.path);
    setModelError(null);
    try {
      await tauri.models.startLoad(m.path);
      await setModel({
        source: 'openai_compatible',
        model: m.name,
        baseUrl: CINDERPAW_API_BASE,
        providerId: LOCAL_PROVIDER_ID,
      });
    } catch (err) {
      setModelError(String(err));
      useNotifications.getState().push('error', 'Could not switch model', String(err));
      // The engine unloads the current model before it tries to load the new
      // one, so a failure here leaves NOTHING resident — while the picker still
      // shows the previous model as active. The next message then goes to an
      // engine with no model and comes back empty, and the screen says the
      // model is loaded. Ask what is actually live and show that.
      try {
        const live = await tauri.models.loaded();
        if (!live) {
          useNotifications.getState().push(
            'error',
            'No model is loaded',
            'The previous model was unloaded before the new one failed. Pick a model to load.',
          );
        }
      } catch { /* status unavailable — the error above is what matters */ }
    } finally {
      setLoadingModel(null);
    }
  };

  // Cloud selection failures (sidecar offline, provider disabled, missing
  // key…) previously vanished into a discarded promise — the picker closed
  // and nothing happened, with no explanation. Surface them.
  const selectCloud = async (providerId: string, modelId: string) => {
    setModelError(null);
    try {
      await setModel({ source: 'byok', providerId, model: modelId });
    } catch (err) {
      setModelError(String(err));
      useNotifications.getState().push('error', 'Could not switch model', String(err));
    }
  };

  const busy = switching || loadingModel !== null;
  const label = loadingModel !== null
    ? 'Loading model…'
    : switching
      ? 'Switching…'
      : modelConfig?.display_name ?? 'Select model';

  const hasLocal = localModels.length > 0;
  const hasCloud = cloudProviders.length > 0;

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 h-6 px-2 rounded text-xs font-medium
                     text-text-secondary bg-bg-surface hover:bg-bg-hover
                     transition-colors outline-none border border-border-subtle
                     disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={busy}
        >
          {busy
            ? <Loader2 size={11} className="animate-spin shrink-0" />
            : <Cpu size={11} className="shrink-0 text-text-muted" />
          }
          <span className="truncate max-w-[180px]">{label}</span>
          <ChevronDown size={10} className="shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        {hasLocal && (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-text-muted">
              <Cpu size={11} /> Local (Cinderpaw)
            </DropdownMenuLabel>
            {localModels.map((m) => {
              const isActive =
                modelConfig?.model === m.name && modelConfig.provider === 'openai_compatible';
              const isLoading = loadingModel === m.path;
              return (
                <DropdownMenuItem
                  key={m.id}
                  disabled={busy}
                  onSelect={(e) => { e.preventDefault(); void selectLocal(m); }}
                  className="flex items-center gap-2"
                >
                  <span className="text-text-primary truncate">{m.name}</span>
                  {isLoading
                    ? <Loader2 size={11} className="ml-auto animate-spin text-brand shrink-0" />
                    : isActive && <span className="ml-auto text-xs text-brand">active</span>}
                </DropdownMenuItem>
              );
            })}
          </>
        )}

        {hasCloud && (
          <>
            {hasLocal && <DropdownMenuSeparator />}
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
                  onClick={() => void selectCloud(p.id, modelId)}
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

        {!hasLocal && !hasCloud && (
          <DropdownMenuItem disabled className="text-text-muted text-xs">
            No models found. Load a model in the Models tab or add a cloud key in Settings
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
