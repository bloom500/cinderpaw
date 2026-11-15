import { createHash } from "node:crypto";
import { htmlToText } from "../tools/builtin/fetch-url.ts";
import type { CinderpawFetch, CronRunRecord, WatchCondition } from "../types.ts";

type Proof = NonNullable<CronRunRecord["proof"]>;
type TextWatch = Extract<WatchCondition, { contains: string }>;
type PriceWatch = Extract<WatchCondition, { priceBelow: number }>;

const NON_CONTENT = new Set(["head", "script", "style", "noscript", "template", "svg"]);

export const isPriceWatch = (w: WatchCondition): w is PriceWatch => "priceBelow" in w;

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

async function fetchPage(url: string, fetch: CinderpawFetch): Promise<{ raw: string; isHtml: boolean }> {
  const response = await fetch(url, { method: "GET", timeoutMs: 15000, headers: { "cache-control": "no-cache" } });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  const raw = await response.text();
  return { raw, isHtml: /html/i.test(response.headers["content-type"] ?? "") || /^\s*<(?:!doctype|html)\b/i.test(raw) };
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** No model participates in proof: it is an exact match in a fresh HTTP body.
 * The bound egress fetch checks DNS, redirects, allowlist and body limits. */
export async function verifyWatch(watch: TextWatch, fetch: CinderpawFetch, checkedAt: number): Promise<Proof | undefined> {
  const { raw, isHtml } = await fetchPage(watch.sourceUrl, fetch);
  const text = (isHtml ? watchPageText(raw) : raw).replace(/\s+/g, " ").trim();
  const needle = watch.contains.replace(/\s+/g, " ").trim();
  const index = text.toLocaleLowerCase("en-US").indexOf(needle.toLocaleLowerCase("en-US"));
  if (index < 0) return undefined;
  return { sourceUrl: watch.sourceUrl, checkedAt, excerpt: text.slice(Math.max(0, index - 100), index + needle.length + 100), contentHash: hash(text) };
}

// --- Price watches (spec 4.10) ---------------------------------------------

export interface PriceRead { amount: number; currency?: string }

/** Said to the person, at creation time and when an hourly check cannot read. */
export const NO_PRICE = "I could not read a price on this page. Some shops show the price only after the page loads in a browser, and I cannot read those yet.";

function amountOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s/g, "");
  // Structured data uses a dot; "1799,99" is the one other shape seen. "1,799.99" loses its commas.
  const n = Number(/^\d+,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const currencyOf = (v: unknown) => (typeof v === "string" && /^[A-Z]{3}$/.test(v.trim()) ? v.trim() : undefined);

function fromOffers(offers: unknown): PriceRead | null {
  for (const o of [offers].flat() as Array<Record<string, unknown> | null>) {
    if (!o || typeof o !== "object") continue;
    const spec = (o.priceSpecification ?? null) as Record<string, unknown> | null;
    const amount = amountOf(o.price) ?? amountOf(o.lowPrice) ?? amountOf(spec?.price);
    if (amount) return { amount, currency: currencyOf(o.priceCurrency) ?? currencyOf(spec?.priceCurrency) };
  }
  return null;
}

function fromJsonLd(node: unknown, depth = 0): PriceRead | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const hit = fromJsonLd(n, depth + 1); if (hit) return hit; }
    return null;
  }
  const o = node as Record<string, unknown>;
  const types = [o["@type"]].flat().map(String);
  if (types.some((t) => t === "Product" || t === "ProductGroup") && o.offers) {
    const hit = fromOffers(o.offers);
    if (hit) return hit;
  }
  return fromJsonLd(o["@graph"], depth + 1);
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);
}

/**
 * The price the page itself declares for search engines, in this order:
 * JSON-LD Product offers, then `product:price:amount` / `og:price:amount`
 * meta tags, then schema.org microdata `itemprop="price"` with a `content`
 * attribute (Thomann, 15 Nov probe). Never guessed from visible text.
 */
