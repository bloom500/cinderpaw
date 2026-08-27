/**
 * L4 module host — the parent (runtime) side (spec §4).
 *
 * Spawns one Bun subprocess per active/evaluating module, enforces the
 * walls the child cannot be trusted with:
 *   - lexical wall on the entry source BEFORE any spawn (module-wall.ts);
 *   - scrubbed env: PATH + the RNG seed, nothing else;
 *   - hard per-request timeout (request fails → caller falls back to
 *     builtin; the host is NOT killed for one late answer);
 *   - N consecutive timeouts → host killed (spec §4 resource wall);
 *   - maxRssMb: the host self-reports RSS on every reply; a breach kills
 *     the host. // ponytail: self-reported RSS, OS-level polling if a
 *     module ever learns to lie about memoryUsage() while staying pure.
 *
 * The child script is embedded as a compile-time text import (same
 * mechanism as SOUL.md — compiled sidecars have no src/ on disk) and
 * written to a temp file at spawn.
 *
 * B3 layers the seam adapter + quarantine watchdog on top of this handle;
 * this file knows nothing about seams or registries.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wallCheck } from "./module-wall.ts";
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
  | { ok: false; reason: string };

export interface SpawnOpts {
  moduleDir: string;
  limits: ModuleHostLimits;
  seed?: number;
  /** Consecutive request timeouts before the host process is killed. */
  maxConsecutiveTimeouts?: number;
  /** How long to wait for the hello line. */
  spawnTimeoutMs?: number;
  log?: (msg: string) => void;
}

/** Resolve the interpreter for the host. A dev machine has `bun` on PATH;
 *  a compiled sidecar IS a bun binary — BUN_BE_BUN=1 makes it act as one. */
function bunExe(): string {
  return Bun.which("bun") ?? process.execPath;
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

  // Write the embedded host script out — compiled sidecars have no src/.
  const hostDir = mkdtempSync(join(tmpdir(), "feral-module-host-"));
  const hostPath = join(hostDir, "host.ts");
  writeFileSync(hostPath, HOST_SOURCE as unknown as string, "utf8");

  const proc = Bun.spawn({
    cmd: [bunExe(), hostPath, opts.moduleDir],
    cwd: opts.moduleDir,
    // Scrubbed env (§4): revoke ambient authority. PATH only, plus the
    // determinism seed and the be-bun switch (inert for a real bun).
    env: {
      PATH: process.env["PATH"] ?? "",
      CINDERPAW_MODULE_SEED: String(opts.seed ?? 1),
      BUN_BE_BUN: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

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
    try {
      rmSync(hostDir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
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

  void proc.exited.then(() => {
    if (alive) kill("process exited");
  });

  const spawnTimeout = setTimeout(() => helloResolve!(null), opts.spawnTimeoutMs ?? 15_000);
  const h = await hello;
  clearTimeout(spawnTimeout);
  if (!h) {
    kill("no hello");
    return { ok: false, reason: "host did not announce itself (crash or spawn timeout)" };
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
    exited: proc.exited,
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
