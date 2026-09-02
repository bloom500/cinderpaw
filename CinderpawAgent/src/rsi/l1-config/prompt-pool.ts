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

/**
 * Index-aligned pool. Keep entries short — they ride on every turn.
 *
 * An entry earns its place only if it says something the base system prompt
 * does NOT already say. The first version of this pool failed that test: it
 * asked for conciseness, step-by-step work and format discipline, all three of
 * which the base prompt already instructs at length. Measured 2026-09-02, the
 * champion's style addendum landed 81% of the way into a 31k-character system
 * prompt, immediately after the base prompt's own "Be concise and direct.",
 * and the model's answer got LONGER (2340 chars vs 2226 for neutral). A pool
 * that restates the prompt gives evolution nothing to choose between, which is
 * why `systemPromptId` was a live-mapped lever with no measurable range.
 *
 * What is here instead are the dials the base prompt deliberately leaves open,
 * where the right setting depends on the task and only a run can tell you:
 * how much to plan before acting, how readily to ask instead of deciding, and
 * when to abandon an approach rather than retry it. Those change what an agent
 * DOES on a long task, not how its prose reads.
 */
export const PROMPT_STYLE_POOL: readonly string[] = [
  // 0 — neutral: no addendum, the agent-as-shipped.
  "",
  // 1 — plan-first: pay an explicit planning step up front. Helps a task with
  //     several interacting parts, costs a turn on a task that had one step.
  "Before acting on a request with more than one step, write the plan as a short numbered list, then follow it and say which step you are on. Revise the list out loud when you learn something that changes it.",
  // 2 — decide-rather-than-ask: shifts where the ask/decide line sits. The
  //     base prompt tells the agent both to ask when it matters and not to ask
  //     about trivia; this pushes that boundary toward acting.
  "Prefer deciding to asking. When a choice is reversible, make it, say which way you went and why, and carry on; save questions for what you cannot undo or cannot know.",
  // 3 — change-approach-on-repeat-failure: governs recovery, which is the
  //     dominant cost on a long autonomous run.
  "When the same approach fails twice, stop repeating it. Say what you now believe is wrong, and try a different route rather than the same one with small variations.",
];

/** Resolve an id to its style text. Out-of-range / non-integer ids fall
 *  back to neutral — a corrupt champion must never poison the prompt. */
export function promptStyleFor(id: number): string {
  if (!Number.isInteger(id) || id < 0 || id >= PROMPT_STYLE_POOL.length) return "";
  return PROMPT_STYLE_POOL[id]!;
}
