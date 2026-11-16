// 16 Nov, "hive mind": a teammate the owner made (Agent Cowork) has fewer tools
// but is still the owner, so what is said to it is remembered for the whole
// team. A public profile (a stranger on WhatsApp) stays walled off.
import { afterEach, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { AgentLoop } from "../src/core/agent-loop.ts";
import { isRestrictedSession, resetSessionVisibility } from "../src/core/session-visibility.ts";

afterEach(() => resetSessionVisibility());

test("a teammate's words reach the team's memory; a stranger's do not", () => {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const registry = new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger));
  const router = new InferenceRouter({ primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
    tokenBudget: { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } }, audit.logger, db.raw);
  const episodic = new EpisodicMemory(db.raw, audit.logger, undefined, isRestrictedSession);
  const agent = new AgentLoop(router, registry, episodic, {}, null, null, null, null, null, null);

  agent.registerProfile("cowork:prices", { systemPrompt: "You are Prices.", allowedTools: ["recall"], owner: true });
  agent.setSessionProfile("cowork:prices", "cowork:prices");
  agent.registerProfile("lead", { systemPrompt: "Sales persona.", allowedTools: ["capture_lead"] });
  agent.setSessionProfile("whatsapp:shop:stranger", "lead");

  expect(isRestrictedSession("cowork:prices")).toBe(false);
  expect(isRestrictedSession("whatsapp:shop:stranger")).toBe(true);

  episodic.record("cowork:prices", "user", "My budget for headphones is 450 lei");
  episodic.record("whatsapp:shop:stranger", "user", "My card number is 4242");
  // What the main agent hears from the other chats: the teammate yes, the stranger no.
  const heard = episodic.since(0, "desktop:main").map((e) => e.content);
  expect(heard).toContain("My budget for headphones is 450 lei");
  expect(heard).not.toContain("My card number is 4242");
  db.close();
});
