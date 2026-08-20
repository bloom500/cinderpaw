/**
 * feral_admin — the commands a person would otherwise open a terminal for.
 *
 * The `self_*` tools already cover the READ half of what the CLI shows:
 * status, providers, health, dreams, genome. This is the ACT half. The point
 * is that once someone has set Cinderpaw up, they should never have to run a
 * command themselves: "update yourself", "use the local model for this
 * one" — and it happens, in the conversation, without a detour through a
 * terminal or a settings screen.
 *
 * Same trust shape as `install_capability`: the tool sends an ACTION NAME and
 * plain values. What each action means, and whether it is allowed at all,
 * lives in the Rust host (`src-tauri/src/admin_bridge.rs`). Nothing here
 * decides anything.
 *
 * Stopping and restarting work, but not instantly: the turn being served runs
 * inside the process that goes away, so the host schedules the exit a few
 * seconds out and answers immediately. The reply reaches the person first;
 * the process goes down after.
 *
 * Two CLI commands stay unreachable, and the host refuses them independently
 * of this file:
 *
 *   - `uninstall` — `update` overwrites in place, so removing the install is
 *     never the way to fix anything, and it is not recoverable by re-running.
 *   - `setup` — an interactive wizard means nothing without the person.
 *
 * Confirmation is drawn where the consequence is. An update replaces the
 * running application, and a stop leaves Cinderpaw off until a person starts it
 * again — the agent cannot undo either, because after both it is not there.
 * A restart and a model switch are not confirmed: both come back on their own.
 */

import type { Tool, ToolResult } from "../../types.ts";

type Action =
  | "update_check"
  | "update_apply"
  | "model_list"
  | "model_switch"
  | "gateway_restart"
  | "gateway_stop";

const ACTIONS: readonly Action[] = [
  "update_check",
  "update_apply",
  "model_list",
  "model_switch",
  "gateway_restart",
  "gateway_stop",
];

