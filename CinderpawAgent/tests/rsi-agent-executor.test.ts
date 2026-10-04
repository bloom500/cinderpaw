/**
 * S1.3c of the AgentLoop evolution spec: the executor. It runs the real
 * sidecar on one task inside an executor cell, carries every model call
 * through the budget broker, and writes the ExecutorRun the orchestrator
 * keeps. Unit tests drive it with a fake cell and scripted processes; one
 * test runs the real sidecar in real Docker against a free stub model.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "../src/rsi/l3-code/code-sandbox.ts";
import { DockerIsolation, type ExecutorCell, type ExecutorCellSpec } from "../src/rsi/l3-code/isolation.ts";
import { runExecutor, toSse, type LineProc } from "../src/rsi/research/agent-executor.ts";
import type { BrokerModel } from "../src/rsi/research/task-budget.ts";
import type { AgentTask } from "../src/rsi/research/task-family.ts";

const dir = (files: Record<string, string> = {}) => {
  const d = mkdtempSync(join(tmpdir(), "exec-"));
  for (const [p, b] of Object.entries(files)) writeFileSync(join(d, p), b);
  return d;
};

const task = (over: Partial<AgentTask["budget"]> = {}): AgentTask => ({
  id: "t1",
  familyId: "f",
  templateId: "x",
  seed: 1,
  instruction: "Write the word done into out.txt.",
  workspaceImage: "a".repeat(64),
  budget: { maxInputTokens: 10_000, maxOutputTokens: 2_000, maxToolCalls: 10, maxWallMs: 10_000, maxUsd: 0, ...over },
  verifier: { kind: "file_exists", checkId: "out" },
});

const stub = (usage = { prompt_tokens: 100, completion_tokens: 20 }): BrokerModel => ({
  id: "stub",
  usdPerMInput: 0,
  usdPerMOutput: 0,
  call: async () => ({ choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }], usage }),
});

/** A scripted process: `onWrite` reacts to what the executor sends it. */
function scripted(onWrite: (line: string, self: ReturnType<typeof scripted>) => void = () => {}) {
  const queue: (string | null)[] = [];
  let wake: (() => void) | null = null;
  let exit!: (code: number) => void;
  const writes: string[] = [];
  const self = {
    writes,
    killed: false,
    push(line: string | null) {
      queue.push(line);
      wake?.();
    },
    proc: {
      lines: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queue.length) {
              const l = queue.shift()!;
              if (l === null) return;
              yield l;
            }
            await new Promise<void>((r) => (wake = r));
          }
        },
      },
      write(line: string) {
        writes.push(line);
        onWrite(line, self);
      },
      kill() {
        self.killed = true;
        self.push(null);
        exit(137);
      },
      exited: new Promise<number>((r) => (exit = r)),
      stderrTail: () => "boot log tail",
    } satisfies LineProc,
  };
  return self;
}

/** A fake cell whose relay and sidecar are scripted. The sidecar, when it
 *  gets the task, asks the "model" `calls` times through the relay, then
 *  says done (unless told to hang). */
function world(opts: { calls?: number; hang?: boolean; extract?: Awaited<ReturnType<ExecutorCell["extractWorkspace"]>> } = {}) {
  const log = { opened: 0, destroyed: 0, extracted: 0, argv: [] as string[][], relayAnswers: [] as { status: number; contentType: string; body: string }[] };
  let asked = 0;
  const relay = scripted((line, self) => {
    const msg = JSON.parse(line);
    if (msg.type !== "response") return;
    log.relayAnswers.push(msg);
    if (asked < (opts.calls ?? 1)) {
      asked++;
      self.push(JSON.stringify({ type: "request", id: asked + 1, body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "go" }], stream: true }) }));
    } else if (!opts.hang) {
      sidecar.push(JSON.stringify({ type: "done", content: "I wrote it.", incomplete: false }));
    }
  });
  const sidecar = scripted((line) => {
    const msg = JSON.parse(line);
    if (msg.type === "message") {
      asked = 1;
      relay.push(JSON.stringify({ type: "request", id: 1, body: JSON.stringify({ model: "x", messages: [{ role: "user", content: msg.content }], stream: true }) }));
    }
  });
  relay.push(JSON.stringify({ type: "ready", port: 4242 }));
  const cell: ExecutorCell = {
    name: "fake",
    processArgv: (p) => {
      const argv = [p.user, ...p.argv, ...Object.entries(p.env).map(([k, v]) => `${k}=${v}`)];
      log.argv.push(argv);
      return argv;
    },
    extractWorkspace: async () => {
      log.extracted++;
      return opts.extract ?? { ok: true, dir: dir({ "out.txt": "done" }), files: 1, bytes: 4 };
    },
    destroy: async () => {
      log.destroyed++;
    },
  };
  const iso = {
    openExecutorCell: async (_spec: ExecutorCellSpec) => {
      log.opened++;
      return { ok: true as const, cell };
    },
  };
  const start = (argv: string[]): LineProc => (argv.includes("/app/src/rsi/research/cell-relay.ts") ? relay.proc : sidecar.proc);
  return { iso, start, log, relay, sidecar };
}

