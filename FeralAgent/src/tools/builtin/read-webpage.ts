/**
 * read_webpage — extracts clean markdown from any public URL via Jina Reader.
 *
 * Routes all requests through r.jina.ai (Jina Reader proxy), which handles
 * JavaScript rendering, cookie walls, and HTML-to-markdown conversion server-side.
 * No API key required for basic use; set FERAL_JINA_API_KEY for higher rate limits.
 *
 * All network access goes through ctx.fetch (the egress proxy), which enforces
 * the domain allowlist, blocks SSRF, and audits every request.
 */

import type { Tool, ToolManifest } from "../../types.ts";

const MAX_CHARS = 50_000;

export function createReadWebpageTool(jinaApiKey?: string): Tool {
  const manifest: ToolManifest = {
    name: "read_webpage",
    description:
      "Read and extract clean text content from any public webpage. " +
      "Returns the page content as markdown. Use this to read articles, " +
      "documentation, or any URL returned from web_search.",
    permissions: ["network:outbound"],
    networkAccess: true,
    allowedDomains: ["r.jina.ai"],
  };

  return {
    manifest,
    parameters: {
      url: {
        type: "string",
        description: "The full URL of the webpage to read (http or https).",
        required: true,
      },
    },
    async execute(args, ctx) {
      const url = args.url;
      if (typeof url !== "string" || !url.trim()) {
        return {
          ok: false,
          content: "read_webpage requires a non-empty 'url' string.",
          error: "bad_args",
        };
      }
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return {
          ok: false,
          content: "read_webpage only supports http and https URLs.",
          error: "bad_scheme",
        };
      }

      const jinaUrl = `https://r.jina.ai/${url}`;
      const headers: Record<string, string> = { Accept: "text/plain" };
      if (jinaApiKey) headers["Authorization"] = `Bearer ${jinaApiKey}`;

      // 60s: Jina Reader renders heavy/JS pages server-side and regularly
      // needs more than 30s for them — observed timeouts at the old limit.
      const res = await ctx.fetch(jinaUrl, { timeoutMs: 60_000, headers });
      if (!res.ok) {
        return {
          ok: false,
          content: `Failed to read page — HTTP ${res.status}.`,
          error: "http_error",
        };
      }

      const text = await res.text();
      const truncated = text.length > MAX_CHARS;
      const content = truncated
        ? text.slice(0, MAX_CHARS) + "\n\n[content truncated]"
        : text;

      return {
        ok: true,
        content,
        data: { url, truncated, chars: text.length },
      };
    },
  };
}
