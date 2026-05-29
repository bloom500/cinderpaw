import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Markdown } from '@/lib/markdown';
import { StreamingIndicator } from '@/components/chat/StreamingIndicator';
import { useModel } from '@/stores/model';
import { useDownload } from '@/stores/download';
import { useSystemInfo } from '@/stores/systemInfo';
import { tauri, type HfModelDetail, type HfFile } from '@/lib/tauri';
import {
  quantToBadge, sizeGb, pickFittedFile, stripFrontmatter, type QuantVariant,
} from '@/lib/modelUtils';

const badgeClass: Record<QuantVariant, string> = {
  full:     'text-text-secondary bg-bg-elevated',
  high:     'text-success',
  balanced: 'text-brand',
  small:    'text-text-muted',
  tiny:     'text-text-disabled',
};

interface Props {
  repoId: string;
  detail: HfModelDetail;
  loading: boolean;
}

export function HfDetailPanel({ repoId, detail, loading }: Props) {
  const navigate     = useNavigate();
  const sysInfo      = useSystemInfo((s) => s.info);
  const isLoading    = useModel((s) => s.isLoading);
  const loadProgress = useModel((s) => s.loadProgress);
  const modelLoad    = useModel((s) => s.load);
  const download     = useDownload();

  const recommended = pickFittedFile(detail.gguf_files, sysInfo);
  const [selected, setSelected] = useState<HfFile | null>(recommended ?? detail.gguf_files[0] ?? null);
  const [fileSizes, setFileSizes] = useState<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    detail.gguf_files.forEach((f) => { if (f.size) m[f.rfilename] = f.size; });
    return m;
  });
  const [localModelPath, setLocalModelPath] = useState<string | null>(null);

  // Fetch missing file sizes via HEAD request
  useEffect(() => {
    detail.gguf_files
      .filter((f) => !f.size)
      .forEach((f) => {
        void tauri.hf.modelSizeInfo(repoId, f.rfilename).then((bytes) => {
          if (bytes > 0) setFileSizes((prev) => ({ ...prev, [f.rfilename]: bytes }));
        }).catch(() => {});
      });
  }, [repoId, detail.gguf_files]);

  useEffect(() => {
    if (!selected) { setLocalModelPath(null); return; }
    void tauri.models.list().then((list) => {
      const match = list.find((m) => m.name === selected.rfilename);
      setLocalModelPath(match ? (match.path as unknown as string) : null);
    }).catch(() => {});
  }, [selected]);

  if (loading) {
    return <div className="flex justify-center py-6"><StreamingIndicator /></div>;
  }

  const isDownloading = download.active?.repoId === repoId;
  const isThisDone    = download.done && localModelPath !== null;

  const handleInstall = async () => {
    if (!selected) return;
    await useDownload.getState().start(repoId, selected.rfilename);
  };

  const handleLoad = async () => {
    if (!localModelPath) return;
    await modelLoad(localModelPath);
    navigate('/chat');
  };

  return (
    <div className="space-y-4 pt-4">
      {/* File list */}
      <div className="space-y-1">
        <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">Download Options</p>
        {detail.gguf_files.map((f) => {
          const isSelected    = selected?.rfilename === f.rfilename;
          const isRecommended = recommended?.rfilename === f.rfilename;
          const size          = fileSizes[f.rfilename];
          const { label, variant } = quantToBadge(f.rfilename);

          return (
            <button
              key={f.rfilename}
              type="button"
              onClick={() => setSelected(f)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm text-left transition-colors
                ${isSelected ? 'bg-bg-active border border-brand' : 'bg-bg-elevated border border-transparent hover:bg-bg-hover'}`}
            >
              <span className={`w-3 h-3 rounded-full border-2 shrink-0 ${isSelected ? 'border-brand bg-brand' : 'border-border-default'}`} />
              <span className="flex-1 text-text-primary font-mono text-xs truncate">{f.rfilename}</span>
              <span className="text-text-muted text-xs shrink-0">
                {size ? sizeGb(size) : '…'}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${badgeClass[variant]}`}>
                {label}
              </span>
              {isRecommended && (
                <span className="flex items-center gap-1 text-[10px] text-brand shrink-0">
                  <Star size={10} fill="currentColor" /> Recommended
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Action area */}
      <div>
        {isDownloading ? (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-text-muted">
              <span>Downloading {download.active?.filename}</span>
              <span>{((download.active?.progress ?? 0) * 100).toFixed(0)}%</span>
            </div>
            <div className="h-2 rounded-full bg-bg-elevated overflow-hidden">
              <div
                className="h-full bg-brand transition-all duration-300"
                style={{ width: `${(download.active?.progress ?? 0) * 100}%` }}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void useDownload.getState().cancel()}
              className="w-full"
            >
              Cancel
            </Button>
          </div>
        ) : isThisDone ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-success text-sm">
              <span>✓</span>
              <span>Model installed successfully</span>
            </div>
            <Button onClick={() => void handleLoad()} className="w-full" disabled={isLoading}>
              {isLoading && loadProgress ? `Loading ${loadProgress.percentage.toFixed(0)}%` : 'Load model'}
            </Button>
          </div>
        ) : localModelPath ? (
          <Button onClick={() => void handleLoad()} className="w-full" disabled={isLoading}>
            {isLoading && loadProgress ? `Loading ${loadProgress.percentage.toFixed(0)}%` : 'Load model'}
          </Button>
        ) : (
          <Button
            onClick={() => void handleInstall()}
            disabled={!selected || download.active !== null}
            className="w-full"
          >
            Install Model Locally
          </Button>
        )}
      </div>

      {/* README */}
      {detail.readme && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm text-text-muted hover:text-text-secondary w-full text-left">
            <span>README</span>
            <span className="text-xs">▸</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 text-sm border-t border-border-subtle pt-3">
              <Markdown>{stripFrontmatter(detail.readme)}</Markdown>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
