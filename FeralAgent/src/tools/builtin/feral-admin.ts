/**
 * feral_admin — the commands a person would otherwise open a terminal for.
 *
 * The `self_*` tools already cover the READ half of what the CLI shows:
 * status, providers, health, dreams, genome. This is the ACT half. The point
 * is that once someone has set Feral up, they should never have to run a
 * command themselves: "update yourself", "use the local model for this
 * one" — and it happens, in the conversation, without a detour through a
 * terminal or a settings screen.
 *
 * Same trust shape as `install_capability`: the tool sends an ACTION NAME and
 * plain values. What each action means, and whether it is allowed at all,
 * lives in the Rust host (`src-tauri/src/admin_bridge.rs`). Nothing here
 * decides anything.
 *
 * Three CLI commands are deliberately unreachable, and the host refuses them
 * independently of this file:
 *
 *   - `uninstall` — not recoverable by re-running, and no phrasing of a user's
 *     request should be able to reach it.
 *   - `gateway stop` / `restart` — the turn being served runs inside the thing
 *     that would be stopped; it would kill its own answer mid-sentence, which
 *     reads as a hang rather than as an action.
 *   - `setup` — an interactive wizard means nothing without the person.
 *
 * Applying an update is confirmed. Switching a model is not: it is cheap,
 * immediately visible, and undone by switching back — a confirmation there
 * would be a habit-forming click that teaches people to stop reading them.
 */

import type { Tool, ToolResult } from "../../types.ts";

type Action = "update_check" | "update_apply" | "model_list" | "model_switch";

const ACTIONS: readonly Action[] = [
  "update_check",
  "update_apply",
  "model_list",
  "model_switch",
];

export const feralAdminTool: Tool = {
  manifest: {
    name: "feral_admin",
    description:
      "Run Feral's own administrative commands. `update_check` reports whether " +
      "a newer version exists; `update_apply` installs it (the person is asked " +
      "first). `model_list` shows which local models and cloud providers are " +
      "set up; `model_switch` changes which one answers. Use these instead of " +
      "telling the person to open a terminal or a settings screen.",
    // No sandbox permissions: this tool performs no fs, network or process
    // work. It only round-trips to the host, where the actions actually run.
    permissions: [],
    networkAccess: false,
  },
  parameters: {
    action: {
      type: "string",
      description:
        "One of: 'update_check', 'update_apply', 'model_list', 'model_switch'.",
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
          "Administrative commands are only available in the Feral desktop app.",
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
          content: `Feral is already up to date (${check?.current ?? "current version"}).`,
        };
      }
      if (!ctx?.askUser) {
        return {
          ok: false,
          content:
            "Updating needs the person's confirmation and there is no way to ask " +
            "here, so nothing was installed.",
          error: "confirmation_unavailable",
        };
      }

      let chose = "";
      try {
        const answers = await ctx.askUser.ask(
          [
            {
              question: `Update Feral to ${check.version}? It is on ${check.current} now.`,
              header: "Update",
              multiSelect: false,
              options: [
                { label: "Update", description: "Downloads and installs the new version." },
                { label: "Not now", description: "Nothing changes." },
              ],
              forceEscalate: true,
            },
          ],
          ctx.sessionId,
        );
        chose = answers?.[0]?.selected?.[0] ?? "";
      } catch {
        return {
          ok: false,
          content: "Nobody confirmed, so Feral was not updated.",
          error: "not_confirmed",
        };
      }
      if (chose !== "Update") {
        return { ok: false, content: "The person declined the update.", error: "declined" };
      }
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
        : `Feral is up to date (${d.current}).`;
    case "update_apply":
      // Said plainly because the alternative — the app vanishing to restart
      // itself mid-conversation — is indistinguishable from a crash.
      return d.applied
        ? `Updated to ${d.version}. It takes effect the next time Feral starts.`
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
  }
}

export function createFeralAdminTools(): Tool[] {
  return [feralAdminTool];
}
