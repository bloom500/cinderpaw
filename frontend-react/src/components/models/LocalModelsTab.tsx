import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { LocalModelCard } from './LocalModelCard';
import { tauri, type ModelInfo } from '@/lib/tauri';
import { useModel } from '@/stores/model';
import { useDownload } from '@/stores/download';

interface Props { onBrowse: () => void }

export function LocalModelsTab({ onBrowse }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [error, setError]   = useState<string | null>(null);
  const loaded   = useModel((s) => s.loaded);
  const doneFlag = useDownload((s) => s.done);

  const refresh = async () => {
    try {
      const list = await tauri.models.list();
      setModels(list);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => { void refresh(); }, []);

  // Re-fetch when a download completes
  useEffect(() => { if (doneFlag) void refresh(); }, [doneFlag]);

  const handleDelete = async (path: string) => {
    // Unload first if currently loaded — prevents Windows file-lock
    if (loaded?.path === path) {
      await tauri.models.unload();
    }
    await tauri.models.delete(path);
    await refresh();
  };

  if (error) {
    return <div className="p-4 text-error text-sm">{error}</div>;
  }

  if (models.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-muted px-6 gap-4">
        <p className="text-center">
          No models installed yet.<br />
          Switch to Browse HuggingFace to download your first model.
        </p>
        <Button variant="outline" onClick={onBrowse}>Browse HuggingFace →</Button>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {models.map((m) => (
          <LocalModelCard
            key={m.path as unknown as string}
            model={m}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  );
}
