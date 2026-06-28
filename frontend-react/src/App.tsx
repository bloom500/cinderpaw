import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { Download } from 'lucide-react';
import { router } from './router';
import { tauri, events } from './lib/tauri';
import { useEmbeddingDownloadStatus } from '@/hooks/useEmbeddingDownloadStatus';
import { useNotifications } from '@/stores/notifications';
import { useModel } from '@/stores/model';

/**
 * Top-of-window banner for the in-flight embedding download. Pinned across
 * page navigation so a user who lands on /chat while the model is still
 * streaming in still sees the indicator. Disappears as soon as the model
 * is on disk (the 'present' state).
 */
function EmbeddingDownloadBanner({ state }: { state: ReturnType<typeof useEmbeddingDownloadStatus> }): JSX.Element | null {
  if (state.kind !== 'downloading') return null;
  const pct = Math.round(state.progress * 100);
  return (
    <div
      className="fixed top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full border border-border-subtle bg-bg-surface/85 px-3 py-1.5 text-xs text-text-secondary backdrop-blur shadow-lg"
      role="status"
      aria-live="polite"
    >
      <Download size={13} className="shrink-0 text-brand animate-pulse" />
      <span>
        Downloading embedding model… {pct}%
      </span>
      <span
        aria-hidden
        className="ml-1 h-1 w-16 overflow-hidden rounded-full bg-bg-muted"
      >
        <span
          className="block h-full bg-brand transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

export default function App() {
  // Cold-start guard for the Fractal Memory Search embedding model. The hook
  // listens to feral://embedding-download-* channels and surfaces one of four
  // clear states (idle/present/downloading/failed) instead of the old
  // fire-and-forget that left the user staring at a "recall doesn't work"
  // surface with no explanation.
  const embedding = useEmbeddingDownloadStatus();

  // Surface a single non-blocking toast on failure so the user knows
  // recall is on the FTS5 fallback without being asked to do anything.
  // Re-pushing on every state change would spam — only fire on the
  // idle → failed transition.
  useEffect(() => {
    if (embedding.kind !== 'failed') return;
    useNotifications.getState().push(
      'error',
      'Embedding model unavailable',
      'Recall will fall back to keyword search. Check your connection or restart once online.',
    );
  }, [embedding.kind]);

  // Tell the host process we're here; surfaces download progress / errors
  // in the right place. (Idempotent — no-op when the model is already on disk.)
  useEffect(() => {
    void tauri.raw.downloadEmbeddingModel().catch(() => {});
  }, []);

  // Auto-reload: when the Rust startup task finishes loading the last model,
  // it emits model-load-progress at 100% while isLoading=false. Sync the store.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    events.modelLoadProgressEvent.listen((e) => {
      if (e.payload.percentage >= 100 && !useModel.getState().isLoading) {
        void useModel.getState().refresh();
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  return (
    <>
      <EmbeddingDownloadBanner state={embedding} />
      <RouterProvider router={router} />
    </>
  );
}
