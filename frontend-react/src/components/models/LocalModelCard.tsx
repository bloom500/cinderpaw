import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Ellipsis, MessageSquare, Play, Square, Star, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useModel } from '@/stores/model';
import { useSystemInfo } from '@/stores/systemInfo';
import { quantToQuality, sizeGb } from '@/lib/modelUtils';
import { scoreFit, type FitLevel, type RunMode } from '@/lib/fitScore';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import type { ModelInfo } from '@/lib/tauri';
import { BTN_OUTLINE, BTN_PRIMARY, CARD, Chip, MakerTile, Meter, Pill, SERIF, Status, makerFor, paramsOf, prettyModelName } from './ui';

// ── Spinner ──────────────────────────────────────────────────────────────────

function DeleteSpinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="animate-spin shrink-0" aria-hidden>
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.25" />
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeDasharray="34.56" strokeDashoffset="26" strokeLinecap="round" />
    </svg>
  );
}

// ── Fit level styles ──────────────────────────────────────────────────────────

const FIT: Record<FitLevel, { tone: 'success' | 'brand' | 'warning' | 'error'; label: string }> = {
  perfect:  { tone: 'success', label: 'Perfect fit' },
  good:     { tone: 'brand',   label: 'Good fit' },
  marginal: { tone: 'warning', label: 'Tight fit' },
  too_big:  { tone: 'error',   label: 'Too large' },
};

