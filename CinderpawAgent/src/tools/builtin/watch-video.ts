/**
 * watch_video — look at a video the way a person does: pictures and words.
 *
 * Darius, 29 Oct 2026: whatever model Cinderpaw runs on should be able to see a
 * YouTube, Instagram or X video, or a local file, the way Claude does with
 * yt-dlp and ffmpeg. No model reads a video file. Every model reads text, and
 * most read pictures, so the host (cinderpaw_core::video, over the same bridge
 * the browser uses) turns the video into evenly spaced frames plus the words
 * spoken in it. A model that sees gets both; one that does not still gets the
 * transcript, the title and the times, which is told to it plainly.
 *
 * yt-dlp and ffmpeg are not on a fresh machine. The first call asks the person
 * before ~150 MB arrive; with nobody there to say yes it refuses and says why.
 */

import type { Tool, ToolManifest, ToolResult } from "../../types.ts";
import { canAskAHuman } from "../../core/permission-mode.ts";
import { guardWebText } from "../../security/injection.ts";

/** A first download of a long video can take minutes; the bridge waits this long. */
const WATCH_MS = 30 * 60_000;
const INSTALL_MS = 15 * 60_000;
/** The transcript rides in the transcript of the chat: bounded like a fetched page. */
const MAX_TRANSCRIPT = 12_000;

