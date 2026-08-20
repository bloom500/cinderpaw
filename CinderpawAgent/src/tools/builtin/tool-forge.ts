/**
 * tool_forge — the agent's door for creating, modifying and deleting its
 * OWN tools (self-extension of the tool surface).
 *
 * Guardrails, in the order a create/update crosses them:
 *   - Only tools created through the forge can be modified or deleted —
 *     builtins and MCP tools are untouchable (checked against the live
 *     registry, not just the store).
 *   - Same trust class as shell_exec: registered only under the
 *     FERAL_ENABLE_SHELL_EXEC gate (see boot.ts). Execution runs in a
 *     subprocess through the ProcessSandbox — see custom-tools.ts for
 *     what that sandbox does and does NOT confine.
 *   - SHAPE gate: the name/params/description must validate.
 *   - SYNTAX gate: the code transpiles BEFORE anything is persisted.
 *   - CONSENT gate: the owner approves before agent-written code runs for
 *     the first time. This is the only gate that covers what the code
 *     *does* — the subprocess runs with the user's own authority, so a
 *     smoke run is a correctness check, never a containment one. Fails
 *     CLOSED when no askUser bridge exists, unless
 *     FERAL_FORGE_NO_PROMPT_OK=true (headless opt-in, mirroring
 *     FERAL_DESKTOP_CONTROL_NO_PROMPT_OK).
 *   - SMOKE gate: the tool is run ONCE with caller-supplied `test_args`
 *     and must return the documented {ok, content} envelope. A tool that
 *     cannot complete one call is not a tool — it is not registered, and
 *     an update that fails restores the previous version.
 *   - Every forge call is audited by the registry like any tool call.
 *
 * A tool that passes all five is available immediately (hot-registered)
 * and persists across restarts (~/.feral/tools/).
 */

import type { AskUserQuestion, Tool, ToolContext, ToolManifest, ToolParameter } from "../../types.ts";
import type { ToolRegistry } from "../registry.ts";
import { cfgBool } from "../../config.ts";
import {
  createCustomTool,
  customToolsDir,
  deleteCustomTool,
  loadCustomTools,
  MAX_CUSTOM_TOOLS,
  QUARANTINE_CALLS,
  resolveToolRuntime,
  saveCustomTool,
  transpileToolCode,
  validateCustomTool,
  type CustomToolRecord,
  type ToolRuntime,
} from "../custom-tools.ts";

/** Ceiling on a smoke run, regardless of the tool's own timeout. The
 *  forge call is blocking the agent loop; a tool that wants 5 minutes per
 *  call can have them in production, not while we are deciding whether it
 *  is real. */
const SMOKE_TIMEOUT_MS = 30_000;

export interface ToolForgeDeps {
  registry: ToolRegistry;
  workspaceRoots: string[];
  /** Injectable for tests. Default: ~/.feral/tools. */
  dir?: string;
  /** Injectable for tests. Default: this binary, re-invoked as the runner. */
  runtime?: ToolRuntime;
  /**
   * Tool-health source for the boot-time pruning pass. Omit to disable
   * pruning (tests, and any caller that has no observation log).
   */
  health?: { buildHealthReport(): { tools: Array<{ tool: string; totalRuns: number; successRate: number }> } };
}

/** A forged tool is dropped at boot when it has earned nothing. */
const PRUNE_UNUSED_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_MIN_RUNS = 5;
const PRUNE_MIN_SUCCESS_RATE = 0.6;
/**
 * Grace period after an edit before failure statistics may condemn a tool.
 *
 * The health report is LIFETIME per tool name, with no notion of which version
 * of the code produced each run. So the normal way a tool gets fixed — forge
 * it, watch it fail five times, rewrite it — leaves it permanently below the
 * success-rate floor, and the next boot deletes the working version on the
 * strength of the broken one's record.
 *
 * ponytail: a week of grace, not versioned statistics. The real fix is to key
 * observations by code hash and reset the window on update; that needs the
 * observation log to carry the hash, which is a bigger change than the bug
 * warrants. Unused-pruning is untouched — it already requires 30 days.
 */
