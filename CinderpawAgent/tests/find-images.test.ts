import { describe, expect, it } from "bun:test";
import {
  createFindImagesTool,
  findImages,
  parseCommons,
  parseINaturalist,
  parseOpenverse,
  parsePexels,
  parseUnsplash,
  render,
} from "../src/tools/builtin/find-images.ts";

// Shapes copied from real answers of each API (1 Oct 2026).
const OPENVERSE = { results: [
  { title: "Kyoto bamboo forest path", creator: "acase1968", license: "by", license_version: "2.0",
    thumbnail: "https://api.openverse.org/v1/images/00d2/thumb/", foreign_landing_url: "https://www.flickr.com/photos/1/2" },
  { title: "no address", creator: "x", license: "by", thumbnail: "", url: "http://insecure.example/a.jpg" },
] };
const COMMONS = { query: { pages: { "1": { title: "File:Bamboo Forest, Arashiyama.jpg", imageinfo: [{
  thumburl: "https://thumb.wikimedia.org/x/960px-Bamboo.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Bamboo.jpg",
  extmetadata: { Artist: { value: '<a href="//c/User:Basile" title="x">Basile Morin</a>' }, LicenseShortName: { value: "CC BY-SA 4.0" } } }] } } } };
const INAT = { results: [
  { uri: "https://www.inaturalist.org/observations/1", taxon: { preferred_common_name: "Red Fox" },
    photos: [{ url: "https://static.inaturalist.org/photos/7/square.jpg", license_code: "cc-by", attribution: "(c) Julius P, some rights reserved (CC BY)" }] },
  { uri: "https://www.inaturalist.org/observations/2", photos: [{ url: "https://static.inaturalist.org/photos/8/square.jpg", license_code: null }] },
] };

describe("parsers", () => {
  it("Openverse: uses the https thumbnail, credits creator and licence, drops a row with no https address", () => {
    const f = parseOpenverse(OPENVERSE);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ url: "https://api.openverse.org/v1/images/00d2/thumb/", credit: "acase1968, CC BY 2.0", source: "Openverse" });
  });

  it("Commons: strips the markup from the artist and the File: prefix from the title", () => {
    expect(parseCommons(COMMONS)[0]).toMatchObject({ title: "Bamboo Forest, Arashiyama", credit: "Basile Morin, CC BY-SA 4.0" });
  });

  it("iNaturalist: asks for the large size and drops a photo with no licence of its own", () => {
    const f = parseINaturalist(INAT);
    expect(f).toHaveLength(1);
    expect(f[0].url).toBe("https://static.inaturalist.org/photos/7/large.jpg");
    expect(f[0].title).toBe("Red Fox");
  });

  it("Pexels and Unsplash read their own shapes", () => {
    expect(parsePexels({ photos: [{ alt: "A cat", photographer: "Ana", url: "https://www.pexels.com/p/1", src: { large: "https://images.pexels.com/1.jpg" } }] })[0])
      .toMatchObject({ credit: "Ana, Pexels licence", url: "https://images.pexels.com/1.jpg" });
    expect(parseUnsplash({ results: [{ alt_description: "Sunset", user: { name: "Bo" }, urls: { regular: "https://images.unsplash.com/1" }, links: { html: "https://unsplash.com/p/1" } }] })[0])
      .toMatchObject({ credit: "Bo, Unsplash licence", page: "https://unsplash.com/p/1" });
  });

  it("garbage in, nothing out, never a throw", () => {
    for (const p of [parseOpenverse, parseCommons, parseINaturalist, parsePexels, parseUnsplash]) {
      expect(p(null)).toEqual([]);
      expect(p({ results: [1, "x", null], photos: [null], query: { pages: { a: 1 } } })).toEqual([]);
    }
  });
});

/** A fetch that answers by host: a Response-like for each, or a failure. */
const fake = (by: Record<string, unknown | Error | number>) => {
  const calls: string[] = [];
  const f = (async (url: string) => {
    const host = new URL(url).hostname;
    calls.push(host);
    const v = by[host];
    if (v instanceof Error) throw v;
    if (typeof v === "number") return { ok: false, status: v, json: async () => ({}) };
    return { ok: v !== undefined, status: v !== undefined ? 200 : 404, json: async () => v };
  }) as never;
  return { f, calls };
};

describe("findImages", () => {
  it("with no keys, goes Openverse then Commons, and never touches the keyed sources", async () => {
    const { f, calls } = fake({ "api.openverse.org": OPENVERSE, "commons.wikimedia.org": COMMONS });
    const r = await findImages(f, "kyoto bamboo", 2);
    expect(r.found.map((x) => x.source)).toEqual(["Openverse", "Wikimedia Commons"]);
    expect(calls).toEqual(["api.openverse.org", "commons.wikimedia.org"]);
    expect(r.notes).toEqual([]);
  });

  it("a source that is down is noted and the next one still answers", async () => {
    const { f } = fake({ "api.openverse.org": new Error("boom"), "commons.wikimedia.org": COMMONS });
    const r = await findImages(f, "bamboo", 1);
    expect(r.found).toHaveLength(1);
    expect(r.notes).toEqual(["openverse could not be reached."]);
  });

  it("with a key, Pexels goes first; asking for it by name without a key says so", async () => {
    const pexels = { photos: [{ alt: "a", photographer: "P", url: "https://www.pexels.com/p/1", src: { large: "https://images.pexels.com/1.jpg" } }] };
    const { f, calls } = fake({ "api.pexels.com": pexels });
    const keyed = await findImages(f, "cat", 1, undefined, { CINDERPAW_PEXELS_KEY: "k" });
    expect(keyed.found[0].source).toBe("Pexels");
    expect(calls).toEqual(["api.pexels.com"]);
    const named = await findImages(f, "cat", 1, "pexels", {});
    expect(named.found).toEqual([]);
    expect(named.notes[0]).toContain("CINDERPAW_PEXELS_KEY");
  });

  it("a ( or ) in an address is encoded, so it cannot end a Markdown image early", async () => {
    const row = { results: [{ title: "t", creator: "c", license: "by", thumbnail: "https://x.example/a_(b).jpg" }] };
    const { f } = fake({ "api.openverse.org": row });
    expect((await findImages(f, "x", 1, "openverse")).found[0].url).toBe("https://x.example/a_%28b%29.jpg");
  });

  it("the same picture from two sources is shown once", async () => {
    const dup = { results: [OPENVERSE.results[0], OPENVERSE.results[0]] };
    const { f } = fake({ "api.openverse.org": dup });
    expect((await findImages(f, "x", 4, "openverse")).found).toHaveLength(1);
  });
});

describe("render and the tool", () => {
  it("names what to do with a picture and what not to do", () => {
    const text = render("bamboo", { found: parseCommons(COMMONS), notes: [] });
    expect(text).toContain("https://thumb.wikimedia.org/x/960px-Bamboo.jpg");
    expect(text).toContain("keep its Credit");
    expect(text).toContain("never invent one");
  });

  it("an empty result tells the agent what to try, and fails the call", async () => {
    const tool = createFindImagesTool();
    const { f } = fake({});
    const r = await tool.execute({ query: "zzzz" }, { fetch: f, sessionId: "t" } as never);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("Try a simpler");
  });

  it("is a drawer tool: it never rides along on every completion", async () => {
    const { isExtendedTool } = await import("../src/tools/tiers.ts");
    expect(isExtendedTool("find_images")).toBe(true);
  });
});
