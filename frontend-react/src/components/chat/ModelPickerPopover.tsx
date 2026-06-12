import { useEffect, useState } from 'react';
import { ChevronDown, Cloud, HardDrive } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useModel } from '@/stores/model';
import { useUI } from '@/stores/ui';
import { useFeralStore } from '@/stores/feral';
import { tauri, type ModelInfo, type ByokProvider } from '@/lib/tauri';

// Feral's own model engine exposes an OpenAI-compatible API here. In agent mode
// a local pick must target THIS (not external Ollama on 11434) so the agent uses
// the model loaded in the Models tab.
const FERAL_API_BASE = 'http://localhost:11435';
const LOCAL_PROVIDER_ID = 'feral-local';

function formatBytes(n: number): string {
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n > 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

export function ModelPickerPopover() {
  const loaded        = useModel((s) => s.loaded);
  const isLoading     = useModel((s) => s.isLoading);
  const progress      = useModel((s) => s.loadProgress);
  const load          = useModel((s) => s.load);
  const cloudModel    = useModel((s) => s.cloudModel);
  const setCloudModel = useModel((s) => s.setCloudModel);

  // Agent mode targets the Feral sidecar (its own model config), not the
  // in-process chat model. The pill stays visually identical; only the
  // selection action + label source change.
  const isAgentMode   = useUI((s) => s.inputMode) === 'agent';
  const feralConfig   = useFeralStore((s) => s.modelConfig);
  const feralSwitching = useFeralStore((s) => s.switching);
  const feralSetModel = useFeralStore((s) => s.setModel);
  const feralSetError = useFeralStore((s) => s.setModelError);

  const [localModels, setLocalModels]     = useState<ModelInfo[]>([]);
  const [cloudProviders, setCloudProviders] = useState<ByokProvider[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    void tauri.models.list().then(setLocalModels).catch(() => {});
    void tauri.raw.getByokSettings()
      .then((providers) => setCloudProviders(providers.filter((p) => p.enabled && p.has_api_key)))
      .catch(() => {});
  }, [open]);

  // In agent mode, selecting a local model must LOAD it into Feral's engine
  // (so /v1/chat/completions has it resident) then point the sidecar at it.
  // Goes through the model store's load() so isLoading/loadProgress are
  // populated — the ModelPill renders a progress bar off those.
  const selectLocalAgent = async (m: ModelInfo) => {
    feralSetError(null);
    try {
      await load(m.path);
      await feralSetModel({
        source: 'openai_compatible',
        model: m.name,
        baseUrl: FERAL_API_BASE,
        providerId: LOCAL_PROVIDER_ID,
      });
    } catch (err) {
      feralSetError(String(err));
    }
  };

  let label: string;
  if (isAgentMode) {
    label = feralSwitching
      ? 'Switching…'
      : isLoading
        ? `Loading ${progress?.percentage.toFixed(0) ?? 0}%`
        : feralConfig?.display_name ?? loaded?.name ?? 'No model selected';
  } else if (isLoading) {
    label = `Loading ${progress?.percentage.toFixed(0) ?? 0}%`;
  } else if (cloudModel) {
    label = `${cloudModel.modelId} · ${cloudModel.providerName}`;
  } else {
    label = loaded?.name ?? 'No model selected';
  }

  const hasLocal = localModels.length > 0;
  const hasCloud = cloudProviders.length > 0;

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 h-full px-4 text-sm font-medium text-text-primary hover:text-text-primary/70 transition-colors outline-none">
          <span className="truncate max-w-[200px]">{label}</span>
          <ChevronDown size={12} className="shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {hasLocal && (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-text-muted">
              <HardDrive size={11} /> Local
            </DropdownMenuLabel>
            {localModels.map((m) => (
              <DropdownMenuItem
                key={m.path}
                onClick={() =>
                  isAgentMode
                    ? void selectLocalAgent(m)
                    : (setCloudModel(null), void load(m.path))
                }
                className="flex flex-col items-start gap-0.5"
              >
                <span className="text-text-primary">{m.name}</span>
                <span className="text-xs text-text-muted">{formatBytes(m.size_bytes)}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {hasCloud && (
          <>
            {hasLocal && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-text-muted">
              <Cloud size={11} /> Cloud
            </DropdownMenuLabel>
            {cloudProviders.map((p) => {
              const modelId = p.default_model ?? '';
              return (
                <DropdownMenuItem
                  key={p.id}
                  disabled={!modelId}
                  onClick={() => {
                    if (!modelId) return;
                    if (isAgentMode) {
                      feralSetError(null);
                      void feralSetModel({ source: 'byok', providerId: p.id, model: modelId });
                    } else {
                      setCloudModel({ providerId: p.id, providerName: p.name, modelId });
                    }
                  }}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="text-text-primary">{p.name}</span>
                  <span className="text-xs text-text-muted">
                    {modelId || 'Set a default model in Settings → Cloud Keys'}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </>
        )}
        {!hasLocal && !hasCloud && (
          <DropdownMenuItem disabled>
            No models found — download one or add a cloud key
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
