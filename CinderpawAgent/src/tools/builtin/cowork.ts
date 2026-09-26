/**
 * cowork_team / cowork_send — the door from ordinary chat into Agent Cowork.
 *
 * Until S4.5 the cowork mailbox had NO user-facing entry point: the runtime
 * is strictly reactive (it only drains inboxes), so nothing ever arrived
 * unless something else wrote a row first. These tools let the main agent
 * — talking to its user — see who the teammates are and hand one of them
 * work. The teammate's answer does NOT come back through this tool's
 * result (turns run on their own schedule against a 5-minute wall);
 * it streams into the UI as `cowork_event`s rendered live by the A2A
 * transcript panel. The tool says so explicitly so the model never sits
 * waiting on a result that will not arrive.
 *
 * Sender identity is honest by construction: a call made INSIDE a
 * `cowork:<id>` session is that agent speaking (real A2A, hop-guarded by
 * the runtime); anything else is `"human"`. Fresh-install discipline:
 * boot registers these only when at least one cowork agent exists, so an
 * install without teammates never sees them.
 *
 * The same rule covers the roster tools below: changing, removing and
 * reading a teammate's replies only exist once there is a teammate.
 */

import type { Tool, ToolManifest } from "../../types.ts";
import type { CoworkAgent, CoworkAgentRepo } from "../../cowork/agent-store.ts";
import type { CoworkMailboxRepo } from "../../cowork/mailbox.ts";
import type { ToolRegistry } from "../registry.ts";
import { rootSessionId } from "../../cowork/approval.ts";
import { HUMAN, type HumanReplyPayload } from "../../cowork/runtime.ts";

/**
 * Register every roster tool the registry does not have yet, and return the
 * names added. Boot calls it when teammates already exist; creating the first
 * teammate calls it too, so none of these needs a restart to appear.
 */
export function registerCoworkRosterTools(
  registry: ToolRegistry,
  agents: CoworkAgentRepo,
  mailbox: CoworkMailboxRepo,
): string[] {
  const tools = [
    createCoworkTeamTool(agents),
    createCoworkSendTool(agents, mailbox),
    createCoworkRepliesTool(agents, mailbox),
    createCoworkUpdateTool(agents, registry),
    createCoworkRemoveTool(agents, mailbox),
  ];
  const gained: string[] = [];
  for (const t of tools) {
    if (registry.has(t.manifest.name)) continue;
    registry.register(t);
    gained.push(t.manifest.name);
  }
  return gained;
}

/**
 * "human" is the person's mailbox address. A teammate whose id were "human"
 * would drain the person's replies and answer them itself.
 */
export function isReservedTeammateName(name: string, id: string): boolean {
  return id === HUMAN || name.trim().toLowerCase() === HUMAN;
}

/** Tool names the registry does not know, so a typo is refused, not stored. */
function unknownTools(registry: ToolRegistry, tools: string[]): string[] {
  return tools.filter((t) => !registry.has(t));
}

/** Resolve a teammate by id or case-insensitive name; `null` when absent. */
function findTeammate(repo: CoworkAgentRepo, q: string): CoworkAgent | null {
  const needle = q.trim().toLowerCase();
  if (!needle) return null;
  const roster = repo.list();
  return (
    roster.find((a) => a.id.toLowerCase() === needle) ??
    roster.find((a) => a.name.toLowerCase() === needle) ??
    null
  );
}

export function createCoworkTeamTool(agents: CoworkAgentRepo): Tool {
  const manifest: ToolManifest = {
    name: "cowork_team",
    description:
      "List your configured teammates (persistent cowork agents). Use this " +
      "before cowork_send when unsure who can take a task.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {},
    async execute() {
      const roster = agents.list();
      if (roster.length === 0) {
        return { ok: true, content: "No teammates are configured.", data: { teammates: [] } };
      }
      const out = roster.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role || undefined,
        instructions: a.instructions || undefined,
        // What they can touch and which model they run on: the two things a
        // person asks before handing a teammate anything consequential.
        tools: a.tools ?? "all (unrestricted)",
        model: a.modelPin ?? "routed per task",
      }));
      return {
        ok: true,
        content: `Teammates: ${roster.map((a) => `"${a.name}"${a.role ? ` (${a.role})` : ""}`).join(", ")}`,
        data: { teammates: out },
      };
    },
  };
}

