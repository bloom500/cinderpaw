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
import type { InferenceConfig } from "../src/types.ts";

const BASE_URL = "http://localhost:11434";
let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

function capture(): { systems: string[]; bodies: string[] } {
  const systems: string[] = [];
  const bodies: string[] = [];
  const original = globalThis.fetch;
  restoreFetch = () => (globalThis.fetch = original);
  globalThis.fetch = (async (_i: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    bodies.push(body);
    const msgs = (JSON.parse(body || "{}").messages ?? []) as { role: string; content: string }[];
    systems.push(msgs.find((m) => m.role === "system")?.content ?? "");
    return new Response(JSON.stringify({ message: { content: "ok" }, prompt_eval_count: 5, eval_count: 3 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { systems, bodies };
}

function agentWith(snapshot: (sid: string) => string, recall: Recaller | null = null) {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const registry = new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger));
  const config: InferenceConfig = {
    primary: { provider: "ollama", model: "m", baseUrl: BASE_URL },
    tokenBudget: { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" },
    trustedBaseUrls: [BASE_URL],
  };
  const router = new InferenceRouter(config, audit.logger, db.raw);
  const agent = new AgentLoop(router, registry, new EpisodicMemory(db.raw, audit.logger), {}, recall);
  const asked: string[] = [];
  agent.setMemorySnapshot((sid) => {
    asked.push(sid);
    return snapshot(sid);
  });
  return { agent, db, asked };
}

const SNAP = "## What you remember (today is 2026-09-27, Sunday)\nAbout the user:\n- name: Darius";

describe("memory snapshot in the system prompt", () => {
  test("built once, on the first turn, and identical on every turn after", async () => {
    const { systems } = capture();
    const { agent, db, asked } = agentWith(() => SNAP);
    await agent.handle("desk", "hi", "m1", () => {});
    await agent.handle("desk", "and again", "m2", () => {});
    expect(asked).toEqual(["desk"]);
    expect(systems[0]).toContain("- name: Darius");
    expect(systems[1]).toBe(systems[0]!);
    db.close();
  });

  test("a guest on a shared channel gets no snapshot", async () => {
    const { systems } = capture();
    const { agent, db, asked } = agentWith(() => SNAP);
    await agent.handle("discord:room:77", "hi", "m1", () => {});
    expect(asked).toEqual([]);
    expect(systems[0]).not.toContain("What you remember");
    db.close();
  });

  test("a cron session gets no snapshot", async () => {
    capture();
    const { agent, db, asked } = agentWith(() => SNAP);
    await agent.handle("cron:daily", "run", "m1", () => {});
    expect(asked).toEqual([]);
    db.close();
  });

  test("a throwing builder costs the turn nothing", async () => {
    const { systems } = capture();
    const { agent, db } = agentWith(() => {
      throw new Error("db locked");
    });
    await agent.handle("desk", "hi", "m1", () => {});
    expect(systems[0]).not.toContain("What you remember");
    db.close();
  });

  test("a fact the snapshot already shows is not repeated in the per-turn block", async () => {
    const { bodies } = capture();
    const recall: Recaller = {
      recall: () => ({ context: "[Memory context]\n- name: Darius\n- city: Iasi\n[End memory context]", episodicHits: 0, semanticFacts: 0 }),
    };
    const { agent, db } = agentWith(() => SNAP, recall);
    await agent.handle("desk", "hi", "m1", () => {});
    expect(bodies[0]!.split("- name: Darius").length - 1).toBe(1);
    expect(bodies[0]).toContain("- city: Iasi");
    db.close();
  });
});
