import { AnimatePresence, motion } from 'framer-motion';
import { Sparkles, Download, X } from 'lucide-react';
import { useUpdater } from '@/stores/updater';
import { cn } from '@/lib/utils';

/**
 * Bottom-right toast that appears when an update is available (or downloading).
 * Driven by the shared updater store, so it reacts to both the startup check
 * and the manual "Check for updates" button in Settings.
 */
export function UpdateToast() {
  const status   = useUpdater((s) => s.status);
  const info     = useUpdater((s) => s.info);
  const progress = useUpdater((s) => s.progress);
  const install  = useUpdater((s) => s.install);
  const dismiss  = useUpdater((s) => s.dismiss);

  const open = status === 'available' || status === 'downloading';
  const downloading = status === 'downloading';

  return (
    <AnimatePresence>
      {open && info && (
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.96 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          className="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-border-default bg-bg-surface shadow-2xl p-4"
        >
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 shrink-0 text-brand">
              <Sparkles size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text-primary">
                Update {info.version} available
              </p>
              {info.notes && (
                <p className="mt-1 text-xs text-text-muted line-clamp-3 whitespace-pre-line">
                  {info.notes}
                </p>
              )}
            </div>
            {!downloading && (
              <button
                type="button"
                onClick={dismiss}
                aria-label="Dismiss"
                className="shrink-0 text-text-muted/60 hover:text-text-muted transition-colors"
              >
                <X size={15} />
              </button>
            )}
          </div>

          {downloading ? (
            <div className="mt-3 space-y-1.5">
              <p className="text-xs text-text-muted flex items-center gap-1.5">
                <Download size={12} className="text-brand" /> Installing… {progress}%
              </p>
              <div className="h-1.5 rounded-full bg-bg-hover overflow-hidden">
                <div
                  className="h-full bg-brand transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={dismiss}
                className="px-3 py-1.5 rounded-md text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                Later
              </button>
              <button
                type="button"
                onClick={() => void install()}
                className={cn(
                  'px-3 py-1.5 rounded-md text-xs font-medium',
                  'bg-brand text-white hover:opacity-90 transition-opacity',
                )}
              >
                Install now
              </button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
