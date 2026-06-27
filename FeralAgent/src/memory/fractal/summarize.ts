/**
 * Module D — cluster summarizer.
 *
 * Wraps the existing `InferenceRouter` chat path so the tree builder can
 * caption each k-means cluster with a short thematic summary. We do NOT
 * add a new inference path — the production `InferFn` factory below binds
 * to `router.complete(...)` and reuses every router guarantee (token
 * budgets, audit, fallback, abort, etc.).
 *
 * The summarizer is intentionally narrow: a fixed instruction + the items
 * numbered + a soft 200-token target + a hard 800-character safety cap.
 * The cap is the last line of defense; the primary governor is the LLM's
 * `maxTokens` field passed by the prod factory. If a model ignores both,
 * we truncate so the tree builder never blows the prompt budget.
 */
import type { InferenceRouter } from "../../sandbox/inference-router.ts";
import { stripThinking } from "../../core/agent-loop.ts";

/**
 * Narrow inference injection: a function that takes a prompt and returns
 * a generated string. Production wires this to `InferenceRouter.complete`;
 * tests pass a mock.
 */
export type InferFn = (prompt: string) => Promise<string>;

/** Soft target for the LLM's per-call `maxTokens`. */
const MAX_TOKENS = 200;

/**
 * Generation budget passed to the router. Larger than {@link MAX_TOKENS}
 * because reasoning models (MiniMax-M3, DeepSeek-R1, VibeThinker, …) spend
 * their first hundreds of tokens inside a `<think>…</think>` block; with only
 * 200 tokens they truncate mid-thought and emit NO answer, so the bench
 * query-gen produced empty/garbage queries (and cluster summaries came back
 * empty). This leaves room to finish reasoning AND emit the answer; the
 * `<think>` block is stripped and the final text is still char-capped below.
 */
const GEN_MAX_TOKENS = 1024;

/**
 * Hard ceiling on the returned string, measured in characters. 200 tokens
 * ≈ 800 chars for English prose at ~4 chars/token. The actual output is
 * capped at `MAX_CHARS` *including* any trailing ellipsis, so we leave
 * one char of headroom when we cut.
 */
const MAX_CHARS = MAX_TOKENS * 4;
const CUT_CHARS = MAX_CHARS - 1; // reserve one char for the "…"

/** Dedicated session id so router telemetry groups all cluster captions. */
const SUMMARY_SESSION_ID = "fractal-summarize";

/**
 * Build the prompt sent to the LLM. Kept as a small named export so tests
 * (and future prompt-tuning iterations) can assert on its exact shape.
 */
export function buildSummaryPrompt(items: string[]): string {
  const numbered = items
    .map((text, i) => `${i + 1}. ${text}`)
    .join("\n");
  return [
    "You are summarizing a cluster of related memory items for a hierarchical",
    "retrieval index. Produce ONE concise thematic summary of the items below,",
    `in at most ${MAX_TOKENS} tokens. Preserve names, dates, and key entities.`,
    "Output ONLY the summary text — no preamble, no bullets, no headings.",
    "",
    "ITEMS:",
    numbered,
    "",
    "SUMMARY:",
  ].join("\n");
}

/**
 * Hard cap on the model's response. Truncates to the nearest preceding
 * whitespace so we never return a half-word. Appends an ellipsis when we
 * actually cut (the tree builder can detect this and decide whether to
 * re-summarize with a tighter prompt). Output length stays ≤ `MAX_CHARS`.
 */
function cap(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const slice = text.slice(0, CUT_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  const clean = lastSpace > CUT_CHARS * 0.5 ? slice.slice(0, lastSpace) : slice;
  return `${clean.trimEnd()}…`;
}

/**
 * Summarize a cluster of `items` into a short thematic caption via `infer`.
 * Throws on an empty items array (caller error — there is nothing to
 * summarize, and silently returning "" would mask a logic bug upstream).
 */
export async function summarizeCluster(
  items: string[],
  infer: InferFn,
): Promise<string> {
  if (items.length === 0) {
    throw new Error("summarizeCluster: items array is empty");
  }
  const prompt = buildSummaryPrompt(items);
  const raw = await infer(prompt);
  return cap(raw.trim());
}

/**
 * Production `InferFn` factory: binds the summarizer to the live
 * `InferenceRouter` via the standard `complete(...)` chat path. Reuses
 * router guarantees (per-session token budget, audit log, model fallback,
 * abort). `cachePrompt: false` because every call's items are different
 * (no stable prefix worth caching).
 */
export function routerInfer(router: InferenceRouter): InferFn {
  return async (prompt) => {
    if (!router.isPrimaryLocal) {
      // ponytail: warn each call; deduplicate in logs if noise — local-first means users should know
      console.warn(
        "[feral:privacy] cluster summarization is sending local memory to cloud model:",
        router.currentModel.model,
        "— set primary to a local engine to keep summaries on-device",
      );
    }
    const res = await router.complete({
      sessionId: SUMMARY_SESSION_ID,
      messages: [{ role: "user", content: prompt }],
      maxTokens: GEN_MAX_TOKENS,
      temperature: 0.1,
      cachePrompt: false,
    });
    // Reasoning models wrap their answer in `<think>…</think>` (often the
    // whole budget). Strip it so callers get the actual question/summary, not
    // the model's monologue — otherwise the bench embeds the reasoning blob as
    // the "query" (inflating latency and tanking recall) and summaries are
    // empty. Handles paired, orphan-close, and dangling-open variants.
    return stripThinking(res.content);
  };
}

/**
 * Production 1-arg `summarizeCluster` wrapper for the tree-builder. Closes
 * over a router so callers don't have to thread the `InferFn` themselves.
 * Result has the shape `BuildTreeDeps.summarize`.
 */
export function summarizeFromRouter(
  router: InferenceRouter,
): (items: string[]) => Promise<string> {
  const infer = routerInfer(router);
  return (items) => summarizeCluster(items, infer);
}
