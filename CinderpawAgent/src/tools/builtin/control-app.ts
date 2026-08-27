/**
 * control_app — drive native desktop applications through the OS accessibility
 * tree (UIA on Windows, AX on macOS via the Rust host).
 *
 * This is STRUCTURAL control: the agent reads element trees and acts on named
 * elements through their accessibility patterns. No screenshots, no OCR, no
 * blind global input synthesis.
 *
 * Security (defense in depth — the OS reach of this tool is large):
 *   - Like `ask_user`, this tool declares NO sandbox permissions and performs
 *     no fs/network/process work itself. It reaches the OS only through the
 *     `desktopControl` bridge, which round-trips to the Rust host. The host is
 *     where every real security decision is enforced: the global opt-in flag,
 *     the app allow/deny policy, and secure-field redaction. (process:spawn
 *     would be the wrong permission here — it forces an executable allowlist
 *     and hands the tool an unused process sandbox; the bridge model, mirroring
 *     ask_user, is the correct fit and still routes through ToolRegistry.)
 *   - State-changing actions (click / type / perform_action) are confirmed with
 *     the user through `ask_user` before they run, unless
 *     CINDERPAW_DESKTOP_CONTROL_CONFIRM=false. Read actions never prompt. When a
 *     transport has no askUser bridge, a required confirmation fails CLOSED
 *     (action denied) unless CINDERPAW_DESKTOP_CONTROL_NO_PROMPT_OK=true opts into
 *     prompt-less execution for trusted/headless setups.
 *   - Any value that could be a secret typed into a password field is redacted
 *     (`[REDACTED]`) in this tool's own audit entries; the host independently
 *     refuses to read secure-field values back to the model.
 *
 * The tool is only registered when CINDERPAW_ENABLE_DESKTOP_CONTROL=true (see
 * index.ts), matching the opt-in posture of shell_exec.
 */

import type { Tool, ToolResult, AskUserQuestion } from "../../types.ts";
import { cfgBool, readEnv } from "../../config.ts";

type Action =
  | "list_windows"
  | "get_tree"
  | "find_elements"
  | "click"
  | "type"
  | "send_keys"
  | "get_value"
  | "get_focused"
  | "perform_action"
  | "launch";

const WRITE_ACTIONS: ReadonlySet<Action> = new Set<Action>(["click", "type", "send_keys", "perform_action", "launch"]);

/**
 * Actions that ALWAYS require user confirmation, even when
 * CINDERPAW_DESKTOP_CONTROL_CONFIRM=false. `launch` creates a process, a higher
 * bar than clicking a button, so it is never silently auto-approved.
 */
const ALWAYS_CONFIRM: ReadonlySet<Action> = new Set<Action>(["launch"]);

const VALID_ACTIONS: ReadonlySet<string> = new Set<string>([
  "list_windows",
  "get_tree",
  "find_elements",
  "click",
  "type",
  "send_keys",
  "get_value",
  "get_focused",
  "perform_action",
  "launch",
]);

/** Default tree depth when the caller omits it. Clamped again in the host. */
const DEFAULT_DEPTH = 4;
const MAX_DEPTH = 30;

/**
 * Redact obviously-sensitive argument values for THIS tool's own audit entry.
 * The host redacts secure-field reads; this protects the typed value on the
 * way in when we cannot yet know whether the target is a password field.
 */
export function redactArgsForAudit(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof out.text === "string") out.text = "[REDACTED]";
  if (typeof out.keys === "string") out.keys = "[REDACTED]";
  return out;
}

function structuredError(message: string, recoverable: boolean): ToolResult {
  return {
    ok: false,
    content: message,
    error: recoverable ? "recoverable" : "unrecoverable",
    data: { error: true, message, recoverable },
  };
}

/**
 * Heuristic: which inbound failures from the host are worth retrying.
 *
 * Inverted default: control_app failures are overwhelmingly transient UI-timing
 * issues (the tree wasn't ready, the element moved, the window wasn't focused
 * yet), so the safe default is "recoverable — let the agent retry". Only
 * DETERMINISTIC failures — policy refusals, bad args, config errors, things a
 * retry can never fix — are marked unrecoverable. The previous allowlist of
 * recoverable substrings was both too narrow (transient errors with no matching
 * keyword fell through to unrecoverable) and too broad in its refusal check
 * (`"not in"` wrongly matched `"not invokable"`), so the agent gave up on
 * failures it should have retried — the bulk of the reported "unrecoverable".
 */
