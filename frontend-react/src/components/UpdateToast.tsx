import { AnimatePresence, motion } from 'framer-motion';
import { Sparkles, Download, X } from 'lucide-react';
import { useUpdater } from '@/stores/updater';
import { cn } from '@/lib/utils';
import { releaseHighlights } from '@/lib/releaseHighlights';

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
  // Three headlines, not the notes: the notes are the whole CHANGELOG section,
  // markdown and all, and three raw lines of it said nothing (24 Sep).
  const highlights = releaseHighlights(info?.notes ?? null);
  const downloading = status === 'downloading';

  return (
    <AnimatePresence>
      {open && info && (
        <motion.div
          // Positioned by AppShell's NotificationLayer (top-right, under the
          // window controls) — it slides in from the right like the toasts it
          // now shares a column with, instead of rising from the corner.
          initial={{ opacity: 0, x: 24, scale: 0.96 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 24, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.8 }}
          // Same glass as the toasts it stacks with (see Toasts.tsx): blurred
          // slab, top-lit sheen, 1px inner ring for the lit edge.
          className={cn(
            'pointer-events-auto relative w-full rounded-xl border border-border-default/60 p-4',
            'bg-bg-elevated/80 backdrop-blur-xl backdrop-saturate-150',
            'shadow-xl shadow-black/25 ring-1 ring-inset ring-white/10',
            'before:absolute before:inset-0 before:rounded-xl before:pointer-events-none',
            'before:bg-linear-to-b before:from-white/6 before:to-transparent',
          )}
        >
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 shrink-0 text-brand">
              <Sparkles size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text-primary">
                A new Cinderpaw is ready
              </p>
              <p className="text-2xs text-text-muted">Version {info.version} · takes a minute, then it restarts</p>
              {highlights.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {highlights.map((h) => (
                    <li key={h} className="flex items-center gap-1.5 text-xs text-text-secondary">
                      <span className="size-1 shrink-0 rounded-full bg-brand" aria-hidden />
                      <span className="truncate">{h.charAt(0).toUpperCase() + h.slice(1)}</span>
                    </li>
                  ))}
                  <li className="text-2xs text-text-muted">and more</li>
                </ul>
              )}
            </div>
            {!downloading && (
              <button
                type="button"
                onClick={dismiss}
                aria-label="Dismiss"
                className="shrink-0 text-text-muted/60 hover:text-text-muted transition-colors"
              >
                <X size={14} />
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
                  'bg-brand text-on-brand hover:opacity-90 transition-opacity',
                )}
              >
                Update now
              </button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
