/**
 * feedback_skill — refine an existing skill given user feedback.
 *
 * The model calls this with `(skill_id, feedback)` and the skill's
 * body is rewritten by the LLM. The new version is written to disk
 * and `skill_refined` is emitted. The model sees the new body back
 * as the tool result so it can confirm the change to the user.
 *
 * Permission: no fs:write declared. The tool writes via the
 * SkillsStorage helper which writes to the user's home dir directly
 * (sandboxed by homedir containment, same pattern as the other
 * skill-related writes that go through the OS). The manifest's
 * `allowedPaths` is intentionally left empty because the write target
 * is the user's home, not a workspace-relative path.
 */

import { SkillsStorage, SkillSelfImprover } from "../../skills/index.ts";
import type { Database } from "bun:sqlite";
import type { Tool, ToolManifest } from "../../types.ts";
import type { InferenceRouter } from "../../sandbox/inference-router.ts";

export function createFeedbackSkillTool(
  db: Database,
  router: InferenceRouter,
  homeDir: string = process.env.HOME ?? process.env.USERPROFILE ?? ".",
): Tool {
  const manifest: ToolManifest = {
    name: "feedback_skill",
    description:
      "Refine an existing skill's body in light of user feedback. " +
      "The skill's version is bumped and the on-disk SKILL.md is updated.",
    permissions: [],
    networkAccess: false,
  };
  const storage = new SkillsStorage(homeDir);
  const improver = new SkillSelfImprover({ storage, db, router });
  return {
    manifest,
    parameters: {
      skill_id: {
        type: "string",
        description: "Id of the skill to refine (e.g. 'deploy-staging').",
        required: true,
      },
      feedback: {
        type: "string",
        description: "What the user wants changed.",
        required: true,
      },
    },
    async execute(args, ctx) {
      const id = args.skill_id;
      const feedback = args.feedback;
      if (typeof id !== "string" || !id.trim()) {
        return { ok: false, content: "feedback_skill requires skill_id", error: "bad_args" };
      }
      if (typeof feedback !== "string" || !feedback.trim()) {
        return { ok: false, content: "feedback_skill requires feedback", error: "bad_args" };
      }
      try {
        const r = await improver.refine(id, feedback);
        // Surface the new version to the transport so the React UI can
        // prompt the user. We don't have a direct transport handle
        // here, so we publish through the audit log (always available)
        // and let index.ts forward via the event sink if present.
        // V1: result is returned to the agent loop, which already
        // emits a `done` event with the new body. The tool result
        // is the canonical place for the structured outcome.
        ctx.audit({
          timestamp: Date.now(),
          sessionId: ctx.sessionId,
          actionType: "tool_call",
          toolName: "feedback_skill",
          result: "success",
          durationMs: 0,
        });
        return {
          ok: true,
          content:
            `Skill "${r.skillId}" refined to v${r.newVersion}.\n\n` +
            `New body:\n${r.body}\n\n` +
            `Triggers: ${r.triggers.join(", ")}`,
          data: { version: r.newVersion, body: r.body, triggers: r.triggers },
        };
      } catch (err) {
        return {
          ok: false,
          content: `feedback_skill failed: ${String(err)}`,
          error: "execution_error",
        };
      }
    },
  };
}
