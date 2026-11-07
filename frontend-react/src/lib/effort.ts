import type { Effort } from '@/stores/model';
import { isChatgptRoute } from '@/lib/localApi';
import { CHATGPT_ID } from '@/lib/chatgptSignIn';

// ponytail: a copy of ANTHROPIC_TAKES_EFFORT in
// CinderpawAgent/src/egress/inference-providers.ts; change both together.
const ANTHROPIC_TAKES_EFFORT =
  /^claude-(?:opus-4-[5-9]|sonnet-4-[6-9]|(?:opus|sonnet|haiku|fable|mythos)-[5-9](?:-\d+)?)(?:-\d{8})?$/;

/** Whether the engine passes Effort on to this model (anthropicEffort /
 *  openAIReasoning): newer Claude models, and anything through OpenRouter or a
 *  ChatGPT plan (its gateway hands it to OpenAI as reasoning effort). The
 *  provider ids cover the model menu, whose providers carry no URL when they
 *  use their default one. */
export function effortReaches(cfg: { provider: string; model: string; base_url?: string | null } | null): boolean {
  if (!cfg) return false;
  const url = cfg.base_url ?? '';
  if (cfg.provider === 'openrouter' || cfg.provider === CHATGPT_ID) return true;
  if (/openrouter\.ai/i.test(url) || isChatgptRoute(url)) return true;
  return (cfg.provider === 'anthropic' || /anthropic\.com/i.test(url)) && ANTHROPIC_TAKES_EFFORT.test(cfg.model);
}

export const EFFORTS: Array<{ id: Effort; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

/** The key a model's own Effort is kept under (useModel.effortByModel). */
export const effortKey = (provider: string, model: string) => `${provider}/${model}`;
