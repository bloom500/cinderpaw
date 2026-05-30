import { tauri, type InferParams, type Settings } from '@/lib/tauri';
import { modelSupportsThinking } from '@/lib/modelUtils';
import type { ReasoningMode } from '@/stores/ui';
import { useModel } from '@/stores/model';

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
  enabledTools?: string[];
}): Promise<InferParams> {
  await ensureSettingsLoaded();

  const mode = opts?.reasoningMode ?? 'auto';
  const name = opts?.modelName ?? '';
  const { temperature, top_p, max_tokens } = useModel.getState().inferParams;

  const enableThinking =
    mode === 'on' ||
    (mode === 'auto' && modelSupportsThinking(name));

  const tools = opts?.enabledTools?.length ? opts.enabledTools : null;

  return {
    temperature,
    top_p,
    repeat_penalty: 1.1,
    max_tokens,
    system_prompt: enableThinking ? THINKING_SYSTEM_PROMPT : null,
    tools,
  };
}
