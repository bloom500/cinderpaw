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
import { decodeEntities } from "./ddg-lite.ts";

const MAX_RESPONSE_CHARS = 32_768;

/**
 * A web page as the words on it.
 *
 * fetch_url returned pages as markup. A modern page's first 32 KB is its <head>:
 * inline CSS, preload links, JSON for its framework. On 17 Sep that was all the
 * agent got from openai.com, twice, and it lost the question it was answering.
 * Scripts, styles and the head go; block ends become line breaks; the title is
 * kept on top. A JSON or plain-text answer is left exactly as it came.
 */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = html
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|hr)\b[^>]*>|<\/(p|div|li|h[1-6]|tr|section|article|header|footer|ul|ol|table|blockquote|pre)>/gi, "\n")
    // Inline tags sit inside a sentence and leave nothing; any other tag (a
    // table cell, an image) separates words and leaves a space.
    .replace(/<\/?(a|span|strong|em|b|i|u|code|small|sup|sub|abbr|mark|time)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const heading = title ? decodeEntities(title).replace(/\s+/g, " ").trim() : "";
  return heading ? `${heading}\n\n${text}` : text;
}

function looksLikeHtml(text: string, contentType: string | undefined): boolean {
  if (contentType && /html/i.test(contentType)) return true;
  return /^\s*(<!doctype html|<html)/i.test(text.slice(0, 200));
}

export function createFetchUrlTool(allowedDomains: string[]): Tool {
  const manifest: ToolManifest = {
    name: "fetch_url",
    description:
      "Fetch the content of a URL (HTTP GET). Any public HTTPS URL works " +
      "(internal/private addresses are blocked). Returns a web page's visible text, " +
      "or any other response body as it came.",
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

      const raw = await res.text();
      const text = looksLikeHtml(raw, res.headers["content-type"]) ? htmlToText(raw) : raw;
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
