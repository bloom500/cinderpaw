/**
 * The user's own commands, attached to the events the agent already emits.
 *
 * `HookRegistry` gives internal code a place to listen; this gives the PERSON
 * one. Post the walk-away report into a team channel, append every file write
 * to an audit system, stop the overnight run from touching anything during a
 * change freeze — each of those is a feature request today, and a line of JSON
 * once this exists.
 *
 * `~/.feral/hooks.json`, one entry per event:
 *
 * ```json
 * {
 *   "after_tool_call": [{ "match": "write_file", "command": ["node", "audit.js"] }],
 *   "before_tool_call": [{ "match": "write_file", "command": ["./freeze-check.sh"] }],
 *   "agent_end":        [{ "command": ["curl", "-XPOST", "https://hooks.example/done"] }]
 * }
 * ```
 *
 * The event payload arrives as JSON on the hook's stdin. No shell is involved:
 * `command` is an argv array, so nothing is re-interpreted on the way.
 *
 * **A `before_*` hook can refuse.** Exit non-zero and the operation is blocked,
 * with the hook's stderr given to the agent as the reason — so it can do
 * something else rather than fail blind. That is the whole point of a freeze
 * check, and it is why hooks are worth more than a notification system.
 * `after_*` hooks cannot block: the thing already happened, and pretending
 * otherwise would be a lie to the agent.
 *
 * Three properties that keep somebody else's script from becoming our problem:
 *   - **bounded** — killed after `timeoutMs` (5s default). A hook that hangs
 *     must not hang the turn.
 *   - **non-fatal** — a failing `after_*` hook is logged and ignored. A
 *     notification script breaking must never fail the work it reports on.
 *   - **fail-open on absence, fail-closed on refusal** — no file means no
 *     hooks; a `before_*` hook that cannot even start does NOT block, because
 *     an unstartable command is a config error, not a policy decision.
 *
 * Read fresh on every install call, so `feral gateway restart` picks up edits;
 * handlers are registered once at boot, which is where the registry lives.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { feralHome } from "../config.ts";
import type { HookRegistry } from "./hook-registry.ts";
import type { HookEvent, HookResult } from "../types.ts";

export interface UserHook {
  /** Argv. First entry is the program; there is no shell. */
  command: string[];
  /** Fire only for this tool (`before_tool_call` / `after_tool_call`). */
  match?: string;
  /** Kill after this many ms. Default 5000. */
  timeoutMs?: number;
}

type HookFile = Partial<Record<HookEvent, UserHook[]>>;

type Log = (message: string) => void;

const DEFAULT_TIMEOUT_MS = 5_000;

export function userHooksPath(): string {
  return join(feralHome(), "hooks.json");
}

/** Parse the file. Absent = no hooks (the normal case); broken = say so. */
export function loadUserHooks(log: Log = () => {}): HookFile {
  let raw: string;
  try {
    raw = readFileSync(userHooksPath(), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as HookFile;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected an object of event → hooks");
    }
    return parsed;
  } catch (err) {
    // Loudly, once: a typo here is otherwise indistinguishable from "the user
    // configured nothing", and they would be waiting for a hook that can never
    // fire.
    log(`hooks: ${userHooksPath()} ignored — ${String(err)}`);
    return {};
  }
}

interface RunOutcome {
  ok: boolean;
  /** Whatever the hook printed on stderr, trimmed — the refusal's reason. */
  stderr: string;
}

function runHook(hook: UserHook, payload: unknown, log: Log): Promise<RunOutcome> {
  const [program, ...args] = hook.command;
  const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!program) {
    log("hooks: an entry has an empty command — skipped");
    return Promise.resolve({ ok: true, stderr: "" });
  }
  return new Promise<RunOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, args, { stdio: ["pipe", "ignore", "pipe"] });
    } catch (err) {
      log(`hooks: could not start ${program}: ${String(err)}`);
      resolve({ ok: true, stderr: "" }); // config error, not a policy decision
      return;
    }
    let stderr = "";
    let settled = false;
    const done = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      log(`hooks: ${program} exceeded ${timeoutMs}ms — killed`);
      child.kill("SIGKILL");
      done({ ok: true, stderr: "" }); // a hook that never answered did not refuse
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    child.on("error", (err) => {
      log(`hooks: ${program} failed: ${String(err)}`);
      done({ ok: true, stderr: "" });
    });
    child.on("close", (code) => {
      if (code !== 0) log(`hooks: ${program} exited ${code}`);
      done({ ok: code === 0, stderr: stderr.trim().slice(0, 400) });
    });
    try {
      child.stdin?.end(JSON.stringify(payload));
    } catch {
      // Child died before reading stdin; `close`/`error` already covers it.
    }
  });
}

/** The tool name in a payload, for `match`. Other events have no name. */
function toolOf(payload: unknown): string | undefined {
  const t = (payload as { tool?: unknown })?.tool;
  return typeof t === "string" ? t : undefined;
}

/**
 * Register every hook declared in the file onto the live registry.
 *
 * Returns how many were installed, so boot can say so in the log — a hook
 * system that gives no sign of having read your file is one you debug by
 * guessing.
 */
export function installUserHooks(registry: HookRegistry, log: Log = () => {}): number {
  const file = loadUserHooks(log);
  let installed = 0;

  for (const [event, hooks] of Object.entries(file) as Array<[HookEvent, UserHook[]]>) {
    if (!Array.isArray(hooks)) continue;
    const blocking = event.startsWith("before_");
    for (const hook of hooks) {
      registry.on(event, (async (payload: unknown): Promise<HookResult> => {
        if (hook.match && toolOf(payload) !== hook.match) return { block: false };
        const outcome = await runHook(hook, { event, ...(payload as object) }, log);
        if (blocking && !outcome.ok) {
          return {
            block: true,
            reason:
              outcome.stderr ||
              `blocked by the hook ${hook.command[0]} (exit non-zero, no reason given)`,
          };
        }
        return { block: false };
      }) as never);
      installed++;
    }
  }
  return installed;
}
