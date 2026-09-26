import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithOpenRouter } from '@/lib/openrouterSignIn';
import { Button } from '@/components/ui/button';
import { LocalModelCard } from './LocalModelCard';
import { tauri, type ModelInfo } from '@/lib/tauri';
import { useModel } from '@/stores/model';
import { useDownload } from '@/stores/download';

interface Props { onBrowse: () => void }

export function LocalModelsTab({ onBrowse }: Props) {
  const [models, setModels]     = useState<ModelInfo[]>([]);
  const [error, setError]       = useState<string | null>(null);
  const [isLoading, setLoading] = useState(true);
  const loaded   = useModel((s) => s.loaded);
  const doneFlag = useDownload((s) => s.done);
  const navigate = useNavigate();

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await tauri.models.list();
      setModels(list ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
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

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted text-sm">
        Scanning for models...
      </div>
    );
  }

  // The memory model downloads by itself on a fresh install, so "no models"
  // has to mean no model that can CHAT. Counted on all files, the list was
  // never empty: a new person saw one card they could not talk to, with a
  // Delete button, and never saw the two ways forward below.
  const chatModels = models.filter((m) => !m.is_embedding);
  const memoryModels = models.filter((m) => m.is_embedding);
  if (chatModels.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-text-muted px-6 gap-4">
        <p className="text-center">
          No chat models on this computer yet.
        </p>
        <div className="flex flex-wrap gap-2 justify-center">
          <Button variant="default" onClick={onBrowse}>Browse HuggingFace →</Button>
          {/* navigate(), not location.hash: the app runs on a memory router,
              so setting the hash changed nothing and this button was dead. */}
          <Button variant="outline" onClick={() => void signInWithOpenRouter()}>Sign in with OpenRouter</Button>
          <Button variant="ghost" onClick={() => navigate('/models?tab=cloud')}>Use a cloud key →</Button>
        </div>
        <p className="text-2xs text-text-disabled text-center max-w-sm">
          Local needs download (1–16GB) · Cloud is instant with an API key
        </p>
        {memoryModels.length > 0 && (
          <p className="text-2xs text-text-muted text-center max-w-sm">
            Already here: the memory model Cinderpaw uses to search what it remembers. It cannot chat.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-4
      [&::-webkit-scrollbar]:w-[3px]
      [&::-webkit-scrollbar-track]:bg-transparent
      [&::-webkit-scrollbar-thumb]:bg-white/10
      [&::-webkit-scrollbar-thumb]:rounded-full
      hover:[&::-webkit-scrollbar-thumb]:bg-white/20"
    >
      <div className="px-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-w-5xl">
        {[...chatModels, ...memoryModels].map((m) => (
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
