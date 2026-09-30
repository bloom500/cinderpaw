import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, CheckCircle, AlertTriangle, XCircle, Download, Play, type LucideIcon } from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Markdown } from '@/lib/markdown';
import { StreamingIndicator } from '@/components/chat/StreamingIndicator';
import { useModel } from '@/stores/model';
import { useDownload } from '@/stores/download';
import { useSystemInfo } from '@/stores/systemInfo';
import { tauri, type HfModelDetail } from '@/lib/tauri';
import {
  quantToBadge, sizeGb, pickFittedFile, stripFrontmatter, extractQuant,
  compatLevel, type QuantVariant, type Compat,
} from '@/lib/modelUtils';

// ── Compatibility popover ─────────────────────────────────────────────────────

const COMPAT_CFG: Record<Compat, {
  Icon: LucideIcon;
  iconCls: string;
  dotCls: string;
  label: string;
  desc: string;
}> = {
  fits: {
    Icon: CheckCircle,
    iconCls: 'text-success',
    dotCls:  'bg-success',
    label:   'Fits',
    desc:    'Should run comfortably on your device',
  },
  slow: {
    Icon: AlertTriangle,
    iconCls: 'text-warning',
    dotCls:  'bg-yellow-500',
    label:   'May be slow',
    desc:    'Will run but leaves little memory headroom',
  },
  no: {
    Icon: XCircle,
    iconCls: 'text-error',
    dotCls:  'bg-error',
    label:   "Won't fit",
    desc:    'Likely exceeds your available memory',
  },
};

function featureTags(modelTags: string[]): string[] {
  const t = modelTags.map((s) => s.toLowerCase());
  const feats: string[] = [];
  if (t.some((s) => ['image-to-text', 'image-text-to-text', 'vision', 'multimodal'].includes(s)))
    feats.push('Vision');
  if (t.some((s) => ['tool-use', 'function-calling', 'tools-call-compatible'].includes(s)))
    feats.push('Tools');
  return feats;
}

interface CompatPopoverProps {
  filename: string;
  modelTags: string[];
  compat: Compat | null;
}

