/**
 * find_images — real photos for a plan, a guide or a card, with their credit.
 *
 * The agent had no way to learn a picture's address: `fetch_url` returns text,
 * `web_search` returns titles. This asks the open photo libraries directly and
 * hands back https addresses, each with who took it and under what licence, so
 * the agent can write `![caption](url)` into an artifact and keep the credit.
 *
 * Sources, in the order a default install tries them:
 *   - Openverse      keyless. Creative-Commons photos from Flickr, museums and more.
 *   - Wikimedia Commons  keyless. Places, landmarks, history; the best metadata.
 *   - iNaturalist    keyless. Animals and plants, photographed by people.
 *   - Pexels, Unsplash  free key (CINDERPAW_PEXELS_KEY / CINDERPAW_UNSPLASH_KEY).
 *     The best-looking lifestyle photos; used first when a key is set, and
 *     simply absent when not, with the result saying so.
 *
 * A stranger's machine has no keys, so the first three alone must carry a
 * default install. The Met's open-access API was left out: it changed its
 * search endpoint on 1 Oct 2026, a source that moves under us is a bad default.
 *
 * Pictures are NOT fetched here, only looked up. The app shows them from their
 * https address and hides one that fails, so a dead link costs a blank, never a
 * broken icon. Text that comes back (titles, names) is from the web, so the
 * whole result goes through `guardWebText`.
 */

import { readEnv } from "../../config.ts";
import { guardWebText } from "../../security/injection.ts";
import type { CinderpawFetch, Tool, ToolManifest } from "../../types.ts";

