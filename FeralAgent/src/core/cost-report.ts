/**
 * Where the tokens went — read side of `completion_cost`.
 *
 * The whole file obeys one rule: **two accounts, reported separately, never
 * multiplied together.**
 *
 *   1. What WE sent, split by category, measured with our own tokenizer. This
 *      is attributable — we know exactly which bytes were the todo list.
 *   2. What the PROVIDER reported for the request as a whole: fresh, read from
 *      cache, written to cache, and what it charged as prompt tokens.
 *
 * The join between them does not exist and is not manufactured. Providers report
 * cache hits per REQUEST, never per message, so "how much of the tool output was
 * served from cache" is not a number anyone has. Scaling a per-request hit ratio
 * across the categories would produce one that looks authoritative and is
 * invented — and it would be invented in the direction that decides what gets
 * optimized next.
 *
 * So the report says two true things: "tool outputs are 61% of what we send" and
 * "74% of this request came from cache". It does not say "tool outputs were 74%
 * cached", because nobody knows that.
 *
 * The two totals will not match either. Ours is an approximate BPE count and the
 * provider's is authoritative; the gap is reported as a ratio rather than
 * absorbed by scaling one to the other.
 */

import type { Database } from "bun:sqlite";
import type { PromptPart } from "../memory/working.ts";

/** One lane of what we sent, summed over the window. */
export interface CategoryTotal {
  category: PromptPart["category"];
  detail: string;
  tokens: number;
  /** Share of what WE sent. Not a share of cost — see the file docstring. */
  shareOfSent: number;
}

/** What the providers said about the same window. Nothing here is attributable. */
export interface ProviderTotals {
  completions: number;
  promptTokens: number;
  completionTokens: number;
  /**
   * Null when NO completion in the window reported cache information — unknown,
   * not zero. A window mixing silent and reporting providers sums only the ones
   * that spoke, and `completionsReportingCache` says how many that was.
   */
  freshTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  completionsReportingCache: number;
  medianLatencyMs: number;
  /**
   * Completions whose token counts are OUR estimate because the provider
   * reported no usage. They are counted, never silently folded into the
   * provider's totals: an estimate presented as an authority is the failure
   * this column exists to make impossible.
   */
  completionsEstimated: number;
}

export interface CostReport {
  /** Account 1: ours, attributable, approximate. */
  sent: CategoryTotal[];
  localPromptTokens: number;
  /** Account 2: theirs, authoritative, not attributable. */
  provider: ProviderTotals;
  /**
   * localPromptTokens / provider.promptTokens. Reported so the disagreement
   * between two tokenizers is visible rather than hidden inside a correction.
   * Null when the provider reported no prompt tokens at all.
   */
  tokenizerRatio: number | null;
}

