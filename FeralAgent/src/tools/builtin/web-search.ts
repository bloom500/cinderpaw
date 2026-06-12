/**
 * web_search — a network tool gated by the sandbox.
 *
 * Declares `network:outbound` with a tight domain whitelist. It never calls
 * fetch directly: it uses `ctx.fetch` (the per-tool feralFetch from the egress
 * proxy), which enforces the whitelist, blocks private/loopback destinations,
 * rate-limits, and audits every request.
 *
 * Backed by the DuckDuckGo Instant Answer API, which needs no API key — a good
 * fit for a local-first agent.
 */

import type { Tool, ToolManifest } from "../../types.ts";

const ALLOWED_DOMAINS = ["duckduckgo.com", "api.duckduckgo.com"];

export function createWebSearchTool(): Tool {
  const manifest: ToolManifest = {
    name: "web_search",
    description:
      "Search the web for a short factual answer and related topics.",
    permissions: ["network:outbound"],
    networkAccess: true,
    allowedDomains: ALLOWED_DOMAINS,
    // Feral-WIP #2: if DuckDuckGo returns no results or fails, escalate
    // to deep_research (which uses Jina + multi-page synthesis) so the
    // model always gets *something* for a web query.
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

      const url =
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}` +
        `&format=json&no_html=1&no_redirect=1&skip_disambig=1`;

      const res = await ctx.fetch(url, { timeoutMs: 12_000 });
      if (!res.ok) {
        return {
          ok: false,
          content: `Search failed with HTTP ${res.status}.`,
          error: "http_error",
        };
      }

      const body = (await res.json()) as DuckDuckGoResponse;
      const summary = summarize(query, body);

      return {
        ok: true,
        content: summary.text,
        data: summary.results,
      };
    },
  };
}

interface DuckDuckGoResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  Answer?: string;
  Definition?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string } | unknown>;
}

interface SearchResult {
  text: string;
  url?: string;
}

function summarize(
  query: string,
  body: DuckDuckGoResponse,
): { text: string; results: SearchResult[] } {
  const results: SearchResult[] = [];

  const headline = body.Answer || body.AbstractText || body.Definition;
  if (headline) {
    results.push({ text: headline, url: body.AbstractURL });
  }

  for (const topic of body.RelatedTopics ?? []) {
    if (results.length >= 5) break;
    if (
      typeof topic === "object" &&
      topic !== null &&
      "Text" in topic &&
      typeof (topic as { Text?: unknown }).Text === "string"
    ) {
      const t = topic as { Text: string; FirstURL?: string };
      results.push({ text: t.Text, url: t.FirstURL });
    }
  }

  if (results.length === 0) {
    return {
      text: `No instant answer found for "${query}".`,
      results,
    };
  }

  const lines = results.map((r, i) =>
    r.url ? `${i + 1}. ${r.text} (${r.url})` : `${i + 1}. ${r.text}`,
  );
  return { text: `Results for "${query}":\n${lines.join("\n")}`, results };
}
