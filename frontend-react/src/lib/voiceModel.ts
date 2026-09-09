import { tauri } from '@/lib/tauri';
import { useUI } from '@/stores/ui';

/**
 * Which on-device transcription model this machine should actually use.
 *
 * Not the stored setting on its own. The stored id was written by whatever
 * build the user ran last, and a build with a different engine offers different
 * ids — an install that once used whisper has `'small'` saved, and a Moonshine
 * build has no such model. Reaching for it produces "model-missing" forever,
 * with a Settings row that looks correct.
 *
 * So: the stored id if this build offers it, otherwise the first model the
 * build does offer, otherwise `null` — which means this build cannot transcribe
 * on the machine at all and the caller must not offer it.
 */
export async function resolveSttModel(): Promise<string | null> {
  let models;
  try {
    models = await tauri.voice.sttModels();
  } catch {
    // The probe failed rather than answered. Treat that as "no local engine":
    // the alternative is handing a model id to a binary that may not have one,
    // and the error the user then sees names a model instead of the problem.
    return null;
  }
  if (models.length === 0) return null;
  const stored = useUI.getState().sttModel;
  return models.some((m) => m.id === stored) ? stored : models[0].id;
}

/**
 * Make sure the on-device model is on disk, starting the download if not.
 *
 * `'unavailable'` means this build has no local engine, `'ready'` means it can
 * transcribe right now, and `'downloading-started'` means bytes are moving and
 * progress is on `cinderpaw://stt-download-*`.
 *
 * NOTE: this must NOT reuse the LLM `download_model` command — that writes to
 * the models dir and makes the frontend auto-load the file as a llama.cpp model.
 */
export async function ensureSttModel(): Promise<'ready' | 'downloading-started' | 'unavailable'> {
  const id = await resolveSttModel();
  if (!id) return 'unavailable';
  if (await tauri.voice.modelPresent(id)) return 'ready';
  await tauri.voice.downloadModel(id);
  return 'downloading-started';
}
