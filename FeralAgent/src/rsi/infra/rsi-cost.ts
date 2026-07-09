/**
 * Thin token→USD layer for the passive RSI budget cap.
 *
 * The engine measures tokens; the user sets a dollar cap (Settings). Local
 * inference runs against the bundled loopback engine and is FREE — so a
 * loopback target is always $0 and the $0 default never halts a local run.
 * Cloud pricing is an approximate blended ($/1k tokens) estimate: a
 * conservative default plus a few known-model overrides. The estimate may
 * drift; the $0-on-local guarantee does not depend on it.
 */

/** Conservative blended price for an unknown cloud model ($/1k tokens).
 *  Deliberately high so an unknown paid model can never silently outspend
 *  the cap by a wide margin. */
const DEFAULT_CLOUD_PRICE_PER_1K = 0.01;

/** Known blended (input+output averaged) $/1k-token overrides. Substring
 *  match on the model id, lowercased. Keep small; tune as prices move. */
const PRICE_OVERRIDES: ReadonlyArray<readonly [match: string, pricePer1k: number]> = [
  ["gpt-4o-mini", 0.0004],
  ["gpt-4o", 0.0075],
  ["claude-haiku", 0.002],
  ["claude-sonnet", 0.009],
  ["claude-opus", 0.045],
  ["deepseek", 0.001],
  ["kimi", 0.0015],
  ["glm", 0.0015],
  ["minimax", 0.0015],
];

/** Blended price per 1k tokens. Loopback (local engine) ⇒ 0 (free). */
export function blendedPricePer1kUsd(modelId: string, isLoopback: boolean): number {
  if (isLoopback) return 0;
  const id = (modelId ?? "").toLowerCase();
  for (const [match, price] of PRICE_OVERRIDES) {
    if (id.includes(match)) return price;
  }
  return DEFAULT_CLOUD_PRICE_PER_1K;
}

/** Estimated USD for a token count at a given $/1k price. */
export function estimateUsd(totalTokens: number, pricePer1kUsd: number): number {
  if (!(totalTokens > 0) || !(pricePer1kUsd > 0)) return 0;
  return (totalTokens / 1000) * pricePer1kUsd;
}
