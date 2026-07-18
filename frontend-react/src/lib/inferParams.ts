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

/**
 * Per-completion output ceiling. NOT a user setting — there is no Controls UI
 * for it, so sourcing it from the persisted store only pinned everyone to a
 * stale 4096 that truncated long answers mid-task (the "MiniMax stops writing"
 * report). 32768 (~24k words) never bites a real chat reply or report, is
 * within every target provider's output limit (so no 400s the way a blind
 * 128k would cause), and stacks with the agent loop's auto-continuation to an
 * effectively unlimited response. The real bound stays the context window.
 */
const MAX_OUTPUT_TOKENS = 32_768;

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
  const { temperature, top_p } = useModel.getState().inferParams;

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
    max_tokens: MAX_OUTPUT_TOKENS,
    system_prompt: systemPrompt,
    tools,
  };
}
