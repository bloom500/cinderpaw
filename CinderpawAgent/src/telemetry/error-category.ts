/** Where a turn failed, from the error text. A fixed list so it can be counted. */
export type ErrorCategory =
  | "network" | "auth" | "billing" | "rate_limit"
  | "context_overflow" | "provider_error" | "tool_error" | "other";

export const ERROR_CATEGORIES: readonly ErrorCategory[] = [
  "network", "auth", "billing", "rate_limit", "context_overflow", "provider_error", "tool_error", "other",
];

// Order matters: an auth error often also says "request failed", so the
// specific shapes are tested before the generic network ones.
// ponytail: regexes over free text; a structured error code from each adapter is the upgrade.
export function classifyError(text: string): ErrorCategory {
  const t = text.toLowerCase();
  if (/\b(401|403)\b|unauthori[sz]ed|invalid api key|forbidden|authentication/.test(t)) return "auth";
  if (/\b402\b|insufficient (credit|balance|funds)|payment required|billing/.test(t)) return "billing";
  if (/\b429\b|rate.?limit|too many requests/.test(t)) return "rate_limit";
  if (/context (length|window)|maximum context|too many tokens|prompt is too long|does not fit/.test(t)) return "context_overflow";
  if (/\b50[0-9]\b|bad gateway|service unavailable|overloaded|internal server error/.test(t)) return "provider_error";
  if (/econn|enotfound|etimedout|fetch failed|network|socket hang up|timed out/.test(t)) return "network";
  if (/\btool\b/.test(t)) return "tool_error";
  return "other";
}
