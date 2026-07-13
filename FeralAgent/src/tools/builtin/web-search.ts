/**
 * web_search — a network tool gated by the sandbox.
 *
 * Declares `network:outbound` with a tight domain whitelist. It never calls
 * fetch directly: it uses `ctx.fetch` (the per-tool feralFetch from the egress
 * proxy), which enforces the whitelist, blocks private/loopback destinations,
 * rate-limits, and audits every request.
 *
 * Backend: a SearXNG instance the user runs (`FERAL_SEARXNG_URL`). SearXNG is
 * a metasearch aggregator — it queries Google/Bing/DDG/etc. and returns ranked
 * results as JSON, with no API key and no per-query cost. Self-hosting also
 * keeps queries on the user's own machine, which is the whole point of a
 * local-first agent.
 *
 * Why not the previous backend: this tool used to call the DuckDuckGo *Instant
 * Answer* API, which is a disambiguation service, not a search index. It
 * returns nothing for most real queries ("who won the 2026 super bowl" → {}),
 * and worse, it returned that emptiness as a SUCCESS — so the declared
 * fallback chain never fired and the model quietly answered from stale
 * training data. Both halves of that bug are fixed here: a real index, and an
 * empty result set is an honest failure.
 *
 * The DDG endpoint is kept as a last-resort safety net for the no-SearXNG
 * case, but it is never treated as a working search engine.
 */

import type { Tool, ToolManifest } from "../../types.ts";

const DDG_DOMAINS = ["duckduckgo.com", "api.duckduckgo.com"];

/** How to tell the user to get real search. Repeated in every failure path —
 *  a dead search tool that doesn't say WHY is the thing that wastes an hour. */
const SETUP_HINT =
  "web_search has no search backend configured. Run a SearXNG instance and " +
  "point FERAL_SEARXNG_URL at it (e.g. http://127.0.0.1:8888) — it is free, " +
  "needs no API key, and keeps queries on this machine. " +
  "See docs/CONFIGURATION.md.";

export interface WebSearchOpts {
  /** Origin of the operator's SearXNG instance, or null when unset.
   *  Comes from `searxngOrigin()` — already validated to be a bare origin. */
  searxngOrigin?: string | null;
}

export function createWebSearchTool(opts: WebSearchOpts = {}): Tool {
  const origin = opts.searxngOrigin ?? null;
  const searxHost = origin ? new URL(origin).hostname : null;

  const manifest: ToolManifest = {
    name: "web_search",
    description:
      "Search the web and return ranked results (title, URL, snippet). Use for " +
      "anything current, factual, or outside your training data. Follow up with " +
      "read_webpage on a result URL when you need the full page.",
    permissions: ["network:outbound"],
    networkAccess: true,
    // Only the configured SearXNG host is whitelisted — plus DDG for the
    // degraded no-backend path. The egress proxy still validates every hop.
    allowedDomains: searxHost ? [searxHost, ...DDG_DOMAINS] : DDG_DOMAINS,
    // If search yields nothing (or no backend is configured), escalate to
    // deep_research, which does multi-page synthesis via its own backend.
    fallback: ["deep_research"],
  };

  return {
    manifest,
    parameters: {
      query: {
        type: "string",
        description: "The search query.",
        required: true,
      },
    },
    async execute(args, ctx) {
      const query = args.query;
      if (typeof query !== "string" || !query.trim()) {
        return {
          ok: false,
          content: "web_search requires a non-empty 'query' string.",
          error: "bad_args",
        };
      }

      if (!origin) {
        // No index configured. Try DDG's instant answer as a courtesy — it
        // occasionally has a definition — but never claim success on empty.
        const ia = await instantAnswer(query, ctx.fetch);
        if (ia.length > 0) return { ok: true, content: render(query, ia), data: ia };
        return { ok: false, content: SETUP_HINT, error: "no_backend" };
      }

      const url =
        `${origin}/search?q=${encodeURIComponent(query.trim())}` +
        `&format=json&safesearch=0`;

      let res: Awaited<ReturnType<typeof ctx.fetch>>;
      try {
        res = await ctx.fetch(url, { timeoutMs: 15_000 });
      } catch (err) {
        return {
          ok: false,
          content:
            `Could not reach the SearXNG instance at ${origin} ` +
            `(${err instanceof Error ? err.message : String(err)}). Is it running?`,
          error: "backend_unreachable",
        };
      }

      if (!res.ok) {
        // 403 on /search?format=json is the classic one: SearXNG ships with
        // the JSON format disabled. Name the fix instead of the status code.
        const hint =
          res.status === 403
            ? ` — SearXNG returns 403 for JSON when the format is not enabled. ` +
              `Add \`formats: [html, json]\` under \`search:\` in its settings.yml and restart it.`
            : "";
        return {
          ok: false,
          content: `SearXNG at ${origin} returned HTTP ${res.status}.${hint}`,
          error: "http_error",
        };
      }

      let body: SearxngResponse;
      try {
        body = (await res.json()) as SearxngResponse;
      } catch {
        return {
          ok: false,
          content:
            `SearXNG at ${origin} did not return JSON. Enable the JSON format ` +
            `(\`formats: [html, json]\` under \`search:\` in settings.yml) and restart it.`,
          error: "bad_response",
        };
      }

      const results: SearchResult[] = [];
      for (const r of body.results ?? []) {
        if (results.length >= 8) break;
        if (typeof r?.url !== "string" || typeof r?.title !== "string") continue;
        const snippet = r.content?.trim();
        results.push({
          text: snippet ? `${r.title} — ${snippet}` : r.title,
          url: r.url,
        });
      }

      if (results.length === 0) {
        return {
          ok: false,
          content: `No results for "${query}".`,
          error: "no_results",
        };
      }

      return { ok: true, content: render(query, results), data: results };
    },
  };
}

interface SearxngResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

interface SearchResult {
  text: string;
  url?: string;
}

/** DuckDuckGo Instant Answer — the degraded path only. Returns [] far more
 *  often than not; callers must treat [] as a failure, never an empty win. */
async function instantAnswer(
  query: string,
  fetch: (url: string, init?: { timeoutMs?: number }) => Promise<{ ok: boolean; json(): Promise<unknown> }>,
): Promise<SearchResult[]> {
  try {
    const url =
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}` +
      `&format=json&no_html=1&no_redirect=1&skip_disambig=1`;
    const res = await fetch(url, { timeoutMs: 12_000 });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Answer?: string;
      Definition?: string;
    };
    const headline = body.Answer || body.AbstractText || body.Definition;
    return headline ? [{ text: headline, url: body.AbstractURL }] : [];
  } catch {
    return [];
  }
}

function render(query: string, results: SearchResult[]): string {
  const lines = results.map((r, i) =>
    r.url ? `${i + 1}. ${r.text}\n   ${r.url}` : `${i + 1}. ${r.text}`,
  );
  return `Results for "${query}":\n${lines.join("\n")}`;
}
