/**
 * watch_video turns a video into pictures + words for any model, asks before
 * the first download, and refuses when nobody is there to say yes.
 */
import { describe, expect, test } from "bun:test";
import { createWatchVideoTool } from "../src/tools/builtin/watch-video.ts";
import type { ToolContext } from "../src/types.ts";

function ctx(over: Partial<ToolContext> & { calls?: string[]; ready?: boolean }): ToolContext {
  const calls = over.calls ?? [];
  let ready = over.ready ?? true;
  const desktopControl = {
    async request(action: string) {
      calls.push(action);
      if (action === "video.ready") return { ready };
      if (action === "video.install") { ready = true; return { ready }; }
      return {
        title: "Night Shift",
        duration: 55.7,
        uploader: "Cinderpaw",
        file: "C:/cache/video.mp4",
        times: [3.5, 10.4],
        pictures: ["AAA", "BBB"],
        per_picture: 1,
        transcript: "It's 3:07 a.m.",
      };
    },
  };
  return { sessionId: "s", desktopControl, ...over } as unknown as ToolContext;
}

describe("watch_video", () => {
  test("gives pictures with their times and the words, and says what a text-only model has", async () => {
    const r = await createWatchVideoTool().execute({ source: "https://youtu.be/x" }, ctx({}));
    expect(r.ok).toBe(true);
    expect(r.images).toEqual(["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"]);
    expect(r.content).toContain("Title: Night Shift");
    expect(r.content).toContain("picture 1 at 0:03, picture 2 at 0:10");
    expect(r.content).toContain("If you cannot see pictures");
    expect(r.content).toContain("3:07 a.m.");
  });

  test("asks the person before the first download, and downloads on yes", async () => {
    const calls: string[] = [];
    const askUser = { ask: async () => [{ selected: ["Yes, download them"] }] };
    const r = await createWatchVideoTool().execute({ source: "https://youtu.be/x" }, ctx({ calls, ready: false, askUser } as never));
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["video.ready", "video.install", "video.watch"]);
  });

  test("downloads nothing on no, and nothing when nobody is there", async () => {
    const calls: string[] = [];
    const askUser = { ask: async () => [{ selected: ["No"] }] };
    const no = await createWatchVideoTool().execute({ source: "https://youtu.be/x" }, ctx({ calls, ready: false, askUser } as never));
    expect(no.error).toBe("install_declined");
    const alone = await createWatchVideoTool().execute({ source: "https://youtu.be/x" }, ctx({ calls, ready: false }));
    expect(alone.error).toBe("install_needs_approval");
    expect(calls).not.toContain("video.install");
  });
});
