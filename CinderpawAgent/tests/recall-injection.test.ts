/**
 * Automatic recall injection — the read half of memory.
 *
 * The agent loop has always held a `Recaller`. Until now it only ever called
 * `noteWrite` on it: memory was written on every turn and read only if the
 * model happened to reach for the `recall` tool. On TheAgentCompany that came
 * out as 12 leaf-write pulses and zero recalls, and across a run of
 * independent tasks the carry from one task to the next was nil. The store was
 * never broken; nobody was asking it anything.
 *
 * These tests assert the ask actually happens and the answer actually reaches
 * the model, because "the wiring looks right" is exactly the claim that was
 * wrong for months. Both halves are checked against the real prompt bytes
 * leaving the process, not against an internal field.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { AgentLoop } from "../src/core/agent-loop.ts";
import type { Recaller } from "../src/core/agent-loop.ts";
import type { RecallResult } from "../src/memory/recall.ts";
import type { InferenceConfig } from "../src/types.ts";

const BASE_URL = "http://localhost:11434";

const BUDGET = {
  perConversation: 50_000,
  perDay: 500_000,
  onExhausted: "stop",
} as const;

let restoreFetch: (() => void) | null = null;
let restoreEnv: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  restoreEnv?.();
  restoreEnv = null;
});

/** Capture every request body the loop sends to the model. */
function installCapturingFetch(): { bodies: string[] } {
  const bodies: string[] = [];
  const original = globalThis.fetch;
  restoreFetch = () => (globalThis.fetch = original);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return new Response(
      JSON.stringify({ message: { content: "ok" }, prompt_eval_count: 5, eval_count: 3 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { bodies };
}

/** A Recaller that records what it was asked and answers with a fixed block. */
class SpyRecaller implements Recaller {
  readonly queries: Array<{ query: string; sessionId: string }> = [];
  constructor(private readonly context: string) {}
  recall(query: string, sessionId: string): RecallResult {
    this.queries.push({ query, sessionId });
    return { context: this.context, episodicHits: 1, semanticFacts: 0 };
  }
}

function buildAgent(recall: Recaller | null) {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const ps = new RealProcessSandbox(audit.logger);
  const registry = new ToolRegistry(egress, audit, ps);

  const config: InferenceConfig = {
    primary: { provider: "ollama", model: "m", baseUrl: BASE_URL },
    tokenBudget: BUDGET,
    trustedBaseUrls: [BASE_URL],
  };
  const router = new InferenceRouter(config, audit.logger, db.raw);
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const agent = new AgentLoop(router, registry, episodic, {}, recall);
  return { agent, db };
}

/** Set an env var for one test and restore it afterwards. */
function withEnv(name: string, value: string | undefined): void {
  const prev = process.env[name];
  restoreEnv = () => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  };
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("automatic recall injection", () => {
  test("the loop asks memory about the user's message, unprompted", async () => {
    const { bodies } = installCapturingFetch();
    const spy = new SpyRecaller("[Memory context]\nThe deploy key is in vault/prod.\n[End memory context]");
    const { agent, db } = buildAgent(spy);

    await agent.handle("s1", "where did we put the deploy key?", "m1", () => {});

    // Asked, without the model having called any tool to make it happen.
    expect(spy.queries).toHaveLength(1);
    expect(spy.queries[0]!.query).toBe("where did we put the deploy key?");
    expect(spy.queries[0]!.sessionId).toBe("s1");

    // And the answer actually left the process, in the request the model saw.
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies[0]).toContain("The deploy key is in vault/prod.");
    db.close();
  });

  test("an empty recall adds nothing to the prompt", async () => {
    const { bodies } = installCapturingFetch();
    const { agent, db } = buildAgent(new SpyRecaller(""));

    await agent.handle("s1", "hello", "m1", () => {});

    expect(bodies[0]).not.toContain("[Memory context]");
    db.close();
  });

  test("a recall that throws costs the turn nothing", async () => {
    // A memory store that is slow, locked or corrupt must degrade to a turn
    // without recall, never to a failed turn.
    const { bodies } = installCapturingFetch();
    const exploding: Recaller = {
      recall() {
        throw new Error("database is locked");
      },
    };
    const { agent, db } = buildAgent(exploding);

    const answer = await agent.handle("s1", "still works?", "m1", () => {});

    expect(answer).toBe("ok");
    expect(bodies.length).toBeGreaterThan(0);
    db.close();
  });

  test("CINDERPAW_RECALL_INJECTION=false restores the old tool-only behaviour", async () => {
    withEnv("CINDERPAW_RECALL_INJECTION", "false");
    installCapturingFetch();
    const spy = new SpyRecaller("[Memory context]\nsomething\n[End memory context]");
    const { agent, db } = buildAgent(spy);

    await agent.handle("s1", "anything", "m1", () => {});

    expect(spy.queries).toHaveLength(0);
    db.close();
  });

  test("a long recall is cut on a line boundary, never mid-fact", async () => {
    // Half a remembered fact is worse than none: the model cannot tell it is
    // reading half. The cap exists because a similarity search has no upper
    // bound on how much it can match.
    withEnv("CINDERPAW_RECALL_INJECTION_MAX_CHARS", "120");
    const { bodies } = installCapturingFetch();
    const lines = Array.from({ length: 40 }, (_, i) => `- fact number ${i} about the system`);
    const { agent, db } = buildAgent(new SpyRecaller(lines.join("\n")));

    await agent.handle("s1", "tell me", "m1", () => {});

    const body = bodies[0]!;
    expect(body).toContain("fact number 0");
    expect(body).not.toContain("fact number 39");
    // Whatever survived the cut is whole lines: no truncated final fact.
    const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
    const withRecall = parsed.messages.map((m) => m.content).join("\n");
    const factFragments = withRecall.match(/- fact number \d+ about the system/g) ?? [];
    const anyFactMention = withRecall.match(/- fact number \d+/g) ?? [];
    expect(factFragments.length).toBe(anyFactMention.length);
    db.close();
  });
});
