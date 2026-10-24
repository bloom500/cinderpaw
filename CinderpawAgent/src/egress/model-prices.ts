/**
 * Real list prices for cloud models, so a weekly limit of $5 means $5.
 *
 * Without them every cloud route was charged UNKNOWN_CLOUD_PRICE ($15/$75 per
 * million), about 100x what Haiku costs, and a $5 task limit stopped after ~7
 * steps. OpenRouter publishes per-token prices for the ~450 models it routes,
 * with no key and no user data; the frontend already reads the same list for
 * context windows (lib/modelCatalog.ts).
 *
 * Matching is exact after spelling cleanup (vendor from the API host, dots and
 * dashes treated alike, a trailing date dropped), never a substring guess. No
 * match, or no catalog yet (offline), falls back to the base resolver, which
 * charges the dear price, so a limit still holds.
 */
import type { InferencePrice, SpendTarget } from "./inference-spend-authority.ts";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const MAX_AGE_MS = 24 * 3_600_000;

const VENDOR_BY_HOST: Record<string, string> = {
  "api.anthropic.com": "anthropic",
  "api.openai.com": "openai",
  "generativelanguage.googleapis.com": "google",
  "api.x.ai": "x-ai",
  "api.deepseek.com": "deepseek",
  "api.mistral.ai": "mistralai",
  "api.moonshot.ai": "moonshotai",
  "api.moonshot.cn": "moonshotai",
};

let prices = new Map<string, InferencePrice>();
let fetchedAt = 0;

const clean = (id: string) => id.trim().toLowerCase().replace(/[._]/g, "-").replace(/-\d{8}$/, "");

function keyFor(target: SpendTarget): string | null {
  let host: string;
  try { host = new URL(target.baseUrl).hostname; } catch { return null; }
  if (host === "openrouter.ai") return clean(target.model);
  const vendor = VENDOR_BY_HOST[host];
  return vendor ? `${vendor}/${clean(target.model)}` : null;
}

/** Parse OpenRouter's /models body. Exported for the test. */
export function loadModelPrices(body: unknown, at = Date.now()): number {
  const rows = (body as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return 0;
  const next = new Map<string, InferencePrice>();
  for (const row of rows as Array<{ id?: unknown; pricing?: Record<string, unknown> }>) {
    const p = row?.pricing;
    const input = Number(p?.prompt), output = Number(p?.completion);
    if (typeof row?.id !== "string" || !(input >= 0) || !(output >= 0)) continue;
    const read = Number(p?.input_cache_read), write = Number(p?.input_cache_write);
    next.set(clean(row.id), {
      inputPerMillionUsd: input * 1e6,
      outputPerMillionUsd: output * 1e6,
      ...(read >= 0 ? { cacheReadPerMillionUsd: read * 1e6 } : {}),
      ...(write >= 0 ? { cacheWritePerMillionUsd: write * 1e6 } : {}),
    });
  }
  if (next.size) { prices = next; fetchedAt = at; }
  return next.size;
}

/** At most once a day, and only when a scheduled agent task is about to run. */
export async function refreshModelPrices(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (Date.now() - fetchedAt < MAX_AGE_MS) return;
  try {
    const res = await fetchImpl(CATALOG_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) loadModelPrices(await res.json());
  } catch { /* offline: the base resolver's dear price still holds the limit */ }
}

export function withModelPrices(base: (t: SpendTarget) => InferencePrice | null): (t: SpendTarget) => InferencePrice | null {
  return (target) => {
    const key = keyFor(target);
    // A local route stays free. ponytail: the list also beats an operator's
    // CINDERPAW_AUTONOMOUS_PRICING_JSON row; make base say "no row" if that matters.
    const own = base(target);
    if (own && own.inputPerMillionUsd === 0 && own.outputPerMillionUsd === 0) return own;
    return (key && prices.get(key)) || own;
  };
}
