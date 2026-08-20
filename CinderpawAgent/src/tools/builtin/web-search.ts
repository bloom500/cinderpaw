/**
 * web_search — a network tool gated by the sandbox.
 *
 * Declares `network:outbound` with a tight domain whitelist. It never calls
 * fetch directly: it uses `ctx.fetch` (the per-tool feralFetch from the egress
 * proxy), which enforces the whitelist, blocks private/loopback destinations,
 * rate-limits, and audits every request.
 *
 * Two backends, in preference order:
 *   1. a SearXNG instance the user runs (`FERAL_SEARXNG_URL`) — a metasearch
 *      aggregator over Google/Bing/DDG/etc., and the queries never leave the
 *      user's machine, which is the whole point of a local-first agent;
 *   2. DuckDuckGo Lite (see ddg-lite.ts) — keyless, zero setup, so search works
 *      on a default install. Also the fallback when a configured SearXNG is
 *      down, in which case the result says so rather than hiding it.
 *
 * Neither one may report emptiness as success. That was the original bug here:
 * the tool called DuckDuckGo's *Instant Answer* API — a disambiguation service,
 * not a search index, which returns `{}` for most real queries — and returned
 * that as `ok: true`. The declared fallback chain never fired and the model
 * quietly answered from stale training data. An empty result set is a FAILURE.
 */

import type { Tool, ToolManifest } from "../../types.ts";
import { DDG_DOMAIN, DDG_THROTTLED_HINT, ddgLiteSearch, type DdgResult } from "./ddg-lite.ts";

/** Offered only when the fallback ALSO came up empty — a working default
 *  install should never be told to go install something. */
const SETUP_HINT =
  " For better results (several engines, and queries that never leave this " +
  "machine), run a SearXNG instance and point FERAL_SEARXNG_URL at it — " +
  "free, no API key. See docs/CONFIGURATION.md.";

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
    // keyless fallback. The egress proxy still validates every hop.
    allowedDomains: searxHost ? [searxHost, DDG_DOMAIN] : [DDG_DOMAIN],
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
        // No SearXNG configured — the default install. DDG Lite is a real
        // index, so this path returns real results; empty still means failed.
        const { results: hits, throttled } = await ddgLiteSearch(ctx.fetch, query, {
          signal: ctx.signal,
        });
        if (hits.length > 0) return { ok: true, content: render(query, toResults(hits)), data: hits };
        return throttled
          ? { ok: false, content: DDG_THROTTLED_HINT, error: "rate_limited" }
          : {
              ok: false,
              content: `No results for "${query}" (DuckDuckGo).${SETUP_HINT}`,
              error: "no_results",
            };
      }

      // A configured-but-broken SearXNG used to mean no search at all. Now it
      // degrades to DDG and SAYS SO — a working search plus a visible warning
      // beats a dead tool, and staying silent about it would train the user to
      // ignore a backend that has been down for a week.
      const degrade = async (why: string, error: string) => {
        const { results: hits, throttled } = await ddgLiteSearch(ctx.fetch, query, {
          signal: ctx.signal,
        });
        if (hits.length === 0) {
          return {
            ok: false as const,
            content: throttled ? `${why}\n\n${DDG_THROTTLED_HINT}` : why,
            error,
          };
        }
        return {
          ok: true as const,
          content: `[web_search fell back to DuckDuckGo — ${why}]\n\n${render(query, toResults(hits))}`,
          data: hits,
        };
      };

      const url =
        `${origin}/search?q=${encodeURIComponent(query.trim())}` +
        `&format=json&safesearch=0`;

      let res: Awaited<ReturnType<typeof ctx.fetch>>;
      try {
        res = await ctx.fetch(url, { timeoutMs: 15_000 });
      } catch (err) {
        return degrade(
          `could not reach the SearXNG instance at ${origin} ` +
            `(${err instanceof Error ? err.message : String(err)}). Is it running?`,
          "backend_unreachable",
        );
      }

      if (!res.ok) {
        // 403 on /search?format=json is the classic one: SearXNG ships with
        // the JSON format disabled. Name the fix instead of the status code.
        const hint =
          res.status === 403
            ? ` — SearXNG returns 403 for JSON when the format is not enabled. ` +
              `Add \`formats: [html, json]\` under \`search:\` in its settings.yml and restart it.`
            : "";
        return degrade(`SearXNG at ${origin} returned HTTP ${res.status}.${hint}`, "http_error");
      }

      let body: SearxngResponse;
      try {
        body = (await res.json()) as SearxngResponse;
      } catch {
        return degrade(
          `SearXNG at ${origin} did not return JSON. Enable the JSON format ` +
            `(\`formats: [html, json]\` under \`search:\` in settings.yml) and restart it.`,
          "bad_response",
        );
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

/** DDG results into the same shape SearXNG results render through. */
function toResults(hits: DdgResult[]): SearchResult[] {
  return hits.map((h) => ({
    text: h.snippet ? `${h.title} — ${h.snippet}` : h.title,
    url: h.url,
  }));
}

function render(query: string, results: SearchResult[]): string {
  const lines = results.map((r, i) =>
    r.url ? `${i + 1}. ${r.text}\n   ${r.url}` : `${i + 1}. ${r.text}`,
  );
  return `Results for "${query}":\n${lines.join("\n")}`;
}
