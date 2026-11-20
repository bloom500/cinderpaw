import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShowVideoTool } from "../src/tools/builtin/show-video.ts";

// Darius, 30 Oct: a film the agent rendered should play in the chat, not be a path.
describe("show_video", () => {
  const dir = mkdtempSync(join(tmpdir(), "show-video-"));
  const run = (path: unknown) => createShowVideoTool().execute({ path }, {} as never);

  it("hands the app a real video file to play", async () => {
    const film = join(dir, "Cinderpaw.mp4");
    writeFileSync(film, "not empty");
    const r = await run(film);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ video: { path: film, name: "Cinderpaw.mp4", bytes: 9 } });
  });

  it("says what is wrong instead of showing a broken player", async () => {
    expect((await run("film.mp4")).content).toContain("absolute path");
    expect((await run(join(dir, "missing.mp4"))).content).toContain("There is no video");
    const gif = join(dir, "loop.gif");
    writeFileSync(gif, "x");
    expect((await run(gif)).content).toContain("not .gif");
    const empty = join(dir, "empty.webm");
    writeFileSync(empty, "");
    expect((await run(empty)).content).toContain("did not finish");
  });
});
