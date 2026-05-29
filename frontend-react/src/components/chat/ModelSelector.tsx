import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useModel } from '@/stores/model';
import { tauri, type ModelInfo } from '@/lib/tauri';

function formatBytes(n: number): string {
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n > 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

export function ModelSelector() {
  const loaded = useModel((s) => s.loaded);
  const isLoading = useModel((s) => s.isLoading);
  const progress = useModel((s) => s.loadProgress);
  const load = useModel((s) => s.load);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    void tauri.models.list().then(setModels).catch(() => {});
  }, [open]);

  const label = isLoading
    ? `Loading ${progress?.percentage.toFixed(0) ?? 0}%`
    : loaded?.name ?? 'No model';

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="text-text-secondary h-7 px-2 text-xs">
          {label}
          <ChevronDown size={12} className="ml-1" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {models.length === 0 && (
          <DropdownMenuItem disabled>No models found</DropdownMenuItem>
        )}
        {models.map((m) => (
          <DropdownMenuItem
            key={m.path as unknown as string}
            onClick={() => void load(m.path as unknown as string)}
            className="flex flex-col items-start gap-0.5"
          >
            <span className="text-text-primary">{m.name}</span>
            <span className="text-xs text-text-muted">{formatBytes(m.size_bytes)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
