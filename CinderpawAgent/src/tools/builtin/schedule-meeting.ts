/**
 * schedule_meeting — capture a meeting/booking request from a lead.
 *
 * Public-connector tool. v1 records the request (preferred time, contact,
 * topic) to `~/.cinderpaw/leads/meetings.jsonl` and pings the owner so they can
 * confirm — it does NOT hold a live calendar yet. The real booking backend
 * (cal.diy — https://github.com/calcom/cal.diy) lands later; when it does,
 * this tool gets a confirmed slot back instead of "someone will confirm".
 *
 * Until then, be honest with the person: their request is noted and a human
 * will confirm the exact time — don't promise a booked slot.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Tool, ToolManifest } from "../../types.ts";
import type { LeadDesk } from "../../core/lead-desk.ts";

function phoneFromSession(sessionId: string): string {
  const m = /(\d{6,15})/.exec(sessionId);
  return m?.[1] ?? "";
}

export function createScheduleMeetingTool(desk: LeadDesk, leadsDir: string): Tool {
  const manifest: ToolManifest = {
    name: "schedule_meeting",
    description:
      "Capture a request to meet, call, or book (with a preferred time). Records " +
      "it for the owner and notifies them to confirm. It does NOT book a live " +
      "calendar slot yet, so tell the person their request is noted and someone " +
      "will confirm the exact time — don't promise a confirmed booking.",
    permissions: ["fs:write"],
    networkAccess: false,
    allowedPaths: [leadsDir],
  };

  return {
    manifest,
    parameters: {
      preferred_time: {
        type: "string",
        description: "When they'd like it (their words are fine, e.g. 'Tue afternoon').",
        required: true,
      },
      name: { type: "string", description: "The person's name, if given.", required: false },
      contact: { type: "string", description: "Phone/email to reach them on.", required: false },
      topic: { type: "string", description: "What the meeting/call is about.", required: false },
    },
    async execute(args, ctx) {
      const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      const preferredTime = str(args.preferred_time);
      const name = str(args.name);
      const contact = str(args.contact);
      const topic = str(args.topic);
      if (!preferredTime) {
        return { ok: false, content: "schedule_meeting needs a 'preferred_time'.", error: "bad_args" };
      }
      const phone = phoneFromSession(ctx.sessionId);
      const record = {
        ts: new Date().toISOString(),
        channel: "whatsapp",
        phone,
        name,
        contact,
        preferredTime,
        topic,
        sessionId: ctx.sessionId,
      };
      const file = join(leadsDir, "meetings.jsonl");
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(record) + "\n", "utf8");

      await desk.notify({
        kind: "meeting",
        sessionId: ctx.sessionId,
        contact: contact || name || phone,
        summary: `Meeting request for ${preferredTime}${topic ? ` — ${topic}` : ""}`,
      });

      return {
        ok: true,
        content:
          `Noted a meeting request for "${preferredTime}". Tell the person it's ` +
          "noted and someone will confirm the exact time shortly.",
        data: record,
      };
    },
  };
}
