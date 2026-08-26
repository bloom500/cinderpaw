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
 */

import type { Tool, ToolManifest } from "../../types.ts";
import type { CoworkAgent, CoworkAgentRepo } from "../../cowork/agent-store.ts";
import type { CoworkMailboxRepo } from "../../cowork/mailbox.ts";
import { rootSessionId } from "../../cowork/approval.ts";

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
      "Delivery is immediate but their work is NOT: they pick the message up " +
      "on their own schedule and the exchange appears live in the Agent " +
      "Cowork transcript panel. Fire-and-forget — do not wait on the answer; " +
      "tell the user to watch the panel instead.",
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
          `in the Agent Cowork transcript panel — tell the user to watch it rather than waiting here.`,
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