function CompatPopover({ filename, modelTags, compat }: CompatPopoverProps) {
  const [open, setOpen] = useState(false);
  if (!compat) return null;
  const cfg   = COMPAT_CFG[compat];
  const quant = extractQuant(filename);
  const feats = featureTags(modelTags);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* span instead of button — avoids button-inside-button (invalid HTML → glitch) */}
        <span
          role="img"
          aria-label={cfg.label}
          className="shrink-0 flex items-center cursor-default"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <cfg.Icon size={14} className={cfg.iconCls} />
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="w-64 bg-bg-surface border border-border-subtle text-text-primary p-4 space-y-3"
      >
        {/* Header */}
        <div>
          <p className="text-xs font-semibold text-text-primary truncate">{filename}</p>
          <p className="text-2xs text-text-muted mt-0.5">Model Variant Information</p>
        </div>
        <div className="border-t border-border-subtle" />

        {/* Quantization */}
        <div>
          <p className="text-micro uppercase tracking-wider text-text-muted font-medium mb-1">Quantization</p>
          <p className="text-sm font-mono text-text-primary">{quant}</p>
        </div>

        {/* Device compatibility */}
        <div>
          <p className="text-micro uppercase tracking-wider text-text-muted font-medium mb-1.5">Device compatibility</p>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full shrink-0 ${cfg.dotCls}`} />
            <span className="text-sm font-medium text-text-primary">{cfg.label}</span>
          </div>
          <p className="text-xs text-text-muted mt-1">{cfg.desc}</p>
        </div>

        {/* Disclaimer */}
        <p className="text-micro text-text-disabled italic leading-relaxed">
          Estimated from file size and your hardware. Actual performance depends on quantization and context length.
        </p>

        {/* Features */}
        {feats.length > 0 && (
          <div>
            <p className="text-micro uppercase tracking-wider text-text-muted font-medium mb-1.5">Features</p>
            <div className="flex flex-wrap gap-1.5">
              {feats.map((f) => (
                <span key={f} className="px-2 py-0.5 rounded bg-bg-elevated text-xs text-text-secondary border border-border-subtle">
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Quality badge colours ─────────────────────────────────────────────────────

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
  const [fileSizes, setFileSizes] = useState<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    detail.gguf_files.forEach((f) => { if (f.size) m[f.rfilename] = f.size; });
    return m;
  });
  // filename → local path (for already-installed files)
  const [installed, setInstalled] = useState<Record<string, string>>({});

  // Fetch missing file sizes
  useEffect(() => {
    detail.gguf_files
      .filter((f) => !f.size)
      .forEach((f) => {
        void tauri.hf.modelSizeInfo(repoId, f.rfilename).then((bytes) => {
          if (bytes > 0) setFileSizes((prev) => ({ ...prev, [f.rfilename]: bytes }));
        }).catch(() => {});
      });
  }, [repoId, detail.gguf_files]);

  // Check which files are already installed
  useEffect(() => {
    void tauri.models.list().then((list) => {
      const map: Record<string, string> = {};
      list.forEach((m) => { map[m.name] = m.path as unknown as string; });
      setInstalled(map);
    }).catch(() => {});
  }, [download.done]);

  if (loading) {
    return <div className="flex justify-center py-6"><StreamingIndicator /></div>;
  }

  const activeFilename = download.active?.filename ?? null;

  const handleDownload = async (filename: string) => {
    await useDownload.getState().start(repoId, filename);
  };

  const handleLoad = async (localPath: string) => {
    await modelLoad(localPath);
    navigate('/chat');
  };

  return (
    <div className="space-y-4">
      {/* File list — each row has its own download/load action */}
      <div>
        <p className="mb-2 text-micro font-medium uppercase tracking-wider text-text-muted">Variants</p>
        <div className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-surface">
        {detail.gguf_files.map((f) => {
          const isRecommended    = recommended?.rfilename === f.rfilename;
          const size             = fileSizes[f.rfilename];
          const { label, variant } = quantToBadge(f.rfilename);
          const compat           = size ? compatLevel(size, sysInfo) : null;
          const localPath        = installed[f.rfilename] ?? null;
          const isThisDownloading = activeFilename === f.rfilename;
          const isAnyDownloading  = download.active !== null;
          const progress         = isThisDownloading ? (download.active?.progress ?? 0) * 100 : 0;

          return (
            <div
              key={f.rfilename}
              className={`flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-bg-hover ${isRecommended ? 'bg-brand/5' : ''}`}
            >
              {/* Quant + quality: what the file is, before what it is called */}
              <span className="w-20 shrink-0 rounded-md border border-border-subtle bg-bg-elevated px-1.5 py-0.5 text-center font-mono text-2xs text-text-primary">
                {extractQuant(f.rfilename)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-text-primary" title={f.rfilename}>{f.rfilename}</p>
                <p className="flex items-center gap-2 text-2xs text-text-muted">
                  <span className={badgeClass[variant]}>{label} quality</span>
                  {isRecommended && (
                    <span className="inline-flex items-center gap-1 text-brand">
                      <Star size={12} fill="currentColor" /> Best for this machine
                    </span>
                  )}
                </p>
              </div>

              {/* Size */}
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-text-muted">
                {size ? sizeGb(size) : '…'}
              </span>

              {/* Compat icon + popover */}
              <span className="w-5 shrink-0"><CompatPopover filename={f.rfilename} modelTags={detail.tags} compat={compat} /></span>

              {/* Per-row action button */}
              <div className="flex w-28 shrink-0 justify-end">
                {isThisDownloading ? (
                  /* Inline progress + cancel */
                  <div className="flex w-full items-center gap-1.5">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-bg-hover">
                      <div
                        className="h-full bg-brand transition-all duration-300"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void useDownload.getState().cancel()}
                      aria-label="Cancel download"
                      className="text-micro text-text-muted hover:text-error transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                ) : localPath ? (
                  /* Already installed → Load button */
                  <button
                    type="button"
                    onClick={() => void handleLoad(localPath)}
                    disabled={isLoading}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-success/30 bg-success/10 px-3 text-xs font-medium text-success hover:bg-success/15 disabled:opacity-40"
                  >
                    <Play size={12} />
                    {isLoading && loadProgress ? `${loadProgress.percentage.toFixed(0)}%` : 'Load'}
                  </button>
                ) : (
                  /* Download button */
                  <button
                    type="button"
                    onClick={() => void handleDownload(f.rfilename)}
                    disabled={isAnyDownloading}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                      isRecommended
                        ? 'bg-brand text-primary-foreground hover:bg-brand-hover'
                        : 'border border-border-default text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                    }`}
                  >
                    <Download size={12} />
                    <span>Download</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
        </div>
      </div>

      {/* README */}
      {detail.readme && (
        <Collapsible>
          <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left text-sm font-medium text-text-secondary hover:text-text-primary">
            <span>README</span>
            <span className="text-xs transition-transform group-data-[state=open]:rotate-90">▸</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 max-h-96 overflow-y-auto rounded-xl border border-border-subtle bg-bg-surface p-4 text-sm thin-scrollbar">
              <Markdown>{stripFrontmatter(detail.readme)}</Markdown>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