const base = (w: ReturnType<typeof world>, over: Partial<Parameters<typeof runExecutor>[0]> = {}) => ({
  iso: w.iso,
  start: w.start,
  task: task(),
  workspaceDir: dir(),
  agentSrcDir: dir(),
  depsDir: dir(),
  model: stub(),
  genome: { temperature: 0.4, systemPromptId: 2 },
  executorHash: "exec-1",
  caps: { maxBytes: 1_000_000, maxEntries: 100 },
  ...over,
});

describe("a task that finishes", () => {
  test("done: usage counted by the broker, workspace hashed, the agent's own claim kept but not graded", async () => {
    const w = world({ calls: 2 });
    const { run } = await runExecutor(base(w));
    expect(run.terminal).toBe("done");
    expect(run.usage.inputTokens).toBe(200);
    expect(run.usage.outputTokens).toBe(40);
    expect(run.workspaceAfter).toMatch(/^[0-9a-f]{64}$/);
    expect(run.claim).toBe("I wrote it.");
    expect(run.modelId).toBe("stub");
    expect(w.log.destroyed).toBe(1);
    expect(w.relay.killed && w.sidecar.killed).toBe(true);
  });

  test("a streamed request is answered as SSE, so the sidecar's stream parser reads it", async () => {
    const w = world();
    await runExecutor(base(w));
    const a = w.log.relayAnswers[0]!;
    expect(a.status).toBe(200);
    expect(a.contentType).toBe("text/event-stream");
    expect(a.body).toContain('"content":"Done."');
    expect(a.body.trim().endsWith("data: [DONE]")).toBe(true);
  });

  test("a `done` marked incomplete is not the end", async () => {
    const w = world({ hang: true });
    const p = runExecutor(base(w, { task: task({ maxWallMs: 2_000 }) }));
    await Bun.sleep(50);
    w.sidecar.push(JSON.stringify({ type: "done", content: "partial", incomplete: true }));
    await Bun.sleep(50);
    w.sidecar.push(JSON.stringify({ type: "done", content: "final" }));
    const { run } = await p;
    expect(run.claim).toBe("final");
  });
});

describe("a task that is stopped", () => {
  test("budget passed on an answered call: the task stops there, budget_exhausted", async () => {
    const w = world({ calls: 3 });
    const { run } = await runExecutor(base(w, { model: stub({ prompt_tokens: 6_000, completion_tokens: 10 }) }));
    expect(run.terminal).toBe("budget_exhausted");
    expect(w.log.relayAnswers.length).toBeLessThan(3);
    expect(w.log.destroyed).toBe(1);
  });

  test("a request that does not fit is answered 402 (not retried by the router) and the task is budget_exhausted", async () => {
    const w = world();
    const { run } = await runExecutor(base(w, { task: task({ maxInputTokens: 5 }) }));
    expect(run.terminal).toBe("budget_exhausted");
    expect(w.log.relayAnswers[0]!.status).toBe(402);
  });

  test("a priced model with a USD limit of 0 is refused before any cell opens", async () => {
    const w = world();
    const { run } = await runExecutor(base(w, { model: { ...stub(), usdPerMInput: 0.2 } }));
    expect(run.terminal).toBe("refused");
    expect(w.log.opened).toBe(0);
  });

  test("wall time: killed at maxWallMs, terminal timeout, workspace not extracted", async () => {
    const w = world({ hang: true });
    const { run } = await runExecutor(base(w, { task: task({ maxWallMs: 150 }) }));
    expect(run.terminal).toBe("timeout");
    expect(w.log.extracted).toBe(0);
    expect(w.log.destroyed).toBe(1);
  });

  test("the sidecar dying early is an error carrying its last log lines", async () => {
    const w = world({ hang: true });
    const p = runExecutor(base(w));
    await Bun.sleep(30);
    w.sidecar.proc.kill();
    const { run } = await p;
    expect(run.terminal).toBe("error");
    expect(run.reason).toContain("boot log tail");
  });

  test("a hostile workspace makes a finished task an error, not a pass", async () => {
    const w = world({ extract: { ok: false, reason: "workspace refused: unsafe name" } });
    const { run } = await runExecutor(base(w));
    expect(run.terminal).toBe("error");
    expect(run.reason).toContain("unsafe name");
    expect(run.workspaceAfter).toBe("");
  });
});

