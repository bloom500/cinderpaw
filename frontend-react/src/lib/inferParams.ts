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
  /**
   * Override the system prompt sent to the model. When set, this wins
   * over the default THINKING_SYSTEM_PROMPT — used by Agent mode to inject
   * the agent's system_prompt verbatim.
   */
  systemPromptOverride?: string | null;
}): Promise<InferParams> {
  await ensureSettingsLoaded();

  const mode = opts?.reasoningMode ?? 'auto';
  const name = opts?.modelName ?? '';
  const { temperature, top_p, max_tokens } = useModel.getState().inferParams;

  const enableThinking =
    mode === 'on' ||
    (mode === 'auto' && modelSupportsThinking(name));

  const tools = opts?.enabledTools?.length ? opts.enabledTools : null;

  // systemPromptOverride wins over the default thinking prompt. A
  // falsy value (null / undefined) falls through to the default.
  const systemPrompt =
    opts && 'systemPromptOverride' in opts
      ? (opts.systemPromptOverride ?? null)
      : (enableThinking ? THINKING_SYSTEM_PROMPT : null);

  return {
    temperature,
    top_p,
    repeat_penalty: 1.1,
    max_tokens,
    system_prompt: systemPrompt,
    tools,
  };
}
