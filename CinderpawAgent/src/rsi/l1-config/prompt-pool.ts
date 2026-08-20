/**
 * The SHARED system-prompt style pool — the versioned pool the genome's
 * `systemPromptId` indexes into, used identically by BOTH surfaces:
 *
 *   - eval:  `RsiSidecar.evalSystemPrompt(id)` (injected via
 *            `RsiSidecarDeps.systemPrompts` in boot.ts), so genomes are
 *            genuinely differentiated by prompt style during the dream
 *            cycle's eval suite;
 *   - live:  `mapGenomeToAgentConfig` resolves the champion's id to the
 *            same text and the AgentLoop appends it to the live system
 *            prompt (per-session, so a mid-session ratchet never
 *            invalidates an active KV cache).
 *
 * This is what makes `systemPromptId` a REAL transferable field instead
 * of an abstract index (the champion-bridge gap): what evolution judged
 * is exactly what the user's agent runs.
 *
 * Size MUST stay in sync with `systemPromptPoolSize` in sidecar.ts's
 * mutation grammar (asserted there at wiring time). Index 0 is the
 * neutral empty style so generation-0 genomes change nothing.
 */

/** Index-aligned pool. Keep entries short — they ride on every turn. */
export const PROMPT_STYLE_POOL: readonly string[] = [
  // 0 — neutral: no addendum, the agent-as-shipped.
  "",
  // 1 — concise-direct
  "Be maximally concise. Answer directly with no preamble, filler, or repetition.",
  // 2 — stepwise-verifier
  "For anything involving computation or multiple constraints, work through it step by step, double-check the result, then state the final answer clearly.",
  // 3 — format-strict
  "When a specific output format is requested (JSON, a bare value, a fixed schema), follow it exactly — no extra prose, no code fences unless asked.",
];

/** Resolve an id to its style text. Out-of-range / non-integer ids fall
 *  back to neutral — a corrupt champion must never poison the prompt. */
export function promptStyleFor(id: number): string {
  if (!Number.isInteger(id) || id < 0 || id >= PROMPT_STYLE_POOL.length) return "";
  return PROMPT_STYLE_POOL[id]!;
}
