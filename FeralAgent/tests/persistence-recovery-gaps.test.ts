/**
 * Pre-release hardening (2026-07-31) — persistence/recovery evidence gaps.
 *
 * Blockers F8 (restart), F7 (memory resume) and F6 (memory write) already have
 * coverage in `release-blockers.test.ts`. This file closes the gaps between that
 * coverage and what the hardening mission's SESSION/PERSISTENCE + MEMORY TESTING
 * sections actually demand:
 *
 *   G1  WRITE → PROCESS RESTART → READ.
 *       F6 proves remember→recall inside ONE process against ONE SemanticMemory
 *       instance. That cannot distinguish a durable write from an in-memory one.
 *       The mission names this round-trip explicitly.
 *
 *   G2  Checkpoint precedence over episodic replay.
 *       `#memoryFor` prefers a running checkpoint over episodic because episodic
 *       truncates tool output to 400 chars. Both paths are tested individually;
 *       the ORDERING between them is not — and getting it wrong silently makes a
 *       resumed turn redo completed work with a lossy transcript.
 *
 *   G3  A resumed turn clears its checkpoint when it completes.
 *       Otherwise the same turn resumes forever — a crash-loop that looks like
 *       an agent stuck repeating itself.
 *
 *   G4  Memory scope is per-key and survives restart-with-overwrite, so a resumed
 *       session reads the LATEST value, not a stale one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { CheckpointStore } from "../src/memory/checkpoint.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { AgentLoop } from "../src/core/agent-loop.ts";
import { createRememberTool } from "../src/tools/builtin/remember.ts";
import { createRecallTool } from "../src/tools/builtin/recall.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

/** Records every prompt body the "model" was sent. */
function installPromptRecorder(): { bodies: string[] } {
  const bodies: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify({ message: { content: "ok" }, prompt_eval_count: 1, eval_count: 1 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  return { bodies };
}

function buildAgent(
  db: ReturnType<typeof openDatabase>,
  checkpoints?: CheckpointStore,
): AgentLoop {
  const audit = new AuditLog(db.raw);
  const registry = new ToolRegistry(
    new EgressProxy(audit.logger),
    audit,
    new RealProcessSandbox(audit.logger),
  );
  const router = new InferenceRouter(
    {
      primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
      tokenBudget: BUDGET,
    },
    audit.logger,
    db.raw,
  );
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
  const agent = new AgentLoop(router, registry, episodic, {}, recall);
  if (checkpoints) agent.setCheckpointStore(checkpoints);
  return agent;
}

describe("G1 — memory write survives a process restart", () => {
  test("WRITE → RESTART → READ: a fact written by one process is read by the next", async () => {
    const db = openDatabase(":memory:");

    // Process 1: write through its own SemanticMemory instance.
    const write = await createRememberTool(
      new SemanticMemory(db.raw, new AuditLog(db.raw).logger),
    ).execute({ key: "codename", value: "ZIMBRU-77" });
    expect(write.ok).toBe(true);

    // "Restart": brand-new SemanticMemory + brand-new recall tool over the SAME db.
    // Any value still held in process-local state is now gone.
    const readBack = await createRecallTool(
      async () => [],
      new SemanticMemory(db.raw, new AuditLog(db.raw).logger),
    ).execute({ query: "what is my codename" });

    expect(readBack.ok).toBe(true);
    expect(readBack.content).toContain("ZIMBRU-77");
    db.close();
  });

  test("a forget survives a restart too — the fact does not come back", async () => {
    const db = openDatabase(":memory:");
    const p1 = new SemanticMemory(db.raw, new AuditLog(db.raw).logger);
    await createRememberTool(p1).execute({ key: "codename", value: "ZIMBRU-77" });
    await createRememberTool(p1).execute({ key: "codename", forget: true });

    const readBack = await createRecallTool(
      async () => [],
      new SemanticMemory(db.raw, new AuditLog(db.raw).logger),
    ).execute({ query: "what is my codename" });

    expect(readBack.content).not.toContain("ZIMBRU-77");
    db.close();
  });

  test("G4 — an overwrite is what the next process reads, not the original", async () => {
    const db = openDatabase(":memory:");
    const p1 = new SemanticMemory(db.raw, new AuditLog(db.raw).logger);
    await createRememberTool(p1).execute({ key: "codename", value: "OLD-VALUE" });
    await createRememberTool(p1).execute({ key: "codename", value: "NEW-VALUE" });

    const readBack = await createRecallTool(
      async () => [],
      new SemanticMemory(db.raw, new AuditLog(db.raw).logger),
    ).execute({ query: "what is my codename" });

    expect(readBack.content).toContain("NEW-VALUE");
    expect(readBack.content).not.toContain("OLD-VALUE");
    db.close();
  });
});

describe("G2 — a running checkpoint takes precedence over episodic replay", () => {
  test("with BOTH a checkpoint and episodic history, the checkpoint wins", async () => {
    const rec = installPromptRecorder();
    const db = openDatabase(":memory:");
    const checkpoints = new CheckpointStore(db.raw);

    // Episodic history for this session (lossy — tool output truncated to 400 chars).
    await buildAgent(db).handle("s-prec", "EPISODIC_ONLY_MARKER", "m1", () => {});

    // A crash left a running checkpoint holding the faithful mid-turn transcript.
    checkpoints.save({
      sessionId: "s-prec",
      messageId: "m2",
      iteration: 3,
      messages: [
        { role: "user", content: "build the report" },
        { role: "tool", name: "read_file", content: "CHECKPOINT_MARKER_42" },
      ],
    });

    rec.bodies.length = 0;
    // Fresh loop over the same db, with the checkpoint store wired.
    await buildAgent(db, checkpoints).handle("s-prec", "continue", "m3", () => {});

    const sent = rec.bodies.join("\n");
    // The faithful checkpoint transcript is what the model got …
    expect(sent).toContain("CHECKPOINT_MARKER_42");
    // … and the lossy episodic replay did NOT get layered on top of it, which would
    // double-count the same session and invite the model to redo finished work.
    expect(sent).not.toContain("EPISODIC_ONLY_MARKER");
    db.close();
  });

  test("without a checkpoint, episodic replay still happens (no regression)", async () => {
    const rec = installPromptRecorder();
    const db = openDatabase(":memory:");
    const checkpoints = new CheckpointStore(db.raw);

    await buildAgent(db).handle("s-noc", "EPISODIC_ONLY_MARKER", "m1", () => {});

    rec.bodies.length = 0;
    await buildAgent(db, checkpoints).handle("s-noc", "continue", "m2", () => {});

    expect(rec.bodies.join("\n")).toContain("EPISODIC_ONLY_MARKER");
    db.close();
  });
});

describe("G3 — a resumed turn clears its checkpoint on completion", () => {
  test("resume → complete → no running checkpoint remains", async () => {
    installPromptRecorder();
    const db = openDatabase(":memory:");
    const checkpoints = new CheckpointStore(db.raw);

    checkpoints.save({
      sessionId: "s-clear",
      messageId: "m0",
      iteration: 2,
      messages: [{ role: "user", content: "half-done work" }],
    });
    expect(checkpoints.loadRunning("s-clear")).not.toBeNull();

    await buildAgent(db, checkpoints).handle("s-clear", "continue", "m1", () => {});

    // If this stays non-null the same turn resumes forever — a crash-loop that
    // presents as an agent endlessly repeating itself.
    expect(checkpoints.loadRunning("s-clear")).toBeNull();
    db.close();
  });
});
