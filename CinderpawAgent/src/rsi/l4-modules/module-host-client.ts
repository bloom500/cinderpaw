/**
 * L4 module host — the parent (runtime) side (spec §4).
 *
 * Starts one module host per active/evaluating module INSIDE an isolation
 * cell (`ModuleCell`, Docker by default): no network, no host filesystem
 * beyond the module and the host script (read-only), no capabilities, a
 * memory and pid cap. That is the boundary. Generated module code used to
 * run as a plain Bun process on the host, where a module that slipped the
 * lexical wall (`globalThis["fe" + "tch"]` does) had the network and the
 * user's files. No cell → refused, never run on the host instead.
 *
 * On top of the cell, the walls the child cannot be trusted with:
 *   - lexical wall on the entry source BEFORE any spawn (module-wall.ts),
 *     a cheap first filter, not the boundary;
 *   - scrubbed env: the RNG seed, nothing else;
 *   - hard per-request timeout (request fails → caller falls back to
 *     builtin; the host is NOT killed for one late answer);
 *   - N consecutive timeouts → host killed (spec §4 resource wall);
 *   - maxRssMb: the host self-reports RSS on every reply; a breach kills
 *     the host. The cell's memory cap is the hard wall under it.
 *
 * The child script is embedded as a compile-time text import (same
 * mechanism as SOUL.md — compiled sidecars have no src/ on disk) and
 * written to a temp file at spawn.
 *
 * B3 layers the seam adapter + quarantine watchdog on top of this handle;
 * this file knows nothing about seams or registries.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wallCheck } from "./module-wall.ts";
import { DockerIsolation, type ModuleCell } from "../l3-code/isolation.ts";
import { bunExec } from "../l3-code/code-sandbox.ts";
// @ts-expect-error — Bun's text import attribute, not typed by @types/bun yet.
import HOST_SOURCE from "./module-host.ts" with { type: "text" };

/** Protocol version this runtime speaks; refuses a host that differs (§12.2). */
export const HOST_PROTOCOL = 1;

export interface ModuleHostLimits {
  timeoutMs: number;
  maxRssMb: number;
}

export type HostReply =
  | { ok: true; result: unknown }
  | { ok: false; error: string; timedOut?: boolean };

export interface ModuleHost {
  moduleId: string;
  methods: string[];
  request(method: string, params: unknown): Promise<HostReply>;
  alive(): boolean;
  /** Failure counters for the B3 watchdog. */
  stats(): { requests: number; failures: number; consecutiveTimeouts: number };
  stop(): void;
  /** Resolves when the child process has fully exited. `stop()` is
   *  fire-and-forget; await this when the caller needs the process gone
   *  (e.g. before removing the module dir — Windows holds the cwd). */
  exited: Promise<unknown>;
}

export type SpawnResult =
  | { ok: true; host: ModuleHost }
  /** `unavailable`: there is no cell on this machine right now (Docker
   *  missing or stopped). Not the module's failure. */
  | { ok: false; reason: string; unavailable?: true };

export interface SpawnOpts {
  moduleDir: string;
  limits: ModuleHostLimits;
  seed?: number;
  /** Consecutive request timeouts before the host process is killed. */
  maxConsecutiveTimeouts?: number;
  /** How long to wait for the hello line. */
  spawnTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Where the module runs. Default: a Docker cell. */
  cell?: ModuleCell;
}

let dockerCell: ModuleCell | null = null;
/** One Docker cell backend per process: one CPU, 128 pids (bun's own
 *  threads count against the pid cap). */
function defaultCell(): ModuleCell {
  return (dockerCell ??= new DockerIsolation({ exec: bunExec, limits: { cpus: 1, pids: 128 } }));
}

