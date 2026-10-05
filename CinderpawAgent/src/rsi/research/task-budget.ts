/**
 * S1.3a of the AgentLoop evolution spec (2026-10-04, §4.4, §17 S1.3): the
 * budget broker. Every model call an executor makes passes through here, so
 * tokens, tool calls and dollars are counted OUTSIDE the executor, which
 * cannot raise its own budget or under-report what it spent.
 *
 * RESEARCH ONLY (spec §4.7). Nothing in `rsi/research/` is wired into a live
 * path.
 *
 * Rules:
 *
 *   1. A limit passed is a failed task (`exhausted()` names which limit);
 *      every later call is refused without reaching the model.
 *   2. `max_tokens` is clamped to the output tokens left, so one answer
 *      cannot overshoot the output limit.
 *   3. A USD limit of 0 means a free model only. A priced model is refused
 *      before its first call, not after the first bill (same default as the
 *      campaign `usdCap`).
 *   4. Usage the provider does not report, or reports as nonsense, is charged
 *      as an estimate from the text. Never as zero: a silent provider must not
 *      make a task look free.
 *
 * Wall time is not here: the cell is killed at `maxWallMs` (S1.3b/c).
 */

import type { TaskBudget } from "./task-family.ts";

/** The OpenAI chat-completions request shape, as much of it as we read. */
export interface ChatBody {
  model: string;
  messages: unknown[];
  max_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: unknown;
}

export interface ChatAnswer {
  choices?: { message?: { content?: unknown; tool_calls?: unknown[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  [key: string]: unknown;
}

export interface BrokerModel {
  id: string;
  /** Dollars per million tokens. Both 0 = a free model (the stub). */
  usdPerMInput: number;
  usdPerMOutput: number;
  call(body: ChatBody): Promise<ChatAnswer>;
}

export interface BrokerUsage {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  usd: number;
  calls: number;
}

export type BrokerResult = { ok: true; answer: ChatAnswer } | { ok: false; reason: string };

/** ponytail: ~3 characters per token, rounded up. Deliberately on the high
 *  side (a real tokenizer gives ~4 for English): an estimate errs toward
 *  charging more. A per-model tokenizer if a campaign needs exact counts. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 3);

// A provider that reports 0 tokens for a call that happened is silent, not
// free: 0 is charged the estimate like a missing number.
const reported = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);

/** Text of a message's content, whether a string or OpenAI content parts. */
const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
      : "";

export class BudgetBroker {
  readonly #budget: TaskBudget;
  readonly #model: BrokerModel;
  readonly #used: BrokerUsage = { inputTokens: 0, outputTokens: 0, toolCalls: 0, usd: 0, calls: 0 };
  #exhausted: string | null = null;

  constructor(budget: TaskBudget, model: BrokerModel) {
    this.#budget = budget;
    this.#model = model;
  }

  usage(): BrokerUsage {
    return { ...this.#used };
  }

  /** Which limit was passed, or null while the task is inside its budget. */
  exhausted(): string | null {
    return this.#exhausted;
  }

  /** One call at a time: the limit check and the charge must not interleave,
   *  or N parallel requests all pass the check before any is charged. */
  complete(body: ChatBody): Promise<BrokerResult> {
    const next = this.#queue.then(() => this.#completeNow(body));
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #queue: Promise<void> = Promise.resolve();

  async #completeNow(body: ChatBody): Promise<BrokerResult> {
    const b = this.#budget;
    const m = this.#model;
    if (this.#exhausted) return { ok: false, reason: `budget exhausted: ${this.#exhausted}` };
    if (!Array.isArray(body?.messages)) return { ok: false, reason: "the request has no messages" };
    if (b.maxUsd === 0 && (m.usdPerMInput > 0 || m.usdPerMOutput > 0)) {
      return { ok: false, reason: `the task's USD limit is 0, so only a free model may run; ${m.id} is priced` };
    }

    // The whole body, not only the messages: tool definitions and system
    // fields are input the provider bills too.
    const inputEstimate = estimateTokens(JSON.stringify(body));
    if (this.#used.inputTokens + inputEstimate > b.maxInputTokens) {
      return this.#exhaust(`input tokens: this request (~${inputEstimate}) does not fit in what is left`);
    }
    const outputLeft = b.maxOutputTokens - this.#used.outputTokens;
    if (outputLeft <= 0) return this.#exhaust("output tokens");

    // The model is pinned here, not chosen by the executor: the price above
    // is this model's, and `n` > 1 would bill several answers as one.
    // Either output-limit name is clamped, and only max_tokens is sent (some
    // providers refuse a request carrying both).
    const { max_completion_tokens, ...rest } = body;
    const asked = Math.min(body.max_tokens ?? outputLeft, max_completion_tokens ?? outputLeft);
    const sent: ChatBody = { ...rest, model: m.id, n: 1, max_tokens: Math.min(asked, outputLeft) };
    let answer: ChatAnswer;
    try {
      answer = await m.call(sent);
    } catch (e) {
      // ponytail: a failed call is charged nothing; a provider that bills
      // failures would be under-counted here. Add its price if one does.
      return { ok: false, reason: `model call failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    const message = answer.choices?.[0]?.message;
    const input = reported(answer.usage?.prompt_tokens) ?? inputEstimate;
    const output = reported(answer.usage?.completion_tokens) ?? estimateTokens(JSON.stringify(message ?? ""));
    const u = this.#used;
    u.calls += 1;
    u.inputTokens += input;
    u.outputTokens += output;
    u.toolCalls += Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0;
    // Models without native tools write calls as text (egress/conformance.ts).
    u.toolCalls += contentText(message?.content).split("<tool_call>").length - 1;
    u.usd += (input * m.usdPerMInput + output * m.usdPerMOutput) / 1_000_000;

    if (u.inputTokens > b.maxInputTokens) this.#exhausted = "input tokens";
    else if (u.outputTokens > b.maxOutputTokens) this.#exhausted = "output tokens";
    else if (u.toolCalls > b.maxToolCalls) this.#exhausted = "tool calls";
    else if (u.usd > b.maxUsd) this.#exhausted = "USD";
    return { ok: true, answer };
  }

  #exhaust(limit: string): BrokerResult {
    this.#exhausted = limit;
    return { ok: false, reason: `budget exhausted: ${limit}` };
  }
}
