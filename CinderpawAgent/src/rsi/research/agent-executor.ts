/**
 * S1.3c of the AgentLoop evolution spec (2026-10-04, §3.2, §4.4, §17): the
 * executor. Runs the REAL sidecar agent loop on one `AgentTask` inside an
 * executor cell and writes the `ExecutorRun`. It never grades: the workspace
 * it hands back goes to the evaluator (S1.2), and the agent's own "done" text
 * is recorded as `claim`, not scored.
 *
 * RESEARCH ONLY (spec §4.7). A user install never runs this.
 *
 * How the pieces meet (design reviewed adversarially before coding; the
 * finding numbers below refer to that review):
 *
 *   host  runExecutor ── BudgetBroker ── the real model, or a free stub
 *           │  stdin/stdout             (the key never leaves the host)
 *   cell  cell-relay.ts (root) ── HTTP on 127.0.0.1 ── sidecar (uid 1000)
 *
 *   - The sidecar streams; the broker calls the model non-streamed (exact
 *     usage) and the answer goes back as SSE (`toSse`), so the sidecar's
 *     request path is the one users run (#1).
 *   - A budget refusal is HTTP 402: the inference router retries only 429
 *     and 5xx, so a refusal ends the turn instead of burning wall time (#12).
 *     Passing a limit ends the task at once: `budget_exhausted`.
 *   - Every `rsi_request` (embeddings and other host-bridge calls) is
 *     answered at once with `ok: false`; nothing in the cell waits five
 *     minutes on a host that is not there (#7).
 *   - The genome may carry only fields `LIVE_REACH` applies; anything else is
 *     refused, because the live agent would ignore it (spec §4.4, parity).
 *   - A timed-out task is failed and its workspace is not extracted (#10).
 *
 * Known differences from a user's run, stated in every report until the
 * wire-parity check exists (#8): the model sits behind a loopback address, so
 * the sidecar takes its local-model branch (no cloud temperature clamp, local
 * timeouts); autonomous mode; no embeddings, web, browser or connectors.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { sha256Canonical } from "../infra/hash-chain.ts";
import { minimalEnv } from "../l3-code/code-sandbox.ts";
import type { ExecutorCell, ExecutorCellSpec, TarCaps } from "../l3-code/isolation.ts";
import { LIVE_REACH, type GenomeConfig } from "../l1-config/genome.ts";
import { BudgetBroker, type BrokerModel, type BrokerUsage, type ChatAnswer, type ChatBody } from "./task-budget.ts";
import type { AgentTask } from "./task-family.ts";

/** Only the genome fields the live agent applies. */
export type LiveGenome = Partial<Pick<GenomeConfig, "temperature" | "systemPromptId">>;

export type Terminal = "done" | "budget_exhausted" | "error" | "timeout" | "refused";

export interface ExecutorRun {
  taskId: string;
  executorHash: string;
  modelId: string;
  terminal: Terminal;
  /** Why it ended, when not `done`. */
  reason?: string;
  /** The agent's own final text. Recorded, never graded. */
  claim?: string;
  usage: BrokerUsage & { wallMs: number };
  /** Content hash of the workspace handed to the evaluator; "" when none. */
  workspaceAfter: string;
}

/** A line-oriented child process. `docker exec -i` in production. */
export interface LineProc {
  lines: AsyncIterable<string>;
  write(line: string): void;
  kill(): void;
  exited: Promise<number>;
  stderrTail(): string;
}

const RELAY_ENTRY = "/app/src/rsi/research/cell-relay.ts";
const SIDECAR_ENTRY = "/app/src/index.ts";
const RELAY_READY_MS = 60_000;

/** Neutral values for the dropped dimensions: the live agent ignores them,
 *  the champion file only needs the full shape. */
const NEUTRAL: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.7,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.4,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 0,
} as GenomeConfig;