export function readPrice(html: string): PriceRead | null {
  for (const m of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const hit = fromJsonLd(JSON.parse(m[1]!.trim())); if (hit) return hit; } catch { /* broken JSON-LD: next block */ }
  }
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const meta = (keys: string[]) => metas.find((t) => keys.includes((attr(t, "property") ?? attr(t, "name") ?? "").toLowerCase()));
  const metaPrice = meta(["product:price:amount", "og:price:amount"]);
  const amount = metaPrice ? amountOf(attr(metaPrice, "content")) : null;
  if (amount) {
    const cur = meta(["product:price:currency", "og:price:currency"]);
    return { amount, currency: currencyOf(cur && attr(cur, "content")) };
  }
  const tags = [...html.matchAll(/<[a-z]+\b[^>]*\sitemprop\s*=\s*["'](?:price|priceCurrency)["'][^>]*>/gi)].map((m) => m[0]);
  const priceTag = tags.find((t) => attr(t, "itemprop") === "price");
  const micro = priceTag ? amountOf(attr(priceTag, "content")) : null;
  if (micro) {
    const cur = tags.find((t) => attr(t, "itemprop") === "priceCurrency");
    return { amount: micro, currency: currencyOf(cur && attr(cur, "content")) };
  }
  return null;
}

const money = (amount: number, currency?: string) => `${Number.isInteger(amount) ? amount : amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;

/** One read, failing closed with a sentence for the person. */
async function readWatchedPrice(watch: PriceWatch, fetch: CinderpawFetch): Promise<{ price: PriceRead; raw: string }> {
  const { raw } = await fetchPage(watch.sourceUrl, fetch);
  const price = readPrice(raw);
  if (!price) throw new Error(NO_PRICE);
  if (watch.currency && price.currency && watch.currency !== price.currency) {
    throw new Error(`This page now shows prices in ${price.currency}, not ${watch.currency}, so I cannot compare them.`);
  }
  return { price, raw };
}

/**
 * The read made when the person accepts a price watch (spec 4.10): what they
 * are told right away. `below`: the price is already under the limit, so there
 * is nothing to wait for and no watch is created.
 */
export async function firstPriceRead(watch: PriceWatch, fetch: CinderpawFetch): Promise<{ text: string; below: boolean }> {
  const { price } = await readWatchedPrice(watch, fetch);
  const cur = price.currency ?? watch.currency;
  const read = money(price.amount, cur);
  const limit = money(watch.priceBelow, cur);
  return price.amount < watch.priceBelow
    ? { text: `It is already under ${limit} today: I read ${read} on this page.`, below: true }
    : { text: `I read ${read} on this page today. I will tell you when it is under ${limit}.`, below: false };
}

/** One scheduled check of any watch: the proof on a hit, and the line for run history. */
export async function checkWatch(watch: WatchCondition, fetch: CinderpawFetch, checkedAt: number): Promise<{ proof?: Proof; result: string }> {
  if (!isPriceWatch(watch)) {
    const proof = await verifyWatch(watch, fetch, checkedAt);
    return { proof, result: proof ? `Verified on ${proof.sourceUrl}:\n“${proof.excerpt}”` : "Checked source; expected text is not present yet." };
  }
  const { price, raw } = await readWatchedPrice(watch, fetch);
  const cur = price.currency ?? watch.currency;
  const read = money(price.amount, cur);
  const limit = money(watch.priceBelow, cur);
  if (price.amount >= watch.priceBelow) return { result: `Read ${read}. Waiting for under ${limit}.` };
  return {
    proof: { sourceUrl: watch.sourceUrl, checkedAt, excerpt: `Price read: ${read} (your limit: under ${limit})`, contentHash: hash(raw), price: price.amount },
    result: `The price dropped to ${read}, under your ${limit}.\n${watch.sourceUrl}`,
  };
}
