/**
 * The installed skills reach the model on every turn.
 *
 * The host sends the roster with each message; the loop used to drop it
 * (`void skillsContext`) and leave discovery to `list_skills`, which Haiku
 * never called. A skill installed from a link was then used only when the
 * person typed its name (27 Oct, doc-coauthoring). This pins the wiring end
 * to end: roster in, menu in the request the provider receives.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { AgentLoop } from "../src/core/agent-loop.ts";
import type { SkillMeta } from "../src/types.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

let restoreFetch: (() => void) | null = null;
afterEach(() => { restoreFetch?.(); restoreFetch = null; });

/** Answers every call with plain text and keeps what the model was sent. */
function captureRequests(): string[] {
  const seen: string[] = [];
  const original = globalThis.fetch;
  restoreFetch = () => { globalThis.fetch = original; };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push(String(init?.body ?? ""));
    return new Response(
      JSON.stringify({ message: { content: "ok" }, prompt_eval_count: 10, eval_count: 5 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return seen;
}

function buildAgent() {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const router = new InferenceRouter(
    { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
    audit.logger,
    db.raw,
  );
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
  const registry = new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger));
  return { agent: new AgentLoop(router, registry, episodic, {}, recall), close: () => db.close() };
}

const coauthoring = {
  id: "doc-coauthoring",
  name: "doc-coauthoring",
  description: "Guide users through a structured workflow for co-authoring documentation.",
  author: "anthropic",
  version: "1",
  license: "MIT",
  tags: [],
  source_provider: "local",
  source_url: null,
  content_url: null,
  install_status: "installed",
  trust_label: "local",
  last_updated: null,
} as unknown as SkillMeta;

describe("installed skills reach the model", () => {
  test("the roster becomes a menu in the request, and an empty roster clears it", async () => {
    const seen = captureRequests();
    const { agent, close } = buildAgent();

    await agent.handle("s1", "Help me write a one-page proposal.", "m1", () => {}, [coauthoring]);
    const first = seen.at(-1)!;
    expect(first).toContain("Available skills (locally installed)");
    expect(first).toContain("doc-coauthoring");

    // Next message with nothing installed: the old menu must not linger.
    await agent.handle("s1", "Thanks.", "m2", () => {});
    expect(seen.at(-1)!).not.toContain("Available skills (locally installed)");
    expect(seen.at(-1)!).not.toContain("doc-coauthoring");
    close();
  });
});
