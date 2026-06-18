import { useCallback, useRef, useState } from 'react';

type RecState = 'idle' | 'recording' | 'preview';
type RecError = 'denied' | 'unsupported' | null;

export function useVoiceRecorder() {
  const [state, setState] = useState<RecState>('idle');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [error, setError] = useState<RecError>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('unsupported');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      console.log('[voice] getUserMedia tracks', (stream.getAudioTracks?.() ?? []).map((tr) => ({
        label: tr.label, enabled: tr.enabled, muted: tr.muted, readyState: tr.readyState,
      })));
      const rec = new MediaRecorder(stream);
      console.log('[voice] MediaRecorder created', { mimeType: rec.mimeType, state: rec.state });
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const b = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || 'audio/webm' });
        console.log('[voice] recorder.onstop', {
          chunks: chunksRef.current.length,
          chunkSizes: chunksRef.current.map((c) => c.size),
          blobSize: b.size,
          blobType: b.type,
          recorderMime: rec.mimeType,
        });
        setBlob(b);
        setDurationMs(Date.now() - startedAtRef.current);
        setState('preview');
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };
      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      rec.start();
      setState('recording');
    } catch {
      setError('denied');
      setState('idle');
    }
  }, []);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const reset = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    setBlob(null);
    setDurationMs(0);
    setState('idle');
    setError(null);
  }, []);

  return { state, start, stop, reset, blob, durationMs, error };
}
