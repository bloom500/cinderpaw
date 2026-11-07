/**
 * Cold-start guard for the Fractal Memory Search embedding model (bge-m3 Q8_0, ~630 MB).
 *
 * The `tauri.raw.downloadEmbeddingModel()` command is idempotent — it
 * returns immediately when the file already exists on disk, downloads in
 * the background otherwise, and emits three channels:
 *   - `cinderpaw://embedding-download-progress` (0..1 fraction)
 *   - `cinderpaw://embedding-download-complete` (final on-disk path)
 *   - `cinderpaw://embedding-download-error`    (failure reason)
 *
 * This hook folds those three into a single `EmbeddingDownloadState` so the
 * UI can render one of four clear shapes instead of:
 *   - "nothing happens" (the old fire-and-forget behaviour), or
 *   - an infinite spinner (if a listener forgets to handle the complete /
 *     error channels).
 *
 * Mount once near the app root. It only listens: useDeferredMemoryModel
 * decides when the download starts.
 */
import { useEffect, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { events } from '@/lib/tauri';

export type EmbeddingDownloadState =
  /** Nothing heard yet: on disk already, or not started. */
  | { kind: 'idle' }
  /** Embedding model is on disk — fractal recall is fully armed. */
  | { kind: 'present' }
  /** Download is in flight; `progress` is 0..1. */
  | { kind: 'downloading'; progress: number }
  /** Download failed; recall falls back to FTS5 keyword search. */
  | { kind: 'failed'; reason: string };

export function useEmbeddingDownloadStatus(): EmbeddingDownloadState {
  const [state, setState] = useState<EmbeddingDownloadState>({ kind: 'idle' });

  useEffect(() => {
    let alive = true;
    let unlistens: UnlistenFn[] = [];

    const isEmbeddingEvent = (repoId: string): boolean => repoId === 'embedding';

    const setup = async (): Promise<void> => {
      // Listen to all three channels. Always filter by repoId so we don't
      // confuse an unrelated HF download with the embedding one.
      // `wrap<T>` events deliver Tauri's `Event<T>` envelope — read the payload
      // (matches the convention in stores/download.ts).
      const u1 = await events.onEmbeddingDownloadProgress.listen((e) => {
        if (!alive || !isEmbeddingEvent(e.payload.repoId)) return;
        setState({ kind: 'downloading', progress: clamp01(e.payload.progress) });
      });
      const u2 = await events.onEmbeddingDownloadComplete.listen((e) => {
        if (!alive || !isEmbeddingEvent(e.payload.repoId)) return;
        setState({ kind: 'present' });
      });
      const u3 = await events.onEmbeddingDownloadError.listen((e) => {
        if (!alive || !isEmbeddingEvent(e.payload.repoId)) return;
        // Don't surface a user-cancelled download as a failure — the user
        // asked for it. A genuine error (network, disk, hash mismatch)
        // surfaces the reason so the operator can investigate.
        if (!e.payload.cancelled) setState({ kind: 'failed', reason: e.payload.error });
      });
      // Register even if we were torn down mid-await: `unlistens` is assigned
      // only after all three resolve, so an unmount in between left the cleanup
      // with an empty list and all three listeners attached for good. `alive`
      // silences their handlers but nothing ever detaches them.
      unlistens = [u1, u2, u3];
      if (!alive) {
        for (const u of unlistens) {
          try { u(); } catch { /* already detached */ }
        }
        unlistens = [];
        return;
      }

      // No probe here: the only probe there is, `downloadEmbeddingModel()`,
      // STARTS the download when the file is missing, so calling it at mount
      // pulled ~600 MB on every first launch and undid useDeferredMemoryModel
      // (smoke test, 7 Nov). This hook only listens; the deferred hook decides
      // when the download starts.
    };

    void setup();

    return () => {
      alive = false;
      for (const u of unlistens) {
        try { u(); } catch { /* listener may already be detached */ }
      }
    };
  }, []);

  return state;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}