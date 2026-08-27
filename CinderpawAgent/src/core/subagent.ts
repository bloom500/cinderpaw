/**
 * Subagent — P0-1.
 *
 * A child `AgentLoop` spun up by the parent for an isolated, bounded
 * task. Pattern from Hermes `tools/delegate_tool.py` + OpenClaw's
 * `runEmbeddedAgent`. Key properties:
 *
 *   - Isolated `WorkingMemory` (child sessionId = `subagent:<parent>:<saId>`)
 *     so a runaway subagent cannot pollute the parent's transcript.
 *   - Filtered `ToolRegistry` — only the parent's tools the caller
 *     explicitly allows. A subagent never inherits the parent's full
 *     tool set, so a parent can delegate "research" without granting
 *     write access.
 *   - Bounded budget — `maxIterations` + `maxTokensPerCall` caps the
 *     worst-case resource use. Exceeding either returns
 *     `status: "failed"` with a short, safe-to-show error.
 *   - Hook integration — `subagent_spawn` fires before the run; a
 *     blocking result aborts the run cleanly. `subagent_complete`
 *     fires after, regardless of outcome.
 *   - Summary truncation — the parent's context is precious. The
 *     subagent's final answer is capped at MAX_SUMMARY_CHARS
 *     (default 4000, see the constant) so a 50k-char research dump
 *     doesn't dominate the parent's next turn.
 *
 * V1 tradeoffs:
 *   - We do not track per-subagent token usage; the shared
 *     `InferenceRouter` bills the subagent's sessionId but the
 *     returned total isn't surfaced through `AgentLoop.handle()`.
 *     P0-1 V1.1 will add a `tokens_used` event; for now the field
 *     is 0 unless the parent inspects the audit log.
 *   - The subagent does NOT do memory extraction, skill auto-create,
 *     or inner-thoughts. Pure compute, fire-and-forget.
 *   - The subagent's child WorkingMemory is discarded after the run.
 *     The audit log + episodic memory keep the trace; the working
 *     memory itself is not persisted (consistent with the parent's
 *     non-persistent working memory).
 */

import { randomUUID } from "node:crypto";
import { AgentLoop } from "./agent-loop.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { HookRegistry } from "./hook-registry.ts";
import type { AuditLog } from "../egress/audit-log.ts";
import { readEnv } from "../config.ts";
import type { EgressProxy } from "../egress/egress-proxy.ts";
import type { ProcessSandbox } from "../types.ts";
import type {
  InferenceRouter,
} from "../egress/inference-router.ts";
import type { ToolObservationLog } from "../telemetry/tool-observations.ts";
import type { EpisodicMemory } from "../memory/episodic.ts";
import type {
  SubagentConfig,
  SubagentResult,
  Tool,
} from "../types.ts";

/**
 * Cap on the answer returned to the parent so a chatty subagent doesn't
 * blow the parent's context budget.
 *
 * X4 fix: the previous 500-char cap truncated deep-research delegations
 * to two sentences, making `delegate_task` useless for anything but the
 * shallowest questions. Raised the default to 4,000 chars (≈1,000 tokens)
 * and made it configurable via env so power users / test setups can tune
 * it without a code change.
 *
 *   CINDERPAW_SUBAGENT_MAX_SUMMARY_CHARS=<int>   default 4000
 *
 * Set to a negative number to disable truncation entirely (use with
 * caution — a 50k-char subagent answer will land in the parent's next
 * prompt verbatim).
 */
const MAX_SUMMARY_CHARS = Number(
  readEnv("CINDERPAW_SUBAGENT_MAX_SUMMARY_CHARS") ?? 4000,
);

export interface SubagentDeps {
  router: InferenceRouter;
  /** All tools the parent has registered; subagent filters by name. */
  allTools: Tool[];
  audit: AuditLog;
  egress: EgressProxy;
  process: ProcessSandbox;
  observations: ToolObservationLog | null;
  episodic: EpisodicMemory;
  hooks: HookRegistry | null;
}

