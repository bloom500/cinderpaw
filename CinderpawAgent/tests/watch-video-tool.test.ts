/**
 * watch_video past 16 frames: the host packs them 16 to a picture, and the
 * text must say which frames each picture holds, or the model reads a grid of
 * 16 as one moment.
 */
import { describe, expect, test } from "bun:test";
import { describePictures } from "../src/tools/builtin/watch-video.ts";

describe("describePictures", () => {
  test("one frame a picture names each picture's time", () => {
    expect(describePictures([1, 65], 1)).toBe("picture 1 at 0:01, picture 2 at 1:05");
  });

  test("grids say how many frames each holds, the last one short", () => {
    const times = Array.from({ length: 20 }, (_, i) => i);
    const lines = describePictures(times, 16).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("grid 1: 16 frames, 0:00, 0:01");
    expect(lines[1]).toBe("grid 2: 4 frames, 0:16, 0:17, 0:18, 0:19");
  });
});
