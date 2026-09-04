/**
 * fetch_url — generic HTTP GET inside the sandbox egress proxy.
 *
 * Requires `network:outbound` with an explicit domain allowlist. All requests
 * go through `ctx.fetch` (cinderpawFetch), which validates the domain, blocks SSRF,
 * rate-limits, and audits every call.
 *
 * Returns the response body as text, truncated to 32 KB to keep the context
 * window bounded. The caller (agent) decides what to do with the content.
 */

import type { Tool, ToolManifest } from "../../types.ts";

const MAX_RESPONSE_CHARS = 32_768;

export function createFetchUrlTool(allowedDomains: string[]): Tool {
  const manifest: ToolManifest = {
    name: "fetch_url",
    description:
      "Fetch the content of a URL (HTTP GET). Any public HTTPS URL works " +
      "(internal/private addresses are blocked). Returns the response body as text.",
    permissions: ["network:outbound"],
    networkAccess: true,
    allowedDomains,
  };

  return {
    manifest,
    parameters: {
      url: {
        type: "string",
        description: "The URL to fetch (must be HTTPS; public hosts only).",
        required: true,
      },
    },
    async execute(args, ctx) {
      const url = args.url;
      if (typeof url !== "string" || !url.trim()) {
        return { ok: false, content: "fetch_url requires a non-empty 'url' string.", error: "bad_args" };
      }
      if (!url.startsWith("https://")) {
        return { ok: false, content: "fetch_url only supports HTTPS URLs.", error: "bad_scheme" };
      }

      const res = await ctx.fetch(url, {
        method: "GET",
        timeoutMs: 15_000,
      });

      if (!res.ok) {
        return {
          ok: false,
          content: `HTTP ${res.status} from ${url}`,
          error: "http_error",
        };
      }

      const text = await res.text();
      const truncated = text.length > MAX_RESPONSE_CHARS;
      const body = truncated ? text.slice(0, MAX_RESPONSE_CHARS) + "\n\n[truncated]" : text;

      return {
        ok: true,
        content: body,
        data: {
          url,
          status: res.status,
          truncated,
          chars: text.length,
        },
      };
    },
  };
}