/** One non-streamed answer as the OpenAI SSE stream the sidecar parses. */
export function toSse(answer: ChatAnswer): string {
  const choice = (answer.choices?.[0] ?? {}) as { message?: Record<string, unknown>; finish_reason?: string };
  const message = choice.message ?? {};
  const delta: Record<string, unknown> = { role: "assistant" };
  if (typeof message.content === "string" && message.content) delta.content = message.content;
  for (const k of ["reasoning_content", "reasoning"]) if (typeof message[k] === "string") delta[k] = message[k];
  const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Record<string, unknown>[]) : [];
  if (calls.length) delta.tool_calls = calls.map((c, index) => ({ index, ...c }));
  const finish = choice.finish_reason ?? (calls.length ? "tool_calls" : "stop");
  const chunks = [
    { object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
    { object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(answer.usage ? { usage: answer.usage } : {}) },
  ];
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function* textLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      yield buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

/** Default `start`: the docker CLI with only `minimalEnv()`; the cell's own
 *  environment is the `-e` pairs inside `argv`. Both pipes are drained. */
function spawnLines(argv: string[]): LineProc {
  const p = Bun.spawn({ cmd: argv, env: minimalEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const tail: string[] = [];
  (async () => {
    for await (const l of textLines(p.stderr)) {
      tail.push(l);
      tail.splice(0, Math.max(0, tail.length - 40));
    }
  })();
  return {
    lines: textLines(p.stdout),
    write: (line) => {
      p.stdin.write(`${line}\n`);
      p.stdin.flush();
    },
    kill: () => p.kill(),
    exited: p.exited,
    stderrTail: () => tail.join("\n"),
  };
}

function hashDir(dir: string): string {
  const files: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const full = join(e.parentPath, e.name);
    files[relative(dir, full).split(sep).join("/")] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
  return sha256Canonical(files);
}

export async function runExecutor(args: {
  iso: { openExecutorCell(spec: ExecutorCellSpec): Promise<{ ok: true; cell: ExecutorCell } | { ok: false; reason: string }> };
  task: AgentTask;
  workspaceDir: string;
  /** The agent's `src/`, copied into the cell root-owned. */
  agentSrcDir: string;
  /** Holds OUR bun.lock; the cell image's dependencies. */
  depsDir: string;
  model: BrokerModel;
  genome: LiveGenome;
  executorHash: string;
  caps: TarCaps;
  start?: (argv: string[]) => LineProc;
}): Promise<{ run: ExecutorRun; workspaceDir?: string }> {
  const t0 = Date.now();
  const { task, model } = args;
  const broker = new BudgetBroker(task.budget, model);
  const result = (terminal: Terminal, extra: Partial<ExecutorRun> = {}): ExecutorRun => ({
    taskId: task.id,
    executorHash: args.executorHash,
    modelId: model.id,
    terminal,
    usage: { ...broker.usage(), wallMs: Date.now() - t0 },
    workspaceAfter: "",
    ...extra,
  });

  const applied = new Set(Object.keys(LIVE_REACH).filter((k) => LIVE_REACH[k as keyof GenomeConfig] === "applied"));
  const ignored = Object.keys(args.genome).filter((k) => !applied.has(k));
  if (ignored.length) {
    return { run: result("refused", { reason: `genome fields the live agent ignores: ${ignored.join(", ")}` }) };
  }
  if (task.budget.maxUsd === 0 && (model.usdPerMInput > 0 || model.usdPerMOutput > 0)) {
    return { run: result("refused", { reason: `the task's USD limit is 0, so only a free model may run; ${model.id} is priced` }) };
  }

  const home = mkdtempSync(join(tmpdir(), "cp-exec-home-"));
  mkdirSync(join(home, "rsi"), { recursive: true });
  writeFileSync(
    join(home, "rsi", "champion.json"),
    JSON.stringify({ genomeId: args.executorHash, score: 0, config: { ...NEUTRAL, ...args.genome }, updatedAt: t0 }),
  );

  const opened = await args.iso.openExecutorCell({
    name: `cp-exec-${task.id.replace(/[^A-Za-z0-9_.-]/g, "_")}-${randomUUID().slice(0, 8)}`,
    depsDir: args.depsDir,
    sourceDir: args.agentSrcDir,
    workspaceDir: args.workspaceDir,
    homeDir: home,
  });
  if (!opened.ok) return { run: result("refused", { reason: opened.reason }) };
  const cell = opened.cell;
  const start = args.start ?? spawnLines;

  let terminal: Terminal | null = null;
  let reason: string | undefined;
  let claim: string | undefined;
  let finished!: () => void;
  const over = new Promise<void>((r) => (finished = r));
  const finish = (t: Terminal, why?: string) => {
    if (terminal) return;
    terminal = t;
    reason = why;
    finished();
  };
  const wall = setTimeout(() => finish("timeout", `wall time ${task.budget.maxWallMs} ms reached`), task.budget.maxWallMs);

  let relay: LineProc | undefined;
  let sidecar: LineProc | undefined;
  try {
    relay = start(cell.processArgv({ user: "root", argv: ["bun", RELAY_ENTRY], env: {} }));
    const relayLines = relay.lines[Symbol.asyncIterator]();
    const port = await Promise.race([
      (async () => {
        for (let n = await relayLines.next(); !n.done; n = await relayLines.next()) {
          try {
            const msg = JSON.parse(n.value);
            if (msg.type === "ready") return msg.port as number;
          } catch {}
        }
        return null;
      })(),
      Bun.sleep(RELAY_READY_MS).then(() => null),
      over.then(() => null),
    ]);
    if (port == null) {
      finish("error", `the model relay did not start: ${relay.stderrTail() || "no output"}`);
    } else {
      const r = relay;
      const respond = (id: number, status: number, contentType: string, body: string) =>
        r.write(JSON.stringify({ type: "response", id, status, contentType, body }));
      const answerModel = async (id: number, raw: string) => {
        let body: ChatBody;
        try {
          body = JSON.parse(raw);
          if (!Array.isArray(body?.messages)) throw new Error("no messages");
        } catch {
          return respond(id, 400, "text/plain", "model relay: the request is not a chat completion");
        }
        const { stream, stream_options: _ignored, ...rest } = body;
        const got = await broker.complete({ ...rest, model: model.id, messages: body.messages });
        if (!got.ok) {
          const limit = broker.exhausted();
          respond(id, limit ? 402 : 502, "text/plain", got.reason);
          if (limit) finish("budget_exhausted", got.reason);
          return;
        }
        if (stream === true) respond(id, 200, "text/event-stream", toSse(got.answer));
        else respond(id, 200, "application/json", JSON.stringify(got.answer));
        const limit = broker.exhausted();
        if (limit) finish("budget_exhausted", `budget exhausted: ${limit}`);
      };
      (async () => {
        for (let n = await relayLines.next(); !n.done; n = await relayLines.next()) {
          let msg: { type?: string; id?: number; body?: string };
          try {
            msg = JSON.parse(n.value);
          } catch {
            continue;
          }
          if (msg.type === "request" && typeof msg.id === "number") void answerModel(msg.id, msg.body ?? "");
        }
        finish("error", `the model relay exited: ${r.stderrTail() || "no output"}`);
      })();

      const s = start(
        cell.processArgv({
          user: "agent",
          argv: ["bun", SIDECAR_ENTRY],
          env: {
            CINDERPAW_HOME: "/tmp/home",
            CINDERPAW_AUTONOMOUS: "true",
            CINDERPAW_PROVIDER: "openai_compatible",
            CINDERPAW_BASE_URL: `http://127.0.0.1:${port}`,
            CINDERPAW_MODEL: model.id,
            // A dummy: the real key stays with the broker on the host.
            CINDERPAW_API_KEY: "cell",
            CINDERPAW_TRUSTED_LOCAL_ORIGINS: `http://127.0.0.1:${port}`,
            CINDERPAW_HTTP_DOMAINS: "127.0.0.1",
          },
        }),
      );
      sidecar = s;
      (async () => {
        for await (const line of s.lines) {
          if (!line.startsWith("{")) continue;
          let ev: { type?: string; id?: string; content?: string; incomplete?: boolean; message?: string };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === "rsi_request" && ev.id) {
            s.write(JSON.stringify({ type: "rsi_response", id: ev.id, ok: false, error: "not available in an executor cell" }));
          } else if (ev.type === "done" && !ev.incomplete) {
            claim = ev.content;
            finish("done");
          } else if (ev.type === "error") {
            finish("error", ev.message ?? "sidecar error");
          }
        }
        finish("error", `the sidecar exited: ${s.stderrTail() || "no output"}`);
      })();
      s.write(JSON.stringify({ type: "message", id: randomUUID(), sessionId: `exec-${task.id}`, content: task.instruction }));
    }

    await over;
  } catch (e) {
    finish("error", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(wall);
    // ponytail: killing the docker client may leave the sidecar idling in the
    // cell for the moment the workspace is copied out; after `done` it has
    // nothing left to write. `docker pause` first if that ever matters.
    sidecar?.kill();
    relay?.kill();
  }

  let workspaceAfter = "";
  let outDir: string | undefined;
  try {
    if (terminal === "done") {
      const out = await cell.extractWorkspace(args.caps);
      if (out.ok) {
        outDir = out.dir;
        workspaceAfter = hashDir(out.dir);
      } else {
        terminal = "error";
        reason = out.reason;
      }
    }
  } finally {
    await cell.destroy();
  }
  return { run: result(terminal ?? "error", { reason, claim, workspaceAfter }), workspaceDir: outDir };
}
