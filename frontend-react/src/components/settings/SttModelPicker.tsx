import { useEffect, useState } from 'react';
import { Download, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { tauri, type SttModel } from '@/lib/tauri';
import { events } from '@/lib/tauri/events';
import { useUI } from '@/stores/ui';
import { useNotifications } from '@/stores/notifications';

/**
 * Pick the on-device transcription model, and get it onto the disk.
 *
 * The rows come from the binary (`stt_models`), never from a list in here. The
 * frontend ships as one bundle for every build and cannot know whether the
 * engine underneath it is Moonshine, whisper, or nothing at all — the old
 * picker offered whisper's "Small (466 MB)" to builds that had no whisper in
 * them, which is a row whose only outcome is a failure the user cannot act on.
 *
 * The download lives here rather than behind the microphone for the same
 * reason the size is on the row: on a fresh install this is hundreds of
 * megabytes, and the first time somebody learns that should not be while
 * holding the mic button waiting for a transcript that is minutes away.
 */
export function SttModelPicker() {
  const sttModel = useUI((s) => s.sttModel);
  const setSttModel = useUI((s) => s.setSttModel);

  const [models, setModels] = useState<SttModel[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const refresh = () =>
    tauri.voice
      .sttModels()
      .then(setModels)
      // An empty list, not a retained stale one. "The probe failed" and "this
      // build has no engine" lead to the same place for the user: there is
      // nothing here they can act on, and pretending otherwise offers a
      // download that cannot start.
      .catch(() => setModels([]));

  useEffect(() => {
    void refresh();
  }, []);

  // Listeners live while the section is mounted rather than while a download
  // runs: `listen` is async, and a fast first chunk would otherwise arrive
  // before anything was listening and leave the bar at zero.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const track = <T,>(
      channel: { listen: (cb: (e: { payload: T }) => void) => Promise<() => void> },
      handler: (payload: T) => void,
    ) => {
      void channel.listen((e) => handler(e.payload)).then((un) => {
        if (cancelled) un();
        else unlisteners.push(un);
      });
    };

    track(events.onSttDownloadProgress, (p: { progress: number }) => setProgress(p.progress));
    track(events.onSttDownloadComplete, () => {
      setProgress(null);
      void refresh();
    });
    track(events.onSttDownloadError, (p: { error: string; cancelled: boolean }) => {
      setProgress(null);
      // A cancel is the user's own doing and needs no toast; anything else is
      // the reason the model is still missing, and it belongs on screen rather
      // than in a log file nobody has open.
      if (!p.cancelled) useNotifications.getState().push('error', p.error);
      void refresh();
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((un) => un());
    };
  }, []);

  // The stored id can name a model this build has no engine for — an install
  // that once ran whisper has `'small'` saved. Falling back to the first row
  // keeps the picker showing what will actually be used.
  const selected = models?.find((m) => m.id === sttModel) ?? models?.[0] ?? null;

  const startDownload = async () => {
    if (!selected) return;
    setProgress(0);
    try {
      await tauri.voice.downloadModel(selected.id);
    } catch (err) {
      setProgress(null);
      useNotifications.getState().push('error', err instanceof Error ? err.message : String(err));
    }
  };

  if (models === null) return null;

  // No engine in this build. Said out loud, because the alternative is a
  // control that looks available and answers "voice-unavailable" on first use.
  if (models.length === 0) {
    return (
      <div>
        <p className="text-sm font-medium text-text-primary">Voice transcription</p>
        <p className="text-xs text-text-muted mt-0.5">
          This build has no on-device transcriber. Voice messages and calls can still use a cloud
          transcriber, chosen the first time you tap the microphone.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">Voice transcription</p>
          <p className="text-xs text-text-muted mt-0.5">
            On-device speech-to-text. Nothing leaves the machine.
          </p>
        </div>
        <select
          value={selected?.id ?? ''}
          onChange={(e) => setSttModel(e.target.value)}
          className="px-2 py-1.5 rounded-md border border-border-subtle bg-bg-surface text-sm text-text-primary"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {m.sizeMb} MB
            </option>
          ))}
        </select>
      </div>

      {progress !== null ? (
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Loader2 size={14} className="animate-spin" />
          Downloading {Math.round(progress * 100)}%
        </div>
      ) : selected?.present ? (
        <p className="text-xs text-text-muted flex items-center gap-1.5">
          <Check size={14} className="text-green-500" />
          Downloaded and ready.
        </p>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" className="gap-2" onClick={() => void startDownload()}>
            <Download size={14} />
            Download {selected?.sizeMb} MB
          </Button>
          <span className="text-xs text-text-muted">
            Needed before this model can transcribe anything.
          </span>
        </div>
      )}
    </div>
  );
}
