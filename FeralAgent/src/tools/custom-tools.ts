/**
 * Custom tools — agent-authored tools, persisted under ~/.feral/tools/.
 *
 * The RSI story's "generation" half for the tool surface: the agent can
 * create / modify / delete its own tools at runtime (via the `tool_forge`
 * builtin). Each custom tool is one JSON record on disk plus a transpiled
 * JS module; execution happens in a SUBPROCESS driven through the same
 * ProcessSandbox as `shell_exec` — the running sidecar never imports
 * agent-written code in-process (trust boundary: same discipline as
 * "the running process never mutates itself").
 *
 * Trust class: identical to shell_exec (arbitrary code, OS-level ambient
 * authority). That is why boot registers the forge + custom tools ONLY
 * under the same FERAL_ENABLE_SHELL_EXEC gate — this feature adds
 * persistence and a first-class tool interface, not a new capability the
 * agent didn't already have through `shell_exec`.
 *
 * Contract for the tool module (what the agent writes):
 *   export default async function (args) {
 *     return { ok: true, content: "...", data?: {...} };
 *   }
 * Args arrive as JSON on stdin via the runner; the result is the last
 * JSON line on stdout. TypeScript is accepted — it is transpiled at save
 * time (which doubles as the syntax check) so the runner works under
 * plain `node` as well as `bun`.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { feralHome } from "../config.ts";
import { resolveExecutables } from "../core/executables.ts";
import type { Tool, ToolManifest, ToolParameter, ToolResult } from "../types.ts";

export const MAX_CODE_BYTES = 64 * 1024;
export const MAX_CUSTOM_TOOLS = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

/** Reserved so a custom tool can never shadow the forge itself. */
export const FORGE_TOOL_NAME = "tool_forge";

export interface CustomToolRecord {
  version: 1;
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  /** The TypeScript/JavaScript source the agent wrote. */
  code: string;
  /** Per-call timeout; clamped to [1s, 5min]. */
  timeoutMs?: number;
  createdAt: number;
  updatedAt: number;
}

export function customToolsDir(): string {
  return join(feralHome(), "tools");
}

const NAME_RE = /^[a-z][a-z0-9_]{2,31}$/;
const PARAM_TYPES = new Set(["string", "number", "boolean", "object", "array"]);

/** Validate the agent-supplied fields. Returns an error string or null. */
export function validateCustomTool(args: {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  code: string;
}): string | null {
  if (!NAME_RE.test(args.name)) {
    return `invalid name "${args.name}" — must match ${NAME_RE} (snake_case, 3-32 chars)`;
  }
  if (args.name === FORGE_TOOL_NAME) return `"${FORGE_TOOL_NAME}" is reserved`;
  if (typeof args.description !== "string" || !args.description.trim()) {
    return "description is required";
  }
  if (args.description.length > 1000) return "description exceeds 1000 chars";
  if (typeof args.code !== "string" || !args.code.trim()) return "code is required";
  if (Buffer.byteLength(args.code, "utf8") > MAX_CODE_BYTES) {
    return `code exceeds ${MAX_CODE_BYTES} bytes`;
  }
  if (!args.parameters || typeof args.parameters !== "object" || Array.isArray(args.parameters)) {
    return "parameters must be an object of {type, description, required?}";
  }
  for (const [key, p] of Object.entries(args.parameters)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key)) return `invalid parameter name "${key}"`;
    if (!p || typeof p !== "object") return `parameter "${key}" must be an object`;
    if (!PARAM_TYPES.has((p as ToolParameter).type)) {
      return `parameter "${key}" has invalid type "${(p as ToolParameter).type}"`;
    }
    if (typeof (p as ToolParameter).description !== "string") {
      return `parameter "${key}" needs a description`;
    }
  }
  return null;
}

/** Transpile TS→JS. Doubles as the syntax check — a parse error is
 *  returned as a string, never thrown. Requires the Bun runtime (the
 *  sidecar always runs under Bun). */
export function transpileToolCode(code: string): { js: string } | { error: string } {
  try {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    return { js: transpiler.transformSync(code) };
  } catch (err) {
    return { error: `code does not parse: ${String((err as Error).message ?? err)}` };
  }
}

/** The subprocess entry point. Plain JS (runs under bun OR node); reads
 *  args JSON from stdin, imports the transpiled module, prints the result
 *  as the last JSON line on stdout. Written idempotently at load time. */
const RUNNER_SOURCE = `import { pathToFileURL } from "node:url";
const modPath = process.argv[2];
let input = "";
for await (const chunk of process.stdin) input += chunk;
let result;
try {
  const mod = await import(pathToFileURL(modPath).href);
  if (typeof mod.default !== "function") throw new Error("tool module must have a default export function");
  const raw = await mod.default(input.trim() ? JSON.parse(input) : {});
  result = raw && typeof raw === "object"
    ? { ok: raw.ok !== false, content: String(raw.content ?? ""), ...(raw.data !== undefined ? { data: raw.data } : {}) }
    : { ok: true, content: String(raw ?? "") };
} catch (err) {
  result = { ok: false, content: String((err && err.stack) || err), error: "tool_error" };
}
process.stdout.write("\\n" + JSON.stringify(result));
`;

