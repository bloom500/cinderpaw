/**
 * One mode instead of four scattered switches, and three answers instead of two.
 *
 * Permissiveness used to be spread across `FERAL_SHELL_WHITELIST="*"`,
 * `FERAL_ENABLE_SHELL_EXEC`, the catastrophic denylist and the blast-radius
 * guard — four knobs with no name for the state they add up to, and no way for
 * a user to say the one thing they most often mean: *look, but do not touch*.
 *
 * The three modes:
 *   - `read_only`     — reads anything, changes nothing. No file writes, no
 *                       destructive or machine-level commands. The mode for
 *                       "audit this repo and tell me what is wrong", and for
 *                       any surface where the person talking is not the owner.
 *   - `workspace_write` (default) — the working agent: writes inside the
 *                       workspace roots, where the safety point can undo it.
 *   - `full_access`   — the operator has decided; guards that exist to prevent
 *                       mistakes get out of the way. The catastrophic denylist
 *                       still applies, because nobody means `mkfs`.
 *
 * And three outcomes, because two were not enough. `Block` is a refusal the
 * agent must work around; `Warn` is a decision that belongs to a human. With a
 * human present, Warn asks. With nobody there, Warn refuses rather than
 * auto-approving itself — the same rule `ask_user` already applies to
 * consequential decisions in walk-away mode, for the same reason: an agent
 * that can approve its own destructive act has no gate at all.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cfgBool, feralHome } from "../config.ts";
import type { CommandIntent } from "./command-intent.ts";

export type PermissionMode = "read_only" | "workspace_write" | "full_access";

export type Decision =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "warn"; question: string; detail: string };

const ALLOW: Decision = { kind: "allow" };

function named(raw: string | undefined): PermissionMode | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "read_only" || v === "readonly") return "read_only";
  if (v === "workspace_write") return "workspace_write";
  if (v === "full_access" || v === "full") return "full_access";
  return null;
}

/** Re-read settings.json at most this often. Shell commands are human-paced. */
const SETTINGS_TTL_MS = 2_000;
let cached: { mode: PermissionMode | null; at: number } | null = null;

/**
 * `permission_mode` from `~/.feral/settings.json`, or null.
 *
 * Every other setting reaches the sidecar as an env var the Rust host exports
 * before spawning it, which means changing one needs a host rebuild AND a
 * restart. For this setting that is the difference between a switch and a
 * ceremony: "read-only for a public connector" was reachable only by relaunching
 * the gateway with a variable set, so nobody would ever use it.
 *
 * Read here instead, by the process that enforces it. `permissionMode()` is
 * called per command, so a change applies to the NEXT command — no restart, no
 * host rebuild, and any UI that already writes settings.json gets the switch for
 * free.
 *
 * Silent on every failure: a missing file, bad JSON, or an unknown value all
 * mean "not configured", never "deny everything". A settings typo must not brick
 * the agent, and the env var and the historical knobs still win over this.
 *
 * ponytail: 2s cache, not a file watcher. Commands come at human speed.
 */
function settingsMode(): PermissionMode | null {
  const now = Date.now();
  if (cached && now - cached.at < SETTINGS_TTL_MS) return cached.mode;
  let mode: PermissionMode | null = null;
  try {
    const raw = readFileSync(join(feralHome(), "settings.json"), "utf8");
    mode = named((JSON.parse(raw) as { permission_mode?: string }).permission_mode);
  } catch {
    mode = null;
  }
  cached = { mode, at: now };
  return mode;
}

/** Drop the settings cache. For tests, and for a settings write that must bite now. */
export function resetPermissionModeCache(): void {
  cached = null;
}

/**
 * The mode this process runs in.
 *
 * Order: `FERAL_PERMISSION_MODE` names it directly; then the historical knobs,
 * so an existing install keeps behaving exactly as it did (a wildcard shell
 * whitelist has always meant "the operator took the brakes off"); then
 * `settings.json`, which is the only one a user can change without a restart.
 * Default `workspace_write`.
 */
export function permissionMode(env: NodeJS.ProcessEnv = process.env): PermissionMode {
  const fromEnv = named(env.FERAL_PERMISSION_MODE);
  if (fromEnv) return fromEnv;
  if ((env.FERAL_SHELL_WHITELIST ?? "").trim() === "*") return "full_access";
  return settingsMode() ?? "workspace_write";
}

/** Intents that change something. Everything else only observes. */
const MUTATING: ReadonlySet<CommandIntent> = new Set<CommandIntent>([
  "write",
  "destructive",
  "process",
  "package",
  "system",
]);

/**
 * May a command with this intent run in this mode?
 *
 * `unknown` is deliberately refused in read-only mode. A binary we cannot
 * classify might do anything, and a read-only promise that lets unclassified
 * commands through is not a promise. In the other modes it passes: refusing
 * every unrecognised binary would break ordinary work for no gain.
 */
export function decideIntent(intent: CommandIntent, mode: PermissionMode): Decision {
  if (mode !== "read_only") return ALLOW;
  if (intent === "read_only") return ALLOW;
  if (intent === "network") {
    return {
      kind: "block",
      reason:
        "read-only mode: network commands can send as well as fetch, so they are not " +
        "read-only. Use the web tools, or ask the user to leave read-only mode.",
    };
  }
  if (intent === "unknown") {
    return {
      kind: "block",
      reason:
        "read-only mode: this binary is not one of the known read-only commands, so " +
        "what it would change cannot be established. Use a recognised read command.",
    };
  }
  return {
    kind: "block",
    reason: `read-only mode: this command would ${
      MUTATING.has(intent) ? "change something" : "act outside reading"
    } (classified: ${intent}). Report what you found instead of changing it.`,
  };
}

/**
 * Destruction aimed outside every workspace root.
 *
 * Previously a flat refusal. It is genuinely ambiguous — sometimes the user
 * really does want the agent to clear a folder elsewhere — so it becomes the
 * human's call when a human is reachable, and stays a refusal when not.
 */
export function decideOutsideWorkspace(path: string, mode: PermissionMode): Decision {
  if (mode === "full_access") return ALLOW;
  return {
    kind: "warn",
    question: `Let the agent destroy "${path}"? It is outside the workspace, so nothing can undo it.`,
    detail:
      `the target "${path}" is outside every workspace root, where no safety point ` +
      "was taken and the change cannot be undone",
  };
}

/** Is anybody there to answer a Warn? */
export function canAskAHuman(hasBridge: boolean): boolean {
  // Walk-away mode auto-answers ordinary questions, but never this class — see
  // the module docstring, and `ask_user`'s own escalation rule.
  return hasBridge && !cfgBool("FERAL_AUTONOMOUS");
}