interface Row {
  prompt_tokens: number;
  completion_tokens: number;
  fresh_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  latency_ms: number;
  breakdown_json: string | null;
  local_prompt_tokens: number | null;
  tokens_estimated: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

/**
 * Aggregate the completions in a window.
 *
 * `sessionId` narrows to one conversation; omitted, it covers everything since
 * `since`. Rows written before the breakdown column existed contribute to the
 * provider account and not to ours, which is correct — we genuinely do not know
 * what they contained.
 */
export function costReport(
  db: Database,
  opts: { sessionId?: string; since?: number } = {},
): CostReport {
  const since = opts.since ?? 0;
  const rows = (
    opts.sessionId
      ? db
          .query<Row, [string, number]>(
            "SELECT * FROM completion_cost WHERE session_id = ? AND ts >= ?",
          )
          .all(opts.sessionId, since)
      : db.query<Row, [number]>("SELECT * FROM completion_cost WHERE ts >= ?").all(since)
  ) as Row[];

  const lanes = new Map<string, CategoryTotal>();
  const addLanes = (r: Row): void => {
    if (!r.breakdown_json) return;
    let parts: PromptPart[];
    try {
      parts = JSON.parse(r.breakdown_json) as PromptPart[];
    } catch {
      return;
    }
    for (const p of parts) {
      const key = `${p.category} ${p.detail}`;
      const existing = lanes.get(key);
      if (existing) existing.tokens += p.tokens;
      else lanes.set(key, { category: p.category, detail: p.detail, tokens: p.tokens, shareOfSent: 0 });
    }
  };
  let localPromptTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let fresh = 0;
  let read = 0;
  let write = 0;
  let reportingCache = 0;
  let estimated = 0;
  const latencies: number[] = [];

  for (const r of rows) {
    // An estimated row contributes to the category table (those lanes are ours
    // either way) but NOT to the provider account, which is only meaningful
    // when a provider actually said something.
    if (r.tokens_estimated) {
      estimated++;
      localPromptTokens += r.local_prompt_tokens ?? 0;
      addLanes(r);
      latencies.push(r.latency_ms);
      continue;
    }
    promptTokens += r.prompt_tokens;
    completionTokens += r.completion_tokens;
    latencies.push(r.latency_ms);
    // A row counts as "reporting cache" if the provider said anything at all.
    // Summing only those keeps a silent provider from diluting the numbers of
    // one that speaks.
    if (r.cache_read_tokens !== null || r.cache_write_tokens !== null || r.fresh_tokens !== null) {
      reportingCache++;
      fresh += r.fresh_tokens ?? 0;
      read += r.cache_read_tokens ?? 0;
      write += r.cache_write_tokens ?? 0;
    }
    localPromptTokens += r.local_prompt_tokens ?? 0;
    addLanes(r);
  }

  const sent = [...lanes.values()].sort((a, b) => b.tokens - a.tokens);
  for (const lane of sent) {
    lane.shareOfSent = localPromptTokens > 0 ? lane.tokens / localPromptTokens : 0;
  }

  return {
    sent,
    localPromptTokens,
    provider: {
      completions: rows.length - estimated,
      promptTokens,
      completionTokens,
      // Null, not 0: nobody told us. The distinction survives all the way to
      // the rendered table.
      freshTokens: reportingCache > 0 ? fresh : null,
      cacheReadTokens: reportingCache > 0 ? read : null,
      cacheWriteTokens: reportingCache > 0 ? write : null,
      completionsReportingCache: reportingCache,
      completionsEstimated: estimated,
      medianLatencyMs: median(latencies),
    },
    tokenizerRatio: promptTokens > 0 ? localPromptTokens / promptTokens : null,
  };
}

/** Render the report as two tables, one per account. Never one table. */
export function renderCostReport(report: CostReport): string {
  const out: string[] = [];
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

  out.push("## What we sent, by category");
  out.push("");
  if (report.sent.length === 0) {
    out.push("_No completion in this window recorded a breakdown._");
  } else {
    out.push("| category | detail | tokens | % of sent |");
    out.push("|---|---|---:|---:|");
    for (const lane of report.sent) {
      out.push(`| ${lane.category} | ${lane.detail} | ${lane.tokens.toLocaleString()} | ${pct(lane.shareOfSent)} |`);
    }
    out.push(`| **total** | | **${report.localPromptTokens.toLocaleString()}** | |`);
    out.push("");
    out.push("_Our tokenizer, our categories. Shares are of what we sent, NOT of what it cost._");
  }

  const p = report.provider;
  out.push("");
  out.push("## What the provider reported, per request");
  out.push("");
  if (p.completions === 0) {
    out.push(
      `**No completion here carried provider numbers.** ${p.completionsEstimated} of them fell back to our own ` +
        "estimate because the provider reported no usage — those tokens are ours, measured twice, and say nothing " +
        "about what was charged.",
    );
    out.push("");
    out.push(`_median latency: ${p.medianLatencyMs} ms_`);
    return out.join("\n");
  }
  out.push(`**Completions:** ${p.completions} · **median latency:** ${p.medianLatencyMs} ms`);
  if (p.completionsEstimated > 0) {
    out.push(
      `_${p.completionsEstimated} further completion(s) reported no usage at all; their tokens are our estimate ` +
        "and are excluded from every figure in this section._",
    );
  }
  out.push(`**Prompt tokens (theirs):** ${p.promptTokens.toLocaleString()} · **completion:** ${p.completionTokens.toLocaleString()}`);
  if (p.cacheReadTokens === null) {
    out.push("**Cache:** no completion in this window reported any cache information — unknown, not zero.");
  } else {
    const known = p.freshTokens! + p.cacheReadTokens;
    out.push(
      `**Cache:** ${p.cacheReadTokens.toLocaleString()} read · ` +
        `${(p.cacheWriteTokens ?? 0).toLocaleString()} written · ` +
        `${(p.freshTokens ?? 0).toLocaleString()} fresh` +
        (known > 0 ? ` — ${pct(p.cacheReadTokens / known)} of billed input came from cache` : ""),
    );
    if (p.completionsReportingCache < p.completions) {
      out.push(`_${p.completions - p.completionsReportingCache} of ${p.completions} completions said nothing about cache and are excluded from those figures._`);
    }
  }
  if (report.tokenizerRatio !== null) {
    out.push("");
    out.push(
      `_Our count is ${pct(report.tokenizerRatio)} of theirs. The two tokenizers disagree; ` +
        "neither table is scaled to match the other._",
    );
  }
  out.push("");
  out.push("_The two tables are not joined. Cache is reported per request, never per message, so no category here carries a cache share._");
  return out.join("\n");
}