export async function spawnModuleHost(opts: SpawnOpts): Promise<SpawnResult> {
  const log = opts.log ?? (() => {});
  const maxConsecutive = opts.maxConsecutiveTimeouts ?? 3;

  // Wall BEFORE spawn — the single lexical enforcement point (§4).
  let manifest: { id?: string; entry?: string };
  try {
    manifest = JSON.parse(readFileSync(join(opts.moduleDir, "manifest.json"), "utf8")) as typeof manifest;
  } catch (err) {
    return { ok: false, reason: `manifest unreadable: ${String(err)}` };
  }
  const entry = typeof manifest.entry === "string" ? manifest.entry : "module.ts";
  let source: string;
  try {
    source = readFileSync(join(opts.moduleDir, entry), "utf8");
  } catch (err) {
    return { ok: false, reason: `entry unreadable: ${String(err)}` };
  }
  const wall = wallCheck(source);
  if (!wall.ok) return { ok: false, reason: `lexical wall: ${wall.reason}` };

  // The cell, or nothing. The reason is the one a person reads.
  const cell = opts.cell ?? defaultCell();
  const avail = await cell.available();
  if (!avail.ok) return { ok: false, reason: avail.reason, unavailable: true };
  const ready = await cell.prepare();
  if (!ready.ok) return { ok: false, reason: ready.reason, unavailable: true };

  // Write the embedded host script out — compiled sidecars have no src/.
  const hostDir = mkdtempSync(join(tmpdir(), "cinderpaw-module-host-"));
  const hostPath = join(hostDir, "host.ts");
  writeFileSync(hostPath, HOST_SOURCE as unknown as string, "utf8");

  const cellName = `cinderpaw-module-${randomUUID().slice(0, 12)}`;
  const { argv, env } = cell.command({
    hostScript: hostPath,
    moduleDir: opts.moduleDir,
    // Scrubbed env (§4): the determinism seed, nothing else.
    env: { CINDERPAW_MODULE_SEED: String(opts.seed ?? 1) },
    // Room for bun itself on top of what the module may use.
    memoryMb: opts.limits.maxRssMb + 256,
    name: cellName,
  });
  const proc = Bun.spawn({ cmd: argv, cwd: tmpdir(), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });

  // Killing the client does not stop the cell: destroy it by name, then the
  // host script it had mounted. Once, whichever path gets here first.
  let destroyed: Promise<void> | null = null;
  const destroyCell = (): Promise<void> =>
    (destroyed ??= cell
      .destroy(cellName)
      .catch(() => undefined)
      .then(() => {
        try {
          rmSync(hostDir, { recursive: true, force: true });
        } catch {
          /* best-effort temp cleanup */
        }
      }));

  let alive = true;
  let requests = 0;
  let failures = 0;
  let consecutiveTimeouts = 0;
  let nextId = 1;
  const pending = new Map<string, (r: HostReply & { rssMb?: number }) => void>();

  let helloResolve: (h: { moduleId: string; methods: string[]; protocol: number } | null) => void;
  const hello = new Promise<{ moduleId: string; methods: string[]; protocol: number } | null>((res) => {
    helloResolve = res;
  });

  const kill = (why: string): void => {
    if (!alive) return;
    alive = false;
    log(`module-host(${manifest.id ?? "?"}): killed — ${why}`);
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    for (const [, settle] of pending) settle({ ok: false, error: `host stopped: ${why}` });
    pending.clear();
    void destroyCell();
  };

  // stdout reader — JSON lines; non-JSON lines (a module's stray
  // console.log) are ignored, the protocol only trusts typed lines.
  void (async () => {
    let buf = "";
    const dec = new TextDecoder();
    try {
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (msg["type"] === "hello") {
            helloResolve!({
              moduleId: String(msg["moduleId"] ?? ""),
              methods: Array.isArray(msg["methods"]) ? (msg["methods"] as string[]) : [],
              protocol: Number(msg["protocol"] ?? 0),
            });
          } else if (msg["type"] === "response") {
            const id = String(msg["id"] ?? "");
            const settle = pending.get(id);
            if (!settle) continue; // late reply after timeout — discarded
            pending.delete(id);
            const rss = Number(msg["rssMb"] ?? 0);
            if (msg["ok"] === true) settle({ ok: true, result: msg["result"], rssMb: rss });
            else settle({ ok: false, error: String(msg["error"] ?? "module error"), rssMb: rss });
          } else if (msg["type"] === "fatal") {
            log(`module-host(${manifest.id ?? "?"}): fatal — ${String(msg["error"])}`);
          }
        }
      }
    } catch {
      /* stream torn down */
    }
    // Stream ended = host exited (crash or stop).
    if (alive) kill("stdout closed (host exited)");
    helloResolve!(null);
  })();

  // stderr is read, not left in the pipe: a chatty module would fill it and
  // stall, and a cell that fails to start says why here (bad mount, no image).
  let stderrTail = "";
  const stderrDone = (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of proc.stderr) stderrTail = (stderrTail + dec.decode(chunk)).slice(-2048);
    } catch {
      /* stream torn down */
    }
  })();

  void proc.exited.then(() => {
    if (alive) kill("process exited");
  });

  // 60s, not 15: the first cell after Docker Desktop starts took 14.4s to
  // say hello (measured 26 Sep); a warm one takes under a second.
  const spawnTimeout = setTimeout(() => helloResolve!(null), opts.spawnTimeoutMs ?? 60_000);
  const h = await hello;
  clearTimeout(spawnTimeout);
  if (!h) {
    kill("no hello");
    // The last words can land just after stdout closed.
    await Promise.race([stderrDone, new Promise((r) => setTimeout(r, 1_000))]);
    const said = stderrTail.trim().split("\n").pop()?.trim();
    return { ok: false, reason: `host did not announce itself (crash or spawn timeout)${said ? `: ${said}` : ""}` };
  }
  if (h.protocol !== HOST_PROTOCOL) {
    kill(`protocol mismatch (host ${h.protocol}, runtime ${HOST_PROTOCOL})`);
    return { ok: false, reason: `host protocol ${h.protocol} ≠ runtime ${HOST_PROTOCOL}` };
  }

  const host: ModuleHost = {
    moduleId: h.moduleId,
    methods: h.methods,
    alive: () => alive,
    stats: () => ({ requests, failures, consecutiveTimeouts }),
    stop: () => kill("stopped by runtime"),
    // Gone means the client exited AND the cell is destroyed.
    exited: proc.exited.then(destroyCell),
    request(method: string, params: unknown): Promise<HostReply> {
      if (!alive) return Promise.resolve({ ok: false, error: "host not running" });
      requests++;
      const id = String(nextId++);
      return new Promise<HostReply>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          failures++;
          consecutiveTimeouts++;
          if (consecutiveTimeouts >= maxConsecutive) {
            kill(`${consecutiveTimeouts} consecutive timeouts`);
          }
          resolve({ ok: false, error: `timeout after ${opts.limits.timeoutMs}ms`, timedOut: true });
        }, opts.limits.timeoutMs);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          consecutiveTimeouts = 0;
          const rss = (reply as { rssMb?: number }).rssMb ?? 0;
          if (rss > opts.limits.maxRssMb) {
            failures++;
            kill(`maxRssMb exceeded (${rss} > ${opts.limits.maxRssMb})`);
            resolve({ ok: false, error: `maxRssMb exceeded (${rss}MB)` });
            return;
          }
          if (!reply.ok) failures++;
          resolve(reply.ok ? { ok: true, result: reply.result } : { ok: false, error: reply.error });
        });
        // A broken pipe here used to throw straight out of the promise
        // executor: the timer stayed armed, the `pending` entry was never
        // settled, and the caller waited the full timeout for a request that
        // was never sent. Fail it immediately and clean up instead.
        try {
          proc.stdin.write(`${JSON.stringify({ type: "request", id, method, params })}\n`);
          void proc.stdin.flush();
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          failures++;
          resolve({
            ok: false,
            error: `host stdin closed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });
    },
  };
  return { ok: true, host };
}
