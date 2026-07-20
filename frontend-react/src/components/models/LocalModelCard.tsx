import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useModel } from '@/stores/model';
import { useSystemInfo } from '@/stores/systemInfo';
import { cleanModelName, quantToQuality, quantToBadge, sizeGb, type QuantVariant } from '@/lib/modelUtils';
import { scoreFit, type FitLevel, type RunMode } from '@/lib/fitScore';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import type { ModelInfo } from '@/lib/tauri';

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

const FIT_STYLES: Record<FitLevel, { pill: string; bar: string; label: string }> = {
  perfect:  { pill: 'text-emerald-400 bg-emerald-400/10', bar: 'bg-emerald-500', label: 'Perfect'   },
  good:     { pill: 'text-brand bg-brand/10',             bar: 'bg-brand',       label: 'Good'      },
  marginal: { pill: 'text-amber-400 bg-amber-400/10',     bar: 'bg-amber-400',   label: 'Marginal'  },
  too_big:  { pill: 'text-error bg-error/10',             bar: 'bg-error',       label: 'Too large' },
};

const RUN_MODE_LABEL: Record<RunMode, string> = {
  gpu:         'GPU',
  cpu_offload: 'Offload',
  cpu:         'CPU',
};

// ── Quant badge colours ───────────────────────────────────────────────────────

const badgeClass: Record<QuantVariant, string> = {
  full:     'text-text-secondary bg-bg-elevated',
  high:     'text-success',
  balanced: 'text-brand',
  small:    'text-text-muted',
  tiny:     'text-text-muted',
};

// ── Mini bar used inside the tooltip breakdown ────────────────────────────────

function MiniBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex-1 h-1 rounded-full bg-bg-elevated overflow-hidden">
      <div className={cn('h-full rounded-full', color)} style={{ width: `${value}%` }} />
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  model:    ModelInfo;
  onDelete: (path: string) => Promise<void>;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function LocalModelCard({ model, onDelete }: Props) {
  const loaded       = useModel((s) => s.loaded);
  const isLoading    = useModel((s) => s.isLoading);
  const loadProgress = useModel((s) => s.loadProgress);
  const load         = useModel((s) => s.load);
  const unload       = useModel((s) => s.unload);
  const sysInfo      = useSystemInfo((s) => s.info);

  const [isDeleting,   setIsDeleting]   = useState(false);
  const [confirmOpen,  setConfirmOpen]  = useState(false);
  const [loadError,    setLoadError]    = useState<string | null>(null);
  const [deleteError,  setDeleteError]  = useState<string | null>(null);

  const path          = model.path as unknown as string;
  const isActive      = loaded?.path === path;
  const isLoadingThis = isLoading && loadProgress !== null && !isActive;

  const displayName = cleanModelName(model.name);
  const sizeStr     = sizeGb(model.size_bytes);
  const quality     = quantToQuality(model.quant ?? '');
  const { label: badgeLabel, variant } = quantToBadge(model.quant ?? '');

  // Compute fit score when system info is available
  const fit = sysInfo
    ? scoreFit(model.size_bytes, model.quant, model.ctx_len, sysInfo)
    : null;

  const fitStyle = fit ? FIT_STYLES[fit.level] : null;

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
    <div className={cn(
      'rounded-lg border border-border-default bg-bg-surface p-4 flex flex-col gap-3',
      isActive && 'border-brand',
    )}>
      {/* ── Header: name + fit pill ── */}
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-text-primary truncate">{displayName}</span>

        <div className="flex items-center gap-1.5 shrink-0">
          {fit && fitStyle && (
            <span className={cn(
              'text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
              fitStyle.pill,
            )}>
              {fitStyle.label}
            </span>
          )}
          {isActive && (
            <span className="text-xs font-medium text-brand">● Active</span>
          )}
        </div>
      </div>

      {/* ── Meta: size · quality · quant badge ── */}
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span>{sizeStr}</span>
        <span>·</span>
        <span>{quality}</span>
        <span className={cn('ml-auto text-[10px] px-1.5 py-0.5 rounded', badgeClass[variant])}>
          {badgeLabel}
        </span>
      </div>

      {/* ── Fit score row ── */}
      {fit && fitStyle && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 cursor-default select-none" aria-label="Fit score">
                {/* Score bar */}
                <div className="flex-1 h-1.5 rounded-full bg-bg-elevated overflow-hidden">
                  <div
                    className={cn('h-full rounded-full transition-all duration-500', fitStyle.bar)}
                    style={{ width: `${fit.score}%` }}
                  />
                </div>

                {/* Score number */}
                <span className="text-[11px] font-mono text-text-muted w-6 text-right tabular-nums">
                  {fit.score}
                </span>

                {/* Run mode + tok/s */}
                <span className="text-[10px] text-text-muted shrink-0">
                  {RUN_MODE_LABEL[fit.runMode]}
                  {fit.estimatedTokPerSec !== null && (
                    <> · ~{fit.estimatedTokPerSec} t/s</>
                  )}
                </span>
              </div>
            </TooltipTrigger>

            <TooltipContent
              side="bottom"
              className="p-3 min-w-[200px] bg-bg-surface border border-border-default text-text-primary"
            >
              <div className="space-y-2.5">
                {/* Component breakdown */}
                {(
                  [
                    { key: 'fit',     label: 'Memory fit', value: fit.components.fit     },
                    { key: 'quality', label: 'Quality',    value: fit.components.quality  },
                    { key: 'speed',   label: 'Speed',      value: fit.components.speed    },
                    { key: 'context', label: 'Context',    value: fit.components.context  },
                  ] as const
                ).map(({ key, label, value }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-[10px] text-text-muted w-16 shrink-0">{label}</span>
                    <MiniBar value={value} color={fitStyle.bar} />
                    <span className="text-[10px] font-mono text-text-secondary w-6 text-right tabular-nums">
                      {value}
                    </span>
                  </div>
                ))}

                {/* Memory detail */}
                <div className="pt-1 border-t border-border-subtle text-[10px] text-text-muted space-y-0.5">
                  <div>
                    {fit.memUsedGb} GB / {fit.memAvailGb} GB
                    {' '}({fit.utilizationPct}% utilization)
                  </div>
                  <div>
                    Run mode: <span className="text-text-secondary">{RUN_MODE_LABEL[fit.runMode]}</span>
                    {fit.estimatedTokPerSec !== null && (
                      <> · ~{fit.estimatedTokPerSec} tok/s</>
                    )}
                  </div>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* ── Load progress ── */}
      {isLoadingThis && loadProgress ? (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-text-muted">
            <span>{loadProgress.statusText}</span>
            <span>{loadProgress.percentage.toFixed(0)}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-bg-elevated overflow-hidden" role="progressbar">
            <div
              className="h-full bg-brand transition-all duration-300"
              style={{ width: `${loadProgress.percentage}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          {isActive ? (
            <>
              <button
                type="button" onClick={handleUnload} aria-label="Unload"
                className="flex-1 text-xs py-1.5 rounded border border-border-default text-text-secondary hover:bg-bg-hover transition-colors"
              >
                Unload
              </button>
              <button
                type="button" onClick={() => setConfirmOpen(true)} disabled={isDeleting} aria-label="Delete"
                className="flex-1 text-xs py-1.5 rounded border border-error text-error hover:bg-bg-hover transition-colors disabled:opacity-60"
              >
                {isDeleting
                  ? <span className="flex items-center justify-center gap-1.5"><DeleteSpinner />Deleting…</span>
                  : 'Delete'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button" onClick={() => { void handleLoad(); }} disabled={isDeleting || isLoading} aria-label="Load"
                className="flex-1 text-xs py-1.5 rounded bg-bg-elevated text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-60"
              >
                Load
              </button>
              <button
                type="button" onClick={() => setConfirmOpen(true)} disabled={isDeleting} aria-label="Delete"
                className="flex-1 text-xs py-1.5 rounded border border-border-default text-text-muted hover:bg-bg-hover transition-colors disabled:opacity-60"
              >
                {isDeleting
                  ? <span className="flex items-center justify-center gap-1.5"><DeleteSpinner />Deleting…</span>
                  : 'Delete'}
              </button>
            </>
          )}
        </div>
      )}

      {loadError && <p className="text-xs text-error break-words">{loadError}</p>}
      {deleteError && !confirmOpen && <p className="text-xs text-error break-words">{deleteError}</p>}

      <Dialog open={confirmOpen} onOpenChange={(open) => { if (!isDeleting) { setConfirmOpen(open); if (!open) setDeleteError(null); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this model?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-text-secondary">
            This deletes <span className="text-text-primary">{displayName}</span> ({sizeStr}) from disk.
            You'll have to download it again to use it.
          </p>
          {deleteError && <p className="text-xs text-error break-words">{deleteError}</p>}
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
              className="px-3 py-1.5 text-sm rounded bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
            >
              {isDeleting ? 'Deleting…' : 'Delete'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