const RUNNER_FILENAME = ".runner.mjs";

function recordPath(dir: string, name: string): string {
  return join(dir, `${name}.json`);
}
function modulePath(dir: string, name: string): string {
  return join(dir, `${name}.mjs`);
}

/** Persist a record + its transpiled module. Caller must have validated. */
export function saveCustomTool(dir: string, record: CustomToolRecord, js: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(recordPath(dir, record.name), JSON.stringify(record, null, 2), "utf8");
  writeFileSync(modulePath(dir, record.name), js, "utf8");
}

export function deleteCustomTool(dir: string, name: string): void {
  rmSync(recordPath(dir, name), { force: true });
  rmSync(modulePath(dir, name), { force: true });
}

/** Load every persisted record. Corrupt files are skipped, never thrown
 *  (journal discipline). */
export function loadCustomTools(dir: string): CustomToolRecord[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: CustomToolRecord[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as CustomToolRecord;
      if (
        parsed?.version === 1 &&
        NAME_RE.test(parsed.name) &&
        f === `${parsed.name}.json` &&
        validateCustomTool(parsed) === null
      ) {
        out.push(parsed);
      }
    } catch {
      // skip corrupt
    }
  }
  return out.slice(0, MAX_CUSTOM_TOOLS);
}

/** Resolve the runtime that executes tool modules: bun preferred, node
 *  fallback. `process.execPath` is useless here — the compiled sidecar
 *  binary re-runs the agent, not a script. Null when neither exists. */
export function resolveToolRuntime(): string | null {
  for (const name of ["bun", "node"]) {
    const [resolved] = resolveExecutables([name]);
    // resolveExecutables keeps the bare name on failure; a real hit is absolute.
    if (resolved && (resolved.includes("/") || resolved.includes("\\"))) return resolved;
  }
  return null;
}

/** Build the registry `Tool` for one custom record. Execution goes
 *  through ctx.process (the ProcessSandbox) — same pipeline, caps and
 *  audit as shell_exec. */
export function createCustomTool(
  record: CustomToolRecord,
  dir: string,
  workspaceRoots: string[],
  runtime: string,
): Tool {
  const manifest: ToolManifest = {
    name: record.name,
    description: `[custom tool] ${record.description}`,
    permissions: ["process:spawn", "fs:read"],
    networkAccess: false,
    allowedPaths: [...workspaceRoots, dir],
    allowedExecutables: [runtime],
  };
  const timeoutMs = Math.min(
    Math.max(record.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000),
    MAX_TIMEOUT_MS,
  );

  return {
    manifest,
    parameters: record.parameters,
    async execute(args, ctx): Promise<ToolResult> {
      if (!ctx.process) {
        return { ok: false, content: `${record.name}: process sandbox unavailable`, error: "no_sandbox" };
      }
      // The runner is written idempotently before each call — trivial cost,
      // and it survives a user wiping the tools dir between boots.
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, RUNNER_FILENAME), RUNNER_SOURCE, "utf8");
      try {
        const result = await ctx.process.run(manifest, ctx.sessionId, {
          executable: runtime,
          args: [join(dir, RUNNER_FILENAME), modulePath(dir, record.name)],
          cwd: workspaceRoots[0],
          stdin: JSON.stringify(args ?? {}),
          timeoutMs,
        });
        const parsed = parseRunnerResult(result.stdout);
        if (parsed) return parsed;
        const detail = result.timedOut
          ? `timed out after ${timeoutMs}ms`
          : `exit ${result.exitCode}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
        return { ok: false, content: `${record.name}: no result emitted (${detail})`, error: "tool_error" };
      } catch (err) {
        return {
          ok: false,
          content: `${record.name} failed: ${String((err as Error).message ?? err)}`,
          error: "spawn_error",
        };
      }
    },
  };
}

/** The runner prints the result as the LAST JSON line — anything the
 *  tool itself logged to stdout above it is ignored. Exported for tests. */
export function parseRunnerResult(stdout: string): ToolResult | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { ok?: boolean; content?: string; data?: unknown; error?: string };
      if (typeof parsed.ok === "boolean") {
        return {
          ok: parsed.ok,
          content: String(parsed.content ?? ""),
          ...(parsed.data !== undefined ? { data: parsed.data } : {}),
          ...(parsed.error ? { error: parsed.error } : {}),
        };
      }
    } catch {
      // not the result line — keep scanning upward
    }
  }
  return null;
}
