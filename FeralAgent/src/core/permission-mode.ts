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

import { cfgBool } from "../config.ts";
import type { CommandIntent } from "./command-intent.ts";

export type PermissionMode = "read_only" | "workspace_write" | "full_access";

export type Decision =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "warn"; question: string; detail: string };

const ALLOW: Decision = { kind: "allow" };

/**
 * The mode this process runs in.
 *
 * `FERAL_PERMISSION_MODE` names it directly. Absent, the historical knobs still
 * decide, so an existing install keeps behaving exactly as it did: a wildcard
 * shell whitelist has always meant "the operator took the brakes off".
 */
export function permissionMode(env: NodeJS.ProcessEnv = process.env): PermissionMode {
  const named = (env.FERAL_PERMISSION_MODE ?? "").trim().toLowerCase();
  if (named === "read_only" || named === "readonly") return "read_only";
  if (named === "workspace_write") return "workspace_write";
  if (named === "full_access" || named === "full") return "full_access";
  if ((env.FERAL_SHELL_WHITELIST ?? "").trim() === "*") return "full_access";
  return "workspace_write";
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
