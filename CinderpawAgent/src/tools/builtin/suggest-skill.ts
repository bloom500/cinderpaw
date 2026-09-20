/**
 * suggest_skill: the agent's way of saying "this is the kind of task worth
 * teaching me once".
 *
 * The "Skills teach Cinderpaw..." line above the composer used to show at all
 * times, which is noise: a skill only earns its place on a task the person
 * will want done the same way again. Whether a request is that kind of task is
 * a judgement the model is already making while it reads it, so the model
 * decides, by calling this. The tool has no effect of its own: the desktop
 * watches for it on the tool stream and shows the offer; every other surface
 * gets a sentence back and can say it in words.
 */
import type { Tool, ToolManifest } from "../../types.ts";

export function createSuggestSkillTool(): Tool {
  const manifest: ToolManifest = {
    name: "suggest_skill",
    description:
      "Offer the user to teach you this task as a reusable skill. Call it ONCE, early, " +
      "when the request is something they will want done the same way again: a recurring " +
      "report, a routine, an automation, anything phrased as 'every time', 'whenever', " +
      "'each week', 'always do it like this'. Never for a one-off question or task. " +
      "Then carry on with the task itself.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {
      reason: {
        type: "string",
        description: "One short line: what makes this task repeatable.",
        required: true,
      },
    },
    async execute(args) {
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (!reason) return { ok: false, error: "bad_args", content: "suggest_skill needs a reason." };
      return {
        ok: true,
        content:
          "The user has been offered to teach this as a skill. If they accept, they will say so; " +
          "continue the task now, do not ask them about it yourself.",
        data: { reason },
      };
    },
  };
}