export const feralAdminTool: Tool = {
  manifest: {
    name: "feral_admin",
    description:
      "Run Cinderpaw's own administrative commands. `update_check` reports whether " +
      "a newer version exists; `update_apply` installs it (the person is asked " +
      "first). `model_list` shows which local models and cloud providers are " +
      "set up; `model_switch` changes which one answers. `gateway_restart` " +
      "restarts you — useful after a change that needs a fresh start; it also " +
      "interrupts anything running in the background. `gateway_stop` shuts you " +
      "down until a person starts you again. Use these instead of telling the " +
      "person to open a terminal or a settings screen.",
    // No sandbox permissions: this tool performs no fs, network or process
    // work. It only round-trips to the host, where the actions actually run.
    permissions: [],
    networkAccess: false,
  },
  parameters: {
    action: {
      type: "string",
      description:
          "One of: 'update_check', 'update_apply', 'model_list', 'model_switch', " +
        "'gateway_restart', 'gateway_stop'.",
      required: true,
    },
    source: {
      type: "string",
      description:
        "model_switch only — 'local' for an on-device model, 'ollama' for an " +
        "Ollama server, 'byok' for a configured cloud provider.",
      required: false,
    },
    model: {
      type: "string",
      description: "model_switch only — the model name, as shown by model_list.",
      required: false,
    },
    provider_id: {
      type: "string",
      description: "model_switch only — required when source is 'byok'.",
      required: false,
    },
    base_url: {
      type: "string",
      description: "model_switch only — optional override for the endpoint.",
      required: false,
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const bridge = ctx?.admin;
    if (!bridge) {
      return {
        ok: false,
        content:
          "Administrative commands are only available in the Cinderpaw desktop app.",
        error: "not_available",
      };
    }

    const action = String(args.action ?? "") as Action;
    if (!ACTIONS.includes(action)) {
      return {
        ok: false,
        content: `action must be one of: ${ACTIONS.join(", ")}.`,
        error: "bad_args",
      };
    }

    /**
     * Ask, and treat everything that is not a clear yes as a no.
     *
     * forceEscalate on both: an unattended run answers its own questions so a
     * long task is not blocked, but neither "replace yourself" nor "switch
     * yourself off" is a decision the thing being replaced or switched off
     * should get to make.
     */
    const confirm = async (
      question: string,
      yes: string,
      yesDesc: string,
      noDesc: string,
    ): Promise<ToolResult | null> => {
      if (!ctx?.askUser) {
        return {
          ok: false,
          content: `That needs the person's confirmation and there is no way to ask here, so nothing happened.`,
          error: "confirmation_unavailable",
        };
      }
      let chose = "";
      try {
        const answers = await ctx.askUser.ask(
          [
            {
              question,
              header: yes,
              multiSelect: false,
              options: [
                { label: yes, description: yesDesc },
                { label: "Not now", description: noDesc },
              ],
              forceEscalate: true,
            },
          ],
          ctx.sessionId,
        );
        chose = answers?.[0]?.selected?.[0] ?? "";
      } catch {
        return { ok: false, content: "Nobody confirmed, so nothing happened.", error: "not_confirmed" };
      }
      return chose === yes ? null : { ok: false, content: "The person declined.", error: "declined" };
    };

    // Shutting down leaves Cinderpaw off until a person starts it again — and the
    // agent cannot undo it, because afterwards it is not there to try.
    if (action === "gateway_stop") {
      const refused = await confirm(
        "Shut Cinderpaw down? It stays off until you start it again.",
        "Shut down",
        "Cinderpaw stops running.",
        "Cinderpaw keeps running.",
      );
      if (refused) return refused;
    }

    // Installing a new version replaces the running application. Same posture
    // as install_capability: confirmed, forceEscalate so an unattended run
    // cannot answer it, and failing closed on every route that is not a clear
    // yes.
    if (action === "update_apply") {
      const check = (await bridge.request("update_check", {})) as {
        available?: boolean;
        version?: string;
        current?: string;
      };
      if (!check?.available) {
        return {
          ok: true,
          content: `Cinderpaw is already up to date (${check?.current ?? "current version"}).`,
        };
      }
      const refused = await confirm(
        `Update Cinderpaw to ${check.version}? It is on ${check.current} now.`,
        "Update",
        "Downloads and installs the new version.",
        "Nothing changes.",
      );
      if (refused) return refused;
    }

    if (action === "model_switch") {
      if (!args.source || !args.model) {
        return {
          ok: false,
          content: "model_switch needs `source` and `model`. Call model_list first.",
          error: "bad_args",
        };
      }
    }

    try {
      const data = await bridge.request(action, {
        source: args.source,
        model: args.model,
        provider_id: args.provider_id,
        base_url: args.base_url,
      });
      return { ok: true, content: summarize(action, data), data: data as never };
    } catch (err) {
      return { ok: false, content: String(err), error: "admin_failed" };
    }
  },
};

/** Say what happened in the words the person would use. */
function summarize(action: Action, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (action) {
    case "update_check":
      return d.available
        ? `Version ${d.version} is available. Currently on ${d.current}.`
        : `Cinderpaw is up to date (${d.current}).`;
    case "update_apply":
      // Said plainly because the alternative — the app vanishing to restart
      // itself mid-conversation — is indistinguishable from a crash.
      return d.applied
        ? `Updated to ${d.version}. It takes effect the next time Cinderpaw starts.`
        : `Nothing to install: ${String(d.reason ?? "already up to date")}.`;
    case "model_list": {
      const local = (d.local as unknown[] | undefined) ?? [];
      const cloud = (d.cloud as unknown[] | undefined) ?? [];
      if (local.length === 0 && cloud.length === 0) {
        return "No models are set up yet — no local model downloaded and no cloud key added.";
      }
      return JSON.stringify({ local, cloud });
    }
    case "model_switch":
      return `Now using ${String(d.model)}${d.provider_id ? ` via ${String(d.provider_id)}` : ""}.`;
    case "gateway_restart":
      // Say the delay out loud. A restart that has been agreed to but has not
      // visibly happened yet looks like the request was ignored.
      return `Restarting in about ${String(d.in_seconds ?? 6)} seconds. Anything running in the background stops; I will be back on my own.`;
    case "gateway_stop":
      return `Shutting down in about ${String(d.in_seconds ?? 6)} seconds. I will not come back until you start Cinderpaw again.`;
  }
}

export function createFeralAdminTools(): Tool[] {
  return [feralAdminTool];
}
