/**
 * Images for the chat's widgets, fetched once through the egress door and
 * kept in the profile (spec 7.1 "Images in cards", answered 27 Sep: "through
 * the engine").
 *
 * Why not let the app load `https:` images itself: every request would leave
 * from the webview, past the egress policy, with a referrer, and a card seen
 * yesterday would be blank offline today. Here an image is fetched by the same
 * `ctx.fetch` as every other tool request, stored under
 * `<profile>/cache/images/<sha256 of the url>.<ext>`, and the app shows the
 * file.
 *
 * Only real raster images are kept: the type is read from the file's first
 * bytes, not from the server's word for it, and SVG (a document that can carry
 * script) is never stored.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cinderpawHome } from "../config.ts";
import type { CinderpawFetch } from "../types.ts";

/** One image, at most. A card thumbnail never needs more. */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** The whole cache; past it the oldest files go first. */
export const CACHE_MAX_BYTES = 200 * 1024 * 1024;
/** A page read only for its preview image: its head is enough. */
const PAGE_MAX_BYTES = 512 * 1024;

export function imageCacheDir(): string {
  return join(cinderpawHome(), "cache", "images");
}

/** The extension for a raster image's first bytes, or null for anything else. */
export function sniffImage(b: Uint8Array): "png" | "jpg" | "gif" | "webp" | "avif" | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (ascii(0, "GIF8")) return "gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  if (ascii(4, "ftypavif")) return "avif";
  return null;
}

const httpsOnly = (u: string): boolean => {
  try { return new URL(u).protocol === "https:"; } catch { return false; }
};

/** Oldest first until the cache fits again. */
function prune(dir: string, cap: number): void {
  const files = readdirSync(dir).map((name) => {
    const path = join(dir, name);
    const s = statSync(path);
    return { path, size: s.size, at: s.mtimeMs };
  }).sort((a, b) => a.at - b.at);
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files) {
    if (total <= cap) break;
    try { unlinkSync(f.path); total -= f.size; } catch { /* in use; next one */ }
  }
}

/**
 * The cached file for an image URL: from the cache when it is there, fetched
 * and stored when not. Null for anything that is not an https raster image
 * within the size cap, or that fails to arrive. Never throws.
 */
export async function cacheImage(
  url: string,
  fetch: CinderpawFetch,
  dir = imageCacheDir(),
  cap = CACHE_MAX_BYTES,
): Promise<string | null> {
  if (!httpsOnly(url)) return null;
  const key = createHash("sha256").update(url).digest("hex").slice(0, 40);
  try {
    if (existsSync(dir)) {
      const hit = readdirSync(dir).find((n) => n.startsWith(`${key}.`));
      if (hit) return join(dir, hit);
    }
    const res = await fetch(url, { method: "GET", timeoutMs: 8_000, maxBytes: IMAGE_MAX_BYTES + 1 });
    if (!res.ok || res.truncated || !res.bytes) return null;
    const bytes = await res.bytes();
    if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) return null;
    const ext = sniffImage(bytes);
    if (!ext) return null;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${key}.${ext}`);
    writeFileSync(file, bytes);
    prune(dir, cap);
    return file;
  } catch {
    return null;
  }
}

/**
 * The preview image a page names for itself (`og:image`, `twitter:image`,
 * `image_src`), resolved against the page, https only. What a link preview in
 * any chat app shows: the picture the page chose to represent it.
 */
export function previewImageIn(html: string, pageUrl: string): string | null {
  const metas = html.match(/<(meta|link)\b[^>]*>/gi) ?? [];
  const attr = (tag: string, name: string) =>
    new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(2).find((v) => v !== undefined) ?? null;
  const wanted = ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"];
  let best: { rank: number; url: string } | null = null;
  for (const tag of metas) {
    const key = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    const raw = rel === "image_src" ? attr(tag, "href") : attr(tag, "content");
    const rank = rel === "image_src" ? wanted.length : wanted.indexOf(key);
    if (!raw || rank < 0 || (best && best.rank <= rank)) continue;
    try {
      const abs = new URL(raw.replace(/&amp;/g, "&"), pageUrl).toString();
      if (httpsOnly(abs)) best = { rank, url: abs };
    } catch { /* not a URL */ }
  }
  return best?.url ?? null;
}

/** Read a page's head for its preview image. Null when it has none or fails. */
export async function pagePreviewImage(pageUrl: string, fetch: CinderpawFetch): Promise<string | null> {
  if (!httpsOnly(pageUrl)) return null;
  try {
    const res = await fetch(pageUrl, { method: "GET", timeoutMs: 6_000, maxBytes: PAGE_MAX_BYTES });
    if (!res.ok) return null;
    return previewImageIn(await res.text(), pageUrl);
  } catch {
    return null;
  }
}