export function createCoworkSendTool(agents: CoworkAgentRepo, mailbox: CoworkMailboxRepo): Tool {
  const manifest: ToolManifest = {
    name: "cowork_send",
    description:
      "Hand a task or question to a named teammate (persistent cowork agent). " +
      "They start on it at once, but a turn can take minutes, and the exchange " +
      "appears live in the Agent Cowork panel. Do not wait on the answer here; " +
      "read it later with cowork_replies when you need to use it.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {
      to: {
        type: "string",
        description: "Teammate name or id. Call cowork_team first if unsure.",
        required: true,
      },
      message: {
        type: "string",
        description: "What you are asking them to do or answer. Be specific — they have their own role and standing instructions, not yours.",
        required: true,
      },
      thread_id: {
        type: "string",
        description: "Optional conversation thread id, so follow-ups stay together.",
        required: false,
      },
    },
    async execute(args, ctx) {
      const to = typeof args.to === "string" ? args.to.trim() : "";
      const body = typeof args.message === "string" ? args.message.trim() : "";
      // Default the thread to the CHAT this was sent from. The frontend uses
      // the conversation id as its session id, so this is what ties a cowork
      // exchange to the conversation in the sidebar - without it every message
      // was thread-less and a reopened chat could never find its own history.
      // A cowork session's own id would be the wrong anchor (it names the
      // teammate, not the conversation), so it is left thread-less as before.
      const fromChat =
        typeof ctx.sessionId === "string" && !rootSessionId(ctx.sessionId).startsWith("cowork:")
          ? ctx.sessionId
          : null;
      const threadId = typeof args.thread_id === "string" && args.thread_id.trim()
        ? args.thread_id.trim()
        : fromChat;
      if (!to || !body) {
        return { ok: false, content: "cowork_send needs 'to' (teammate) and 'message'.", error: "bad_args" };
      }
      const target = findTeammate(agents, to);
      if (!target) {
        const roster = agents.list();
        return {
          ok: false,
          content:
            `No teammate "${to}". Configured: ` +
            (roster.length > 0
              ? roster.map((a) => `"${a.name}"`).join(", ")
              : "(none — no cowork agents are configured)") +
            ". Call cowork_team for details.",
          error: "unknown_teammate",
        };
      }
      // Honest sender: inside a cowork session the speaker IS that agent;
      // anywhere else the request ultimately comes from the person. The ROOT
      // session, so a subagent a teammate spawned is still attributed to that
      // teammate rather than being recorded as the human.
      const root =
        typeof ctx.sessionId === "string" ? rootSessionId(ctx.sessionId) : "";
      const sender = root.startsWith("cowork:") ? root.slice("cowork:".length) : "human";
      // Carry the thread's hop count forward. Without this the automatic reply
      // path was capped but this tool was not: a message sent here had no
      // payload, so the next reader saw hop 0 and two teammates could
      // ping-pong for as long as the budget lasted.
      const hops = mailbox.lastHopsInThread(threadId) + 1;
      const msg = mailbox.send({
        fromAgentId: sender,
        toAgentId: target.id,
        threadId,
        body,
        payloadJson: JSON.stringify({ coworkHops: hops }),
      });
      return {
        ok: true,
        content:
          `Delivered to "${target.name}" (from: ${sender}). Their reply will appear ` +
          `in the Agent Cowork panel. Tell the user so rather than waiting here; ` +
          `when you need the answer yourself, call cowork_replies.`,
        data: {
          messageId: msg.id,
          to: target.id,
          toName: target.name,
          from: sender,
          threadId: msg.threadId,
        },
      };
    },
  };
}

/** Longest reply cowork_replies hands back per message, in characters. */
const REPLY_MAX = 6000;

/**
 * cowork_replies — what teammates answered the person in this conversation.
 *
 * cowork_send is fire-and-forget, so without this the main agent could hand
 * work out and never use what came back: "ask Atlas, then summarise it for
 * me" could not work, because the answer existed only in the panel. Unread
 * replies are marked read once returned, so one answer is not acted on
 * twice; `all: true` re-reads the whole thread.
 */
