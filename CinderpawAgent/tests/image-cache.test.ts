import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheImage, previewImageIn, sniffImage } from "../src/tools/image-cache.ts";
import { attachImages } from "../src/tools/builtin/show-widget.ts";
import type { CinderpawFetch } from "../src/types.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');

/** A fetch double: url → bytes or html, and a log of what was asked. */
function fakeFetch(routes: Record<string, Uint8Array | string>) {
  const asked: string[] = [];
  const fetch: CinderpawFetch = async (url) => {
    asked.push(url);
    const body = routes[url];
    if (body === undefined) return { status: 404, ok: false, headers: {}, text: async () => "", json: async () => null };
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    return { status: 200, ok: true, headers: {}, text: async () => new TextDecoder().decode(bytes), json: async () => null, bytes: async () => bytes };
  };
  return { fetch, asked };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "img-cache-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("cacheImage", () => {
  test("fetches once, then serves the file from the cache", async () => {
    const { fetch, asked } = fakeFetch({ "https://cdn.example/a": PNG });
    const first = await cacheImage("https://cdn.example/a", fetch, dir);
    const again = await cacheImage("https://cdn.example/a", fetch, dir);
    expect(first).toBe(again);
    expect(first?.endsWith(".png")).toBe(true);
    expect(asked).toEqual(["https://cdn.example/a"]);
  });

  test("keeps only https raster images, by their bytes", async () => {
    const { fetch } = fakeFetch({ "https://x.example/s.svg": SVG, "http://x.example/a.png": PNG });
    expect(await cacheImage("https://x.example/s.svg", fetch, dir)).toBeNull();
    expect(await cacheImage("http://x.example/a.png", fetch, dir)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    expect(sniffImage(new TextEncoder().encode("RIFF1234WEBPVP8 "))).toBe("webp");
  });

  test("the oldest files go when the cache is over its cap", async () => {
    const { fetch } = fakeFetch({ "https://x.example/1": PNG, "https://x.example/2": PNG });
    await cacheImage("https://x.example/1", fetch, dir, PNG.length);
    await Bun.sleep(5);
    await cacheImage("https://x.example/2", fetch, dir, PNG.length);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

describe("previewImageIn", () => {
  test("takes the page's own preview picture, resolved against the page", () => {
    const html = `<head><meta name="twitter:image" content="https://cdn.example/t.jpg">
      <meta property="og:image" content="/img/hero.jpg?w=800&amp;h=600"></head>`;
    expect(previewImageIn(html, "https://shop.example/bike")).toBe("https://shop.example/img/hero.jpg?w=800&h=600");
    expect(previewImageIn("<p>none</p>", "https://shop.example/")).toBeNull();
  });
});

describe("attachImages", () => {
  test("a linked card gets its page's picture; a failed one keeps its placeholder", async () => {
    const { fetch } = fakeFetch({
      "https://shop.example/bike": '<meta property="og:image" content="https://cdn.example/bike.png">',
      "https://cdn.example/bike.png": PNG,
    });
    const widget = { kind: "cards", items: [
      { title: "Aventon", url: "https://shop.example/bike" },
      { title: "Broken", image: "https://cdn.example/missing.png" },
    ] } as Record<string, unknown>;
    expect(await attachImages(widget, fetch, dir)).toBe(1);
    const [a, b] = widget.items as Record<string, unknown>[];
    expect(a.image).toBe("https://cdn.example/bike.png");
    expect(String(a.imageFile).startsWith(dir)).toBe(true);
    expect(b.image).toBeUndefined();
    expect(b.imageFile).toBeUndefined();
  });
});
