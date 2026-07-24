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
 * What the ProcessSandbox actually buys here — read this before trusting
 * the word "sandboxed": it is a SPAWN-TIME gate. It checks that the tool
 * declared `process:spawn`, that the executable is on the allowlist, that
 * the cwd is inside `allowedPaths`, and it scrubs the environment. Once
 * the runtime is running the agent's module, that module has the user's
 * full ambient authority: it can read any file the user can read and open
 * any socket the user can open. `allowedPaths` below constrains the cwd,
 * not the child's syscalls, and `networkAccess: false` means only "this
 * tool is not handed an egress-proxied ctx.fetch" — the child calls
 * `fetch` itself, outside the proxy.
 *
 * ponytail: OS-level confinement (job objects / seccomp / a WASI runtime)
 * is the real fix and is deliberately not attempted here. Until then the
 * containment story is the forge's CONSENT gate — the owner approves the
 * code before it runs — and the deny wall on the fs tools. Upgrade path:
 * run the module under a WASI runtime with an explicit preopen set, which
 * would also make `networkAccess` true rather than decorative.
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
 * time, which doubles as the syntax check.
 *
 * The runner is THIS binary re-invoked with `--custom-tool-runner` (see
 * custom-tool-runner.ts): a packaged Feral embeds its Bun runtime, so the
 * feature no longer depends on the user having `bun` or `node` installed.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cfgBool, feralHome } from "../config.ts";
import { CUSTOM_TOOL_RUNNER_FLAG } from "./custom-tool-runner.ts";
import type { AskUserQuestion, Tool, ToolManifest, ToolParameter, ToolResult } from "../types.ts";

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
  /**
   * Quarantine counter: how many owner-approved calls this tool has made.
   * Below QUARANTINE_CALLS the tool is "experimental" and every call is
   * confirmed; at or above it the tool has graduated and runs unattended.
   * Absent on records written before quarantine existed — treated as 0, so
   * an already-forged tool re-enters quarantine once. That is deliberate:
   * those tools were registered by the old transpile-only gate and have
   * never been reviewed by anyone.
   */
  calls?: number;
  createdAt: number;
  updatedAt: number;
}

/** Owner-approved calls before a forged tool stops asking. */
export const QUARANTINE_CALLS = 3;

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

/**
 * Update ONLY the quarantine counter of a stored record. Deliberately does
 * not go through `saveCustomTool`: that needs the transpiled module, and a
 * counter bump must never be able to rewrite executable code.
 */
export function setCustomToolCalls(dir: string, name: string, calls: number): void {
  const file = recordPath(dir, name);
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as CustomToolRecord;
    if (record?.name !== name) return;
    record.calls = calls;
    writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
  } catch {
    // Missing / corrupt record → nothing to count. The caller still gates
    // the call; losing the counter costs an extra prompt, never a silent
    // ungated execution.
  }
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

/** How to spawn a tool module: the executable plus the argv that go before
 *  the module path. */
export interface ToolRuntime {
  executable: string;
  prefix: string[];
}

/**
 * Resolve the runtime that executes tool modules — always ourselves.
 *
 * Packaged, `process.execPath` IS the sidecar and re-invoking it with the
 * runner flag runs the module inside the embedded Bun. In development the
 * sidecar runs *under* a bun interpreter, so the entry script has to be
 * passed too (`bun <entry> --custom-tool-runner <module>`), otherwise bun
 * would try to interpret our flag as one of its own.
 *
 * Never returns null: unlike the old bun/node PATH lookup, there is no
 * machine where this feature is unavailable.
 */
export function resolveToolRuntime(): ToolRuntime {
  // ponytail: dev mode is identified by the interpreter's filename. A bun
  // binary renamed to something else would be misread as a packaged
  // sidecar; the cost is a failed spawn at forge time, not a wrong result.
  // Upgrade path if that ever bites: a build-time flag baked into VERSION.
  const interpreter = basename(process.execPath).toLowerCase().replace(/\.exe$/, "");
  const underBun = interpreter === "bun" || interpreter === "bun-debug";
  return {
    executable: process.execPath,
    prefix: underBun ? [Bun.main, CUSTOM_TOOL_RUNNER_FLAG] : [CUSTOM_TOOL_RUNNER_FLAG],
  };
}

