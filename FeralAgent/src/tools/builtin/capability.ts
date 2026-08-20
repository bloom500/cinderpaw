/**
 * Capability tools — how Feral acquires an ability it does not have.
 *
 * Before these, the agent could SEE capabilities (`list_skills`, `read_skill`)
 * but never obtain one: "install the thing that lets you read Excel files"
 * simply failed. The install commands existed, but only as Tauri commands the
 * UI called.
 *
 * The reason they could not just be handed over as-is is the shape of the old
 * one. `install_skill(meta, content, overwrite)` took the file body, the
 * metadata AND the trust label from its caller. Exposing that to the agent
 * would mean the agent supplies the code, the metadata, and the claim about
 * where the code came from — self-authorization with extra steps.
 *
 * So these tools send a NAME and nothing else. The host resolves what that
 * name means against its own catalogues, fetches from its own allowlist, and
 * stamps the trust label itself. The rule, stated once:
 *
 *   The agent may REQUEST a capability installation. It may never establish
 *   that capability's provenance, and it may never authorize its own install.
 *
 * Security posture mirrors `control_app`: no sandbox permissions are declared
 * and no fs/network work happens here. The tools reach the machine only
 * through the `capabilities` bridge, which round-trips to the Rust host where
 * every real decision is made. Installing is confirmed with the user through
 * `ask_user` and fails CLOSED when no such bridge exists — adding software to
 * someone's computer is not something to do on a silent default.
 */

import type { Tool, ToolResult } from "../../types.ts";

interface CatalogueEntry {
  id: string;
  name: string;
  description: string;
  author?: string;
  version?: string;
  trust_label?: string;
  source_provider?: string;
  install_status?: string;
}

/** Human-facing name for a trust label, for the confirmation prompt. */
function trustPhrase(label: string | undefined): string {
  switch (label) {
    case "verified":
      return "published by Feral";
    case "community":
      return "published by the community";
    case "bundled":
      return "shipped with Feral";
    case "local":
    case "unknown":
      return "from this machine";
    default:
      return "of unknown origin";
  }
}

export const inspectCapabilityTool: Tool = {
  manifest: {
    name: "inspect_capability",
    description:
      "Read a capability from Feral's catalogue WITHOUT installing it. Returns " +
      "what it does, who published it and how far it is trusted. Use this " +
      "before install_capability so you can tell the person what you are " +
      "about to add to their machine.",
    // No sandbox permissions on purpose: this tool does no fs or network work
    // itself. It reaches the catalogue only through the host bridge, which is
    // where every check actually runs.
    permissions: [],
    networkAccess: false,
  },
  parameters: {
    name: {
      type: "string",
      description: "The capability id, as listed by list_skills.",
      required: true,
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const bridge = ctx?.capabilities;
    if (!bridge) {
      return {
        ok: false,
        content: "Capabilities are not available on this transport.",
        error: "not_available",
      };
    }
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) {
      return { ok: false, content: "name is required.", error: "bad_args" };
    }

    try {
      const data = (await bridge.request("inspect", { name })) as {
        meta?: CatalogueEntry;
        content?: string;
      };
      const meta = data?.meta;
      if (!meta) {
        return { ok: false, content: `No capability named '${name}'.`, error: "not_found" };
      }
      // The body can be long; the agent needs enough to describe it, not the
      // whole file. `read_skill` is the tool for the full text, once installed.
      const body = (data.content ?? "").slice(0, 2000);
      return {
        ok: true,
        content:
          `${meta.name} (${meta.id})\n` +
          `${meta.description}\n` +
          `Trust: ${trustPhrase(meta.trust_label)}` +
          (meta.author ? ` · author: ${meta.author}` : "") +
          (meta.version ? ` · version: ${meta.version}` : "") +
          `\nInstalled: ${meta.install_status === "installed" ? "yes" : "no"}\n\n` +
          body,
        data: { meta },
      };
    } catch (err) {
      return { ok: false, content: String(err), error: "inspect_failed" };
    }
  },
};

export const installCapabilityTool: Tool = {
  manifest: {
    name: "install_capability",
    description:
      "Install a capability from Feral's catalogue so you can use it. The " +
      "person is asked to confirm first. Use this when the task needs an " +
      "ability you do not have yet — say, reading spreadsheets — rather than " +
      "telling them to go and install something themselves.",
    permissions: [],
    networkAccess: false,
  },
  parameters: {
    name: {
      type: "string",
      description: "The capability id, as listed by list_skills.",
      required: true,
    },
    reason: {
      type: "string",
      description:
        "One short line on why this is needed, shown to the person in the " +
        "confirmation. Say what it lets you do for THEM, not what it is.",
      required: false,
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const bridge = ctx?.capabilities;
    if (!bridge) {
      return {
        ok: false,
        content: "Capabilities are not available on this transport.",
        error: "not_available",
      };
    }
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) {
      return { ok: false, content: "name is required.", error: "bad_args" };
    }

    // Look it up FIRST, so the confirmation names a real thing and its real
    // source. Asking "install foo?" about an id that does not exist, or whose
    // origin we have not checked, is a prompt that cannot be answered well.
    let entry: CatalogueEntry;
    try {
      const data = (await bridge.request("inspect", { name })) as { meta?: CatalogueEntry };
      if (!data?.meta) {
        return { ok: false, content: `No capability named '${name}'.`, error: "not_found" };
      }
      entry = data.meta;
    } catch (err) {
      return { ok: false, content: String(err), error: "inspect_failed" };
    }

    // Fail CLOSED without a way to ask. A transport with no askUser bridge is
    // not permission to proceed quietly — it is the absence of the one thing
    // that makes proceeding legitimate.
    if (!ctx?.askUser) {
      return {
        ok: false,
        content:
          "Installing needs the person's confirmation and there is no way to ask on " +
          "this transport, so nothing was installed.",
        error: "confirmation_unavailable",
      };
    }

    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    let chose = "";
    try {
      const answers = await ctx.askUser.ask(
        [
          {
            question:
              `Add "${entry.name}" to Feral?` +
              (reason ? ` ${reason}` : "") +
              ` It is ${trustPhrase(entry.trust_label)}.`,
            header: "Add",
            multiSelect: false,
            options: [
              { label: "Add it", description: entry.description },
              { label: "Not now", description: "Nothing is installed." },
            ],
            // Walk-away mode answers questions by itself so a long unattended
            // task is not blocked by an absent user. This one is exempt: an
            // agent approving its own software installs while nobody is
            // watching is exactly the self-authorization this whole path
            // exists to prevent. With no human to ask, it fails closed.
            forceEscalate: true,
          },
        ],
        ctx.sessionId,
      );
      chose = answers?.[0]?.selected?.[0] ?? "";
    } catch {
      // Timeout, cancel, or no human in walk-away mode. Every one of those is
      // the absence of consent, never a substitute for it.
      return {
        ok: false,
        content: `Nobody confirmed, so '${entry.id}' was not installed.`,
        error: "not_confirmed",
      };
    }

    if (chose !== "Add it") {
      return {
        ok: false,
        content: `The person declined; '${entry.id}' was not installed.`,
        error: "declined",
      };
    }

    try {
      await bridge.request("install", { name: entry.id });
      return {
        ok: true,
        content:
          `Installed ${entry.name}. Use read_skill('${entry.id}') to read how it works.`,
        data: { id: entry.id },
      };
    } catch (err) {
      return { ok: false, content: String(err), error: "install_failed" };
    }
  },
};

export function createCapabilityTools(): Tool[] {
  return [inspectCapabilityTool, installCapabilityTool];
}
