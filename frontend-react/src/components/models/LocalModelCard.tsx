import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useModel } from '@/stores/model';
import { cleanModelName, quantToQuality, quantToBadge, sizeGb, type QuantVariant } from '@/lib/modelUtils';
import type { ModelInfo } from '@/lib/tauri';

const badgeClass: Record<QuantVariant, string> = {
  full:     'text-text-secondary bg-bg-elevated',
  high:     'text-success',
  balanced: 'text-brand',
  small:    'text-text-muted',
  tiny:     'text-text-muted',
};

interface Props {
  model: ModelInfo;
  onDelete: (path: string) => Promise<void>;
}

export function LocalModelCard({ model, onDelete }: Props) {
  const loaded       = useModel((s) => s.loaded);
  const isLoading    = useModel((s) => s.isLoading);
  const loadProgress = useModel((s) => s.loadProgress);
  const load         = useModel((s) => s.load);
  const unload       = useModel((s) => s.unload);
  const [isDeleting, setIsDeleting] = useState(false);

  const path         = model.path as unknown as string;
  const isActive     = loaded?.path === path;
  const isLoadingThis = isLoading && loadProgress !== null && !isActive;

  const displayName = cleanModelName(model.name);
  const sizeStr     = sizeGb(model.size_bytes);
  const quality     = quantToQuality(model.quant ?? '');
  const { label: badgeLabel, variant } = quantToBadge(model.quant ?? '');

  const handleLoad   = () => { void load(path); };
  const handleUnload = () => { void unload(); };
  const handleDelete = async () => {
    setIsDeleting(true);
    try { await onDelete(path); } finally { setIsDeleting(false); }
  };

  return (
    <div className={cn(
      'rounded-lg border border-border-default bg-bg-surface p-4 flex flex-col gap-3',
      isActive && 'border-brand',
    )}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-text-primary truncate">{displayName}</span>
        {isActive && (
          <span className="text-xs font-medium text-brand shrink-0">● Active</span>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span>{sizeStr}</span>
        <span>·</span>
        <span>{quality}</span>
        <span className={cn('ml-auto text-[10px] px-1.5 py-0.5 rounded', badgeClass[variant])}>
          {badgeLabel}
        </span>
      </div>

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
                type="button"
                onClick={handleUnload}
                aria-label="Unload"
                className="flex-1 text-xs py-1.5 rounded border border-border-default text-text-secondary hover:bg-bg-hover transition-colors"
              >
                Unload
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                aria-label="Delete"
                className="flex-1 text-xs py-1.5 rounded border border-error text-error hover:bg-bg-hover transition-colors disabled:opacity-60"
              >
                {isDeleting ? '⠼ Deleting' : 'Delete'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleLoad}
                disabled={isDeleting || isLoading}
                aria-label="Load"
                className="flex-1 text-xs py-1.5 rounded bg-bg-elevated text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-60"
              >
                Load
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                aria-label="Delete"
                className="flex-1 text-xs py-1.5 rounded border border-border-default text-text-muted hover:bg-bg-hover transition-colors disabled:opacity-60"
              >
                {isDeleting ? '⠼ Deleting' : 'Delete'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
