import { createHash } from "node:crypto";
import { htmlToText } from "../tools/builtin/fetch-url.ts";
import type { CinderpawFetch, CronRunRecord, WatchCondition } from "../types.ts";

const NON_CONTENT = new Set(["head", "script", "style", "noscript", "template", "svg"]);

/** Exclude explicitly hidden subtrees with Bun's HTML parser, including nested
 * same-name tags. This reads static source text: external CSS, layout and
 * JavaScript visibility are not evaluated and require browser verification. */
function watchPageText(html: string): string {
  const stripped = new HTMLRewriter().on("*", {
    element(element) {
      const style = (element.getAttribute("style") ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
      const hiddenStyle = /(?:^|;)\s*(?:display\s*:\s*none|(?:content-)?visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0*)?)\s*(?:!\s*important\s*)?(?:;|$)/i.test(style);
      if (NON_CONTENT.has(element.tagName) || element.hasAttribute("hidden") || element.hasAttribute("inert") || element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true" || hiddenStyle) {
        element.remove();
      }
    },
  }).transform(html);
  return htmlToText(stripped);
}

/** No model participates in proof: it is an exact match in a fresh HTTP body.
 * The bound egress fetch checks DNS, redirects, allowlist and body limits. */
export async function verifyWatch(watch: WatchCondition, fetch: CinderpawFetch, checkedAt: number): Promise<CronRunRecord["proof"] | undefined> {
  const response = await fetch(watch.sourceUrl, { method: "GET", timeoutMs: 15000, headers: { "cache-control": "no-cache" } });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  const raw = await response.text();
  const isHtml = /html/i.test(response.headers["content-type"] ?? "") || /^\s*<(?:!doctype|html)\b/i.test(raw);
  const text = (isHtml ? watchPageText(raw) : raw).replace(/\s+/g, " ").trim();
  const needle = watch.contains.replace(/\s+/g, " ").trim();
  const index = text.toLocaleLowerCase("en-US").indexOf(needle.toLocaleLowerCase("en-US"));
  if (index < 0) return undefined;
  return { sourceUrl: watch.sourceUrl, checkedAt, excerpt: text.slice(Math.max(0, index - 100), index + needle.length + 100), contentHash: createHash("sha256").update(text).digest("hex") };
}
