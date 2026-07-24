/**
 * delegate_task — spawn a subagent for an isolated, bounded task.
 *
 * Pattern from Hermes `delegate_tool.py` + OpenClaw's `runEmbeddedAgent`.
 * The parent agent calls this when a sub-task should run with isolated
 * working memory, a filtered tool set, and its own budget. The
 * subagent's final answer is returned to the parent as a short
 * summary (capped at MAX_SUMMARY_CHARS so the parent's context
 * stays manageable).
 *
 * Permission: no fs/network/process declared. The subagent itself
 * receives a filtered ToolRegistry built from the parent's tools,
 * so the parent's permissions don't transitively extend.
 */

import { Subagent } from "../../core/subagent.ts";
import { ToolRegistry } from "../../tools/registry.ts";
import type { AuditLog } from "../../egress/audit-log.ts";
import type { EgressProxy } from "../../egress/egress-proxy.ts";
import type { ProcessSandbox } from "../../types.ts";
import type { InferenceRouter } from "../../egress/inference-router.ts";
import type { ToolObservationLog } from "../../telemetry/tool-observations.ts";
import type { EpisodicMemory } from "../../memory/episodic.ts";
import type { HookRegistry } from "../../core/hook-registry.ts";
import type { Tool, ToolManifest } from "../../types.ts";

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_TOKENS = 4096;
const ALLOWED_TOOLS_DEFAULT: string[] = [
  "read_file",
  "list_directory",
  "grep",
  "file_search",
  "web_search",
  "read_webpage",
  "fetch_url",
  "time_date",
  "calculator",
  "recall",
  "ask_user",
  "read_skill",
];

/** Factory — needs the parent's components so the subagent inherits
 *  the same router / sandbox / audit / hooks as the parent. */
export function createDelegateTaskTool(deps: {
  router: InferenceRouter;
  parentRegistry: ToolRegistry;
  allTools: Tool[];
  audit: AuditLog;
  egress: EgressProxy;
  process: ProcessSandbox;
  observations: ToolObservationLog | null;
  episodic: EpisodicMemory;
  hooks: HookRegistry | null;
  parentSessionIdFor(ctxSessionId: string): string;
}): Tool {
  const manifest: ToolManifest = {
    name: "delegate_task",
    description:
      "Spawn a subagent for a bounded, isolated task. The subagent " +
      "gets its own working memory, a filtered tool set, and a " +
      "token/iteration budget. IMPORTANT: by default the subagent gets " +
      "READ-ONLY tools (read_file, list_directory, grep, file_search, " +
      "web_search, read_webpage, fetch_url, recall, read_skill, …) — it " +
      "CANNOT write files, edit, or run commands unless you pass " +
      "`allowed_tools` explicitly. Delegate research freely; for work that " +
      "changes anything, list the tools it needs. Returns a short summary; " +
      "for long outputs the subagent must summarise before returning. " +
      "For a large task with INDEPENDENT parts, call delegate_task " +
      "once per part in the SAME response — the subagents run in " +
      "parallel and you assemble their summaries.",
    permissions: [],
    networkAccess: false,
  };

  const subagent = new Subagent({
    router: deps.router,
    allTools: deps.allTools,
    audit: deps.audit,
    egress: deps.egress,
    process: deps.process,
    observations: deps.observations,
    episodic: deps.episodic,
    hooks: deps.hooks,
  });

  return {
    manifest,
    parameters: {
      task: {
        type: "string",
        description: "What the subagent should do. Be specific and concise.",
        required: true,
      },
      allowed_tools: {
        type: "array",
        description:
          "Tool names the subagent may call. Default = safe read/research tools.",
      },
      max_iterations: {
        type: "number",
        description: "Cap on agent-loop iterations. Default 8.",
      },
      max_tokens: {
        type: "number",
        description: "Per-completion token cap. Default 4096.",
      },
    },
    async execute(args, ctx) {
      const task = args.task;
      if (typeof task !== "string" || !task.trim()) {
        return { ok: false, content: "delegate_task requires a non-empty 'task'.", error: "bad_args" };
      }
      // allowedTools: accept array of strings, default to safe set.
      const allowedTools = Array.isArray(args.allowed_tools)
        ? (args.allowed_tools as unknown[]).filter((t): t is string => typeof t === "string")
        : ALLOWED_TOOLS_DEFAULT;
      const maxIterations = typeof args.max_iterations === "number"
        ? Math.max(1, Math.min(50, Math.floor(args.max_iterations)))
        : DEFAULT_MAX_ITERATIONS;
      const maxTokens = typeof args.max_tokens === "number"
        ? Math.max(256, Math.min(16384, Math.floor(args.max_tokens)))
        : DEFAULT_MAX_TOKENS;

      // Live status on the PARENT's stream: every surface (desktop card,
      // TUI, Discord status line) renders tool_progress, so the delegation
      // shows what the child is doing instead of stalling silently.
      const onEvent = (event: { type: string; tool?: string }) => {
        if (event.type === "tool_start") {
          ctx.progress?.({ stage: "subagent", progress: null, message: `subagent → ${event.tool}` });
        } else if (event.type === "tool_done") {
          ctx.progress?.({ stage: "subagent", progress: null, message: `subagent ✓ ${event.tool}` });
        }
      };
      const base = {
        allowedTools,
        budget: { maxTokens, maxIterations },
        parentSessionId: deps.parentSessionIdFor(ctx.sessionId),
        onEvent,
      };

      let r = await subagent.run({ ...base, task });

      // One adjusted retry, mirroring what the parent would do by hand: hand
      // the child its own failure and require a different approach. Without
      // this the parent's only options were to re-delegate the identical task
      // (the loop this whole layer is meant to avoid) or give up. Bounded to
      // exactly one extra run so a failing delegation costs 2× at worst.
      if (r.status !== "completed") {
        ctx.progress?.({ stage: "subagent", progress: null, message: "subagent failed — retrying once" });
        const retry = await subagent.run({
          ...base,
          task:
            `${task}\n\n(Your previous attempt failed: ${r.answer.slice(0, 300)}\n` +
            "Take a DIFFERENT approach. If the task is impossible with the tools you have, " +
            "do not keep trying — say exactly which tool you needed and stop.)",
        });
        if (retry.status === "completed") {
          r = retry;
        } else {
          // Both failed: report both attempts. The parent needs to know it
          // was tried twice, not conclude the task is merely unlucky.
          return {
            ok: false,
            content:
              `[subagent ${r.subagentId}] failed twice (status=${retry.status}).\n` +
              `Attempt 1: ${r.answer.slice(0, 500)}\n` +
              `Attempt 2: ${retry.answer.slice(0, 500)}\n` +
              `The subagent had these tools: ${allowedTools.join(", ")}. ` +
              "If it needed a tool that is not in that list, re-delegate with an explicit `allowed_tools`, " +
              "or do the work yourself.",
            data: retry,
            error: retry.status,
          };
        }
      }

      return {
        ok: true,
        content:
          `[subagent ${r.subagentId}] status=${r.status} ` +
          `toolCalls=${r.toolCalls} durationMs=${r.durationMs}\n\n` +
          r.answer,
        data: r,
      };
    },
  };
}
