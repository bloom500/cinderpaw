/**
 * A deterministic model, so behaviour can be tested instead of described.
 *
 * Every unit test here already stubs `fetch` its own way, which means each one
 * re-invents the wiring and none of them describe BEHAVIOUR — they describe
 * functions. The gap that keeps costing us is between the two: "does a turn
 * that hits a token cutoff still deliver a whole answer", "does a run in
 * read-only mode refuse and say why", "does a stacked tool-call block execute
 * both calls". Those are answered by driving the real loop, real registry and
 * real tools against a scripted model.
 *
 * Scripted, not random: a scenario is a list of completions the model will
 * return, in order. What varies between runs is only what the code does with
 * them, which is the entire point — a harness whose model is unpredictable
 * cannot tell a regression from a bad day.
 *
 * Every scenario gets a fresh temp workspace and a fresh in-memory database,
 * so one leaving state behind cannot make the next one pass.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "../../src/core/agent-loop.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { AuditLog } from "../../src/egress/audit-log.ts";
import { EgressProxy } from "../../src/egress/egress-proxy.ts";
import { InferenceRouter } from "../../src/egress/inference-router.ts";
import { EpisodicMemory } from "../../src/memory/episodic.ts";
import { SemanticMemory } from "../../src/memory/semantic.ts";
import { RecallEngine } from "../../src/memory/recall.ts";
import { RealProcessSandbox } from "../../src/egress/process-sandbox.ts";
import { openDatabase } from "../../src/db.ts";
import { createReadFileTool } from "../../src/tools/builtin/read-file.ts";
import { createWriteFileTool } from "../../src/tools/builtin/write-file.ts";
import { createListDirectoryTool } from "../../src/tools/builtin/list-directory.ts";

const BUDGET = { perConversation: 200_000, perDay: 1_000_000, onExhausted: "stop" } as const;

/** One scripted completion. `finishReason: "length"` models a token cutoff. */
export interface Turn {
  content: string;
  finishReason?: "stop" | "length";
}

export interface Scenario {
  name: string;
  category: "baseline" | "file-tools" | "permissions" | "resilience";
  /** What this scenario proves, in the words of the failure it prevents. */
  proves: string;
  prompt: string;
  script: Turn[];
  /** Environment for this scenario only; restored afterwards. */
  env?: Record<string, string | undefined>;
}

export interface Outcome {
  /** The answer the user would have seen. */
  answer: string;
  /** Every request body the model was sent — what the agent said back to it. */
  sent: string[];
  /** The scenario's workspace, for asserting on files. */
  workspace: string;
  /** How many completions the loop asked for. */
  completions: number;
}

/** Encode a tool call the way the loop's parser expects to find one. */
export function toolCall(name: string, args: Record<string, unknown>): string {
  return `<tool_call>\n${JSON.stringify({ name, args })}\n</tool_call>`;
}

/**
 * Run one scenario end to end and report what happened.
 *
 * The tool registry gets the REAL file tools bound to the scenario workspace:
 * a harness whose tools are stubs proves the loop can talk to stubs.
 */
export async function runScenario(scenario: Scenario): Promise<Outcome> {
  const workspace = await mkdtemp(join(tmpdir(), `feral-parity-${scenario.name}-`));
  const savedEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(scenario.env ?? {})) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const originalFetch = globalThis.fetch;
  const sent: string[] = [];
  let index = 0;

  try {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(String(init?.body ?? ""));
      // Past the end of the script the model repeats its last word. A scenario
      // that runs longer than its script is a bug in the scenario, and this
      // makes it show up as a stuck assertion rather than a crash.
      const turn = scenario.script[Math.min(index, scenario.script.length - 1)]!;
      index++;
      // Scenarios are written before the workspace exists, and the file tools
      // require absolute paths — so `{{ws}}` stands in for the temp directory
      // and is substituted here, in the one place that knows it.
      // Backslashes are doubled because `{{ws}}` lands inside a JSON string in
      // the tool-call payload, and a Windows path would otherwise be read as
      // escape sequences by the parser.
      const content = turn.content.split("{{ws}}").join(workspace.replace(/\\/g, "\\\\"));
      // Shaped like a real terminal Ollama chunk, `done: true` included. The
      // streaming reader only harvests `done_reason` from a chunk that says it
      // is the last one, so a mock without it silently loses every cutoff
      // signal — and the scenario that exists to prove cutoffs are handled
      // would have passed for the wrong reason.
      return new Response(
        JSON.stringify({
          message: { content },
          done: true,
          done_reason: turn.finishReason ?? "stop",
          finish_reason: turn.finishReason ?? "stop",
          prompt_eval_count: 100,
          eval_count: 50,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const router = new InferenceRouter(
      {
        primary: { provider: "ollama", model: "parity", baseUrl: "http://localhost:11434" },
        tokenBudget: BUDGET,
      },
      audit.logger,
      db.raw,
    );
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
    const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));
    registry.register(createReadFileTool([workspace]));
    registry.register(createWriteFileTool([workspace]));
    registry.register(createListDirectoryTool([workspace]));

    const agent = new AgentLoop(router, registry, episodic, {}, recall);
    const answer = await agent.handle(
      `parity-${scenario.name}`,
      scenario.prompt,
      `m-${scenario.name}`,
      () => {},
    );
    return { answer, sent, workspace, completions: index };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