const PRUNE_RECENT_EDIT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Load persisted custom tools and register them. Returns the names
 * registered — boot calls this once, before registering the forge.
 *
 * Also the capability economy: a tool that has never been called in 30 days,
 * or that fails most of the time over a meaningful sample, is deleted rather
 * than re-registered. Without this the forge only ever grows, every dead
 * experiment keeps costing prompt tokens, and MAX_CUSTOM_TOOLS eventually
 * blocks the agent from building something it actually needs.
 *
 * Deliberately here and not in the dream cycle: this runs on every boot, on
 * every surface, with no scheduler involved — and it keeps the forge's
 * lifecycle inside the forge.
 */
export function registerPersistedCustomTools(deps: ToolForgeDeps): string[] {
  const dir = deps.dir ?? customToolsDir();
  const runtime = deps.runtime ?? resolveToolRuntime();
  const health = deps.health?.buildHealthReport().tools ?? [];
  const now = Date.now();
  const registered: string[] = [];
  for (const record of loadCustomTools(dir)) {
    if (deps.registry.has(record.name)) continue; // never shadow a builtin
    const stats = health.find((t) => t.tool === record.name);
    const runs = stats?.totalRuns ?? 0;
    // Never prune on the health report alone: with no observation log every
    // tool looks unused. The age check is what makes "unused" meaningful.
    const neverUsed = deps.health !== undefined && runs === 0 && now - record.updatedAt > PRUNE_UNUSED_MS;
    // …and never on stats that predate the current code (see the constant).
    const settled = now - record.updatedAt > PRUNE_RECENT_EDIT_MS;
    const mostlyBroken =
      settled && runs >= PRUNE_MIN_RUNS && (stats?.successRate ?? 1) < PRUNE_MIN_SUCCESS_RATE;
    if (neverUsed || mostlyBroken) {
      deleteCustomTool(dir, record.name);
      continue;
    }
    deps.registry.register(createCustomTool(record, dir, deps.workspaceRoots, runtime));
    registered.push(record.name);
  }
  return registered;
}

/**
 * Owner consent for running agent-written code. Mirrors control_app's
 * `confirmWrite`: no askUser bridge → fail CLOSED unless a headless
 * deployment opted in, and a timeout / cancel counts as a denial.
 *
 * The prompt states the authority honestly rather than the reassuring
 * version: the module runs as the user, because the ProcessSandbox gates
 * WHICH binary is spawned, not what the spawned code then does.
 */
async function confirmForge(
  action: string,
  record: CustomToolRecord,
  ctx: ToolContext,
): Promise<boolean> {
  if (!ctx.askUser) return cfgBool("FERAL_FORGE_NO_PROMPT_OK");
  const verb = action === "create" ? "wrote a new tool" : "rewrote its tool";
  const question: AskUserQuestion = {
    question:
      `Cinderpaw ${verb} "${record.name}" (${record.description}) and wants to run it. ` +
      `Agent-written tools run as you — your files, your network, your credentials. ` +
      `Allow ${record.code.split("\n").length} lines of generated code to run?`,
    header: "New tool",
    options: [
      { label: "Allow", description: `Run and keep "${record.name}". You can remove it later.` },
      { label: "Deny", description: "Nothing is written and nothing runs." },
    ],
    multiSelect: false,
  };
  try {
    const answers = await ctx.askUser.ask([question], ctx.sessionId);
    return (answers[0]?.selected?.[0]?.toLowerCase() ?? "").startsWith("allow");
  } catch {
    return false;
  }
}

