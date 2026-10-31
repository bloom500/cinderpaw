import { AnimatePresence } from 'framer-motion';
import { Sparkles, Download } from 'lucide-react';
import { useUpdater } from '@/stores/updater';
import { NoticeCard, NoticeButton } from '@/components/NoticeCard';
import { releaseHighlights } from '@/lib/releaseHighlights';
import { useAttentionTurn } from '@/lib/attention';

/**
 * The notice that appears when an update is available (or downloading).
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
  // Waits its turn behind What's new and the Alpha card (lib/attention).
  const turn = useAttentionTurn('update', open && !!info);

  return (
    <AnimatePresence>
      {turn && info && (
        <NoticeCard
          icon={Sparkles}
          title="A new Cinderpaw is ready"
          line={`Version ${info.version} · takes a minute, then it restarts`}
          onClose={downloading ? undefined : dismiss}
          actions={downloading ? undefined : (
            <>
              <NoticeButton onClick={dismiss}>Later</NoticeButton>
              <NoticeButton primary onClick={() => void install()}>Update now</NoticeButton>
            </>
          )}
        >
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
          {downloading && (
            <div className="mt-3 space-y-1.5">
              <p className="text-xs text-text-muted flex items-center gap-1.5">
                <Download size={12} className="text-brand" /> Installing… {progress}%
              </p>
              <div className="h-1.5 rounded-full bg-bg-hover overflow-hidden">
                <div
                  className="h-full bg-brand transition-all duration-(--motion-slow)"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}
        </NoticeCard>
      )}
    </AnimatePresence>
  );
}
