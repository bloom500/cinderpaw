/**
 * Cost primitives for bounded autonomous inference.
 *
 * Cloud authorization never guesses from a model-name substring. Operators
 * provide exact provider/model/baseUrl tuples with split rates through
 * FERAL_AUTONOMOUS_PRICING_JSON; routes not present in that catalog fail
 * closed. Loopback inference is always free.
 */

import type {
  InferencePrice,
  SpendTarget,
} from "../../egress/inference-spend-authority.ts";

/** Conservative display-only fallback used by legacy, non-authorizing stats. */
const DEFAULT_CLOUD_PRICE_PER_1K = 0.01;

interface PricingEntry extends InferencePrice {
  provider: string;
  model: string;
  baseUrl: string;
}

export type InferencePriceResolver = (target: SpendTarget) => InferencePrice | null;

/**
 * Parse an operator-owned exact-route catalog once at boot. Malformed JSON or
 * malformed entries produce an empty resolver, keeping autonomous cloud work
 * fail-closed rather than partially trusting a damaged price list.
 */
export function priceResolverFromJson(raw: string | null | undefined): InferencePriceResolver {
  if (!raw?.trim()) return (target) => localPrice(target);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return (target) => localPrice(target);
  }
  if (!Array.isArray(parsed)) return (target) => localPrice(target);

  const entries: PricingEntry[] = [];
  for (const value of parsed) {
    const entry = parseEntry(value);
    if (!entry) return (target) => localPrice(target);
    entries.push(entry);
  }

  const byRoute = new Map(entries.map((entry) => [routeKey(entry), entry]));
  return (target) => {
    const local = localPrice(target);
    if (local) return local;
    const entry = byRoute.get(routeKey(target));
    if (!entry) return null;
    return {
      inputPerMillionUsd: entry.inputPerMillionUsd,
      outputPerMillionUsd: entry.outputPerMillionUsd,
      ...(entry.cacheReadPerMillionUsd !== undefined
        ? { cacheReadPerMillionUsd: entry.cacheReadPerMillionUsd }
        : {}),
      ...(entry.cacheWritePerMillionUsd !== undefined
        ? { cacheWritePerMillionUsd: entry.cacheWritePerMillionUsd }
        : {}),
    };
  };
}

function parseEntry(value: unknown): PricingEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.provider !== "string" ||
    typeof row.model !== "string" ||
    typeof row.baseUrl !== "string" ||
    !validRate(row.inputPerMillionUsd) ||
    !validRate(row.outputPerMillionUsd) ||
    !optionalRate(row.cacheReadPerMillionUsd) ||
    !optionalRate(row.cacheWritePerMillionUsd)
  ) return null;
  return {
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl,
    inputPerMillionUsd: row.inputPerMillionUsd,
    outputPerMillionUsd: row.outputPerMillionUsd,
    ...(row.cacheReadPerMillionUsd !== undefined
      ? { cacheReadPerMillionUsd: row.cacheReadPerMillionUsd }
      : {}),
    ...(row.cacheWritePerMillionUsd !== undefined
      ? { cacheWritePerMillionUsd: row.cacheWritePerMillionUsd }
      : {}),
  };
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalRate(value: unknown): value is number | undefined {
  return value === undefined || validRate(value);
}

function localPrice(target: SpendTarget): InferencePrice | null {
  try {
    const host = new URL(target.baseUrl).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
      return { inputPerMillionUsd: 0, outputPerMillionUsd: 0 };
    }
  } catch {
    // Invalid cloud-looking URLs are unknown, never free.
  }
  return null;
}

function routeKey(target: Pick<SpendTarget, "provider" | "model" | "baseUrl">): string {
  return [
    target.provider.trim().toLowerCase().replace(/[-_]/g, ""),
    target.model.trim(),
    normalizeBaseUrl(target.baseUrl),
  ].join("\u0000");
}

function normalizeBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.trim().replace(/\/$/, "");
  }
}

/** Display-only blended fallback retained for legacy GoalMode telemetry. */
export function blendedPricePer1kUsd(_modelId: string, isLoopback: boolean): number {
  return isLoopback ? 0 : DEFAULT_CLOUD_PRICE_PER_1K;
}

/** Estimated USD for display-only legacy token totals. */
export function estimateUsd(totalTokens: number, pricePer1kUsd: number): number {
  if (!(totalTokens > 0) || !(pricePer1kUsd > 0)) return 0;
  return (totalTokens / 1000) * pricePer1kUsd;
}
