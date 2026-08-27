/**
 * capture_lead — record an interested person's details so the business owner
 * can follow up. Public-connector tool: it's how a sales/support persona turns
 * a chat into a durable lead. Appends one JSON line per lead to
 * `~/.cinderpaw/leads/leads.jsonl`; no network, no owner ping (use
 * `escalate_to_human` when a human is actually needed now).
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Tool, ToolManifest } from "../../types.ts";

/** Pull the phone number out of a `whatsapp:4071…@s.whatsapp.net` sessionId. */
function phoneFromSession(sessionId: string): string {
  const m = /(\d{6,15})/.exec(sessionId);
  return m?.[1] ?? "";
}

export function createCaptureLeadTool(leadsDir: string): Tool {
  const manifest: ToolManifest = {
    name: "capture_lead",
    description:
      "Save an interested person's details (name, contact, what they want) so " +
      "the business owner can follow up later. Use once you have at least a " +
      "name OR a contact detail plus a sense of what they're interested in. " +
      "After saving, let the person know someone will be in touch.",
    permissions: ["fs:write"],
    networkAccess: false,
    allowedPaths: [leadsDir],
  };

  return {
    manifest,
    parameters: {
      name: { type: "string", description: "The person's name, if given.", required: false },
      contact: { type: "string", description: "Phone, email, or other contact they shared.", required: false },
      interest: { type: "string", description: "What product/service they're interested in.", required: false },
      notes: { type: "string", description: "Any other useful detail (budget, timing, questions).", required: false },
    },
    async execute(args, ctx) {
      const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      const name = str(args.name);
      const contact = str(args.contact);
      const interest = str(args.interest);
      const notes = str(args.notes);
      if (!name && !contact) {
        return { ok: false, content: "capture_lead needs at least a name or a contact detail.", error: "bad_args" };
      }
      const record = {
        ts: new Date().toISOString(),
        channel: "whatsapp",
        phone: phoneFromSession(ctx.sessionId),
        name,
        contact,
        interest,
        notes,
      };
      const file = join(leadsDir, "leads.jsonl");
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(record) + "\n", "utf8");
      return {
        ok: true,
        content: `Lead saved (${name || contact}). The owner can follow up.`,
        data: record,
      };
    },
  };
}