const RUN_MODE_LABEL: Record<RunMode, string> = {
  gpu:         'GPU',
  cpu_offload: 'GPU + CPU',
  cpu:         'CPU',
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  model:    ModelInfo;
  onDelete: (path: string) => Promise<void>;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function LocalModelCard({ model, onDelete }: Props) {
  const navigate     = useNavigate();
  const loaded       = useModel((s) => s.loaded);
  const isLoading    = useModel((s) => s.isLoading);
  const loadProgress = useModel((s) => s.loadProgress);
  const load         = useModel((s) => s.load);
  const unload       = useModel((s) => s.unload);
  const sysInfo      = useSystemInfo((s) => s.info);

  const [open,         setOpen]         = useState(false);
  const [isDeleting,   setIsDeleting]   = useState(false);
  const [confirmOpen,  setConfirmOpen]  = useState(false);
  const [loadError,    setLoadError]    = useState<string | null>(null);
  const [deleteError,  setDeleteError]  = useState<string | null>(null);

  const path          = model.path as unknown as string;
  const isActive      = loaded?.path === path;
  const isLoadingThis = isLoading && loadProgress !== null && !isActive;

  const displayName = prettyModelName(model.name);
  const maker       = makerFor(model.name);
  const params      = paramsOf(model.name);
  // The host's verdict (the same rule behind refuse_if_embedding): an
  // embedding model turns text into vectors for memory and search, and cannot
  // hold a conversation. It used to sit in this list with a quality label, a
  // tok/s estimate and a Load button, like a chat model that happened to be
  // small (20 Sep).
  const isEmbedding = model.is_embedding;
  const sizeStr     = sizeGb(model.size_bytes);
  const quant       = model.quant ?? '';
  const quality     = quantToQuality(quant);

  const fit = sysInfo ? scoreFit(model.size_bytes, model.quant, model.ctx_len, sysInfo) : null;
  const fitStyle = fit ? FIT[fit.level] : null;
  const memTotal = sysInfo && sysInfo.vram_total_mb > 0 ? 'VRAM' : 'RAM';
  const where = fit && sysInfo
    ? fit.runMode === 'cpu'
      ? `on CPU (${sysInfo.cores} threads)`
      : `on ${sysInfo.gpu_name.replace(/^(AMD|NVIDIA)\s+/i, '')}`
    : null;

  const handleLoad = async () => {
    setLoadError(null);
    try { await load(path); } catch (err) { setLoadError(String(err)); }
  };
  const handleUnload = () => { void unload(); };
  const handleDelete = async () => {
    setDeleteError(null);
    setIsDeleting(true);
    try { await onDelete(path); setConfirmOpen(false); }
    catch (err) { setDeleteError(String(err)); }
    finally { setIsDeleting(false); }
  };

  return (
    <article
      className={cn(
        CARD,
        'relative overflow-hidden transition-shadow',
        open && 'shadow-md',
        isActive && 'border-brand/40',
      )}
    >
      {/* The running model wears a thin brand edge, so it is found at a glance. */}
      {isActive && <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-brand" />}

      <div className="flex flex-wrap items-center gap-4 p-4 sm:flex-nowrap">
        <MakerTile maker={maker} fallback={displayName} />

        {/* ── Name, maker, tags, memory ── */}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-lg font-semibold text-text-primary" style={{ fontFamily: SERIF }} title={model.name}>
              {displayName}
            </h3>
            {isActive && <Pill tone="brand"><Star size={12} className="fill-current" /> Active</Pill>}
          </div>
          <p className="mt-0.5 truncate text-xs text-text-muted">
            {maker?.label ?? 'Local file'}
            {' · '}
            {isEmbedding ? 'Embedding model: used for memory and search, not for chat' : quality}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {params && <Chip>{params}</Chip>}
            {quant && <Chip>{quant}</Chip>}
            <Chip>{sizeStr}</Chip>
          </div>
          {fit && !isEmbedding && (
            <div className="mt-3 max-w-md">
              <div className="mb-1 flex items-center justify-between gap-3 text-2xs text-text-muted">
                <span>Estimated memory use</span>
                <span className="tabular-nums">{fit.memUsedGb} GB / {fit.memAvailGb} GB {memTotal}</span>
              </div>
              <Meter
                value={fit.memAvailGb > 0 ? fit.memUsedGb / fit.memAvailGb : 1}
                tone={fitStyle?.tone ?? 'brand'}
                label="Estimated memory use"
              />
            </div>
          )}
        </div>

        {/* ── Status and speed ── */}
        <div className="hidden w-40 shrink-0 space-y-1 lg:block">
          {isActive ? <Status tone="success">Running</Status> : <Status tone="neutral">Installed</Status>}
          {fit && !isEmbedding && fit.estimatedTokPerSec !== null && (
            <>
              <p className="text-sm font-medium text-text-primary tabular-nums">~{fit.estimatedTokPerSec} tokens/sec</p>
              {where && <p className="truncate text-2xs text-text-muted">{where}</p>}
            </>
          )}
        </div>

        {/* ── Actions ── */}
        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-28">
          {isLoadingThis && loadProgress ? (
            <div className="space-y-1">
              <div className="flex justify-between text-2xs text-text-muted">
                <span className="truncate">{loadProgress.statusText}</span>
                <span className="tabular-nums">{loadProgress.percentage.toFixed(0)}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-bg-elevated" role="progressbar" aria-valuenow={Math.round(loadProgress.percentage)}>
                <div className="h-full bg-brand transition-all duration-300" style={{ width: `${loadProgress.percentage}%` }} />
              </div>
            </div>
          ) : isActive ? (
            <button type="button" onClick={handleUnload} className={cn(BTN_OUTLINE, 'w-full')}>
              <Square size={12} className="fill-error text-error" /> Stop
            </button>
          ) : !isEmbedding ? (
            <button
              type="button"
              onClick={() => { void handleLoad(); }}
              disabled={isDeleting || isLoading}
              className={cn(BTN_PRIMARY, 'w-full')}
            >
              <Play size={14} className="fill-current" /> Run
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? 'Hide details' : 'Show details'}
            title={open ? 'Hide details' : 'Show details'}
            className={cn(BTN_OUTLINE, 'w-full', open && 'bg-bg-hover')}
          >
            <Ellipsis size={16} />
          </button>
        </div>
      </div>

      {loadError && <p className="px-4 pb-3 text-xs text-error wrap-break-word">{loadError}</p>}
      {deleteError && !confirmOpen && <p className="px-4 pb-3 text-xs text-error wrap-break-word">{deleteError}</p>}

      {/* ── Opened: how well it fits, what the file is, what you can do ── */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-border-subtle bg-bg-elevated/50">
              <div className="grid gap-6 p-5 md:grid-cols-[220px_minmax(0,1fr)]">
                {fit && fitStyle && !isEmbedding ? (
                  <div>
                    <div className="flex items-center gap-4">
                      <ScoreRing score={fit.score} tone={fitStyle.tone} />
                      <div>
                        <Pill tone={fitStyle.tone}>{fitStyle.label}</Pill>
                        <p className="mt-1.5 text-2xs text-text-muted">{fit.utilizationPct}% of your {memTotal}</p>
                      </div>
                    </div>
                    <div className="mt-4 space-y-2">
                      {([
                        ['Memory fit', fit.components.fit],
                        ['Quality', fit.components.quality],
                        ['Speed', fit.components.speed],
                        ['Context', fit.components.context],
                      ] as const).map(([label, value]) => (
                        <div key={label} className="flex items-center gap-2">
                          <span className="w-20 shrink-0 text-2xs text-text-muted">{label}</span>
                          <Meter value={value / 100} tone={fitStyle.tone} label={label} />
                          <span className="w-7 shrink-0 text-right text-2xs tabular-nums text-text-secondary">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-text-secondary">
                    {isEmbedding
                      ? 'Cinderpaw uses this model to turn what it remembers into vectors, so it can search them. It cannot chat.'
                      : 'Hardware details are still loading.'}
                  </p>
                )}

                <div className="min-w-0">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                    {quant && <Fact label="Quantization" value={quant} hint={quality} />}
                    <Fact label="Size on disk" value={sizeStr} />
                    {model.ctx_len ? <Fact label="Context" value={`${model.ctx_len.toLocaleString()} tokens`} /> : null}
                    {fit && !isEmbedding && <Fact label="Runs on" value={RUN_MODE_LABEL[fit.runMode]} />}
                    {fit && !isEmbedding && fit.estimatedTokPerSec !== null && <Fact label="Speed" value={`~${fit.estimatedTokPerSec} tok/s`} hint="estimate" />}
                    {params && <Fact label="Parameters" value={params} />}
                  </dl>
                  <div className="mt-4 rounded-xl border border-border-subtle bg-bg-surface px-3 py-2">
                    <p className="text-micro uppercase tracking-wider text-text-muted">File</p>
                    <p className="truncate font-mono text-xs text-text-secondary" title={path}>{path}</p>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {isActive && (
                      <button type="button" onClick={() => navigate('/chat')} className={BTN_PRIMARY}>
                        <MessageSquare size={14} /> Chat with it
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setConfirmOpen(true)}
                      disabled={isDeleting}
                      className={cn(BTN_OUTLINE, 'text-error hover:bg-error/10')}
                    >
                      {isDeleting
                        ? <><DeleteSpinner />Deleting…</>
                        : <><Trash2 size={14} /> Delete</>}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Dialog open={confirmOpen} onOpenChange={(o) => { if (!isDeleting) { setConfirmOpen(o); if (!o) setDeleteError(null); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this model?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-text-secondary">
            This deletes <span className="text-text-primary">{displayName}</span> ({sizeStr}) from disk.
            You'll have to download it again to use it.
            {isEmbedding && ' Until then, Cinderpaw searches its memory by keywords only, and recalls less.'}
          </p>
          {deleteError && <p className="text-xs text-error wrap-break-word">{deleteError}</p>}
          <DialogFooter>
            <button
              type="button"
              onClick={() => { setConfirmOpen(false); setDeleteError(null); }}
              disabled={isDeleting}
              className="px-3 py-1.5 text-sm rounded text-text-muted hover:bg-bg-hover disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={isDeleting}
              className="px-3 py-1.5 text-sm rounded bg-error text-primary-foreground hover:bg-error/90 disabled:opacity-50"
            >
              {isDeleting ? 'Deleting…' : 'Delete'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className="truncate font-medium text-text-primary">{value}</dd>
      {hint && <dd className="truncate text-2xs text-text-muted">{hint}</dd>}
    </div>
  );
}

/** The fit score as a ring, 0..100. */
function ScoreRing({ score, tone }: { score: number; tone: 'success' | 'brand' | 'warning' | 'error' }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const stroke = { success: 'var(--success)', brand: 'var(--brand)', warning: 'var(--warning)', error: 'var(--error)' }[tone];
  return (
    <div className="relative size-14 shrink-0" role="img" aria-label={`Fit score ${score} of 100`}>
      <svg viewBox="0 0 56 56" className="size-14 -rotate-90">
        <circle cx="28" cy="28" r={r} fill="none" strokeWidth="5" className="stroke-bg-hover" />
        <motion.circle
          cx="28" cy="28" r={r} fill="none" strokeWidth="5" strokeLinecap="round" stroke={stroke}
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - score / 100) }}
          transition={{ duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums text-text-primary">{score}</span>
    </div>
  );
}
