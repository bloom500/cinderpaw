/**
 * RQT pre-release blockers (2026-07-12).
 *
 *   F8 — a session had no memory across a restart: WorkingMemory lived only
 *        in RAM, so a fresh AgentLoop over the SAME db started amnesiac even
 *        though every turn was already in episodic.
 *   F7 — `resume_get` always returned null: setCurrentTask/touchLastActive
 *        had no production caller (covered by the dispatch wiring; the store
 *        round-trip is asserted here).
 *   F6 — the agent had no way to WRITE a fact. `remember` is that path, and
 *        `recall` now reads facts back.
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
import { createRememberTool } from "../src/tools/builtin/remember.ts";
import { createRecallTool } from "../src/tools/builtin/recall.ts";
import { getCurrentTask, setCurrentTask, touchLastActive, getLastActive } from "../src/memory/resume.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

let restoreFetch: (() => void) | null = null;
afterEach(() => { restoreFetch?.(); restoreFetch = null; });

/** Records every prompt (and the tool schemas) the "model" was sent. */
function installPromptRecorder(): { prompts: unknown[][]; tools: string[][] } {
  const prompts: unknown[][] = [];
  const tools: string[][] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: unknown[];
      tools?: { function?: { name?: string }; name?: string }[];
    };
    prompts.push(body.messages ?? []);
    tools.push((body.tools ?? []).map((t) => t.function?.name ?? t.name ?? "").filter(Boolean));
    return new Response(
      JSON.stringify({ message: { content: "ok" }, prompt_eval_count: 1, eval_count: 1 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = original; };
  return { prompts, tools };
}

function buildRegistry(db: ReturnType<typeof openDatabase>): ToolRegistry {
  const audit = new AuditLog(db.raw);
  return new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger));
}

