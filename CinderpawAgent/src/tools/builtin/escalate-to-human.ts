/**
 * escalate_to_human — hand a conversation off to the business owner.
 *
 * Public-connector tool. Use when the person needs something the assistant
 * can't answer or do (a firm quote, a complaint, anything beyond the knowledge
 * base), or explicitly asks for a human. Three effects:
 *   1. appends the escalation to `~/.cinderpaw/leads/escalations.jsonl`,
 *   2. pings the owner via the LeadDesk notifier (a WhatsApp message),
 *   3. PAUSES the assistant on this conversation (via LeadDesk) so the human
 *      can take over without the bot talking over them.
 *
 * After calling this, tell the person a colleague will get back to them, then
 * stop — do not keep answering, the conversation is now the human's.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Tool, ToolManifest } from "../../types.ts";
import type { LeadDesk } from "../../core/lead-desk.ts";

function phoneFromSession(sessionId: string): string {
  const m = /(\d{6,15})/.exec(sessionId);
  return m?.[1] ?? "";
}

export function createEscalateToHumanTool(desk: LeadDesk, leadsDir: string): Tool {
  const manifest: ToolManifest = {
    name: "escalate_to_human",
    description:
      "Hand this conversation to the business owner when you can't help (a firm " +
      "price/commitment, a complaint, anything outside the knowledge base) or " +
      "the person asks for a human. This notifies the owner and pauses you on " +
      "this chat so they can take over. After calling it, tell the person a " +
      "colleague will follow up shortly, then stop replying.",
    permissions: ["fs:write"],
    networkAccess: false,
    allowedPaths: [leadsDir],
  };

  return {
    manifest,
    parameters: {
      reason: {
        type: "string",
        description: "Why you're escalating, in one short line (the owner sees this).",
        required: true,
      },
      contact: {
        type: "string",
        description: "The person's name and/or contact, if known.",
        required: false,
      },
    },
    async execute(args, ctx) {
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      const contact = typeof args.contact === "string" ? args.contact.trim() : "";
      if (!reason) {
        return { ok: false, content: "escalate_to_human needs a 'reason'.", error: "bad_args" };
      }
      const phone = phoneFromSession(ctx.sessionId);
      const record = {
        ts: new Date().toISOString(),
        channel: "whatsapp",
        phone,
        contact,
        reason,
        sessionId: ctx.sessionId,
      };
      const file = join(leadsDir, "escalations.jsonl");
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(record) + "\n", "utf8");

      // Pause first (so any race on the next inbound message is already gated),
      // then ping the owner. Both are connector-side via the shared desk.
      desk.pause(ctx.sessionId);
      await desk.notify({
        kind: "escalation",
        sessionId: ctx.sessionId,
        contact: contact || phone,
        summary: reason,
      });

      return {
        ok: true,
        content:
          "Escalated to the owner and paused yourself on this chat. Tell the " +
          "person a colleague will get back to them shortly, then stop replying.",
        data: record,
      };
    },
  };
}
