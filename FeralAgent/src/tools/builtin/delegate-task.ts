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
      "token/iteration budget. Returns a short summary; for long " +
      "outputs the subagent must summarise before returning.",
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

      const r = await subagent.run({
        task,
        allowedTools,
        budget: { maxTokens, maxIterations },
        parentSessionId: deps.parentSessionIdFor(ctx.sessionId),
      });

      return {
        ok: r.status === "completed",
        content:
          `[subagent ${r.subagentId}] status=${r.status} ` +
          `toolCalls=${r.toolCalls} durationMs=${r.durationMs}\n\n` +
          r.answer,
        data: r,
        error: r.status === "completed" ? undefined : r.status,
      };
    },
  };
}