function buildAgent(db: ReturnType<typeof openDatabase>, registry = buildRegistry(db)): AgentLoop {
  const audit = new AuditLog(db.raw);
  const router = new InferenceRouter(
    { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
    audit.logger,
    db.raw,
  );
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
  return new AgentLoop(router, registry, episodic, {}, recall);
}

/** Stand-in for a tool an MCP server registers after the loop already exists. */
function lateTool(name: string) {
  return {
    manifest: { name, description: "a late-registered MCP tool", permissions: [], networkAccess: false },
    parameters: {},
    async execute() { return { ok: true, content: "late tool ran" }; },
  };
}

describe("MCP — tools registered after boot are actually callable", () => {
  // Live smoke found MCP tools discoverable via list_tools and accepted by
  // load_tool, yet never advertised to the model: the loop snapshotted the
  // schemas at construction, and boot starts the MCP servers with a
  // fire-and-forget connectAll() that registers them later.
  test("a late-registered tool reaches the model once the drawer loads it", async () => {
    const { tools } = installPromptRecorder();
    const db = openDatabase(":memory:");
    const registry = buildRegistry(db);
    const agent = buildAgent(db, registry);

    // MCP connects AFTER the AgentLoop is constructed.
    registry.register(lateTool("mcp_discord_login"));

    // Not core, so it is not advertised until the model pulls it in…
    await agent.handle("s-mcp", "hi", "m1", () => {});
    expect(tools.at(-1)).not.toContain("mcp_discord_login");

    // …and once load_tool enables it, it MUST appear as a callable function.
    await registry.call("load_tool", { names: ["mcp_discord_login"] }, "s-mcp");
    await agent.handle("s-mcp", "now use it", "m2", () => {});
    expect(tools.at(-1)).toContain("mcp_discord_login");
    db.close();
  });

  test("list_tools and the advertised schemas agree that an MCP tool is optional", async () => {
    // The two tier predicates used to disagree: list_tools called an mcp_ tool
    // optional while isCoreTool called it core.
    const { isCoreTool, isExtendedTool } = await import("../src/tools/tiers.ts");
    expect(isExtendedTool("mcp_discord_login")).toBe(true);
    expect(isCoreTool("mcp_discord_login")).toBe(false);
  });

  test("persona-only profile: new voice, owner toolset (multi-agent routing)", async () => {
    const { prompts, tools } = installPromptRecorder();
    const db = openDatabase(":memory:");
    const registry = buildRegistry(db);
    registry.register(lateTool("late_owner_tool")); // extended-style name → core by default
    const agent = buildAgent(db, registry);

    // No allowedTools → persona replaces the prompt but keeps the owner's
    // full advertised toolset (per-connector "different agent" routing).
    agent.registerProfile("discord-persona", { systemPrompt: "You are Spike, the ops bot." });
    agent.setSessionProfile("discord:123", "discord-persona");

    await agent.handle("discord:123", "hello", "m1", () => {});
    expect(JSON.stringify(prompts.at(-1))).toContain("Spike, the ops bot");
    // Owner-core tool still advertised — the persona did not restrict tools.
    expect(tools.at(-1)).toContain("late_owner_tool");
    db.close();
  });

  test("a profile's allow-list can name a tool registered after the profile", async () => {
    const { tools } = installPromptRecorder();
    const db = openDatabase(":memory:");
    const registry = buildRegistry(db);
    const agent = buildAgent(db, registry);

    agent.registerProfile("public", {
      systemPrompt: "shop bot",
      allowedTools: ["mcp_shop_lookup"],
    });
    agent.setSessionProfile("wa:cust", "public");
    registry.register(lateTool("mcp_shop_lookup"));

    await agent.handle("wa:cust", "do you sell shoes?", "m1", () => {});
    expect(tools.at(-1)).toContain("mcp_shop_lookup");
    db.close();
  });
});

describe("F8 — sessions survive a restart", () => {
  test("a fresh AgentLoop over the same db replays the session transcript", async () => {
    const { prompts } = installPromptRecorder();
    const db = openDatabase(":memory:");

    // Session 1: the user says something memorable.
    await buildAgent(db).handle("s-restart", "my codename is ZIMBRU-77", "m1", () => {});

    // "Restart": a brand-new AgentLoop, same database, same sessionId.
    await buildAgent(db).handle("s-restart", "what is my codename?", "m2", () => {});

    const lastPrompt = JSON.stringify(prompts.at(-1));
    expect(lastPrompt).toContain("ZIMBRU-77");
    db.close();
  });

  test("a session unknown to the db starts empty, not crashing", async () => {
    installPromptRecorder();
    const db = openDatabase(":memory:");
    await buildAgent(db).handle("s-fresh", "hello", "m1", () => {});
    db.close();
  });

  test("a tool-heavy session still replays its conversation turns", () => {
    // Regression: the rehydration LIMIT used to be applied over ALL roles, so
    // a session whose recent rows were tool results replayed none of the real
    // conversation — amnesia survived precisely for agentic sessions.
    const db = openDatabase(":memory:");
    const episodic = new EpisodicMemory(db.raw, new AuditLog(db.raw).logger);
    episodic.record("s-tools", "user", "my codename is ZIMBRU-77");
    episodic.record("s-tools", "assistant", "noted");
    for (let i = 0; i < 60; i++) episodic.record("s-tools", "tool", `read_file: chunk ${i}`);

    const replayed = episodic.conversation("s-tools", 40);
    expect(replayed.some((e) => e.content.includes("ZIMBRU-77"))).toBe(true);
    // The conversation turns are what `limit` counts — 60 tool rows must not
    // push the two real turns out of the window. That is this test's point and
    // it still holds.
    expect(replayed.filter((e) => e.role !== "tool")).toHaveLength(2);
    // Tool rows now come back too, and that is a deliberate reversal. Dropping
    // them produced a replayed transcript in which the agent had never opened a
    // file in its life; the model read that as the house style and stopped
    // opening files. Measured: same prompt, same tools, 1 tool call with no
    // history, 0 with these forty turns. The caller collapses them to a
    // one-line note — see replayedToolNote.
    expect(replayed.some((e) => e.role === "tool")).toBe(true);
    db.close();
  });

  test("the extractor's own observation notes are not replayed as assistant turns", () => {
    // The MemoryExtractor records its internal notes with role 'assistant'
    // under the live sessionId. Replaying them would feed the model its own
    // scratchpad as things it said out loud.
    const db = openDatabase(":memory:");
    const episodic = new EpisodicMemory(db.raw, new AuditLog(db.raw).logger);
    episodic.record("s-obs", "user", "hello");
    episodic.record("s-obs", "assistant", "hi there");
    episodic.record("s-obs", "assistant", "[obs:preference] likes tea\n  • drinks tea");

    const replayed = episodic.conversation("s-obs", 40);
    expect(replayed.some((e) => e.content.startsWith("[obs:"))).toBe(false);
    expect(replayed).toHaveLength(2);
    db.close();
  });

  test("the connector reply carries the warning, driven by the REAL loop", async () => {
    // The warning moved out of connectors.ts into the loop's exit. The tests
    // that used to cover it here drove a FAKE agent whose handleTurn returned
    // text without running the loop, which is exactly why they stayed green
    // while three surfaces shipped unmarked inventions. So this one drives
    // `runAgent` — the actual function Discord and WhatsApp call — over a real
    // AgentLoop, and asserts on what the person would receive.
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          message: { content: "I read src/core/quantum-scheduler.ts — it exports two constants." },
          prompt_eval_count: 1,
          eval_count: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    restoreFetch = () => { globalThis.fetch = original; };

    const db = openDatabase(":memory:");
    const { runAgent } = await import("../src/transports/connectors.ts");
    const { reply } = await runAgent(buildAgent(db), "discord:c1:u1", "what does it do?", "d-1");
    expect(reply).toContain("two constants");
    expect(reply).toContain("no file was opened");
    db.close();
    // 20s, not bun's default 5s. Its first run took 5394ms and failed on the
    // timeout alone, then passed seven times in a row at ~200ms — the cold cost
    // (tokenizer + module init) lands on whichever test runs first, and CI is
    // always cold. A flaky green is worse than no test.
  }, 20_000);

  test("an unsourced answer is marked on every surface, not just the connectors", async () => {
    // The warning lived in connectors.ts, so Discord and Slack got it and the
    // desktop, the TUI and /runtime/chat shipped the invention bare. Measured:
    // six live completions, three fabricated line counts for files that do not
    // exist, not one of them marked. `handle()` is the shared exit — assert
    // there and every surface is covered by construction.
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          message: { content: "I read src/core/quantum-scheduler.ts — it exports two constants." },
          prompt_eval_count: 1,
          eval_count: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    restoreFetch = () => { globalThis.fetch = original; };

    const db = openDatabase(":memory:");
    const answer = await buildAgent(db).handle("s-bare", "what does it do?", "m1", () => {});
    expect(answer).toContain("no file was opened");

    // …and the warning is NOT in the stored turn. It is the environment
    // talking; anything appended to the assistant's recorded text comes back
    // as the assistant's own voice on the next replay.
    const stored = new EpisodicMemory(db.raw, new AuditLog(db.raw).logger).conversation("s-bare", 40);
    const asst = stored.find((e) => e.role === "assistant");
    expect(asst?.content).toContain("two constants");
    expect(asst?.content).not.toContain("no file was opened");
    db.close();
  });

  test("the same answer with a tool call behind it is left alone", async () => {
    // The false-positive guard. `answerToolCalls` replaced the connector's
    // whole-run sum, so if it miscounts, every sourced answer gets accused —
    // and a warning that cries wolf is one people learn to skip.
    const original = globalThis.fetch;
    let nth = 0;
    globalThis.fetch = (async () => {
      nth += 1;
      const content =
        nth === 1
          ? '{"name": "list_tools", "args": {}}'
          : "I read src/core/quantum-scheduler.ts — it is the tick loop.";
      return new Response(
        JSON.stringify({ message: { content }, prompt_eval_count: 1, eval_count: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    restoreFetch = () => { globalThis.fetch = original; };

    const db = openDatabase(":memory:");
    const answer = await buildAgent(db).handle("s-sourced", "what does it do?", "m1", () => {});
    expect(nth).toBeGreaterThan(1); // the tool round actually happened
    expect(answer).not.toContain("no file was opened");
    db.close();
  });

  test("a replayed answer that opened nothing is replayed as unverified", async () => {
    // The turns the tool note cannot reach: there are no tool rows to name. On
    // the real poisoned session these were the MAJORITY — 8 answers about a
    // file with nothing behind them against 5 with — including "read X and
    // summarise" answered at length three times in a row. Replayed unmarked,
    // the transcript's house style is answering from memory, and the model
    // matched it: 0 tool calls in 3 of 3 runs where a clean session made 2-5.
    //
    // The claim can be in the QUESTION rather than the answer, which is the
    // shape here: asked about a named file, the model describes it and never
    // repeats the path.
    const { prompts } = installPromptRecorder();
    const db = openDatabase(":memory:");
    const episodic = new EpisodicMemory(db.raw, new AuditLog(db.raw).logger);
    episodic.record("s-unver", "user", "Read D:\\proj\\src\\scheduler.ts and summarise it");
    episodic.record("s-unver", "assistant", "It is the tick loop that walks ready state objects.");

    await buildAgent(db).handle("s-unver", "and now?", "m2", () => {});

    const messages = (prompts.at(-1) ?? []) as { role: string; content: string }[];
    // Matched on the marker, not the word "unverified" — the system prompt uses
    // that word too, and a substring assertion that broad passes for the wrong
    // reason.
    const marked = messages.filter((m) => m.content?.includes("[tool:earlier_answer]"));
    expect(marked).toHaveLength(1);
    expect(marked[0]!.content).toContain("unverified");
    // Environment voice, never the model's own — the lesson from the marker.
    expect(marked[0]!.role).toBe("user");
    expect(messages.some((m) => m.role === "assistant" && m.content.includes("[tool:earlier_answer]"))).toBe(false);
    db.close();
  });

  test("an answer with tools behind it is not marked unverified", async () => {
    // The false-positive guard. Marking a sourced answer would teach the
    // opposite lesson and make the note meaningless.
    const { prompts } = installPromptRecorder();
    const db = openDatabase(":memory:");
    const episodic = new EpisodicMemory(db.raw, new AuditLog(db.raw).logger);
    episodic.record("s-sourced-replay", "user", "Read D:\\proj\\src\\scheduler.ts and summarise it");
    episodic.record("s-sourced-replay", "tool", "read_file: export const x = 1");
    episodic.record("s-sourced-replay", "assistant", "It is the tick loop.");

    await buildAgent(db).handle("s-sourced-replay", "and now?", "m2", () => {});

    const messages = (prompts.at(-1) ?? []) as { role: string; content: string }[];
    expect(messages.some((m) => m.content?.includes("[tool:earlier_answer]"))).toBe(false);
    expect(messages.some((m) => m.content?.includes("[tool:earlier_tool_use]"))).toBe(true);
    db.close();
  });

  test("the replayed tool note never lands in the assistant's voice", async () => {
    // The note that puts tool use back into a replayed transcript was first
    // prefixed onto the assistant's answer. The model read forty turns of
    // answers opening with `[used read_file ×3]` and produced one of its own:
    // zero tool calls, a fabricated answer, and a receipt stapled to the front
    // of it. Evidence in the imitated channel is a template. So this asserts
    // the CHANNEL, not the wording.
    const { prompts } = installPromptRecorder();
    const db = openDatabase(":memory:");
    const episodic = new EpisodicMemory(db.raw, new AuditLog(db.raw).logger);
    episodic.record("s-voice", "user", "what does config.ts do?");
    episodic.record("s-voice", "tool", "read_file: export const x = 1");
    episodic.record("s-voice", "tool", "read_file: export const y = 2");
    episodic.record("s-voice", "assistant", "it exports two constants");

    await buildAgent(db).handle("s-voice", "and now?", "m2", () => {});

    const messages = (prompts.at(-1) ?? []) as { role: string; content: string }[];
    const carrying = messages.filter((m) => m.content?.includes("read_file ×2"));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.role).toBe("user");
    expect(carrying[0]!.content).toContain("[tool:earlier_tool_use]");
    expect(messages.some((m) => m.role === "assistant" && m.content.includes("read_file"))).toBe(false);
    db.close();
  });

  test("a cron session does not inherit the previous run's transcript", async () => {
    // `cron:${jobId}` is stable across runs but each run is independent.
    const { prompts } = installPromptRecorder();
    const db = openDatabase(":memory:");

    await buildAgent(db).handle("cron:7", "first run: the sky is ZIMBRU-77", "c1", () => {});
    await buildAgent(db).handle("cron:7", "second run: report status", "c2", () => {});

    expect(JSON.stringify(prompts.at(-1))).not.toContain("ZIMBRU-77");
    db.close();
  });
});

describe("F7 — memory resume round-trips through the meta table", () => {
  test("setCurrentTask / touchLastActive are readable by resume_get's readers", () => {
    const db = openDatabase(":memory:");
    expect(getCurrentTask(db.raw)).toBeNull();
    expect(getLastActive(db.raw)).toBeNull();

    setCurrentTask(db.raw, { title: "ship the release", ts: 1234, workspaceId: null });
    touchLastActive(db.raw, 5678);

    expect(getCurrentTask(db.raw)?.title).toBe("ship the release");
    expect(getLastActive(db.raw)).toBe(5678);
    db.close();
  });

  test("the loop reports owner turns on ANY surface, but not machine or public sessions", async () => {
    installPromptRecorder();
    const db = openDatabase(":memory:");
    const agent = buildAgent(db);
    const seen: string[] = [];
    agent.setUserTurnObserver((_s, text) => seen.push(text));

    // A connector conversation is the owner working — it must count. (This is
    // why the observer lives in the loop and not in dispatch: connectors call
    // agent.handle directly.)
    await agent.handle("whatsapp:owner", "renew the domain", "w1", () => {});
    // A cron run is not the user.
    await agent.handle("cron:7", "scheduled digest", "c1", () => {});
    // Neither is a customer talking to a public persona.
    agent.registerProfile("public", { systemPrompt: "you are a shop bot", allowedTools: [] });
    agent.setSessionProfile("whatsapp:customer", "public");
    await agent.handle("whatsapp:customer", "do you sell shoes?", "w2", () => {});

    expect(seen).toEqual(["renew the domain"]);
    db.close();
  });
});

describe("F6 — the agent can write memory", () => {
  test("remember stores a fact that recall reads back", async () => {
    const db = openDatabase(":memory:");
    const semantic = new SemanticMemory(db.raw, new AuditLog(db.raw).logger);

    const remember = createRememberTool(semantic);
    const written = await remember.execute({ key: "codename", value: "ZIMBRU-77" });
    expect(written.ok).toBe(true);

    // Fractal search finds nothing (fresh index) — the fact must still surface.
    const recall = createRecallTool(async () => [], semantic);
    const read = await recall.execute({ query: "what is my codename" });
    expect(read.ok).toBe(true);
    expect(read.content).toContain("ZIMBRU-77");
    db.close();
  });

  test("remember with forget deletes the fact", async () => {
    const db = openDatabase(":memory:");
    const semantic = new SemanticMemory(db.raw, new AuditLog(db.raw).logger);
    const remember = createRememberTool(semantic);

    await remember.execute({ key: "codename", value: "ZIMBRU-77" });
    await remember.execute({ key: "codename", forget: true });

    const read = await createRecallTool(async () => [], semantic).execute({ query: "codename" });
    expect(read.content).not.toContain("ZIMBRU-77");
    db.close();
  });

  test("recall finds a fact whose key is a short token", async () => {
    // The query filter used to drop every word of <= 2 chars, so 'id' / 'qr' /
    // a two-letter code — exactly the keys users ask about by name — could
    // never be matched, and the agent would claim it did not remember.
    const db = openDatabase(":memory:");
    const semantic = new SemanticMemory(db.raw, new AuditLog(db.raw).logger);
    await createRememberTool(semantic).execute({ key: "id", value: "ZIMBRU-77" });

    const read = await createRecallTool(async () => [], semantic).execute({
      query: "what is my id",
    });
    expect(read.content).toContain("ZIMBRU-77");
    db.close();
  });

  test("remember rejects a write with no value", async () => {
    const db = openDatabase(":memory:");
    const semantic = new SemanticMemory(db.raw, new AuditLog(db.raw).logger);
    const res = await createRememberTool(semantic).execute({ key: "k" });
    expect(res.ok).toBe(false);
    db.close();
  });
});
