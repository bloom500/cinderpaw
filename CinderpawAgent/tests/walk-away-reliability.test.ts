/**
 * Walk-away reliability: crash-resume checkpointing, write_file idempotency,
 * autonomous ask_user, and the end-of-turn decision audit.
 *
 * The through-line: a task you start and walk away from must survive a sidecar
 * death, must not redo finished side effects on resume, must not block on a
 * question with nobody there to answer, and must tell you what it decided
 * while you were gone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "../src/memory/checkpoint.ts";
import { WorkingMemory } from "../src/memory/working.ts";
import { openDatabase } from "../src/db.ts";
import { createWriteFileTool } from "../src/tools/builtin/write-file.ts";
import { createAskUserTool } from "../src/tools/builtin/ask-user.ts";
import { AgentLoop } from "../src/core/agent-loop.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import type { ChatMessage, Tool, ToolContext, ToolManifest, ToolResult } from "../src/types.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;
const toolBlock = (name: string, args: Record<string, unknown>) =>
  "<tool_call>\n" + JSON.stringify({ name, args }) + "\n</tool_call>";

// ───────────────────────────────────────────── checkpointing (item 1)

describe("CheckpointStore", () => {
  test("a running turn is resumable; a finished one is not", () => {
    const db = openDatabase(":memory:");
    const store = new CheckpointStore(db.raw);
    const messages: ChatMessage[] = [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "step 1 done" },
      { role: "tool", name: "write_file", content: "Written 40 bytes to /x" },
    ];
    store.save({ sessionId: "s1", messageId: "m1", iteration: 7, messages });

    const running = store.loadRunning("s1");
    expect(running).not.toBeNull();
    expect(running!.iteration).toBe(7);
    expect(running!.messages).toHaveLength(3);
    // The tool result is preserved in full — the whole point vs lossy episodic.
    expect(running!.messages[2]!.content).toContain("Written 40 bytes");
    expect(store.incomplete().map((r) => r.sessionId)).toEqual(["s1"]);

    store.markDone("s1");
    expect(store.loadRunning("s1")).toBeNull();
    expect(store.incomplete()).toHaveLength(0);
    db.close();
  });

  test("each save overwrites the last — only the latest state resumes", () => {
    const db = openDatabase(":memory:");
    const store = new CheckpointStore(db.raw);
    store.save({ sessionId: "s", messageId: "m", iteration: 1, messages: [{ role: "user", content: "a" }] });
    store.save({ sessionId: "s", messageId: "m", iteration: 2, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] });
    const r = store.loadRunning("s");
    expect(r!.iteration).toBe(2);
    expect(r!.messages).toHaveLength(2);
    db.close();
  });

  test("WorkingMemory.restore rehydrates a full transcript, dropping system rows", () => {
    const mem = new WorkingMemory("SYSTEM PROMPT");
    mem.restore([
      { role: "system", content: "stale system" },
      { role: "user", content: "hi" },
      { role: "tool", name: "grep", content: "match at line 5" },
    ]);
    const rendered = mem.render();
    // The WorkingMemory's own system prompt is used, not the stored one.
    expect(rendered[0]).toEqual({ role: "system", content: "SYSTEM PROMPT" });
    expect(rendered.some((m) => m.content === "stale system")).toBe(false);
    // Tool row survived — this is what episodic replay could not give.
    expect(rendered.some((m) => m.role === "tool" && m.content.includes("match at line 5"))).toBe(true);
  });

  test("corrupt checkpoint JSON resolves to null, never throws", () => {
    const db = openDatabase(":memory:");
    db.raw.query(
      "INSERT INTO session_checkpoint (session_id, message_id, iteration, messages, status, updated_at) VALUES ('s','m',1,'{not json','running',1)",
    ).run();
    const store = new CheckpointStore(db.raw);
    expect(store.loadRunning("s")).toBeNull();
    db.close();
  });
});

// ───────────────────────────────────────────── write_file idempotency (item 2)

describe("write_file is idempotent", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "feral-wf-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("re-writing identical content is a skipped no-op", async () => {
    const tool = createWriteFileTool([dir]);
    const ctx = { sessionId: "s", manifest: tool.manifest } as unknown as ToolContext;
    const path = join(dir, "out.txt");

    const first = await tool.execute({ path, content: "hello" }, ctx);
    expect(first.ok).toBe(true);
    expect((first.data as { skipped?: boolean }).skipped).toBeUndefined();

    // Make the mtime observable: if it rewrote, mtime changes.
    const mtime1 = readFileSync(path); // content check below is the real assertion
    const second = await tool.execute({ path, content: "hello" }, ctx);
    expect(second.ok).toBe(true);
    expect((second.data as { skipped?: boolean }).skipped).toBe(true);
    expect(second.content).toContain("Unchanged");
    expect(readFileSync(path, "utf8")).toBe("hello");
    void mtime1;

    // Different content still writes.
    const third = await tool.execute({ path, content: "goodbye" }, ctx);
    expect((third.data as { skipped?: boolean }).skipped).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("goodbye");
  });
});

// ───────────────────────────────────────────── autonomous ask_user (item 4)

describe("autonomous ask_user does not block", () => {
  afterEach(() => { delete process.env.CINDERPAW_AUTONOMOUS; });

  const questions = [{
    question: "Which format?",
    options: [{ label: "JSON", recommended: true }, { label: "CSV" }],
    multiSelect: false,
  }];

  test("with CINDERPAW_AUTONOMOUS it takes the recommended option and never calls the bridge", async () => {
    process.env.CINDERPAW_AUTONOMOUS = "true";
    const tool = createAskUserTool();
    let bridgeCalled = false;
    // A bridge that would HANG forever if consulted — proves we never wait.
    const ctx = {
      sessionId: "s",
      askUser: { ask: () => { bridgeCalled = true; return new Promise(() => {}); }, cancel: () => {} },
    } as unknown as ToolContext;

    const r = await tool.execute({ questions }, ctx);
    expect(r.ok).toBe(true);
    expect(bridgeCalled).toBe(false);
    const data = r.data as { autoResolved?: boolean; answers?: Array<{ selected?: string[] }> };
    expect(data.autoResolved).toBe(true);
    expect(data.answers?.[0]?.selected).toEqual(["JSON"]);
  });

  test("autonomous works even with NO bridge (headless walk-away)", async () => {
    process.env.CINDERPAW_AUTONOMOUS = "true";
    const tool = createAskUserTool();
    const ctx = { sessionId: "s" } as unknown as ToolContext; // no askUser
    const r = await tool.execute({ questions }, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as { autoResolved?: boolean }).autoResolved).toBe(true);
  });

  test("without the flag and no bridge, it still fails closed (unchanged default)", async () => {
    const tool = createAskUserTool();
    const ctx = { sessionId: "s" } as unknown as ToolContext;
    const r = await tool.execute({ questions }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no_ask_user_bridge");
  });
});

// ─────────────────────────── end-to-end through the agent loop (items 1 + 5)

/** Minimal loop harness over a scripted model. */
function loopHarness(script: string[]) {
  let callIdx = 0;
  const sentBodies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sentBodies.push(String(init?.body ?? ""));
    const content = script[Math.min(callIdx, script.length - 1)] ?? "done.";
    callIdx++;
    return new Response(
      JSON.stringify({ message: { content }, prompt_eval_count: 10, eval_count: 5 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const router = new InferenceRouter(
    { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
    audit.logger, db.raw,
  );
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
  const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));
  const checkpoints = new CheckpointStore(db.raw);
  const agent = new AgentLoop(router, registry, episodic, {}, recall);
  agent.setCheckpointStore(checkpoints);
  return { db, registry, agent, checkpoints, sentBodies, restore: () => { globalThis.fetch = originalFetch; } };
}

const echoTool = (name: string): Tool => ({
  manifest: { name, description: "echo", permissions: [], networkAccess: false } as ToolManifest,
  parameters: {},
  async execute(): Promise<ToolResult> { return { ok: true, content: `${name} ran` }; },
});

describe("agent loop crash-resume", () => {
  test("a completed turn leaves no running checkpoint", async () => {
    const h = loopHarness([toolBlock("noop", {}), "All done."]);
    try {
      h.registry.register(echoTool("noop"));
      await h.agent.handle("s1", "run noop then answer", "m1", () => {});
      // markDone fired on normal completion → nothing to resume.
      expect(h.checkpoints.loadRunning("s1")).toBeNull();
    } finally { h.restore(); h.db.close(); }
  });

  test("a session with a prior running checkpoint resumes that transcript", async () => {
    const h = loopHarness(["Picking up from the checkpoint."]);
    try {
      // Simulate a crash: a running checkpoint left by a dead process, holding a
      // tool result that episodic (truncated) would not carry faithfully.
      h.checkpoints.save({
        sessionId: "s2",
        messageId: "m0",
        iteration: 4,
        messages: [
          { role: "user", content: "build the report" },
          { role: "tool", name: "read_file", content: "SECRET_MARKER_42 found in config" },
        ],
      });
      await h.agent.handle("s2", "continue", "m1", () => {});
      // The resumed transcript — with the full tool result — was sent to the model.
      const all = h.sentBodies.join("\n");
      expect(all).toContain("SECRET_MARKER_42");
    } finally { h.restore(); h.db.close(); }
  });

  test("autonomous decisions are appended to the final answer as an audit block", async () => {
    process.env.CINDERPAW_AUTONOMOUS = "true";
    const h = loopHarness([
      toolBlock("ask_user", { questions: [{ question: "Deploy to prod?", options: [{ label: "Staging first", recommended: true }, { label: "Prod" }], multiSelect: false }] }),
      "I proceeded with staging.",
    ]);
    try {
      h.registry.register(createAskUserTool());
      const answer = await h.agent.handle("s3", "ship it", "m1", () => {});
      expect(answer).toContain("Decisions I made on your behalf");
      expect(answer).toContain("Deploy to prod?");
      expect(answer).toContain("Staging first");
    } finally { h.restore(); h.db.close(); delete process.env.CINDERPAW_AUTONOMOUS; }
  });
});
