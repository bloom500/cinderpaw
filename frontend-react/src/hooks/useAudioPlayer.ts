import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Web Audio playback for recorded voice (Blob) or on-disk audio (URL).
 *
 * Why not a plain `<audio>` element: in the Tauri WebView2 runtime the HTML
 * media element fails to play MediaRecorder's `blob:` WebM/Opus output
 * (MEDIA_ELEMENT_ERROR code 4 + ERR_FILE_NOT_FOUND), even though Web Audio's
 * `decodeAudioData` decodes the very same bytes successfully. So we decode once
 * and play via an `AudioBufferSourceNode`, tracking progress off the context
 * clock. Works identically for the record preview and the persisted bubble.
 */
export function useAudioPlayer(source: Blob | string) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  /** Why playback failed, for the caller to show. Null when all is well. */
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const nodeRef = useRef<AudioBufferSourceNode | null>(null);
  const startedAtRef = useRef(0); // ctx.currentTime when the current node started
  const offsetRef = useRef(0); // seconds into the buffer where playback resumes
  const rafRef = useRef<number | null>(null);
  /** Latest `stopNode`, so the source-change effect can call it without taking
   *  the callback as a dependency (which would re-run it on every render). */
  const stopNodeRef = useRef<(() => void) | null>(null);

  // Re-decode if the source changes (e.g. re-record produces a new blob).
  useEffect(() => {
    // Stop the node too, not just the React state. Clearing `playing` while an
    // AudioBufferSourceNode was still connected left the OLD clip audible with
    // the UI showing paused — the user hears one recording and looks at
    // another. `stopNodeRef` rather than `stopNode` so this effect does not
    // re-run every time the callback identity changes.
    stopNodeRef.current?.();
    bufferRef.current = null;
    offsetRef.current = 0;
    setProgress(0);
    setPlaying(false);
  }, [source]);

  const ensureBuffer = useCallback(async () => {
    if (bufferRef.current) return bufferRef.current;
    const AC: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = ctxRef.current ?? (ctxRef.current = new AC());
    const arrayBuf =
      source instanceof Blob ? await source.arrayBuffer() : await (await fetch(source)).arrayBuffer();
    const buf = await ctx.decodeAudioData(arrayBuf);
    bufferRef.current = buf;
    return buf;
  }, [source]);

  const clearRaf = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const stopNode = useCallback(() => {
    if (nodeRef.current) {
      nodeRef.current.onended = null; // suppress the natural-end handler on manual stop
      try { nodeRef.current.stop(); } catch { /* already stopped */ }
      nodeRef.current = null;
    }
    clearRaf();
  }, []);

  stopNodeRef.current = stopNode;

  const tick = useCallback(() => {
    const ctx = ctxRef.current;
    const buf = bufferRef.current;
    if (!ctx || !buf) return;
    const elapsed = offsetRef.current + (ctx.currentTime - startedAtRef.current);
    setProgress(buf.duration > 0 ? Math.min(1, elapsed / buf.duration) : 0);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const play = useCallback(async () => {
    setError(null);
    try {
      const buf = await ensureBuffer();
      const ctx = ctxRef.current!;
      if (ctx.state === 'suspended') await ctx.resume();
      stopNode();
    const startOffset = offsetRef.current >= buf.duration ? 0 : offsetRef.current;
    offsetRef.current = startOffset;
    startedAtRef.current = ctx.currentTime;
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    node.onended = () => {
      setPlaying(false);
      offsetRef.current = 0;
      setProgress(0);
      clearRaf();
    };
      node.start(0, startOffset);
      nodeRef.current = node;
      setPlaying(true);
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      // `ensureBuffer` creates the AudioContext BEFORE it decodes, so a failed
      // decode — a corrupt blob, a codec the browser will not take — left a
      // context allocated with nothing playing. Chrome allows six per page, so
      // a handful of bad clips in one conversation and every later play() threw
      // on construction instead: the whole player dead, for the rest of the
      // session, with no message anywhere.
      if (ctxRef.current) {
        void ctxRef.current.close().catch(() => undefined);
        ctxRef.current = null;
      }
      bufferRef.current = null;
      setPlaying(false);
      setProgress(0);
      throw err;
    }
  }, [ensureBuffer, stopNode, tick]);

  const pause = useCallback(() => {
    const ctx = ctxRef.current;
    const buf = bufferRef.current;
    if (ctx && buf) {
      offsetRef.current = Math.min(buf.duration, offsetRef.current + (ctx.currentTime - startedAtRef.current));
    }
    stopNode();
    setPlaying(false);
  }, [stopNode]);

  const toggle = useCallback(() => {
    if (playing) pause();
    // `void play()` swallowed the rejection: pressing play on an undecodable
    // clip did nothing at all, with no error and no state change, which reads
    // as a dead button. Surface it instead.
    else void play().catch((err: unknown) => setError(String(err)));
  }, [playing, pause, play]);

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      stopNode();
      void ctxRef.current?.close();
      ctxRef.current = null;
    };
  }, [stopNode]);

  return { playing, progress, toggle, error };
}
