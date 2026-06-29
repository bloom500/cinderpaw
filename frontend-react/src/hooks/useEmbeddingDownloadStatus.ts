/**
 * Cold-start guard for the Fractal Memory Search embedding model (~130 MB).
 *
 * The `tauri.raw.downloadEmbeddingModel()` command is idempotent — it
 * returns immediately when the file already exists on disk, downloads in
 * the background otherwise, and emits three channels:
 *   - `feral://embedding-download-progress` (0..1 fraction)
 *   - `feral://embedding-download-complete` (final on-disk path)
 *   - `feral://embedding-download-error`    (failure reason)
 *
 * This hook folds those three into a single `EmbeddingDownloadState` so the
 * UI can render one of four clear shapes instead of:
 *   - "nothing happens" (the old fire-and-forget behaviour), or
 *   - an infinite spinner (if a listener forgets to handle the complete /
 *     error channels).
 *
 * Mount once near the app root. On the very first call we probe the model
 * presence by invoking `downloadEmbeddingModel()` — if the embedding is
 * already on disk, the Rust side returns `Ok(key)` without firing any of the
 * three events, so we treat "no event in 500 ms after a successful return"
 * as the `present` state.
 */
import { useEffect, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { tauri, events } from '@/lib/tauri';

export type EmbeddingDownloadState =
  /** Initial state before the probe completes. */
  | { kind: 'idle' }
  /** Embedding model is on disk — fractal recall is fully armed. */
  | { kind: 'present' }
  /** Download is in flight; `progress` is 0..1. */
  | { kind: 'downloading'; progress: number }
  /** Download failed; recall falls back to FTS5 keyword search. */
  | { kind: 'failed'; reason: string };

/** How long to wait after `downloadEmbeddingModel()` returns Ok before
 *  treating the absence of an event as "already present". The Rust side
 *  emits no event when the file exists, so this delay is the only signal. */
const PRESENT_PROBE_MS = 500;

export function useEmbeddingDownloadStatus(): EmbeddingDownloadState {
  const [state, setState] = useState<EmbeddingDownloadState>({ kind: 'idle' });

  useEffect(() => {
    let alive = true;
    let unlistens: UnlistenFn[] = [];
    let probeTimer: ReturnType<typeof setTimeout> | null = null;

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
      unlistens = [u1, u2, u3];

      // Probe: the Rust command is idempotent. If the model is on disk it
      // returns Ok with no events — we time out to 'present'. Otherwise it
      // returns Err("Download already in progress") OR starts streaming
      // events from the background task.
      try {
        await tauri.raw.downloadEmbeddingModel();
        probeTimer = setTimeout(() => {
          if (!alive) return;
          setState((s) => (s.kind === 'idle' ? { kind: 'present' } : s));
        }, PRESENT_PROBE_MS);
      } catch (err) {
        const msg = String(err);
        // "Download already in progress" means another caller (e.g. a
        // retry) is mid-download. The events will arrive — leave state
        // as 'idle' and let them move us to 'downloading'.
        if (msg.includes('already in progress')) return;
        setState({ kind: 'failed', reason: msg });
      }
    };

    void setup();

    return () => {
      alive = false;
      if (probeTimer !== null) clearTimeout(probeTimer);
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