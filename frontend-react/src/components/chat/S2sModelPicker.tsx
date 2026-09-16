import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { SelectMenu } from '@/components/ui/select-menu';
import { tauri } from '@/lib/tauri';
import { useUI } from '@/stores/ui';

/**
 * Which realtime model a call runs on, for the vendor that is selected.
 *
 * The model used to be a constant in Rust (`S2S_PROVIDERS`), so a user who knew
 * that `gemini-3.8-live-extended-thinking` exists had nowhere to type it and no
 * way to reach it short of rebuilding the app. On a stranger's machine that
 * means never: the vendor ships a better live model and the app keeps calling
 * last year's.
 *
 * The list is asked of the vendor with the key already stored, so it is right
 * on a machine that installs this next year, and it falls back in Rust to the
 * one pinned in the build when there is no key or no network. Nothing is typed
 * by hand, which is the point: a live model id that is one character wrong does
 * not produce an error, it drops the socket and reads as a network fault.
 */
export function S2sModelPicker({ provider, label }: { provider: string; label: string }) {
  const chosen = useUI((s) => s.s2sModel[provider] ?? '');
  const setS2sModel = useUI((s) => s.setS2sModel);
  const [models, setModels] = useState<{ id: string; label: string }[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    tauri.raw
      .listS2sModels(provider)
      .then(setModels)
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [provider]);

  // Nothing to choose between: one model, or a build whose Rust side does not
  // have this command yet. A picker with a single fixed option is furniture.
  if (!models || models.length <= 1) return null;

  return (
    <div className="w-full max-w-sm">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-text-muted">{label} model</span>
        <button
          type="button"
          onClick={load}
          aria-label="Refresh the model list"
          className="p-1 rounded text-text-muted hover:text-text-secondary"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>
      <SelectMenu
        ariaLabel={`${label} realtime model`}
        value={chosen || models[0]!.id}
        onChange={(v) => setS2sModel(provider, v)}
        options={models.map((m) => ({ value: m.id, label: m.label }))}
      />
      {/* The vendor answering "yes I will open a session" is not the same as the
          model holding a conversation: gemini-3.5-transcribe-live is in Google's
          own list and only transcribes. Said here rather than learned from a
          call that connects and never speaks. */}
      <p className="mt-1 text-[11px] leading-snug text-text-muted opacity-70">
        Listed by {label}. A transcription-only model will connect and stay silent.
      </p>
    </div>
  );
}
