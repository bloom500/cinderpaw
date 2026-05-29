import { tauri, type InferParams, type Settings } from '@/lib/tauri';
import { modelSupportsThinking } from '@/lib/modelUtils';
import type { ReasoningMode } from '@/stores/ui';

let cachedSettings: Settings | null = null;

export async function ensureSettingsLoaded(): Promise<Settings> {
  if (cachedSettings) return cachedSettings;
  cachedSettings = await tauri.settings.get();
  return cachedSettings;
}

const THINKING_SYSTEM_PROMPT =
  'Think step by step inside <think>...</think> before answering.';

export async function currentInferParams(opts?: {
  reasoningMode?: ReasoningMode;
  modelName?: string;
}): Promise<InferParams> {
  await ensureSettingsLoaded();

  const mode = opts?.reasoningMode ?? 'auto';
  const name = opts?.modelName ?? '';

  const enableThinking =
    mode === 'on' ||
    (mode === 'auto' && modelSupportsThinking(name));

  return {
    temperature: 0.8,
    top_p: 0.95,
    repeat_penalty: 1.1,
    max_tokens: 2048,
    system_prompt: enableThinking ? THINKING_SYSTEM_PROMPT : null,
  };
}