export class Subagent {
  readonly #router: InferenceRouter;
  readonly #allTools: Tool[];
  readonly #audit: AuditLog;
  readonly #egress: EgressProxy;
  readonly #process: ProcessSandbox;
  readonly #observations: ToolObservationLog | null;
  readonly #episodic: EpisodicMemory;
  readonly #hooks: HookRegistry | null;

  constructor(deps: SubagentDeps) {
    this.#router = deps.router;
    this.#allTools = deps.allTools;
    this.#audit = deps.audit;
    this.#egress = deps.egress;
    this.#process = deps.process;
    this.#observations = deps.observations;
    this.#episodic = deps.episodic;
    this.#hooks = deps.hooks;
  }

  /**
   * Run one subagent task end-to-end. Returns a structured result;
   * never throws.
   */
  async run(config: SubagentConfig): Promise<SubagentResult> {
    const subagentId = config.subagentId ?? `sa-${randomUUID().slice(0, 8)}`;
    const childSessionId = `subagent:${config.parentSessionId}:${subagentId}`;
    const startedAt = Date.now();
    let toolCallCount = 0;
    let tokensUsed = 0;

    // P0-4: subagent_spawn hook. A blocking handler aborts the run
    // before any model call is made.
    if (this.#hooks) {
      try {
        const r = await this.#hooks.fire("subagent_spawn", {
          parentSessionId: config.parentSessionId,
          subagentId,
          task: config.task,
          allowedTools: config.allowedTools,
        });
        if (r?.block) {
          return this.#wrap(
            {
              status: "failed",
              answer: `Subagent blocked by hook: ${r.reason}`,
              toolCalls: 0,
              tokensUsed: 0,
              durationMs: Date.now() - startedAt,
              subagentId,
            },
            config.parentSessionId,
            subagentId,
          );
        }
      } catch (err) {
        process.stderr.write(`[subagent] spawn hook fire failed: ${String(err)}\n`);
      }
    }

    // Filter tools. A tool the parent has but didn't list in
    // `allowedTools` is invisible to the subagent — the registry
    // rejects unknown names at call time anyway, but filtering
    // upstream keeps the system prompt honest (the LLM doesn't
    // see tools it can't call).
    const allowedSet = new Set(config.allowedTools);
    // Depth-1 recursion guard: a subagent can never delegate again, even
    // when the parent (or the model) lists it — unbounded spawn trees are
    // a budget bomb. Deliberate fan-out stays the PARENT's job.
    allowedSet.delete("delegate_task");
    const filteredTools = this.#allTools.filter((t) =>
      allowedSet.has(t.manifest.name),
    );

    // Build a child ToolRegistry with the filtered set. The registry
    // is constructed fresh — no shared state with the parent's
    // registry, so a subagent's tool signals and audit rows are
    // tagged with the child sessionId.
    const childRegistry = new ToolRegistry(
      this.#egress,
      this.#audit,
      this.#process,
      this.#observations ?? undefined,
      undefined,
      undefined,
      this.#hooks ?? undefined,
    );
    for (const t of filteredTools) {
      try {
        childRegistry.register(t);
      } catch (err) {
        // A duplicate-name collision is a programmer error; surface
        // it loudly rather than silently dropping the tool.
        process.stderr.write(
          `[subagent] failed to register "${t.manifest.name}": ${String(err)}\n`,
        );
      }
    }

    // Build the child AgentLoop. The same router is reused (separate
    // sessionId gives the subagent its own budget slice). The other
    // collaborators (recall, extractor, soul, user) are deliberately
    // null — a subagent starts with a clean slate.
    //
    const childAgent = new AgentLoop(
      this.#router,
      childRegistry,
      this.#episodic,
      {
        maxTokensPerCall: config.budget.maxTokens,
        onBudgetExhausted: "stop",
      },
      null,
      null,
      null,
      null,
      this.#hooks,
    );

    // Cancellation. `AgentLoop.stop()` is the path a user's Stop already takes
    // — it latches `ctx.stopped`, aborts the router and aborts the in-flight
    // tool — so routing the caller's signal into it reuses a hardened path
    // instead of adding a second, less-tested one.
    //
    // A signal that has ALREADY fired is checked before the first model call:
    // spawning a child for a turn the user just stopped would spend money on
    // an answer nobody is waiting for.
    if (config.signal?.aborted) {
      return this.#wrap(
        {
          status: "cancelled",
          answer: "Cancelled before the subagent started.",
          toolCalls: 0,
          tokensUsed: 0,
          durationMs: Date.now() - startedAt,
          subagentId,
        },
        config.parentSessionId,
        subagentId,
      );
    }
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      childAgent.stop(childSessionId);
    };
    config.signal?.addEventListener("abort", onAbort, { once: true });

    let errorMessage: string | null = null;
    try {
      const rawAnswer = await childAgent.handle(
        childSessionId,
        config.task,
        subagentId,
        (event) => {
          // Subagent events are observed to decide the final status (the
          // agent loop never throws — it converts errors into a returned
          // string and an `error` event) and forwarded to the caller's
          // observer so the parent can surface live progress.
          if (event.type === "tool_done") toolCallCount++;
          if (event.type === "error") {
            errorMessage = event.message;
          }
          try {
            config.onEvent?.(event);
          } catch {
            // A broken observer must never fail the run.
          }
        },
      );
      const summary = rawAnswer.length > MAX_SUMMARY_CHARS
        ? rawAnswer.slice(0, MAX_SUMMARY_CHARS) + "\n…(truncated)"
        : rawAnswer;
      // Status: if the agent loop emitted an error event, the run
      // failed (even though `handle()` returned a string). Otherwise
      // it's a completion. The "I reached the maximum number of
      // reasoning steps" text in `rawAnswer` also counts as a
      // failure — the subagent ran out of iterations.
      // A stopped run reports `cancelled` even though the loop returned a
      // string: it stopped because it was told to, and calling that `failed`
      // would send delegate_task's retry after work the user just abandoned.
      let status: SubagentResult["status"] = "completed";
      if (cancelled) status = "cancelled";
      else if (errorMessage) status = "failed";
      else if (
        /reached the maximum number of reasoning steps/i.test(rawAnswer) ||
        /completed \d+ actions but haven't been able to produce a final answer/i.test(rawAnswer)
      ) {
        status = "failed";
      }
      return this.#wrap(
        {
          status,
          answer: summary,
          toolCalls: toolCallCount,
          tokensUsed,
          durationMs: Date.now() - startedAt,
          subagentId,
        },
        config.parentSessionId,
        subagentId,
      );
    } catch (err) {
      return this.#wrap(
        {
          status: cancelled ? "cancelled" : "failed",
          answer: cancelled
            ? "Cancelled while the subagent was running."
            : `Subagent failed: ${String(err).slice(0, 500)}`,
          toolCalls: toolCallCount,
          tokensUsed,
          durationMs: Date.now() - startedAt,
          subagentId,
        },
        config.parentSessionId,
        subagentId,
      );
    } finally {
      // A parent signal outlives one child (a whole turn's worth of them), so
      // an un-removed listener is a leak that grows with every worker spawned.
      config.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Fire subagent_complete and return the result. Centralised so the
   *  hook fires on every exit path. */
  async #wrap(
    result: SubagentResult,
    parentSessionId: string,
    subagentId: string,
  ): Promise<SubagentResult> {
    if (this.#hooks) {
      try {
        await this.#hooks.fire("subagent_complete", {
          parentSessionId,
          subagentId,
          status: result.status,
          durationMs: result.durationMs,
        });
      } catch (err) {
        process.stderr.write(
          `[subagent] complete hook fire failed: ${String(err)}\n`,
        );
      }
    }
    return result;
  }
}
