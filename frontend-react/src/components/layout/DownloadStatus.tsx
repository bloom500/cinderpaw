/**
 * Phase 4 S3 — download progress, out of the sidebar.
 *
 * This was a button in the sidebar header, rendered only when the rail was
 * expanded: collapse the sidebar and a model download became invisible while
 * it was still running. A download is application state, not navigation, so it
 * now sits in the window chrome next to the toasts, where transient status
 * already lives and where nothing can hide it.
 *
 * It renders nothing while there is nothing to say. A permanently visible
 * download icon on an app that is not downloading is chrome pretending to be
 * information — and there is no download history behind it to open.
 */

import { motion, AnimatePresence } from 'framer-motion';
import { Download, X, CheckCircle, AlertCircle } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { useDownload } from '@/stores/download';

export function DownloadStatus() {
  const active = useDownload((s) => s.active);
  const done   = useDownload((s) => s.done);
  const error  = useDownload((s) => s.error);

  const hasActivity = active !== null || done || error !== null;
  const progress    = active ? Math.round(active.progress * 100) : 0;

  return (
    <AnimatePresence>
      {hasActivity && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.15 }}
        >
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="relative h-8 w-10 flex items-center justify-center text-text-muted/60 hover:text-text-secondary hover:bg-white/5 transition-colors"
                /* The label carries the state, so a screen reader hears what
                   the coloured dot means to everyone else. */
                aria-label={
                  active ? `Downloading, ${progress}%`
                  : error ? 'Download failed'
                  : 'Download complete'
                }
              >
                <Download size={14} strokeWidth={1.5} />
                {active && (
                  <span className="absolute top-1 right-2 w-2 h-2 rounded-full bg-brand" />
                )}
                {done && !active && (
                  <span className="absolute top-1 right-2 w-2 h-2 rounded-full bg-success" />
                )}
                {error && (
                  <span className="absolute top-1 right-2 w-2 h-2 rounded-full bg-error" />
                )}
              </button>
            </PopoverTrigger>

            <PopoverContent
              side="bottom"
              align="end"
              sideOffset={8}
              className="w-72 bg-bg-surface border border-border-subtle text-text-primary p-4"
            >
              <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-3">
                Downloads
              </p>

              {active && (
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-text-primary truncate">{active.filename}</p>
                      <p className="text-2xs text-text-muted truncate">{active.repoId}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void useDownload.getState().cancel()}
                      className="shrink-0 p-0.5 rounded text-text-muted hover:text-error hover:bg-error/10 transition-colors"
                      aria-label="Cancel download"
                    >
                      <X size={13} />
                    </button>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-2xs text-text-muted">
                      <span>Downloading…</span>
                      <span>{progress}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-bg-elevated overflow-hidden">
                      <motion.div
                        className="h-full bg-brand rounded-full"
                        animate={{ width: `${progress}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {done && !active && (
                <div className="flex items-center gap-2 text-success text-sm">
                  <CheckCircle size={14} />
                  <span>Download complete</span>
                  <button
                    type="button"
                    onClick={() => useDownload.getState().reset()}
                    className="ml-auto text-2xs text-text-muted hover:text-text-secondary"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {error && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-error text-sm">
                    <AlertCircle size={14} />
                    <span>Download failed</span>
                  </div>
                  <p className="text-2xs text-text-muted break-all">{error}</p>
                  <button
                    type="button"
                    onClick={() => useDownload.getState().reset()}
                    className="text-2xs text-text-muted hover:text-text-secondary mt-1"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </PopoverContent>
          </Popover>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
