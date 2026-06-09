/**
 * http_request — generic HTTP method (the upgrade over `fetch_url` which is GET-only).
 *
 * Uses the sandbox's egress proxy (SSRF guard, domain whitelist, rate
 * limit) for all requests. Methods: GET, POST, PUT, PATCH, DELETE,
 * HEAD. `json` is a sugar for `Content-Type: application/json` +
 * `JSON.stringify(body)`.
 *
 * The allowedDomains are taken from the tool's manifest at registration
 * time; the caller cannot widen them. This keeps the egress proxy's
 * domain allowlist authoritative.
 */

import type { Tool, ToolManifest } from "../../types.ts";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

const VALID_METHODS: ReadonlySet<HttpMethod> = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD",
]);

const MAX_RESPONSE_BYTES = 256 * 1024; // 256 KB hard cap

export function createHttpRequestTool(allowedDomains: string[]): Tool {
  const manifest: ToolManifest = {
    name: "http_request",
    description:
      "Send an HTTP request through the sandboxed egress proxy (domain " +
      "whitelist, SSRF guard, rate-limited). Supports GET, POST, PUT, " +
      "PATCH, DELETE, HEAD. The response body is returned as text and " +
      "capped at 256 KB. Use `json` for a sugar that stringifies the " +
      "body and sets `Content-Type: application/json`.",
    permissions: ["network:outbound"],
    networkAccess: true,
    allowedDomains,
  };

  return {
    manifest,
    parameters: {
      method: {
        type: "string",
        description: "HTTP method. One of: GET (default), POST, PUT, PATCH, DELETE, HEAD.",
        required: false,
      },
      url: {
        type: "string",
        description: "Absolute URL. Must be HTTPS and on a domain the tool's manifest whitelists.",
        required: true,
      },
      headers: {
        type: "object",
        description: "Optional extra HTTP headers (string-to-string map).",
        required: false,
      },
      body: {
        type: "string",
        description: "Optional request body as a string. Ignored for GET/HEAD.",
        required: false,
      },
      json: {
        type: "object",
        description: "Optional JSON body (object). When set, `body` is ignored and Content-Type is set to application/json.",
        required: false,
      },
      timeout_ms: {
        type: "number",
        description: "Request timeout in milliseconds (default 15s).",
        required: false,
      },
    },
    async execute(args, ctx) {
      const url = args.url;
      if (typeof url !== "string" || !url.trim()) {
        return { ok: false, content: "http_request requires a non-empty 'url' string.", error: "bad_args" };
      }
      const methodRaw = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
      if (!VALID_METHODS.has(methodRaw as HttpMethod)) {
        return { ok: false, content: `http_request: invalid method "${methodRaw}".`, error: "bad_args" };
      }
      const method = methodRaw as HttpMethod;
      const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;

      // Build headers. The egress proxy will refuse disallowed schemes,
      // so we don't need to re-check here, but we DO need to refuse
      // file://, etc. on the agent's side for a clean error message.
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, content: `http_request only supports http(s) URLs.`, error: "bad_scheme" };
      }

      const headers: Record<string, string> = {};
      if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
        for (const [k, v] of Object.entries(args.headers)) {
          if (typeof v === "string") headers[k] = v;
        }
      }

      let body: string | undefined;
      if (args.json !== undefined && args.json !== null) {
        try {
          body = JSON.stringify(args.json);
        } catch (err) {
          return { ok: false, content: `http_request: cannot serialize json: ${String(err)}`, error: "bad_args" };
        }
        headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
      } else if (typeof args.body === "string") {
        body = args.body;
      }

      try {
        const res = await ctx.fetch(url, { method, headers, body, timeoutMs });
        const raw = await res.text();
        const truncated = raw.length > MAX_RESPONSE_BYTES;
        const text = truncated ? raw.slice(0, MAX_RESPONSE_BYTES) + "\n\n[response truncated at 256 KB]" : raw;
        return {
          ok: res.ok,
          content: `[${method} ${url} → ${res.status}]\n${text}`,
          data: {
            status: res.status,
            ok: res.ok,
            headers: res.headers,
            bodyBytes: raw.length,
            truncated,
          },
        };
      } catch (err) {
        return {
          ok: false,
          content: `http_request failed: ${String((err as Error).message ?? err)}`,
          error: "network_error",
        };
      }
    },
  };
}
