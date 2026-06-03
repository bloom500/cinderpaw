import { useModelSelector } from '@/hooks/useModelSelector';
import { Check, Loader2, AlertCircle, Disc3 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ModelSelector() {
  const {
    models,
    currentModel,
    loading,
    loadingProgress,
    loadingStatus,
    error,
    selectModel,
    unloadModel,
  } = useModelSelector();

  return (
    <div className="flex flex-col h-full bg-bg-surface border-r border-border-subtle">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border-subtle">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
          Models
        </h2>
        <p className="text-[11px] text-text-muted/70">
          Select a model to use with agents
        </p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Current model display */}
        {currentModel && (
          <div className="px-4 py-3 border-b border-border-subtle/50 bg-bg-hover/30">
            <div className="flex items-start gap-2 mb-2">
              <Disc3 size={12} className="text-success mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-text-primary truncate">
                  {currentModel.name}
                </p>
                <p className="text-[11px] text-text-muted">Active</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void unloadModel()}
              disabled={loading}
              className="w-full px-2 py-1 text-[11px] rounded border border-border-subtle text-text-muted hover:text-text-secondary hover:bg-bg-hover disabled:opacity-50 transition-colors"
            >
              Unload
            </button>
          </div>
        )}

        {/* Available models */}
        <div className="px-4 py-3">
          {models.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-4">
              No models loaded. Download one from the Models tab.
            </p>
          ) : (
            <div className="space-y-2">
              {models.map((model) => {
                const isLoading = loading;
                const isCurrent = currentModel?.path === model.path;

                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => void selectModel(model.path)}
                    disabled={isLoading || isCurrent}
                    className={cn(
                      'w-full px-3 py-2 rounded-md text-left transition-colors text-sm',
                      'border border-border-subtle',
                      isCurrent
                        ? 'bg-brand/10 border-brand/30 text-text-primary'
                        : 'bg-bg-hover hover:bg-bg-hover/80 text-text-secondary',
                      (isLoading || isCurrent) && 'opacity-60 cursor-not-allowed',
                    )}
                  >
                    <div className="flex items-start gap-2">
                      {isCurrent ? (
                        <Check size={14} className="text-success mt-0.5 shrink-0" />
                      ) : isLoading ? (
                        <Loader2 size={14} className="text-brand mt-0.5 shrink-0 animate-spin" />
                      ) : null}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium truncate">{model.name}</p>
                        <p className="text-[10px] text-text-muted truncate">
                          {(model.size_bytes / (1024 * 1024 * 1024)).toFixed(1)}GB
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Loading progress */}
        {loading && (
          <div className="px-4 py-3 border-t border-border-subtle/50 bg-bg-hover/20">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Loader2 size={12} className="text-brand animate-spin" />
                <p className="text-xs text-text-secondary">{loadingStatus}</p>
              </div>
              <div className="w-full h-1.5 bg-bg-hover rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand transition-all"
                  style={{ width: `${loadingProgress}%` }}
                />
              </div>
              <p className="text-[10px] text-text-muted text-right">
                {Math.round(loadingProgress)}%
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="px-4 py-3 border-t border-border-subtle bg-red-500/5">
          <div className="flex gap-2">
            <AlertCircle size={12} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-[11px] text-red-400 line-clamp-2">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
}