/** Build the registry `Tool` for one custom record. Execution goes
 *  through ctx.process (the ProcessSandbox) — same pipeline, caps and
 *  audit as shell_exec. */
export function createCustomTool(
  record: CustomToolRecord,
  dir: string,
  workspaceRoots: string[],
  runtime: ToolRuntime,
): Tool {
  const manifest: ToolManifest = {
    name: record.name,
    description: `[custom tool] ${record.description}`,
    permissions: ["process:spawn", "fs:read"],
    // Describes what the SANDBOX grants this tool (no proxied ctx.fetch),
    // NOT what the child process can reach. See the module docblock.
    networkAccess: false,
    allowedPaths: [...workspaceRoots, dir],
    allowedExecutables: [runtime.executable],
  };
  const timeoutMs = Math.min(
    Math.max(record.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000),
    MAX_TIMEOUT_MS,
  );

  // Quarantine state is cached once it graduates so a trusted tool costs no
  // disk read per call; while quarantined the counter is re-read from disk so
  // it stays correct across restarts and across the TUI/desktop/connector
  // processes that each build their own Tool object from the same store.
  let graduated = (record.calls ?? 0) >= QUARANTINE_CALLS;

  return {
    manifest,
    parameters: record.parameters,
    async execute(args, ctx): Promise<ToolResult> {
      if (!ctx.process) {
        return { ok: false, content: `${record.name}: process sandbox unavailable`, error: "no_sandbox" };
      }

      if (!graduated) {
        const seen = loadCustomTools(dir).find((r) => r.name === record.name)?.calls ?? 0;
        if (seen >= QUARANTINE_CALLS) {
          graduated = true;
        } else {
          const verdict = await confirmQuarantinedCall(record, args, ctx, seen);
          if (verdict === "deny") {
            return {
              ok: false,
              content:
                `${record.name}: the user declined this call. The tool is still experimental ` +
                `(${seen}/${QUARANTINE_CALLS} approved calls). Explain what you wanted it to do, or use another tool.`,
              error: "denied",
            };
          }
          if (verdict === "always") {
            setCustomToolCalls(dir, record.name, QUARANTINE_CALLS);
            graduated = true;
          } else {
            setCustomToolCalls(dir, record.name, seen + 1);
          }
        }
      }
      try {
        const result = await ctx.process.run(manifest, ctx.sessionId, {
          executable: runtime.executable,
          args: [...runtime.prefix, modulePath(dir, record.name)],
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

/**
 * Confirm one call of a still-experimental forged tool. Same fail-closed
 * discipline as the forge's creation gate (`confirmForge`) and control_app's
 * `confirmWrite`: no bridge to ask through → denied, unless a headless
 * deployment opted in with FERAL_FORGE_NO_PROMPT_OK.
 *
 * The prompt shows the ARGUMENTS, because that is what differs between a
 * benign call and a harmful one — the code was already reviewed at creation.
 */
async function confirmQuarantinedCall(
  record: CustomToolRecord,
  args: Record<string, unknown>,
  ctx: Parameters<Tool["execute"]>[1],
  seen: number,
): Promise<"once" | "always" | "deny"> {
  if (!ctx.askUser) return cfgBool("FERAL_FORGE_NO_PROMPT_OK") ? "once" : "deny";
  let rendered: string;
  try {
    rendered = JSON.stringify(args ?? {}).slice(0, 300);
  } catch {
    rendered = "(unserializable arguments)";
  }
  const question: AskUserQuestion = {
    question:
      `Run the agent-built tool "${record.name}" (${record.description})? ` +
      `Call ${seen + 1} of ${QUARANTINE_CALLS} while it is still experimental. Arguments: ${rendered}`,
    header: "Run tool",
    options: [
      { label: "Allow once", description: "Run this call. Feral will ask again next time." },
      { label: "Always allow", description: `Stop asking — "${record.name}" becomes a normal tool.` },
      { label: "Deny", description: "Skip this call." },
    ],
    multiSelect: false,
  };
  try {
    const answers = await ctx.askUser.ask([question], ctx.sessionId);
    const picked = answers[0]?.selected?.[0]?.toLowerCase() ?? "";
    if (picked.startsWith("always")) return "always";
    if (picked.startsWith("allow")) return "once";
    return "deny";
  } catch {
    return "deny"; // timeout / cancel → fail safe
  }
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
