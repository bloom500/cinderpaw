/**
 * cowork_create_teammate — how a roster comes to exist at all.
 *
 * Until this existed, teammates could only be created by a seed script or by
 * writing to SQLite by hand, which meant Agent Cowork was a feature nobody
 * who installed Cinderpaw could ever reach. The two teammates on the dev box
 * came from `scripts/cowork-demo.mjs`; shipping them as defaults would have
 * been us deciding who a stranger works with.
 *
 * CHICKEN AND EGG. `cowork_team` / `cowork_send` are registered only when the
 * roster is non-empty — correct, because an install with no teammates must
 * gain no cowork surface. But that also meant the first teammate could never
 * be created from chat, and boot.ts said so in a comment: "creating your first
 * teammate requires a restart to gain the tools". This tool is therefore
 * registered ALWAYS, and it registers the other two itself the moment the
 * roster stops being empty. No restart, and the fresh-install contract is
 * unchanged: with no teammates, the only cowork tool present is the one that
 * makes them.
 *
 * ON REQUEST ONLY. Nothing here fires on the agent's own initiative. A
 * teammate is a persistent named entity with its own model budget that keeps
 * running after the conversation that made it; creating one because the model
 * thought it might help is the kind of default nobody set and everybody
 * inherits.
 *
 * TOOLS ARE SCOPED AT CREATION, and that is the point rather than a detail.
 * Handing every teammate the whole registry cost ~16.5k tokens of schema on
 * every completion, for ~600 tokens of answer, with 13-55 seconds before the
 * first token. The caller names what this teammate needs; `[]` is a legal and
 * meaningful answer (a teammate that only thinks and replies).
 */

import type { Tool, ToolManifest } from "../../types.ts";
import type { CoworkAgentRepo } from "../../cowork/agent-store.ts";
import type { CoworkMailboxRepo } from "../../cowork/mailbox.ts";
import type { ToolRegistry } from "../registry.ts";
import { createCoworkTeamTool, createCoworkSendTool } from "./cowork.ts";
import { readEnv } from "../../config.ts";