export function createCoworkRepliesTool(agents: CoworkAgentRepo, mailbox: CoworkMailboxRepo): Tool {
  const manifest: ToolManifest = {
    name: "cowork_replies",
    description:
      "Read what your teammates answered in this conversation, and who is still " +
      "working. Call it when you need a teammate's answer to continue, or when the " +
      "user asks what a teammate said.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {
      thread_id: {
        type: "string",
        description: "Conversation thread id. Omit to use this conversation.",
        required: false,
      },
      all: {
        type: "boolean",
        description: "Include replies already read before. Default: only new ones.",
        required: false,
      },
    },
    async execute(args, ctx) {
      const root = typeof ctx.sessionId === "string" ? rootSessionId(ctx.sessionId) : "";
      const threadId =
        typeof args.thread_id === "string" && args.thread_id.trim()
          ? args.thread_id.trim()
          : root && !root.startsWith("cowork:")
            ? ctx.sessionId
            : "";
      if (!threadId) {
        return { ok: false, content: "cowork_replies needs a thread_id here.", error: "bad_args" };
      }
      const all = args.all === true;
      const rows = mailbox.byThread(threadId);
      const nameOf = (id: string) => agents.get(id)?.name ?? id;
      const replies = rows.filter((r) => r.toAgentId === HUMAN && (all || r.status === "pending"));
      // A message from the person stays `pending` until its teammate has
      // finished with it, so this is also who is still working.
      const working = [
        ...new Set(
          rows.filter((r) => r.fromAgentId === HUMAN && r.status === "pending").map((r) => nameOf(r.toAgentId)),
        ),
      ];

      const lines = replies.map((r) => {
        let p: Partial<HumanReplyPayload> = {};
        try {
          p = JSON.parse(r.payloadJson ?? "{}") as HumanReplyPayload;
        } catch {
          /* an unreadable payload still has a body worth showing */
        }
        const asked = p.replyTo ? rows.find((q) => q.id === p.replyTo)?.body : undefined;
        const about = asked ? ` (to "${asked.slice(0, 80).replace(/\s+/g, " ")}")` : "";
        const body = r.body.length > REPLY_MAX ? `${r.body.slice(0, REPLY_MAX)} … (truncated)` : r.body;
        return p.failed
          ? `${nameOf(r.fromAgentId)} could not answer${about}: ${body}`
          : `${nameOf(r.fromAgentId)}${about}:\n${body}`;
      });
      for (const r of replies) if (r.status === "pending") mailbox.updateStatus(r.id, "read");

      const tail = working.length > 0 ? `Still working: ${working.join(", ")}.` : "";
      const content =
        lines.length > 0
          ? [...lines, tail].filter(Boolean).join("\n\n")
          : [all ? "No teammate has answered in this conversation yet." : "No new replies.", tail]
              .filter(Boolean)
              .join(" ");
      return {
        ok: true,
        content,
        data: {
          threadId,
          replies: replies.map((r) => ({ id: r.id, from: nameOf(r.fromAgentId), body: r.body, at: r.createdAt })),
          working,
        },
      };
    },
  };
}

/**
 * cowork_update_teammate — change a teammate instead of living with it.
 *
 * Creation refuses an existing name and told the model to "change that one
 * instead", but nothing could: a typo in a role, a tool the teammate turned
 * out to need, or a model pin that stopped existing stayed for good.
 */
