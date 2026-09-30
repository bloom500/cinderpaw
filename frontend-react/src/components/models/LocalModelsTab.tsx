import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Database, Gauge, Plus, RefreshCw, Sparkles, WandSparkles } from 'lucide-react';
import { signInWithOpenRouter } from '@/lib/openrouterSignIn';
import { Button } from '@/components/ui/button';
import { LocalModelCard } from './LocalModelCard';
import { SystemBar } from './SystemBar';
import { BTN_ICON, BTN_OUTLINE, BTN_PRIMARY, CARD, MakerTile, Pill, SERIF, SectionHeader, Status, makerFor, prettyModelName } from './ui';
import { tauri, type ModelInfo } from '@/lib/tauri';
import { useModel } from '@/stores/model';
import { useDownload } from '@/stores/download';
import { useSystemInfo } from '@/stores/systemInfo';
import { scoreFit } from '@/lib/fitScore';
import { recommendModel } from '@/lib/hardwareRecommendation';
import { sizeGb } from '@/lib/modelUtils';
import { cn } from '@/lib/utils';

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

  if (isLoading && models.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-text-muted">
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
      <div className={cn(CARD, 'flex flex-col items-center gap-4 px-6 py-12 text-text-muted')}>
        <p className="text-center text-lg text-text-primary" style={{ fontFamily: SERIF }}>
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
    <div className="space-y-6">
      <SectionHeader title="Local Models" subtitle="Run private models on your own machine. Everything stays on your device.">
        <Pill tone="success" dot>Auto-detected</Pill>
        <button type="button" onClick={() => void refresh()} className={BTN_ICON} aria-label="Scan for models again" title="Scan for models again">
          <RefreshCw size={16} className={cn(isLoading && 'animate-spin')} />
        </button>
        <span aria-hidden className="mx-1 h-6 w-px bg-border-subtle" />
        <span className="text-xs text-text-muted">Runtime</span>
        <RuntimeChip />
      </SectionHeader>

      <SystemBar />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-xl font-semibold text-text-primary" style={{ fontFamily: SERIF }}>Installed on this device</h3>
              <p className="text-sm text-text-secondary">Run a model, stop it, or open it for the details.</p>
            </div>
            <button type="button" onClick={onBrowse} className={BTN_PRIMARY}>
              <Plus size={16} /> Add model
            </button>
          </div>

          {chatModels.map((m) => (
            <LocalModelCard key={m.path as unknown as string} model={m} onDelete={handleDelete} />
          ))}

          {memoryModels.length > 0 && (
            <div className="pt-3">
              <h4 className="text-sm font-semibold text-text-primary">Memory model</h4>
              <p className="mb-3 text-xs text-text-muted">Cinderpaw uses it to search what it remembers. It cannot chat.</p>
              <div className="space-y-3">
                {memoryModels.map((m) => (
                  <LocalModelCard key={m.path as unknown as string} model={m} onDelete={handleDelete} />
                ))}
              </div>
            </div>
          )}
        </section>

        <aside className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
          <ActiveModelCard models={models} />
          <RecommendationCard onBrowse={onBrowse} />
          <StorageCard models={models} />
        </aside>
      </div>
    </div>
  );
}

/** Which engine runs local models here. There is one, built in; the chip only
 *  says whether it has the GPU. */
function RuntimeChip() {
  const info = useSystemInfo((s) => s.info);
  return (
    <span className="inline-flex h-9 items-center gap-2 rounded-xl border border-border-subtle bg-bg-surface px-3 text-sm text-text-primary shadow-sm">
      <Gauge size={16} className="text-text-muted" />
      llama.cpp{info ? (info.supports_vulkan ? ' · Vulkan' : ' · CPU') : ''}
    </span>
  );
}

function SideCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className={cn(CARD, 'p-4')}>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
        <span className="text-brand">{icon}</span>{title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="text-text-muted">{label}</span>
      <span className="truncate text-right font-medium text-text-primary" title={value}>{value}</span>
    </div>
  );
}

