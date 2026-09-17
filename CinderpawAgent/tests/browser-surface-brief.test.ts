/**
 * The browser as a surface: when the person has a page open, the agent must
 * reach for `browser` rather than web_search on the very page in front of
 * them. The tool description cannot say "right now", so the host reports the
 * visible page with every message and this turns it into a per-turn brief.
 */

import { describe, expect, test } from "bun:test";
import { browserSurfaceBrief } from "../src/dispatch.ts";

describe("browserSurfaceBrief", () => {
  test("no page on screen is no brief at all", () => {
    expect(browserSurfaceBrief(null)).toBe("");
    expect(browserSurfaceBrief(undefined)).toBe("");
    expect(browserSurfaceBrief({})).toBe("");
    // A blank url is the new-tab page: the browser is open with nothing in it.
    expect(browserSurfaceBrief({ url: "   " })).toBe("");
  });

  test("the page is named, and browser is put ahead of the fetching tools", () => {
    const brief = browserSurfaceBrief({ url: "https://anaf.ro/form", title: "Formular REV" });
    expect(brief).toContain("https://anaf.ro/form");
    expect(brief).toContain("Formular REV");
    expect(brief).toContain("snapshot");
    // The whole point: the order is stated, not implied.
    expect(brief.indexOf("browser")).toBeLessThan(brief.indexOf("web_search"));
  });

  test("a page with no title yet still gets its address said", () => {
    const brief = browserSurfaceBrief({ url: "https://example.com/a" });
    expect(brief).toContain("https://example.com/a");
    expect(brief).not.toContain('"" —');
  });
});