export function createCoworkUpdateTool(agents: CoworkAgentRepo, registry: ToolRegistry): Tool {
  const manifest: ToolManifest = {
    name: "cowork_update_teammate",
    description:
      "Change a teammate: rename them, or change their role, standing instructions, " +
      "tools or model. Use ONLY when the user asks for the change.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {
      teammate: { type: "string", description: "Current name or id of the teammate.", required: true },
      name: { type: "string", description: "New name. The id stays the same.", required: false },
      role: { type: "string", description: "New one-line role.", required: false },
      instructions: {
        type: "string",
        description: "New standing instructions (replaces the old ones).",
        required: false,
      },
      tools: {
        type: "array",
        description: "The full new list of tool names (replaces the old list). [] means no tools.",
        required: false,
      },
      model: {
        type: "string",
        description: "Model id to pin, or \"\" to let the Brain Stack route again.",
        required: false,
      },
    },
    async execute(args) {
      const current = findTeammate(agents, typeof args.teammate === "string" ? args.teammate : "");
      if (!current) return unknownTeammate(agents, args.teammate);

      const changed: string[] = [];
      let name = current.name;
      if (typeof args.name === "string" && args.name.trim() && args.name.trim() !== current.name) {
        name = args.name.trim();
        const clash = agents
          .list()
          .find((a) => a.id !== current.id && a.name.toLowerCase() === name.toLowerCase());
        if (clash || isReservedTeammateName(name, "")) {
          return {
            ok: false,
            content: clash
              ? `Another teammate is already called "${clash.name}". Nothing was changed.`
              : `"${name}" is reserved for the person. Nothing was changed.`,
            error: "name_taken",
          };
        }
        changed.push("name");
      }
      let tools = current.tools;
      if (args.tools !== undefined) {
        if (!Array.isArray(args.tools)) {
          return { ok: false, content: "tools must be a list of tool names.", error: "bad_args" };
        }
        const list = args.tools.filter((t): t is string => typeof t === "string");
        const unknown = unknownTools(registry, list);
        if (unknown.length > 0) {
          return {
            ok: false,
            content: `No such tool: ${unknown.join(", ")}. Nothing was changed.`,
            error: "unknown_tool",
          };
        }
        tools = list;
        changed.push("tools");
      }
      let role = current.role;
      if (typeof args.role === "string") {
        role = args.role.trim();
        changed.push("role");
      }
      let instructions = current.instructions;
      if (typeof args.instructions === "string") {
        instructions = args.instructions;
        changed.push("instructions");
      }
      let modelPin = current.modelPin;
      if (typeof args.model === "string") {
        modelPin = args.model.trim() || undefined;
        changed.push("model");
      }
      if (changed.length === 0) {
        return {
          ok: false,
          content: "Nothing to change: pass at least one of name, role, instructions, tools, model.",
          error: "bad_args",
        };
      }
      const saved = agents.upsert({ id: current.id, name, role, instructions, modelPin, tools });
      return {
        ok: true,
        content: `Updated "${saved.name}" (${changed.join(", ")}). It applies from their next turn.`,
        data: { id: saved.id, name: saved.name, changed, tools: saved.tools ?? null, model: saved.modelPin ?? null },
      };
    },
  };
}

/**
 * cowork_remove_teammate — the way out. The store could always delete a row;
 * nothing called it, so a teammate made by mistake, or one spending budget
 * nobody wanted, stayed until someone edited the database by hand.
 */
export function createCoworkRemoveTool(agents: CoworkAgentRepo, mailbox: CoworkMailboxRepo): Tool {
  const manifest: ToolManifest = {
    name: "cowork_remove_teammate",
    description:
      "Remove a teammate for good. Messages still waiting for them are cancelled. " +
      "Use ONLY when the user asks for it.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {
      teammate: { type: "string", description: "Name or id of the teammate to remove.", required: true },
    },
    async execute(args) {
      const target = findTeammate(agents, typeof args.teammate === "string" ? args.teammate : "");
      if (!target) return unknownTeammate(agents, args.teammate);
      // Left pending, these would show as "working" in the panel for ever:
      // nobody drains the inbox of a teammate that no longer exists.
      const waiting = mailbox.inbox(target.id, "pending");
      for (const m of waiting) mailbox.updateStatus(m.id, "rejected");
      agents.remove(target.id);
      return {
        ok: true,
        content:
          `Removed "${target.name}".` +
          (waiting.length > 0 ? ` ${waiting.length} message(s) still waiting for them were cancelled.` : "") +
          " Their past messages stay in the conversation history.",
        data: { id: target.id, name: target.name, cancelled: waiting.length },
      };
    },
  };
}

function unknownTeammate(agents: CoworkAgentRepo, asked: unknown) {
  const roster = agents.list().map((a) => `"${a.name}"`).join(", ") || "(none)";
  return {
    ok: false,
    content: `No teammate "${typeof asked === "string" ? asked : ""}". Configured: ${roster}.`,
    error: "unknown_teammate",
  };
}