/** Slug used when the caller does not supply an id: readable in paths and logs. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "teammate"
  );
}

export interface CoworkCreateDeps {
  agents: CoworkAgentRepo;
  mailbox: CoworkMailboxRepo;
  registry: ToolRegistry;
  log?: (msg: string) => void;
}

export function createCoworkCreateTool(deps: CoworkCreateDeps): Tool {
  const manifest: ToolManifest = {
    name: "cowork_create_teammate",
    description:
      "Create a persistent teammate agent (Agent Cowork). Use ONLY when the " +
      "user asks for one — a teammate outlives this conversation and spends " +
      "its own model budget. Ask them what it should do and which tools it " +
      "needs before calling this.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {
      name: {
        type: "string",
        description: "What the user wants to call them, e.g. \"Atlas\".",
        required: true,
      },
      role: {
        type: "string",
        description:
          "One line on what they are for. Shown in the roster and used in their standing prompt.",
        required: true,
      },
      instructions: {
        type: "string",
        description:
          "Standing instructions applied on every turn they take. Write it as if briefing a colleague on their first day.",
        required: false,
      },
      tools: {
        type: "array",
        description:
          "Tool names this teammate may call. Keep it to what the role actually needs: every tool listed is re-sent as schema on each of their completions, so a long list makes them slow. Omit for unrestricted (not recommended); pass [] for a teammate that only reads and replies.",
        required: false,
      },
      model: {
        type: "string",
        description: "Pin them to one model id. Omit to let the Brain Stack route per task.",
        required: false,
      },
    },
    async execute(args) {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const role = typeof args.role === "string" ? args.role.trim() : "";
      if (!name || !role) {
        return {
          ok: false,
          content:
            "cowork_create_teammate needs 'name' and 'role'. Ask the user what this teammate is for before creating it.",
          error: "bad_args",
        };
      }

      const roster = deps.agents.list();

      // A roster cap, for runs billed per teammate. Every teammate spends its
      // own model budget on its own loop, so on a metered run the roster size
      // IS the cost multiplier, and asking the model to be frugal is not a
      // limit — it decides to hire on its own. Unset means no cap, so an
      // ordinary install is unchanged.
      const capRaw = readEnv("CINDERPAW_MAX_COWORKERS")?.trim();
      const cap = capRaw ? Number.parseInt(capRaw, 10) : Number.NaN;
      if (Number.isFinite(cap) && cap >= 0 && roster.length >= cap) {
        return {
          ok: false,
          content:
            `The teammate limit for this run is ${cap}, and ${roster.length} already ` +
            `${roster.length === 1 ? "exists" : "exist"}. Work with the teammates you have, or do the ` +
            `task yourself — creating another is not available.`,
          error: "coworker_limit",
        };
      }

      // The row id is DERIVED from the name, so the duplicate check has to be
      // on the id as well as on the name. Checking only the name let two
      // different names that slug to one id ("Atlas" and "Atlas!", or any two
      // names sharing their first 32 sluggable characters) fall through to
      // `upsert`, whose ON CONFLICT(id) DO UPDATE overwrote the existing
      // teammate — role, instructions, tool scope, model pin — and handed the
      // newcomer that teammate's inbox, while reporting a successful creation.
      // Identity is an ownership boundary; creating one teammate must never
      // mutate another.
      const id = slugify(name);
      const clash =
        roster.find((a) => a.name.toLowerCase() === name.toLowerCase()) ??
        roster.find((a) => a.id === id);
      if (clash) {
        return {
          ok: false,
          content:
            `A teammate called "${clash.name}" already exists` +
            (clash.name.toLowerCase() === name.toLowerCase()
              ? ". "
              : ` — "${name}" and "${clash.name}" both shorten to the id "${id}". `) +
            `Pick another name, or say you want to change that one instead — ` +
            `this tool will not overwrite them.`,
          error: "name_taken",
        };
      }

      // Unknown tool names are refused rather than silently dropped: a
      // teammate created with a typo would look configured and then quietly
      // lack the one capability it was made for.
      const requested = Array.isArray(args.tools)
        ? args.tools.filter((t): t is string => typeof t === "string")
        : undefined;
      if (requested) {
        const unknown = requested.filter((t) => !deps.registry.has(t));
        if (unknown.length > 0) {
          return {
            ok: false,
            content:
              `No such tool: ${unknown.join(", ")}. Call tool_health or list what you have ` +
              `and use exact names — a teammate created with a typo looks configured and is not.`,
            error: "unknown_tool",
          };
        }
      }

      const agent = deps.agents.upsert({
        id,
        name,
        role,
        instructions: typeof args.instructions === "string" ? args.instructions : "",
        modelPin: typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined,
        tools: requested,
      });

      // First teammate: the mailbox tools become reachable NOW, not after a
      // restart. Registering is idempotent-by-check so a second creation is a
      // no-op here.
      const gained: string[] = [];
      if (!deps.registry.has("cowork_team")) {
        deps.registry.register(createCoworkTeamTool(deps.agents));
        gained.push("cowork_team");
      }
      if (!deps.registry.has("cowork_send")) {
        deps.registry.register(createCoworkSendTool(deps.agents, deps.mailbox));
        gained.push("cowork_send");
      }
      deps.log?.(
        `cowork: created teammate "${agent.name}" (${agent.id})` +
          (gained.length > 0 ? ` — ${gained.join(" + ")} now available` : ""),
      );

      const scope =
        agent.tools === undefined
          ? "every tool you have (unrestricted — consider narrowing this)"
          : agent.tools.length === 0
            ? "no tools (they read and reply only)"
            : agent.tools.join(", ");
      return {
        ok: true,
        content:
          `Created "${agent.name}" — ${agent.role}. Tools: ${scope}. ` +
          (gained.length > 0
            ? `cowork_team and cowork_send are now available. `
            : "") +
          `Hand them work with cowork_send; their replies appear in the Agent Cowork panel.`,
        data: {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          tools: agent.tools ?? null,
          toolsGained: gained,
        },
      };
    },
  };
}
