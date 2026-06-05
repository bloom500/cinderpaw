/**
 * Best-effort context-window size (in tokens) for a model, used by the live
 * context ring. This is a frontend heuristic — local models default to a
 * conservative window, cloud/BYOK models match their real published context so
 * the ring reflects actual headroom (e.g. MiniMax ~1M sits near-empty).
 *
 * Extend KNOWN with new families as needed; order matters (first match wins).
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
/** Default window for an unknown cloud model (conservative). */
export const CLOUD_DEFAULT_CONTEXT = 32_768;

export function contextWindowFor(model: string | undefined, isLocal: boolean): number {
  if (model) {
    for (const [re, n] of KNOWN) if (re.test(model)) return n;
  }
  return isLocal ? LOCAL_DEFAULT_CONTEXT : CLOUD_DEFAULT_CONTEXT;
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
