import { cachedLimitFor } from '@/lib/modelCatalog';

/**
 * Last-resort context windows, used only when the published catalog
 * (`modelCatalog.ts`) has no answer, e.g. on a machine that has never been
 * online. It is a guess by family and it goes stale: Claude is listed at
 * 200k here and Sonnet 4.5 has since shipped with 1M. The catalog wins.
 *
 * Order matters (first match wins).
 */
const KNOWN: Array<[RegExp, number]> = [
  [/minimax/i,                          1_000_000],
  [/gemini.*(1\.5|2\.|2-|flash|pro)/i,  1_000_000],
  [/claude/i,                             200_000],
  [/\bo1\b|\bo3\b|\bo4\b/i,               200_000],
  [/gpt-4o|gpt-4\.1|gpt-4-turbo/i,        128_000],
  [/llama.?3\.[1-3]/i,                    128_000],
  [/gpt-4(?![o.])/i,                        8_192],
  [/gpt-3\.5/i,                            16_385],
  [/deepseek/i,                            65_536],
  [/qwen.?(2\.5|3)/i,                      32_768],
  [/mistral|mixtral/i,                     32_768],
];

/** Default window for an unknown local model (most local GGUFs run 4k–8k). */
export const LOCAL_DEFAULT_CONTEXT = 8_192;

/**
 * The context window of a model, or `null` when nothing here knows it.
 *
 * `null` is the whole point of this signature. The old code answered 32,768 for
 * every cloud model it had not heard of, so a 200k GLM and a 1M Gemini both drew
 * a ring that was 'full' after a long file, and nothing on screen said the
 * number was invented. A local model keeps a default because a GGUF that is
 * loaded reports its real `ctx_len` anyway, and 8k is the honest shape of one
 * that is not.
 */
export function contextWindowFor(model: string | undefined, isLocal: boolean): number | null {
  if (model) {
    const published = cachedLimitFor(model);
    if (published) return published;
    for (const [re, n] of KNOWN) if (re.test(model)) return n;
  }
  return isLocal ? LOCAL_DEFAULT_CONTEXT : null;
}

/**
 * Is this target the on-device engine? Decided by the base URL, exactly like
 * the sidecar's `InferenceRouter.isPrimaryLocal` — NOT by the provider name.
 * BYOK providers (MiniMax, NVIDIA NIM, …) are wired through the
 * `openai_compatible` provider with a cloud base URL, so keying "local" off the
 * provider name classified every one of them as local.
 */
export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const h = new URL(baseUrl).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

export interface ActiveModelInputs {
  isAgentMode: boolean;
  /** Agent-mode target (provider + model + base_url). */
  cinderpawConfig?: { model?: string; base_url?: string } | null;
  /** Chat-mode cloud target. */
  cloudModel?: { modelId: string } | null;
  /** The local GGUF currently in memory, if any. `ctx_len` is its real KV cache. */
  loaded?: { name?: string; ctx_len?: number } | null;
}

/**
 * The context window of the model that will actually serve the next request.
 *
 * The rule that matters: a loaded local model's `ctx_len` is authoritative ONLY
 * when the local engine is the active target. A local GGUF often stays loaded as
 * the offline fallback while the agent talks to a cloud model — its 8192-token
 * KV cache says nothing about MiniMax's 1M window, and letting it win is what
 * pinned the ring to 8192 during cloud sessions.
 */
export function activeContextWindow(i: ActiveModelInputs): { model: string | undefined; isLocal: boolean; ctxWindow: number | null } {
  let model: string | undefined;
  let isLocal: boolean;

  if (i.isAgentMode) {
    model = i.cinderpawConfig?.model;
    isLocal = isLocalBaseUrl(i.cinderpawConfig?.base_url);
  } else if (i.cloudModel) {
    model = i.cloudModel.modelId;
    isLocal = false;
  } else {
    model = i.loaded?.name;
    isLocal = true;
  }

  const ctxWindow = isLocal
    ? (i.loaded?.ctx_len ?? contextWindowFor(model, true))
    : contextWindowFor(model, false);

  return { model, isLocal, ctxWindow };
}

/**
 * Rough token estimate for a body of text. Matches the chars/4 heuristic used
 * elsewhere in the app — good enough for a usage gauge, not for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface RemainingEstimate {
  freeTokens: number;
  msgsRemaining: number;
  showAsTokens: boolean;
}

const FALLBACK_AVG_TOKENS_PER_MSG = 200;

export function estimateRemaining(
  windowTokens: number,
  usedTokens: number,
  messageCount: number,
): RemainingEstimate {
  const freeTokens = Math.max(0, windowTokens - usedTokens);
  const avgPerMsg = messageCount > 0 ? usedTokens / messageCount : FALLBACK_AVG_TOKENS_PER_MSG;
  const msgsRemaining = Math.floor(freeTokens / avgPerMsg);
  return { freeTokens, msgsRemaining, showAsTokens: msgsRemaining < 1 };
}