function ActiveModelCard({ models }: { models: ModelInfo[] }) {
  const loaded = useModel((s) => s.loaded);
  const unload = useModel((s) => s.unload);
  const info = useSystemInfo((s) => s.info);

  if (!loaded) {
    return (
      <SideCard icon={<Sparkles size={16} />} title="Currently active model">
        <Status tone="neutral">Nothing running</Status>
        <p className="mt-1.5 text-xs text-text-muted">Press Run on a model to load it. Chats use it until you stop it.</p>
      </SideCard>
    );
  }

  const file = models.find((m) => (m.path as unknown as string) === loaded.path);
  const fit = file && info ? scoreFit(file.size_bytes, file.quant, loaded.ctx_len, info) : null;
  const name = prettyModelName(loaded.name);
  return (
    <SideCard icon={<Sparkles size={16} />} title="Currently active model">
      <div className="flex items-center gap-3">
        <MakerTile maker={makerFor(loaded.name)} fallback={name} className="size-10 rounded-xl" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary" style={{ fontFamily: SERIF }} title={loaded.name}>{name}</p>
          <Status tone="success">Running</Status>
        </div>
      </div>
      <div className="mt-3 border-t border-border-subtle pt-2">
        {fit?.estimatedTokPerSec != null && <Row label="Speed (estimate)" value={`~${fit.estimatedTokPerSec} tokens/sec`} />}
        <Row label="Context length" value={`${loaded.ctx_len.toLocaleString()} tokens`} />
        <Row label="Runs on" value={loaded.backend} />
      </div>
      <button type="button" onClick={() => void unload()} className={cn(BTN_OUTLINE, 'mt-3 h-8 w-full text-xs')}>Stop</button>
    </SideCard>
  );
}

function RecommendationCard({ onBrowse }: { onBrowse: () => void }) {
  const info = useSystemInfo((s) => s.info);
  const rec = recommendModel(info);
  if (!rec) return null;
  return (
    <SideCard icon={<WandSparkles size={16} />} title="Recommended for your hardware">
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold text-text-primary" style={{ fontFamily: SERIF }}>{rec.sizeClass}</span>
        <span className="text-xs text-text-muted">models · {rec.quant} · {rec.approxFileSize}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-text-secondary">{rec.rationale}</p>
      <button type="button" onClick={onBrowse} className="mt-3 text-xs font-medium text-brand hover:underline">
        Find one on Hugging Face →
      </button>
    </SideCard>
  );
}

/** How much disk the models take, split by model so the big one stands out. */
function StorageCard({ models }: { models: ModelInfo[] }) {
  const total = models.reduce((sum, m) => sum + m.size_bytes, 0);
  if (total === 0) return null;
  const sorted = [...models].sort((a, b) => b.size_bytes - a.size_bytes);
  const shades = ['bg-brand', 'bg-brand/70', 'bg-brand/45', 'bg-brand/25', 'bg-text-muted/40'];
  return (
    <SideCard icon={<Database size={16} />} title="Storage">
      <p className="text-xs text-text-secondary">
        {models.length} {models.length === 1 ? 'model takes' : 'models take'} up <span className="font-semibold text-text-primary">{sizeGb(total)}</span> on this device.
      </p>
      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-bg-elevated" aria-hidden>
        {sorted.map((m, i) => (
          <div key={m.path as unknown as string} className={cn('h-full', shades[Math.min(i, shades.length - 1)])} style={{ width: `${(m.size_bytes / total) * 100}%` }} />
        ))}
      </div>
      <ul className="mt-3 space-y-1">
        {sorted.map((m, i) => (
          <li key={m.path as unknown as string} className="flex items-center gap-2 text-xs">
            <span aria-hidden className={cn('size-2 shrink-0 rounded-full', shades[Math.min(i, shades.length - 1)])} />
            <span className="min-w-0 flex-1 truncate text-text-secondary">{prettyModelName(m.name)}</span>
            <span className="tabular-nums text-text-muted">{sizeGb(m.size_bytes)}</span>
          </li>
        ))}
      </ul>
    </SideCard>
  );
}