export interface Found {
  url: string;
  title: string;
  /** "Photographer, licence": what a caption must carry. */
  credit: string;
  /** The page the picture lives on. */
  page: string;
  source: string;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const https = (v: unknown): string => {
  const s = str(v);
  try { return new URL(s).protocol === "https:" ? s : ""; } catch { return ""; }
};
const plain = (html: string): string => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const licence = (code: string, version?: string): string =>
  code ? `CC ${code.toUpperCase()}${version ? ` ${version}` : ""}` : "";

export const SOURCES = ["openverse", "commons", "inaturalist", "pexels", "unsplash"] as const;
export type Source = (typeof SOURCES)[number];

// --- one parser per source: JSON in, Found[] out, no network ---------------------------

export function parseOpenverse(json: unknown): Found[] {
  const rows = isRec(json) && Array.isArray(json.results) ? json.results : [];
  return rows.flatMap((r): Found[] => {
    if (!isRec(r)) return [];
    const url = https(r.thumbnail) || https(r.url);
    if (!url) return [];
    const by = str(r.creator) || "unknown";
    return [{
      url,
      title: str(r.title) || "Untitled",
      credit: `${by}, ${licence(str(r.license), str(r.license_version)) || "see page"}`,
      page: https(r.foreign_landing_url) || url,
      source: "Openverse",
    }];
  });
}

export function parseCommons(json: unknown): Found[] {
  const pages = isRec(json) && isRec(json.query) && isRec(json.query.pages) ? Object.values(json.query.pages) : [];
  return pages.flatMap((p): Found[] => {
    if (!isRec(p) || !Array.isArray(p.imageinfo) || !isRec(p.imageinfo[0])) return [];
    const info = p.imageinfo[0];
    const url = https(info.thumburl) || https(info.url);
    if (!url) return [];
    const meta = isRec(info.extmetadata) ? info.extmetadata : {};
    const val = (k: string) => (isRec(meta[k]) ? plain(str((meta[k] as Rec).value)) : "");
    return [{
      url,
      title: str(p.title).replace(/^File:/, "").replace(/\.\w+$/, ""),
      credit: `${val("Artist") || "unknown"}, ${val("LicenseShortName") || "see page"}`,
      page: https(info.descriptionurl) || url,
      source: "Wikimedia Commons",
    }];
  });
}

export function parseINaturalist(json: unknown): Found[] {
  const rows = isRec(json) && Array.isArray(json.results) ? json.results : [];
  return rows.flatMap((r): Found[] => {
    if (!isRec(r) || !Array.isArray(r.photos) || !isRec(r.photos[0])) return [];
    const photo = r.photos[0];
    // The observation's licence filter says nothing about the PHOTO's: keep only
    // photos that carry a licence of their own ("all rights reserved" has none).
    const code = str(photo.license_code);
    const url = https(photo.url).replace("/square.", "/large.");
    if (!code || !url) return [];
    const taxon = isRec(r.taxon) ? str(r.taxon.preferred_common_name) || str(r.taxon.name) : "";
    return [{
      url,
      title: taxon || "Observation",
      credit: str(photo.attribution) || `unknown, ${licence(code)}`,
      page: https(r.uri) || url,
      source: "iNaturalist",
    }];
  });
}

export function parsePexels(json: unknown): Found[] {
  const rows = isRec(json) && Array.isArray(json.photos) ? json.photos : [];
  return rows.flatMap((r): Found[] => {
    if (!isRec(r) || !isRec(r.src)) return [];
    const url = https(r.src.large) || https(r.src.medium);
    if (!url) return [];
    return [{
      url,
      title: str(r.alt) || "Photo",
      credit: `${str(r.photographer) || "unknown"}, Pexels licence`,
      page: https(r.url) || url,
      source: "Pexels",
    }];
  });
}

export function parseUnsplash(json: unknown): Found[] {
  const rows = isRec(json) && Array.isArray(json.results) ? json.results : [];
  return rows.flatMap((r): Found[] => {
    if (!isRec(r) || !isRec(r.urls)) return [];
    const url = https(r.urls.regular) || https(r.urls.small);
    if (!url) return [];
    const user = isRec(r.user) ? str(r.user.name) : "";
    const links = isRec(r.links) ? https(r.links.html) : "";
    return [{
      url,
      title: str(r.alt_description) || str(r.description) || "Photo",
      credit: `${user || "unknown"}, Unsplash licence`,
      page: links || url,
      source: "Unsplash",
    }];
  });
}

// --- the lookups ---------------------------------------------------------------------

const q = encodeURIComponent;

interface Lookup {
  id: Source;
  /** Hosts this lookup talks to: the tool's egress allowlist is the union. */
  host: string;
  needsKey?: "CINDERPAW_PEXELS_KEY" | "CINDERPAW_UNSPLASH_KEY";
  request(query: string, n: number, key: string): { url: string; headers?: Record<string, string> };
  parse(json: unknown): Found[];
}

const LOOKUPS: Lookup[] = [
  {
    id: "pexels", host: "api.pexels.com", needsKey: "CINDERPAW_PEXELS_KEY",
    request: (s, n, key) => ({ url: `https://api.pexels.com/v1/search?query=${q(s)}&per_page=${n}`, headers: { Authorization: key } }),
    parse: parsePexels,
  },
  {
    id: "unsplash", host: "api.unsplash.com", needsKey: "CINDERPAW_UNSPLASH_KEY",
    request: (s, n, key) => ({ url: `https://api.unsplash.com/search/photos?query=${q(s)}&per_page=${n}`, headers: { Authorization: `Client-ID ${key}` } }),
    parse: parseUnsplash,
  },
  {
    // `commercial` keeps out the no-commercial-use licences: a plan gets exported and shared.
    id: "openverse", host: "api.openverse.org",
    request: (s, n) => ({ url: `https://api.openverse.org/v1/images/?q=${q(s)}&page_size=${n}&license_type=commercial` }),
    parse: parseOpenverse,
  },
  {
    id: "commons", host: "commons.wikimedia.org",
    request: (s, n) => ({
      url: `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=${n}` +
        `&gsrsearch=${q(`${s} filetype:bitmap`)}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=960`,
    }),
    parse: parseCommons,
  },
  {
    // Over-fetch: photos with no licence of their own are dropped by the parser.
    id: "inaturalist", host: "api.inaturalist.org",
    request: (s, n) => ({ url: `https://api.inaturalist.org/v1/observations?q=${q(s)}&photos=true&quality_grade=research&per_page=${n * 3}` }),
    parse: parseINaturalist,
  },
];

export interface FindResult {
  found: Found[];
  /** Sources that were skipped or failed, in words the person can read. */
  notes: string[];
}

/**
 * Ask the sources in order until `count` pictures are in hand. A source that
 * fails or has no key is noted and the next one is tried: one library being
 * down must not leave the agent with nothing.
 */
export async function findImages(
  fetch: CinderpawFetch,
  query: string,
  count: number,
  only?: Source,
  keys: Partial<Record<string, string | undefined>> = {},
): Promise<FindResult> {
  const found: Found[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const l of LOOKUPS) {
    if (only && l.id !== only) continue;
    if (found.length >= count) break;
    const key = l.needsKey ? keys[l.needsKey] ?? "" : "";
    if (l.needsKey && !key) {
      // Silent when merely skipping in auto mode; loud when it was asked for by name.
      if (only) notes.push(`${l.id} needs a free API key in ${l.needsKey}, which is not set.`);
      continue;
    }
    try {
      const { url, headers } = l.request(query, count, key);
      const res = await fetch(url, { method: "GET", timeoutMs: 10_000, ...(headers ? { headers } : {}) });
      if (!res.ok) { notes.push(`${l.id} answered HTTP ${res.status}.`); continue; }
      for (const f of l.parse(await res.json())) {
        if (found.length >= count) break;
        // A literal ( or ) in the address would end `![caption](address)` early.
        const url = f.url.replace(/\(/g, "%28").replace(/\)/g, "%29");
        if (seen.has(url)) continue;
        seen.add(url);
        found.push({ ...f, url });
      }
    } catch {
      notes.push(`${l.id} could not be reached.`);
    }
  }
  return { found, notes };
}

/** What the agent reads: one block per picture, then how to use them. */
export function render(query: string, r: FindResult): string {
  if (r.found.length === 0) {
    return `No pictures found for "${query}".${r.notes.length ? ` ${r.notes.join(" ")}` : ""} Try a simpler or more general query (a place, an animal, an object).`;
  }
  const lines = r.found.map((f, i) =>
    `${i + 1}. ${f.title}\n   ${f.url}\n   Credit: ${f.credit} (${f.source}), page: ${f.page}`);
  return [
    `${r.found.length} picture${r.found.length === 1 ? "" : "s"} for "${query}":`,
    ...lines,
    "Use one as ![short caption](address) under the section it belongs to, and keep its Credit in the caption. Use only these addresses; never invent one.",
    ...(r.notes.length ? [r.notes.join(" ")] : []),
  ].join("\n");
}

export function createFindImagesTool(): Tool {
  const manifest: ToolManifest = {
    name: "find_images",
    description:
      "Find real photos on the web for a plan, guide or card: https addresses with credit and licence, from " +
      "Openverse, Wikimedia Commons, iNaturalist (and Pexels, Unsplash when a key is set). " +
      "Put one in an artifact as ![caption](address) under its section and keep the credit.",
    permissions: ["network:outbound"],
    networkAccess: true,
    allowedDomains: LOOKUPS.map((l) => l.host),
  };

  return {
    manifest,
    parameters: {
      query: { type: "string", description: "What the picture shows, in a few plain words: a place, an animal, an object.", required: true },
      count: { type: "number", description: "How many pictures (1-8, default 4).", required: false },
      source: {
        type: "string",
        description: "Optional: ask one library by name. Omit to try them all in order.",
        required: false,
        schema: { type: "string", enum: [...SOURCES] },
      },
    },
    async execute(args, ctx) {
      const query = str(args.query);
      if (!query) return { ok: false, content: "find_images requires a non-empty 'query'.", error: "bad_args" };
      const count = typeof args.count === "number" && Number.isFinite(args.count) ? Math.min(8, Math.max(1, Math.round(args.count))) : 4;
      const only = (SOURCES as readonly string[]).includes(args.source as string) ? (args.source as Source) : undefined;
      const result = await findImages(ctx.fetch, query, count, only, {
        CINDERPAW_PEXELS_KEY: readEnv("CINDERPAW_PEXELS_KEY"),
        CINDERPAW_UNSPLASH_KEY: readEnv("CINDERPAW_UNSPLASH_KEY"),
      });
      return {
        ok: result.found.length > 0,
        content: guardWebText(render(query, result), "find_images", ctx?.sessionId),
        ...(result.found.length > 0 ? { data: { count: result.found.length, query } } : { error: "no_results" }),
      };
    },
  };
}