function fail(content: string, error = "watch_video_error"): ToolResult {
  return { ok: false, content, error };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

interface Watched {
  title?: string | null;
  duration?: number | null;
  uploader?: string | null;
  file: string;
  /** The second each frame was taken at. */
  times: number[];
  /** JPEG base64: one frame each, or `per_picture` frames in a 4x4 grid. */
  pictures: string[];
  per_picture: number;
  transcript?: string | null;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** "picture 1 at 0:04, ..." or, for grids, which frames each grid holds. */
export function describePictures(times: number[], perPicture: number): string {
  if (perPicture <= 1) return times.map((t, i) => `picture ${i + 1} at ${clock(t)}`).join(", ");
  const grids: string[] = [];
  for (let i = 0; i < times.length; i += perPicture) {
    const part = times.slice(i, i + perPicture);
    grids.push(`grid ${grids.length + 1}: ${part.length} frames, ${part.map(clock).join(", ")}`);
  }
  return grids.join("\n");
}

export function createWatchVideoTool(): Tool {
  const manifest: ToolManifest = {
    name: "watch_video",
    description:
      "Watch a video or look at a picture: a link (YouTube, Instagram, X, TikTok, Vimeo and " +
      "most sites with a video) or any video or picture file anywhere on this computer, " +
      "including ones you made yourself (a render in your workspace), not only what the " +
      "person sends. Use file_search to find one by name. Returns evenly spaced frames with " +
      "their times, plus the words said in it when the site has captions, and the title. " +
      "Use it whenever a video or picture matters; never guess what one shows from its " +
      "name or link. `frames` has no small limit: by default one every 2 seconds (8 to 64); " +
      "ask for more for fast motion, up to 400 a call. Past 16, frames come 16 to a picture " +
      "in a 4x4 grid, read left to right, top to bottom. For a close look at one moment, " +
      "set `start` and `end` (seconds) and ask for many frames of just that stretch; walk a " +
      "long video stretch by stretch to see all of it.",
    permissions: [],
    // The download is the host's (yt-dlp in the app), not this process's.
    networkAccess: false,
    timeoutMs: WATCH_MS + INSTALL_MS,
  };

  return {
    manifest,
    parameters: {
      source: { type: "string", description: "The video's link, or the full path of a video or picture file.", required: true },
      frames: { type: "number", description: "How many frames, 1-400. Default: one every 2 seconds, 8 to 64.", required: false },
      start: { type: "number", description: "Seconds: take frames from here on. Default the beginning.", required: false },
      end: { type: "number", description: "Seconds: take frames up to here. Default the end.", required: false },
    },
    async execute(args, ctx) {
      const source = typeof args.source === "string" ? args.source.trim() : "";
      if (!source) return fail("watch_video needs `source`: a link or a file path.", "bad_args");
      if (!ctx.desktopControl) {
        return fail("watch_video needs the desktop app, which downloads and opens the video; it is not available in this session.", "unavailable");
      }
      const bridge = ctx.desktopControl;
      // The host fills in what is missing: the default count, the whole video.
      const asked = num(args.frames);
      const frames = asked === undefined ? undefined : Math.max(1, Math.min(400, Math.round(asked)));
      const start = num(args.start);
      const end = num(args.end);

      const { ready } = (await bridge.request("video.ready", {}, ctx.sessionId)) as { ready: boolean };
      if (!ready) {
        if (!canAskAHuman(Boolean(ctx.askUser))) {
          return fail(
            "Watching videos needs yt-dlp and ffmpeg, which are not installed, and nobody is here to say yes to the download. Tell the person; they install the first time they share a video with you.",
            "install_needs_approval",
          );
        }
        const [answer] = await ctx.askUser!.ask(
          [{
            question: "Download yt-dlp and ffmpeg so I can watch videos?",
            header: "Install",
            preview: "About 150 MB, once, into Cinderpaw's own folder. yt-dlp fetches videos from links; ffmpeg takes pictures out of them.",
            multiSelect: false,
            forceEscalate: true,
            options: [
              { label: "Yes, download them", description: "Then I watch the video." },
              { label: "No", description: "Nothing is downloaded." },
            ],
          }],
          ctx.sessionId,
        );
        if (!(answer?.selected?.[0] ?? "").toLowerCase().startsWith("yes")) {
          return fail("The person said no to downloading the video tools. Do not try to get the video another way.", "install_declined");
        }
        ctx.progress?.({ stage: "install", progress: null, message: "Downloading yt-dlp and ffmpeg" });
        try {
          await bridge.request("video.install", {}, ctx.sessionId, INSTALL_MS);
        } catch (e) {
          return fail(`Could not download the video tools: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      ctx.progress?.({ stage: "watch", progress: null, message: "Getting the video" });
      let w: Watched;
      try {
        w = (await bridge.request("video.watch", { source, frames, start, end }, ctx.sessionId, WATCH_MS)) as Watched;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return fail(`Could not get that video (${why}). Some sites need a login yt-dlp does not have; say so instead of guessing what it shows.`);
      }

      const shots = w.pictures ?? [];
      const times = w.times ?? [];
      const head = [
        w.title ? `Title: ${w.title}` : null,
        w.uploader ? `By: ${w.uploader}` : null,
        typeof w.duration === "number" ? `Length: ${clock(w.duration)}` : null,
        `File: ${w.file}`,
      ].filter(Boolean).join("\n");
      const what = w.per_picture > 1
        ? `${times.length} frames are attached as ${shots.length} pictures, ${w.per_picture} frames to a picture in a 4x4 grid, read left to right, top to bottom:\n${describePictures(times, w.per_picture)}\n`
        : `${shots.length} pictures are attached, in order: ${describePictures(times, 1)}. `;
      let words = (w.transcript ?? "").trim();
      if (words.length > MAX_TRANSCRIPT) words = `${words.slice(0, MAX_TRANSCRIPT)} [transcript cut here; the video goes on]`;
      // Captions and titles are the uploader's words: untrusted, like any page.
      const said = words ? guardWebText(words, source, ctx.sessionId) : "";
      const content = [
        head,
        shots.length
          ? `${what}Describe what they show before you rely on them. If you cannot see pictures, say that you only have the words below.`
          : "No pictures could be taken from this file.",
        said ? `What is said in it (captions):\n${said}` : "The video has no captions, so what is said in it is not known. Do not invent it.",
      ].join("\n\n");
      return {
        ok: true,
        content,
        images: shots.map((b64) => `data:image/jpeg;base64,${b64}`),
        data: { title: w.title, duration: w.duration, file: w.file, frames: times, hasTranscript: Boolean(words) },
      };
    },
  };
}