describe("refusals", () => {
  test("a genome field the live agent ignores is refused before any cell opens", async () => {
    const w = world();
    const { run } = await runExecutor(base(w, { genome: { temperature: 0.4, systemPromptId: 2, decompositionDepth: 3 } as never }));
    expect(run.terminal).toBe("refused");
    expect(run.reason).toContain("decompositionDepth");
    expect(w.log.opened).toBe(0);
  });

  test("no cell: refused with the cell's reason", async () => {
    const w = world();
    const iso = { openExecutorCell: async () => ({ ok: false as const, reason: "Docker is not running." }) };
    const { run } = await runExecutor(base(w, { iso }));
    expect(run).toMatchObject({ terminal: "refused", reason: "Docker is not running." });
  });
});

describe("what crosses into the cell", () => {
  test("the sidecar gets a dummy key and the relay's loopback address, never the host's env or the real model", async () => {
    const w = world();
    process.env.CINDERPAW_TEST_SECRET = "host-secret";
    await runExecutor(base(w));
    const sidecarArgv = w.log.argv.find((a) => a.includes("/app/src/index.ts"))!;
    expect(sidecarArgv[0]).toBe("agent");
    expect(sidecarArgv).toContain("CINDERPAW_BASE_URL=http://127.0.0.1:4242");
    expect(sidecarArgv).toContain("CINDERPAW_API_KEY=cell");
    expect(sidecarArgv.join(" ")).not.toContain("host-secret");
    expect(w.log.argv.find((a) => a.includes("/app/src/rsi/research/cell-relay.ts"))![0]).toBe("root");
  });

  test("the sidecar's bridge requests are answered at once with an error, so nothing waits five minutes", async () => {
    const w = world({ hang: true });
    const p = runExecutor(base(w, { task: task({ maxWallMs: 500 }) }));
    await Bun.sleep(30);
    w.sidecar.push(JSON.stringify({ type: "rsi_request", id: "r1", method: "embed_text", params: {} }));
    await Bun.sleep(30);
    const answer = w.sidecar.writes.map((l) => JSON.parse(l)).find((m) => m.type === "rsi_response");
    expect(answer).toMatchObject({ type: "rsi_response", id: "r1", ok: false });
    await p;
  });
});

describe("toSse", () => {
  test("content, tool calls with an index, usage in the last chunk, then [DONE]", () => {
    const sse = toSse({
      choices: [{ message: { content: "hi", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const chunks = sse.split("\n\n").filter(Boolean).map((c) => c.replace(/^data: /, ""));
    expect(chunks.at(-1)).toBe("[DONE]");
    const first = JSON.parse(chunks[0]!);
    expect(first.choices[0].delta.content).toBe("hi");
    expect(first.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: "c1", function: { name: "read_file" } });
    const last = JSON.parse(chunks.at(-2)!);
    expect(last.choices[0].finish_reason).toBe("tool_calls");
    expect(last.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4 });
  });
});

async function dockerUp(): Promise<boolean> {
  try {
    const r = await bunExec(["docker", "version", "--format", "{{.Server.Os}}"], { cwd: tmpdir(), timeoutMs: 15_000 });
    return r.exitCode === 0 && r.stdout.trim() === "linux";
  } catch {
    return false;
  }
}

const up = await dockerUp();
if (!up) console.error("rsi-agent-executor: real Docker run SKIPPED, Docker is not running here");

describe.skipIf(!up)("the real sidecar in a real cell, stub model", () => {
  test("boots, asks the stub through the relay and the broker, finishes, and its workspace comes out", async () => {
    const pkg = join(import.meta.dir, "..");
    const { run, workspaceDir } = await runExecutor({
      iso: new DockerIsolation({ exec: bunExec, limits: { pids: 256, memory: "1g", cpus: 2, scratch: "128m" } }),
      task: task({ maxWallMs: 240_000, maxInputTokens: 200_000, maxOutputTokens: 20_000 }),
      workspaceDir: dir({ "notes.txt": "start" }),
      agentSrcDir: join(pkg, "src"),
      depsDir: pkg,
      model: stub(),
      genome: { temperature: 0.4, systemPromptId: 2 },
      executorHash: "exec-real",
      caps: { maxBytes: 10_000_000, maxEntries: 1_000 },
    });
    if (run.terminal !== "done") throw new Error(`${run.terminal}: ${run.reason}`);
    expect(run.usage.calls).toBeGreaterThan(0);
    expect(workspaceDir).toBeTruthy();
  }, 600_000);
});
