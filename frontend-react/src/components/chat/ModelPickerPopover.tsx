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
import { tauri, type ModelInfo, type ByokProvider } from '@/lib/tauri';

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

  let label: string;
  if (isLoading) {
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
        <button className="flex items-center gap-1.5 h-full px-3 text-xs text-text-secondary hover:text-text-primary transition-colors outline-none">
          <span className="truncate max-w-[180px]">{label}</span>
          <ChevronDown size={11} className="shrink-0 opacity-60" />
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
                onClick={() => { setCloudModel(null); void load(m.path); }}
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
                    setCloudModel({ providerId: p.id, providerName: p.name, modelId });
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
