import { describe, expect, it } from "bun:test";
import { createFetchUrlTool } from "../src/tools/builtin/fetch-url.ts";

/** A fetch that answers every address with this body. */
const page = (html: string, type = "text/html") =>
  ({
    fetch: async () => ({ ok: true, status: 200, headers: { "content-type": type }, text: async () => html }),
    sessionId: "t",
  }) as never;

describe("fetch_url tells the agent a page's picture", () => {
  const tool = createFetchUrlTool(["example.com"]);

  it("ends the text with the page's og:image, resolved against the page", async () => {
    const html = `<html><head><title>Tokyo</title><meta property="og:image" content="/img/tokyo.jpg"></head><body><p>A city.</p></body></html>`;
    const r = await tool.execute({ url: "https://example.com/tokyo" }, page(html));
    expect(r.content).toContain("A city.");
    expect(r.content).toContain("Picture: https://example.com/img/tokyo.jpg");
  });

  it("says nothing about a picture when the page names none, or is not a page", async () => {
    const none = await tool.execute({ url: "https://example.com/a" }, page("<html><body><p>Hi</p></body></html>"));
    expect(none.content).not.toContain("Picture:");
    const json = await tool.execute({ url: "https://example.com/b" }, page('{"og:image":"x"}', "application/json"));
    expect(json.content).not.toContain("Picture:");
  });
});
