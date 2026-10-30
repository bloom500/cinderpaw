/**
 * show_video — put a video the agent made in front of the person, playable.
 *
 * Darius, 30 Oct 2026: after the agent renders a film (HyperFrames, Remotion,
 * ffmpeg), the person should watch it in the chat, not be told a path to go
 * and find. The chat already plays videos (its own player, the one for
 * attachments); what was missing was a way for the agent to hand it one. This
 * checks the file and passes its path on in `data.video`; the app opens that
 * one file to its player (allow_video_preview, which refuses the private and
 * credential folders) and draws it in the reply.
 */

import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { Tool, ToolManifest, ToolResult } from "../../types.ts";

/** What the chat's player can play: the same list the host allows. */
const PLAYABLE = new Set([".mp4", ".m4v", ".mov", ".webm"]);

function fail(content: string): ToolResult {
  return { ok: false, content, error: "show_video_error" };
}

export function createShowVideoTool(): Tool {
  const manifest: ToolManifest = {
    name: "show_video",
    description:
      "Show the person a video file in the chat, with a player, so they can watch it right there. " +
      "Use it after you make or edit a video (a render, a cut, a screen recording). " +
      "`path` must be the absolute path of an .mp4, .m4v, .mov or .webm file on this computer.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      path: { type: "string", description: "Absolute path of the video file.", required: true },
    },
    async execute(args) {
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (!path || !isAbsolute(path)) return fail("Give the absolute path of the video file.");
      const ext = extname(path).toLowerCase();
      if (!PLAYABLE.has(ext)) {
        return fail(`The chat plays .mp4, .m4v, .mov and .webm, not ${ext || "a file without an extension"}. Convert it first (ffmpeg to .mp4), then show that.`);
      }
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return fail(`There is no video at ${path}. Check the path the render wrote.`);
      if (info.size === 0) return fail(`${basename(path)} is empty: the render did not finish.`);
      const name = basename(path);
      return {
        ok: true,
        content: `${name} is in the chat now, with a player. Do not paste its path again; say in a sentence what it is.`,
        data: { video: { path, name, bytes: info.size } },
      };
    },
  };
}