export function isRecoverable(message: string): boolean {
  const m = message.toLowerCase();
  const PERMANENT = [
    "denylist", // security denylist — never controllable
    "allowlist", // not in CINDERPAW_DESKTOP_CONTROL_ALLOWED_APPS
    // Keyed on the variable's stable tail, not on the brand: this matcher was
    // spelled "is not in feral" and stopped recognising its own refusal the
    // day the variable became CINDERPAW_DESKTOP_CONTROL_ALLOWED_APPS — the
    // agent then retried an action policy had permanently denied.
    "allowed_apps",
    "control is disabled", // CINDERPAW_ENABLE_DESKTOP_CONTROL not set
    "requires", // missing required arg (model error)
    "unknown action",
    "unsupported action",
    "does not support", // element lacks the requested pattern
    "not invokable",
    "malformed element id",
    "illegal characters",
    "declined", // user said no
    "no resolvable app name",
  ];
  if (PERMANENT.some((p) => m.includes(p))) return false;
  // element_not_found, window closed/changed, focus race, COM hiccup, timeout,
  // partial SendInput, etc. → transient, worth a retry.
  return true;
}

export function createControlAppTool(): Tool {
  return {
    manifest: {
      name: "control_app",
      description:
        "Drive a native desktop application through the OS accessibility tree " +
        "(structural control — no screenshots/OCR). Use `list_windows` to find " +
        "an app's pid, `get_tree`/`find_elements` to discover elements, then " +
        "`click`/`type`/`send_keys`/`perform_action` to act on an element by its `element_id`. " +
        "Use `launch` (with `app`) to OPEN an application by name (e.g. " +
        "\"notepad.exe\", \"calc.exe\") — then call `list_windows` to get its pid. " +
        "IMPORTANT: `type` REPLACES the element's entire current contents (it sets " +
        "the field value, it does not append) — read the current value first if you " +
        "must preserve it. `type` uses the value pattern, which Electron/Chromium apps " +
        "(Discord, Slack, VS Code, most chat apps) IGNORE — for those, use `send_keys` " +
        "instead, which synthesizes real keystrokes. `send_keys` (with `keys`) types " +
        "literal text AND presses named keys: e.g. keys=\"hello{Enter}\" types \"hello\" " +
        "then presses Enter to SEND (chat apps submit on Enter, not a button). Named " +
        "keys use braces: {Enter} {Tab} {Esc} {Backspace} {Delete} {Up} {Down} {Left} " +
        "{Right}; chords like {Ctrl+A} (select all) work too. " +
        "State-changing actions ask the user to confirm first (unless YOLO mode is on). " +
        "Security-sensitive apps (password managers, OS credential dialogs, Cinderpaw itself) are blocked. " +
        "Requires desktop control to be enabled by the user. " +
        "ELECTRON/BROWSER CONTENT: Discord, VS Code and browser PAGES expose their real " +
        "UI only when accessibility is forced on. If you `launch` them with this tool they " +
        "start with it enabled and `get_tree` will see their content; an app that was ALREADY " +
        "running before you launched it may show only empty 'Pane' wrappers — close it and " +
        "`launch` it again to inspect its content. " +
        "SHARED-PID WINDOWS: one process can own several windows (Win11 explorer.exe owns the " +
        "Taskbar AND File Explorer windows under one pid). Pass `window_title` (a substring from " +
        "`list_windows`) to `get_tree`/`find_elements` to pick the right window; without it the " +
        "tool skips the Taskbar/desktop and uses the first real window.",
      permissions: [],
      networkAccess: false,
    },
    parameters: {
      action: {
        type: "string",
        description:
          "What to do: 'list_windows' | 'get_tree' | 'find_elements' | 'click' | " +
          "'type' | 'get_value' | 'get_focused' | 'perform_action'.",
        required: true,
      },
      pid: {
        type: "number",
        description: "Target process id (required for get_tree, find_elements).",
        required: false,
      },
      element_id: {
        type: "string",
        description:
          "Opaque element handle from a previous get_tree/find_elements result " +
          "(required for click, type, get_value, perform_action).",
        required: false,
      },
      text: {
        type: "string",
        description: "Text to set into the element (required for 'type').",
        required: false,
      },
      keys: {
        type: "string",
        description:
          "Keystroke spec for 'send_keys' (required). Literal characters are typed " +
          "as real key presses; named keys go in braces — {Enter} {Tab} {Esc} " +
          "{Backspace} {Delete} {Up} {Down} {Left} {Right} {Home} {End} {Space} " +
          "{PageUp} {PageDown} — and chords like {Ctrl+A}. Example: " +
          "\"hello Bloom{Enter}\" types the text and sends it. Use {{ and }} for " +
          "literal braces.",
        required: false,
      },
      action_name: {
        type: "string",
        description:
          "Named action for 'perform_action': press, toggle, expand, collapse, focus.",
        required: false,
      },
      app: {
        type: "string",
        description:
          "Executable name or absolute path to OPEN (required for 'launch'), e.g. " +
          "'notepad.exe' or 'calc.exe'. A single program token only — no arguments " +
          "or shell syntax. Shells/terminals and security-sensitive apps are blocked.",
        required: false,
      },
      query: {
        type: "object",
        description:
          "Element filter for 'find_elements': { role?, name?, automation_id?, " +
          "value_contains? }. All provided fields must match.",
        required: false,
        schema: {
          type: "object",
          properties: {
            role: { type: "string", description: "Exact role, e.g. 'Button', 'Edit'." },
            name: { type: "string", description: "Substring of the element name." },
            automation_id: { type: "string", description: "Substring of the automation id." },
            value_contains: { type: "string", description: "Substring of the element value." },
          },
        },
      },
      depth: {
        type: "number",
        description:
          `Tree depth for 'get_tree' (default ${DEFAULT_DEPTH}, max ${MAX_DEPTH}). ` +
          "Electron apps and web pages bury content deep — use a larger depth (e.g. 12–20) " +
          "to reach it. Output is capped by a node budget, so a big depth is safe.",
        required: false,
      },
      window_title: {
        type: "string",
        description:
          "Optional window-title substring (from list_windows) for 'get_tree'/'find_elements' " +
          "to disambiguate when one pid owns several windows (e.g. explorer.exe's Taskbar vs a " +
          "File Explorer window). Omit to auto-pick the first real, non-Taskbar window.",
        required: false,
      },
    },

    async execute(args, ctx): Promise<ToolResult> {
      const action = String(args.action ?? "") as Action;
      if (!VALID_ACTIONS.has(action)) {
        return structuredError(
          `control_app: unknown action "${args.action}". Valid: ${[...VALID_ACTIONS].join(", ")}.`,
          false,
        );
      }
      if (!ctx.desktopControl) {
        return structuredError(
          "control_app: desktop control is not available in this session " +
            "(the host has it disabled, or the transport has no desktopControl bridge).",
          false,
        );
      }

      // Build the params the host expects, validating per-action requirements.
      const params: Record<string, unknown> = {};
      switch (action) {
        case "get_tree":
        case "find_elements":
          if (typeof args.pid !== "number") {
            return structuredError(`control_app: action "${action}" requires a numeric "pid".`, false);
          }
          params.pid = args.pid;
          if (typeof args.window_title === "string" && args.window_title.trim()) {
            params.window_title = args.window_title.trim();
          }
          if (action === "get_tree") {
            params.depth = typeof args.depth === "number"
              ? Math.max(1, Math.min(MAX_DEPTH, Math.floor(args.depth)))
              : DEFAULT_DEPTH;
          } else {
            params.query = (args.query && typeof args.query === "object") ? args.query : {};
          }
          break;
        case "click":
        case "get_value":
          if (typeof args.element_id !== "string" || !args.element_id) {
            return structuredError(`control_app: action "${action}" requires "element_id".`, false);
          }
          params.element_id = args.element_id;
          break;
        case "type":
          if (typeof args.element_id !== "string" || !args.element_id) {
            return structuredError(`control_app: "type" requires "element_id".`, false);
          }
          if (typeof args.text !== "string") {
            return structuredError(`control_app: "type" requires "text".`, false);
          }
          params.element_id = args.element_id;
          params.text = args.text;
          break;
        case "send_keys":
          if (typeof args.element_id !== "string" || !args.element_id) {
            return structuredError(`control_app: "send_keys" requires "element_id".`, false);
          }
          if (typeof args.keys !== "string" || !args.keys) {
            return structuredError(`control_app: "send_keys" requires "keys".`, false);
          }
          params.element_id = args.element_id;
          params.keys = args.keys;
          break;
        case "perform_action":
          if (typeof args.element_id !== "string" || !args.element_id) {
            return structuredError(`control_app: "perform_action" requires "element_id".`, false);
          }
          if (typeof args.action_name !== "string" || !args.action_name) {
            return structuredError(`control_app: "perform_action" requires "action_name".`, false);
          }
          params.element_id = args.element_id;
          params.action_name = args.action_name;
          break;
        case "launch":
          if (typeof args.app !== "string" || !args.app.trim()) {
            return structuredError(`control_app: "launch" requires "app" (an executable name).`, false);
          }
          params.app = args.app.trim();
          break;
        case "list_windows":
        case "get_focused":
          break;
      }

      // Confirmation gate for state-changing actions. `launch` always confirms
      // (process creation), regardless of CINDERPAW_DESKTOP_CONTROL_CONFIRM.
      const confirmNeeded =
        WRITE_ACTIONS.has(action) &&
        (ALWAYS_CONFIRM.has(action) || readEnv("CINDERPAW_DESKTOP_CONTROL_CONFIRM") !== "false");
      if (confirmNeeded) {
        const confirmed = await confirmWrite(action, args, ctx);
        if (!confirmed) {
          return structuredError(
            `control_app: the user declined the "${action}" action.`,
            false,
          );
        }
      }

      // Audit with redaction (the registry also audits raw args; this entry is
      // the redacted, human-meaningful record of the OS action).
      ctx.audit({
        timestamp: Date.now(),
        sessionId: ctx.sessionId,
        actionType: "tool_call",
        toolName: "control_app",
        argsJson: JSON.stringify({ action, ...redactArgsForAudit(params) }),
        result: "success",
      });

      try {
        const data = await ctx.desktopControl.request(action, params, ctx.sessionId);
        return {
          ok: true,
          content: summarize(action, data),
          data,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return structuredError(`control_app: ${message}`, isRecoverable(message));
      }
    },
  };
}

/** Ask the user to approve a state-changing action. Returns true if approved. */
async function confirmWrite(
  action: Action,
  args: Record<string, unknown>,
  ctx: Parameters<Tool["execute"]>[1],
): Promise<boolean> {
  if (!ctx.askUser) {
    // No way to ask the user → fail CLOSED. Confirmation was required for this
    // state-changing action and we cannot obtain it; the host denylist is a
    // separate gate, not a substitute for per-action consent. A trusted/headless
    // transport that genuinely has no askUser bridge can opt out explicitly.
    return cfgBool("CINDERPAW_DESKTOP_CONTROL_NO_PROMPT_OK");
  }
  const target = typeof args.element_id === "string" ? args.element_id : "(focused element)";
  const detail =
    action === "type"
      ? `REPLACE the entire contents of ${target} with new text`
      : action === "send_keys"
      ? `send keystrokes to ${target} (this can type text and press keys like Enter to submit)`
      : action === "perform_action"
      ? `perform "${String(args.action_name)}" on ${target}`
      : `click ${target}`;
  const question: AskUserQuestion = {
    question: `Allow the agent to ${detail}?`,
    header: "Desktop",
    options: [
      { label: "Allow", recommended: true },
      { label: "Deny" },
    ],
    multiSelect: false,
  };
  try {
    const answers = await ctx.askUser.ask([question], ctx.sessionId);
    const picked = answers[0]?.selected?.[0]?.toLowerCase() ?? "";
    return picked.startsWith("allow");
  } catch {
    // Timeout / cancel → treat as a denial (fail safe).
    return false;
  }
}

/** Compact, model-facing summary of a successful action. */
function summarize(action: Action, data: unknown): string {
  if (action === "list_windows" && Array.isArray(data)) {
    const lines = data
      .slice(0, 50)
      .map((w: any) => `  pid ${w.pid}  ${w.app_name}  "${w.title}"`)
      .join("\n");
    return `Open windows (${data.length}):\n${lines}`;
  }
  if (action === "get_value" && data && typeof data === "object" && "value" in (data as any)) {
    return `Value: ${(data as any).value}`;
  }
  if ((action === "find_elements") && Array.isArray(data)) {
    return `Found ${data.length} element(s).`;
  }
  if (action === "click" || action === "type" || action === "send_keys" || action === "perform_action") {
    return `${action} succeeded.`;
  }
  return JSON.stringify(data);
}