export function createToolForgeTool(deps: ToolForgeDeps): Tool {
  const dir = deps.dir ?? customToolsDir();
  const runtime = deps.runtime ?? resolveToolRuntime();

  const manifest: ToolManifest = {
    name: "tool_forge",
    description:
      "Create, modify, delete or inspect your OWN custom tools. Actions: " +
      "`create` (name, description, parameters, code, test_args), `update` " +
      "(partial), `delete` (name), `list`, `show` (name). The tool's `code` " +
      "is a TypeScript/JavaScript module: `export default async function " +
      "(args) { return { ok: true, content: \"...\", data?: any }; }`. It runs " +
      "in a subprocess with Node/Bun builtins available (node:fs, node:path, " +
      "fetch, …). NETWORK IS OFF unless you list `allowed_domains` — a tool " +
      "that fetches must declare the hosts it calls. create/update ask the " +
      "user for approval and then SMOKE-RUN " +
      "the tool once with your `test_args` — if that run fails, the tool is " +
      "not registered (and an update keeps the previous version), so pass " +
      "test_args that genuinely exercise it. On success the tool is callable " +
      "immediately by its name and persists across restarts. Only " +
      "forge-created tools can be updated or deleted — builtins are " +
      "protected. Use this when you lack a tool for a recurring task, or an " +
      "existing custom tool is buggy.",
    // process:spawn is what lets the forge smoke-run a candidate before
    // registering it. The runtime is always this binary, so the permission
    // is always usable.
    permissions: ["fs:read", "fs:write", "process:spawn"],
    networkAccess: false,
    allowedPaths: [dir],
    allowedExecutables: [runtime.executable],
  };

  /** Names created by the forge (loaded from disk + created this session).
   *  The store on disk is the durable source of truth. */
  const ownedNames = (): Set<string> => new Set(loadCustomTools(dir).map((r) => r.name));

  return {
    manifest,
    parameters: {
      action: {
        type: "string",
        description: "One of: create, update, delete, list, show.",
        required: true,
      },
      name: {
        type: "string",
        description: "Tool name (snake_case, 3-32 chars). Required for all actions except `list`.",
        required: false,
      },
      description: {
        type: "string",
        description: "What the tool does — shown to you when choosing tools. Required for `create`.",
        required: false,
      },
      parameters: {
        type: "object",
        description:
          'Parameter spec: {"<param>": {"type": "string|number|boolean|object|array", "description": "...", "required": true|false}}. Default {} (no parameters).',
        required: false,
      },
      code: {
        type: "string",
        description:
          "The module source. Must have `export default async function (args) { ... }` returning {ok, content, data?}. Required for `create`.",
        required: false,
      },
      timeout_ms: {
        type: "number",
        description: "Per-call timeout in ms (default 30000, max 300000).",
        required: false,
      },
      test_args: {
        type: "object",
        description:
          "Arguments for the one smoke run that decides whether the tool gets registered. Must cover every required parameter. Pick values that make the tool do its real work — a run that returns ok:false blocks registration.",
        required: false,
      },
      allowed_domains: {
        type: "array",
        description:
          'Hostnames this tool may fetch, e.g. ["api.github.com"] (or ["*"] for any public host). Omit and the tool has NO network — its fetch calls are refused. Loopback and private addresses are always blocked.',
        required: false,
      },
    },
    async execute(args, ctx) {
      const action = typeof args.action === "string" ? args.action : "";
      const name = typeof args.name === "string" ? args.name.trim() : "";

      if (action === "list") {
        const records = loadCustomTools(dir);
        if (records.length === 0) {
          return { ok: true, content: "No custom tools yet. Use action=create to make one." };
        }
        const lines = records.map((r) => `- ${r.name}: ${r.description}`);
        return { ok: true, content: `Custom tools (${records.length}):\n${lines.join("\n")}`, data: { tools: records.map((r) => r.name) } };
      }

      if (!name) return { ok: false, content: `tool_forge: action "${action}" requires a name.`, error: "bad_args" };

      if (action === "show") {
        const record = loadCustomTools(dir).find((r) => r.name === name);
        if (!record) return { ok: false, content: `tool_forge: no custom tool "${name}".`, error: "not_found" };
        return {
          ok: true,
          content: `${record.name}: ${record.description}\nparameters: ${JSON.stringify(record.parameters)}\n\n${record.code}`,
          data: { record },
        };
      }

      if (action === "delete") {
        if (!ownedNames().has(name)) {
          return {
            ok: false,
            content: `tool_forge: "${name}" is not a forge-created tool — builtins cannot be deleted.`,
            error: "protected",
          };
        }
        deleteCustomTool(dir, name);
        deps.registry.unregister(name);
        return { ok: true, content: `Deleted custom tool "${name}".` };
      }

      if (action !== "create" && action !== "update") {
        return { ok: false, content: `tool_forge: unknown action "${action}". Use create|update|delete|list|show.`, error: "bad_args" };
      }

      const existing = loadCustomTools(dir).find((r) => r.name === name);
      if (action === "create" && deps.registry.has(name) && !ownedNames().has(name)) {
        return { ok: false, content: `tool_forge: "${name}" already exists as a builtin — pick another name.`, error: "name_taken" };
      }
      if (action === "update" && !existing) {
        return { ok: false, content: `tool_forge: no custom tool "${name}" to update — use action=create.`, error: "not_found" };
      }
      if (action === "create" && !existing && loadCustomTools(dir).length >= MAX_CUSTOM_TOOLS) {
        return { ok: false, content: `tool_forge: limit of ${MAX_CUSTOM_TOOLS} custom tools reached — delete one first.`, error: "limit" };
      }

      // Merge update over the existing record; create demands the full shape.
      const description =
        typeof args.description === "string" && args.description.trim()
          ? args.description.trim()
          : existing?.description ?? "";
      const parameters =
        args.parameters && typeof args.parameters === "object" && !Array.isArray(args.parameters)
          ? (args.parameters as Record<string, ToolParameter>)
          : existing?.parameters ?? {};
      const code = typeof args.code === "string" && args.code.trim() ? args.code : existing?.code ?? "";
      const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : existing?.timeoutMs;
      const allowedDomains = Array.isArray(args.allowed_domains)
        ? (args.allowed_domains as string[])
        : existing?.allowedDomains;

      const invalid = validateCustomTool({ name, description, parameters, code, ...(allowedDomains ? { allowedDomains } : {}) });
      if (invalid) return { ok: false, content: `tool_forge: ${invalid}`, error: "bad_args" };

      const transpiled = transpileToolCode(code);
      if ("error" in transpiled) return { ok: false, content: `tool_forge: ${transpiled.error}`, error: "bad_code" };
      if (!code.includes("export default")) {
        return { ok: false, content: "tool_forge: code must have `export default async function (args) {...}`.", error: "bad_code" };
      }

      // An update that does not touch what EXECUTES (the code, or the hosts it
      // may reach) has nothing to smoke: the same bytes already passed, with
      // the same egress, and re-running them costs a spawn plus whatever side
      // effects the test args have. Metadata-only edits — a better
      // description, a longer timeout — take this door.
      const behaviourUnchanged =
        !!existing &&
        existing.code === code &&
        (existing.allowedDomains ?? []).join(",") === (allowedDomains ?? []).join(",");

      // The smoke run needs arguments, and only the caller knows which ones
      // are meaningful. Demand coverage of the required params up front —
      // a cheap rejection before we ask the user to approve anything.
      const requiredParams = Object.entries(parameters)
        .filter(([, p]) => p.required !== false)
        .map(([key]) => key);
      const testArgs =
        args.test_args && typeof args.test_args === "object" && !Array.isArray(args.test_args)
          ? (args.test_args as Record<string, unknown>)
          : {};
      const uncovered = behaviourUnchanged ? [] : requiredParams.filter((key) => !(key in testArgs));
      if (uncovered.length > 0) {
        return {
          ok: false,
          content:
            `tool_forge: pass test_args covering the required parameter(s) ${uncovered.join(", ")} — ` +
            `"${name}" is smoke-run once before it is registered.`,
          error: "bad_args",
        };
      }

      if (!ctx.process && !behaviourUnchanged) {
        return {
          ok: false,
          content: "tool_forge: no process sandbox available — a tool cannot be verified, so it will not be registered.",
          error: "no_sandbox",
        };
      }

      const now = Date.now();
      const record: CustomToolRecord = {
        version: 1,
        name,
        description,
        parameters,
        code,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(allowedDomains && allowedDomains.length > 0 ? { allowedDomains } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      // CONSENT before the code runs even once. Everything above this line
      // inspects text; everything below executes it.
      if (!(await confirmForge(action, record, ctx))) {
        return {
          ok: false,
          content: `tool_forge: the user declined "${action}" for "${name}" — nothing was written.`,
          error: "denied",
        };
      }

      // Persist first: the runner imports the module from disk, so there is
      // nothing to smoke-run until it exists. An update overwrites the live
      // module here and `restore()` puts it back if the candidate fails —
      // the previous version stays REGISTERED throughout, so a failed update
      // is a no-op from the agent's side.
      saveCustomTool(dir, record, transpiled.js);
      const restore = () => {
        const previous = existing ? transpileToolCode(existing.code) : null;
        if (existing && previous && "js" in previous) saveCustomTool(dir, existing, previous.js);
        else deleteCustomTool(dir, name);
      };

      // `calls: QUARANTINE_CALLS` marks the smoke candidate as already
      // graduated so it does not prompt: the consent gate a few lines above
      // IS the approval for this one execution. The PERSISTED record still
      // has calls: 0, so the first real call re-enters quarantine.
      const candidate = createCustomTool(
        {
          ...record,
          timeoutMs: Math.min(record.timeoutMs ?? SMOKE_TIMEOUT_MS, SMOKE_TIMEOUT_MS),
          calls: QUARANTINE_CALLS,
        },
        dir,
        deps.workspaceRoots,
        runtime,
      );
      let smoke: Awaited<ReturnType<Tool["execute"]>>;
      if (behaviourUnchanged) {
        smoke = { ok: true, content: "(code unchanged — smoke run skipped)" };
      } else {
        try {
          smoke = await candidate.execute(testArgs, ctx);
        } catch (err) {
          smoke = { ok: false, content: String((err as Error)?.message ?? err), error: "tool_error" };
        }
      }
      // ADVERSARIAL half. The run above is a self-graded exam: the model wrote
      // the tool AND chose the arguments, so it can pick inputs that make its
      // own code look good. This second run uses arguments the model did not
      // choose — none at all — and asks a question it cannot dodge: does the
      // tool still return the documented envelope when its inputs are missing?
      //
      // It is allowed to FAIL (ok:false is a fine answer to "no arguments").
      // What it may not do is crash, hang, or emit nothing, because that is
      // the shape of a tool that will one day kill an unattended run: a
      // `args.path.split()` on an absent field throws, the runner emits no
      // result line, and the agent sees an unexplained tool_error at 3am.
      //
      // ponytail: one negative case, not a fuzzer. It catches the single most
      // common forged-tool defect (unguarded argument access) for the cost of
      // one extra spawn. Property-based generation from the parameter schema
      // is the upgrade path if this ever proves too shallow.
      // Skipped when the code is unchanged (nothing new to probe) and when the
      // tool takes no arguments (the run above already WAS the no-args case).
      if (smoke.ok && !behaviourUnchanged && Object.keys(testArgs).length > 0) {
        let robust: Awaited<ReturnType<Tool["execute"]>>;
        try {
          robust = await candidate.execute({}, ctx);
        } catch (err) {
          robust = { ok: false, content: String((err as Error)?.message ?? err), error: "tool_error" };
        }
        // "no result emitted" is the runner's words for a crash/timeout/silence.
        if (robust.error === "spawn_error" || /no result emitted/.test(robust.content)) {
          restore();
          return {
            ok: false,
            content:
              `tool_forge: "${name}" passed its smoke run but CRASHED when called with no ` +
              `arguments, so it was NOT registered${existing ? " (the previous version is untouched)" : ""}. ` +
              `Guard every argument you read — return {ok:false, content:"<what is missing>"} ` +
              `instead of throwing. It reported: ${robust.content.slice(0, 300)}`,
            error: "smoke_failed",
            data: { name, action, phase: "no_args" },
          };
        }
      }

      if (!smoke.ok) {
        restore();
        return {
          ok: false,
          content:
            `tool_forge: "${name}" failed its smoke run and was NOT registered` +
            `${existing ? " (the previous version is untouched)" : ""} — ${smoke.content}`,
          error: "smoke_failed",
          data: { name, action, testArgs },
        };
      }

      deps.registry.unregister(name);
      deps.registry.register(createCustomTool(record, dir, deps.workspaceRoots, runtime));

      return {
        ok: true,
        content:
          `${action === "create" ? "Created" : "Updated"} custom tool "${name}" — approved, smoke-run with ` +
          `${JSON.stringify(testArgs)}, and registered. It returned: ${smoke.content.slice(0, 200)}`,
        data: { name, action },
      };
    },
  };
}
