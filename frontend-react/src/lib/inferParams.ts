import { tauri, type InferParams, type Settings } from '@/lib/tauri';

let cachedSettings: Settings | null = null;

export async function ensureSettingsLoaded(): Promise<Settings> {
  if (cachedSettings) return cachedSettings;
  cachedSettings = await tauri.settings.get();
  return cachedSettings;
}

export async function currentInferParams(opts?: { enableThinking?: boolean }): Promise<InferParams> {
  await ensureSettingsLoaded();
  // Use sensible defaults; settings page (spec 4) will expose tuning controls
  return {
    temperature: 0.8,
    top_p: 0.95,
    repeat_penalty: 1.1,
    max_tokens: 2048,
    system_prompt: null,
    ...( opts?.enableThinking ? {} : {} ),
  };
}
