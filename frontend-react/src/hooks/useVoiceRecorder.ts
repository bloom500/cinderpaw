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
    let gotStream = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      gotStream = true;
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
    } catch (err) {
      // Release the microphone. `getUserMedia` may well have SUCCEEDED and the
      // failure come from `new MediaRecorder(stream)` — WebView2 is picky about
      // MIME types — in which case the mic was already live and stayed live:
      // the OS recording indicator on, the driver capturing, and the user told
      // only that recording "didn't work".
      streamRef.current?.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* already ended */ }
      });
      streamRef.current = null;
      recorderRef.current = null;
      // And say which failure it was, by WHERE it happened rather than by the
      // error's type. If `getUserMedia` never handed us a stream, the microphone
      // was refused or missing — "denied" is the right thing to tell the user.
      // If we did get the stream and the failure came after, the microphone is
      // fine and the recorder could not encode: sending that person to their
      // permission settings wastes their time on something that is not wrong.
      setError(gotStream ? 'unsupported' : 'denied');
      setState('idle');
    }
  }, []);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const reset = useCallback(() => {
    // Detach the handler before stopping. `onstop` fires asynchronously, so a
    // reset while a recording was still finishing had its blob land afterwards
    // and put the hook back into `preview` — the recording the user had just
    // discarded reappearing on its own.
    const rec = recorderRef.current;
    if (rec) {
      rec.ondataavailable = null;
      rec.onstop = null;
      if (rec.state !== 'inactive') {
        try { rec.stop(); } catch { /* already stopped */ }
      }
    }
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
