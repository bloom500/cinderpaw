/**
 * L4 module host (spec §4) — the child-process side.
 *
 * SELF-CONTAINED BY DESIGN: this file is embedded into the sidecar binary
 * as a text import (`module-host-client.ts`), written out to a temp file
 * at spawn time and run under a real Bun interpreter — so it may import
 * NOTHING from the rest of the runtime (node: builtins only). The lexical
 * wall runs parent-side before this process is ever spawned
 * (`module-wall.ts` — single enforcement point; the host trusts its
 * spawner, which is runtime code).
 *
 * Protocol: JSON lines over stdin/stdout — the transport discipline
 * already proven by the sidecar itself and desktop_control.
 *   → child announces: {type:"hello", protocol:1, moduleId, seam, methods}
 *   ← parent asks:     {type:"request", id, method, params}
 *   → child answers:   {type:"response", id, ok, result|error, rssMb}
 * The `protocol` field in hello is the version byte (§12.2): host and
 * runtime refuse mismatched pairs explicitly.
 *
 * Determinism aid: Math.random is replaced with a seeded PRNG
 * (FERAL_MODULE_SEED env); wall-clock stays readable (spec §4).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleDir = process.argv[2] ?? ".";
const seed = (Number(process.env["FERAL_MODULE_SEED"] ?? "1") >>> 0) || 1;

// mulberry32 — tiny, seedable, good enough for module determinism.
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(seed);

function send(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

const manifest = JSON.parse(readFileSync(join(moduleDir, "manifest.json"), "utf8")) as {
  id: string;
  seam: string;
  entry: string;
};
const mod = (await import(pathToFileURL(join(moduleDir, manifest.entry)).href)) as {
  default?: Record<string, unknown>;
};
if (!mod.default || typeof mod.default !== "object") {
  send({ type: "fatal", error: "module has no default export object" });
  process.exit(1);
}
const impl: Record<string, unknown> = mod.default;
const methods = Object.keys(impl).filter((k) => typeof impl[k] === "function");
send({ type: "hello", protocol: 1, moduleId: manifest.id, seam: manifest.seam, methods });

async function handle(line: string): Promise<void> {
  let req: { id?: string; method?: string; params?: unknown };
  try {
    req = JSON.parse(line) as typeof req;
  } catch {
    send({ type: "response", id: null, ok: false, error: "malformed request line", rssMb: rssMb() });
    return;
  }
  const id = req.id ?? null;
  const fn = req.method ? impl[req.method] : undefined;
  if (typeof fn !== "function") {
    send({ type: "response", id, ok: false, error: `unknown method: ${String(req.method)}`, rssMb: rssMb() });
    return;
  }
  try {
    const result = await (fn as (p: unknown) => unknown)(req.params);
    send({ type: "response", id, ok: true, result, rssMb: rssMb() });
  } catch (err) {
    send({ type: "response", id, ok: false, error: String(err), rssMb: rssMb() });
  }
}

let buf = "";
const dec = new TextDecoder();
for await (const chunk of process.stdin) {
  buf += typeof chunk === "string" ? chunk : dec.decode(chunk as Uint8Array);
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line.length > 0) void handle(line);
  }
}
