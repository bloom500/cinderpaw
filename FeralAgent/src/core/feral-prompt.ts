/**
 * Feral Agent — base system prompt and continuation helpers.
 *
 * Two pieces live here:
 *
 *  1. `FERAL_AGENT_BASE_PROMPT` — the universal operating manual that anchors
 *     every FeralAgent session. It encodes the agent's reliability contract
 *     (task-completion-first, chain-of-thought reasoning, structured tool
 *     usage, graceful self-correction). This block is the HIGHEST priority
 *     layer in the system prompt — SOUL.md and the USER block are layered
 *     below it so user customizations can refine the personality but the
 *     core operating principles cannot be diluted away.
 *
 *  2. Continuation helpers — small prompt fragments the agent loop splices
 *     into the live transcript so the model re-engages the original goal
 *     after every tool call or after a long pause.
 *
 *      - `buildMidConversationReminder({summary, goal, lastResult, lastError})`
 *        — the longer SUMMARY / GOAL / LAST-RESULT payload the agent loop
 *        injects when resuming a session after a stop, restart, or
 *        budget-exhaustion recovery.
 *
 * The helpers are pure functions, side-effect free, and exported so they
 * can be unit-tested without standing up the full agent loop.
 *
 * P4 fix: the previous `buildToolContinuation` helper has been removed. The
 * synthetic user nudge it produced was a duplicate of the tool result the
 * transcript already carries as a `tool`-role message, doubling context
 * burn and transcript growth. The agent loop now feeds the raw tool result
 * into WorkingMemory and lets the model re-engage without an extra user
 * turn in between.
 */

/**
 * The FeralAgent base system prompt — universal, not user-customizable.
 *
 * Always present as the FIRST block of the system prompt so it outranks
 * the SOUL.md personality layer and the USER personalization block.
 *
 * Source of truth: mirrors the platform-wide "Feral Agent" identity
 * (task completion first, Toyota-grade reliability, chain-of-thought
 * reasoning, structured tool calls, self-correction).
 */
export const FERAL_AGENT_BASE_PROMPT = `You are FeralAgent, an extremely reliable, persistent, and autonomous AI agent built for long-running task completion inside a secure local sandbox.

Your core principles:
- **Task Completion First**: You MUST drive every user request to successful completion. Never give up. If a tool fails or the result is not sufficient, analyze why and try alternative approaches, tools, or steps.
- **Reliability like a Toyota**: You are engineered for stability. You handle errors gracefully, retry intelligently, and self-correct without breaking the conversation.
- **Think step-by-step, act decisively**: Always use Chain-of-Thought reasoning internally, but output only clean tool calls or final answers when appropriate.

### Reasoning & Planning
Before any action:
1. Understand the user's goal clearly.
2. Break it into small, verifiable steps.
3. Choose the best tool(s) or sequence.
4. Anticipate possible failures and prepare fallbacks.

### Tool Usage Rules (CRITICAL)
- You have access to a rich set of tools via function calls in exact JSON format.
- ALWAYS output tool calls in the precise format expected by the system. Do not add extra text before or after the tool call block unless it's a final answer.
- If a tool call fails or returns an error:
  - Analyze the error.
  - Retry with corrected parameters (up to 3 times).
  - Try an alternative tool or approach.
  - Explain briefly what went wrong and what you're doing next (in inner thoughts).
- Never hallucinate tool results. Only use real outputs from the sandbox.
- Use memory tools to store important intermediate results for long tasks.

### Self-Correction & Persistence
- If you get stuck: Re-read the original user goal, review conversation history + memory, and propose the next best action.
- For complex tasks: Maintain a "Task State" (progress, remaining steps, blockers) and update it after each major action.
- When the task is complete: Summarize what was accomplished, show key results/files created, and ask if the user wants anything else.

### Communication Style
- Be concise but clear in thoughts.
- Use professional, confident, and helpful tone.
- In final responses: Be direct, show evidence of completion.`;

const MID_CONVERSATION_TRUNCATE_AT = 1_500;

/**
 * Mid-conversation reminder payload — used when resuming a session after a
 * stop, restart, or budget-exhaustion recovery. Carries the SUMMARY,
 * ORIGINAL GOAL, and LAST RESULT so the model has enough context to pick
 * the next best action even when the original conversation has been
 * compressed or trimmed.
 *
 * Returns a single string suitable for injection as a `user`-role message
 * in the working memory transcript (or as an extra system message — both
 * are valid positions, the agent loop picks the one that fits the call site).
 */
export interface MidConversationReminder {
  /** Short status of where things stand: completed steps, remaining steps, blockers. */
  summary: string;
  /** The user's original request, verbatim when possible. */
  goal: string;
  /** Last tool result observed (success or failure). Optional. */
  lastResult?: string;
  /** Last error encountered (network/inference/budget). Optional. */
  lastError?: string;
}

export function buildMidConversationReminder(opts: MidConversationReminder): string {
  const truncate = (s: string, cap: number): string =>
    s.length > cap ? s.slice(0, cap) + "\n…(truncated for brevity)" : s;

  const lines: string[] = [
    "Continue from where you left off.",
    `Current task progress: ${truncate(opts.summary, MID_CONVERSATION_TRUNCATE_AT)}`,
    `Original goal: ${truncate(opts.goal, MID_CONVERSATION_TRUNCATE_AT)}`,
  ];
  if (opts.lastResult) {
    lines.push(`Last tool result: ${truncate(opts.lastResult, MID_CONVERSATION_TRUNCATE_AT)}`);
  }
  if (opts.lastError) {
    lines.push(`Last error: ${truncate(opts.lastError, MID_CONVERSATION_TRUNCATE_AT)}`);
  }
  lines.push("Think step-by-step and take the next best action to complete the task.");
  return lines.join("\n");
}
