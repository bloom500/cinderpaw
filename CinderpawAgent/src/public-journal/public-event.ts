/**
 * Public Event schema — the ONLY shape that may leave this machine for the
 * public Cubby Journal.
 *
 * Threat model: the Evolution Journal (`rsi/infra/journal.ts`) is written for
 * a trusted local reader. Its `observed` / `hypothesized` / `decided.reason` /
 * `experimented.change` fields are free text produced by the engine and by
 * models, and `candidateId` is attacker-influenceable in the L3/L4 layers
 * (a code candidate can be named after a file). None of that is safe to
 * publish, so this module does NOT filter the journal — it re-builds a small
 * event from scratch out of values it can prove are safe:
 *
 *   1. **Allowlisted keys only.** The output object is constructed literally.
 *      There is no spread of a source object anywhere in this file, so a new
 *      field appearing in the journal can never leak by default.
 *   2. **No free text, ever.** Summaries come from templates in this file with
 *      only numbers and enum members interpolated. Journal prose is dropped.
 *   3. **Identifiers are hashed.** `candidateId` / `cycleId` become truncated
 *      SHA-256 refs, so lineage stays traceable publicly without publishing a
 *      name that might contain a path or a prompt fragment.
 *   4. **Numbers are validated.** Every metric must be a finite number in its
 *      declared range, then it is rounded — NaN/Infinity/-0 never ship.
 *   5. **Defence in depth.** `assertPublicSafe` re-scans the finished event for
 *      secret-shaped strings and throws. An allowlist should make this
 *      unreachable; it exists so that a future bug in 1-4 fails closed.
 *
 * If a field does not exist here, it is not published. Extending the schema is
 * a deliberate edit to this file, reviewed on its own.
 */

import { createHash } from "node:crypto";
import type { ExperimentLayer, JournalEntry } from "../rsi/infra/journal.ts";

/** Bump only on incompatible changes. The landing-page validator pins this. */
export const PUBLIC_EVENT_SCHEMA_VERSION = 1;

/** Who published the event. A publisher is a whole trust domain, not a user:
 *  `cubby` is the private local Cinderpaw instance, `paw` is the community support
 *  bot on the VPS. They authenticate with different tokens and never share
 *  state — see `docs/public-journal.md`. */
export const PUBLISHERS = ["cubby", "paw"] as const;
export type Publisher = (typeof PUBLISHERS)[number];

/** BRSI layers (`docs/brsi-spec.md` §5). L6 is included for forward
 *  compatibility; nothing emits it yet. */
export const LAYERS = ["L0", "L1", "L2", "L3", "L4", "L5", "L6"] as const;
export type PublicLayer = (typeof LAYERS)[number];

/** Event types that have a real source in the runtime today.
 *  Adding a member here without a real emitter would put a category on the
 *  public page that can never fill — don't. */
export const PUBLIC_EVENT_TYPES = [
  /** A candidate was evaluated and ratcheted in (journal `decided.accept`). */
  "evolution.promoted",
  /** A candidate was evaluated and not promoted (journal `decided.reject`). */
  "evolution.rejected",
  /** A cycle stopped before reaching a decision (journal `decided.halt`). */
  "evolution.halted",
] as const;
export type PublicEventType = (typeof PUBLIC_EVENT_TYPES)[number];

/** Metric keys that may be published, with the range each must fall in.
 *  A value outside its range is dropped rather than clamped: an out-of-range
 *  metric means the source changed meaning, and publishing a clamped number
 *  would be publishing a wrong one. */
export const METRIC_RANGES = {
  /** Aggregate fitness, BRSI §2.2. */
  aggregate: [0, 1],
  /** Confidence-gate verdict. */
  confidence: [0, 1],
  accuracy: [0, 1],
  latency: [0, 1],
  cost: [0, 1],
  toolSuccess: [0, 1],
  hallucination: [0, 1],
  userSatisfaction: [0, 1],
  /** Wall-clock minutes the cycle ran. Loose upper bound; a cycle longer
   *  than a day is a bug, not a datum worth publishing. */
  durationMin: [0, 1440],
} as const satisfies Record<string, readonly [number, number]>;

export type MetricKey = keyof typeof METRIC_RANGES;

/** Tier gate outcomes. Enums, so they are safe to publish verbatim. */
export const TIER0 = ["passed", "failed"] as const;
export const TIER1 = ["no_regression", "regression"] as const;

/** One entry in the public journal. Every field is either an enum member, a
 *  validated number, a hash, or a string this file generated. */
export interface PublicEvent {
  schemaVersion: typeof PUBLIC_EVENT_SCHEMA_VERSION;
  /** Deterministic over the source row: re-exporting the same journal row
   *  yields the same id, so replays dedupe instead of duplicating. */
  id: string;
  publisher: Publisher;
  /** Wall-clock ms since epoch, from the source row. */
  ts: number;
  type: PublicEventType;
  layer: PublicLayer | null;
  /** Template-generated. Never contains text from the journal. */
  summary: string;
  /** Truncated hash of the candidate id — lineage without the name. */
  candidateRef: string | null;
  /**
   * A pronounceable name for the same candidate, generated from `candidateRef`
   * (see `candidateWord`). What a reader is shown; `candidateRef` is what rows
   * are correlated by, and it stays because two candidates can generate the
   * same name.
   */
  candidateName: string | null;
  /** Truncated hash of the cycle id. */
  cycleRef: string | null;
  /** Allowlisted numeric metrics. Absent key = not available in the source. */
  metrics: Partial<Record<MetricKey, number>>;
  checks: {
    tier0?: (typeof TIER0)[number];
    tier1?: (typeof TIER1)[number];
  };
}

/** Liveness, published alongside events. Presence, not a journal entry: it is
 *  overwritten per publisher rather than appended, so a heartbeat every minute
 *  cannot flood the journal. */
export interface PublicHeartbeat {
  schemaVersion: typeof PUBLIC_EVENT_SCHEMA_VERSION;
  publisher: Publisher;
  ts: number;
  /** `working` = the runtime did measurable work recently; `online` = alive but
   *  idle. `sleeping` is never SENT — it is what the reader infers when a
   *  heartbeat goes stale, so a dead instance cannot report itself awake. */
  state: "online" | "working";
  /** Version string of the publishing runtime. Validated to a narrow charset. */
  agentVersion: string | null;
}

/** The whole publish payload: presence plus zero or more events. */
export interface PublicPayload {
  schemaVersion: typeof PUBLIC_EVENT_SCHEMA_VERSION;
  publisher: Publisher;
  heartbeat: PublicHeartbeat;
  events: PublicEvent[];
}

/* ------------------------------------------------------------- helpers */

/** Truncated SHA-256. 12 hex chars ≈ 48 bits — plenty to correlate rows in a
 *  journal of thousands, far too little to invert back to a path or prompt. */
export function publicRef(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

/** Round to 4 decimals. Fitness values are ratios; publishing 17 digits of
 *  float noise implies a precision the evaluator does not have. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Keep a metric only if it is a finite number inside its declared range.
 *  Everything else — string, null, NaN, Infinity, out of range — is dropped. */
function takeMetric(out: Partial<Record<MetricKey, number>>, key: MetricKey, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  const [lo, hi] = METRIC_RANGES[key];
  if (value < lo || value > hi) return;
  // `+ 0` normalises -0, which JSON.stringify would emit as "0" anyway but
  // which compares surprisingly in tests.
  out[key] = round4(value) + 0;
}

/** Only the layers the public schema knows. An unrecognised layer publishes as
 *  null rather than as itself — the reader shows "Not available". */
function takeLayer(value: unknown): PublicLayer | null {
  return typeof value === "string" && (LAYERS as readonly string[]).includes(value)
    ? (value as PublicLayer)
    : null;
}

/* -------------------------------------------------------- the sanitizer */

/**
 * The part of a published id that is supposed to make it unique.
 *
 * `row.hash` comes from the Evolution Journal and was used verbatim whenever it
 * was a non-empty string — including `"1"` from a torn write or a debug run.
 * The store deduplicates on this id, so a short accidental value collides with
 * an unrelated event and one of the two is silently dropped. Only a real
 * chain hash is trusted; anything else falls back to the composite key, which
 * is unique by construction.
 */
function hashPart(row: { hash?: unknown; cycleId?: unknown; timestamp?: unknown }, type: string): string {
  const h = row.hash;
  // Hex, and long enough to be a digest rather than a stray value. The point is
  // to reject things like "1" from a torn write or a debug run — which are
  // short enough to collide with an unrelated event, and the store deduplicates
  // on this id, so a collision silently drops one of the two. A real chain hash
  // is 64 characters; the floor is set well below that so a shorter digest
  // scheme would still be usable.
  if (typeof h === "string" && h.length >= 8 && /^[a-f0-9]+$/i.test(h)) return h.toLowerCase();
  return `${String(row.cycleId)}|${String(row.timestamp)}|${type}`;
}

/** Strings that must never appear in a published event, checked over the
 *  finished object. This is the fail-closed backstop, NOT the primary defence
 *  (that is the allowlist above) — which is why it can be blunt about false
 *  positives: nothing this file generates looks like any of these. */
const FORBIDDEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[A-Za-z]:[\\/]/, "windows filesystem path"],
  [/\\\\[^\\]/, "UNC path"],
  // The list is the point: a directory NOT named here publishes the path.
  // `/opt/homebrew/...` on macOS and `/mnt/c/...` under WSL both went
  // straight through, and a filesystem path is a username, a project name,
  // and often a client's name, published to a page anyone can read.
  [
    /(^|[^\w])\/(home|Users|etc|var|root|tmp|proc|opt|usr|srv|mnt|media|dev|Volumes|Applications|Library|private)\//,
    "unix filesystem path",
  ],
  [/\b(sk|pk|rk)-[A-Za-z0-9]{8,}/, "api key"],
  [/\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{8,}/, "github token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/, "slack token"],
  [/\bAKIA[0-9A-Z]{12,}/, "aws access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\beyJ[A-Za-z0-9_-]{16,}\./, "jwt"],
  [/\$\{?[A-Z][A-Z0-9_]{3,}\}?/, "environment variable reference"],
  [/[\w.+-]+@[\w-]+\.[\w.]{2,}/, "email address"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, "ip address"],
  [/\bBearer\s+\S+/i, "authorization header"],
];

/** Every string in the event, with a dotted path for the error message. */
function* walkStrings(value: unknown, path = "$"): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* walkStrings(value[i], `${path}[${i}]`);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* walkStrings(v, `${path}.${k}`);
  }
}

/**
 * Throw if `event` contains anything secret-shaped. Runs on the publisher side
 * before the request is built AND on the landing side before the event is
 * stored, so a compromised or out-of-date exporter still cannot get a path or a
 * key into the public store.
 *
 * `id`, `candidateRef` and `cycleRef` are hex hashes and are exempt from the
 * key-shaped patterns — hex of the right length would otherwise trip nothing
 * here today, but keeping them out of the scan makes the intent explicit.
 */
export function assertPublicSafe(event: unknown, label = "event"): void {
  for (const [path, str] of walkStrings(event)) {
    for (const [pattern, what] of FORBIDDEN_PATTERNS) {
      if (pattern.test(str)) {
        throw new Error(`refusing to publish ${label}: ${what} at ${path}`);
      }
    }
  }
}

/* ------------------------------------------------- names, not hashes */

/**
 * Syllable pieces. NOT a dictionary and not a list of real words — the names
 * are built here, so the space is every combination rather than whatever
 * someone once typed into an array.
 */
// Clusters and diphthongs are allowed to open a name and nowhere else.
// Letting them stack anywhere produced "Moareathousk" — technically generated,
// impossible to say, and therefore no better than the hash it replaced.
const OPENING_ONSETS = [
  "b", "br", "c", "cl", "d", "dr", "f", "fl", "g", "gl", "h", "j", "k", "kr",
  "l", "m", "n", "p", "pl", "r", "s", "sh", "sk", "sl", "sn", "st", "t",
  "th", "tr", "v", "w", "y", "z",
] as const;
const ONSETS = ["b", "c", "d", "f", "g", "l", "m", "n", "p", "r", "s", "t", "v", "z"] as const;
const OPENING_NUCLEI = ["a", "e", "i", "o", "u", "ae", "ai", "ea", "io", "oa"] as const;
const NUCLEI = ["a", "e", "i", "o", "u"] as const;
const CODAS = ["", "", "", "l", "n", "r", "s", "th", "nd", "st"] as const;

/**
 * A pronounceable name for a candidate, generated from its public ref.
 *
 * Why generated from the ref rather than drawn fresh: the same candidate has
 * to keep the same name. The journal is re-exported and replayed, and a name
 * rolled at export time would rename history on every pass — the reader would
 * watch "the one that got promoted" become a different word overnight. Seeding
 * from the ref makes the name a property of the candidate instead of a
 * property of the moment it was printed.
 *
 * Seeded from the HASH, never from the candidate id. `candidateId` is
 * attacker-influenceable in L3/L4 — a code candidate can be named after a file
 * — which is why it is hashed before anything is published. A function of the
 * hash can leak nothing the hash does not already, and this one keeps about 30
 * of its 48 bits.
 *
 * Two or three syllables, so it reads as a name and not as a password.
 */
export function candidateWord(ref: string): string {
  // xorshift32 seeded from the ref: deterministic, and it moves the bits
  // around so the first syllable is not just the first hex digit wearing a
  // hat. A zero seed would freeze the generator, so it falls back to 1.
  let x = Number.parseInt(ref.slice(0, 8), 16);
  if (!Number.isFinite(x) || x === 0) x = 1;
  const next = (): number => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return Math.abs(x);
  };
  const syllables = 2 + (next() % 2);
  let out = "";
  for (let i = 0; i < syllables; i++) {
    const first = i === 0;
    const onsets = first ? OPENING_ONSETS : ONSETS;
    const nuclei = first ? OPENING_NUCLEI : NUCLEI;
    out += onsets[next() % onsets.length]!;
    out += nuclei[next() % nuclei.length]!;
    // A coda closes the name and nothing else: mid-word consonant clusters are
    // where these stop being pronounceable.
    if (i === syllables - 1) out += CODAS[next() % CODAS.length]!;
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/* --------------------------------------------------------- the mappers */

/** Summary templates. The ONLY place public prose is written. Every
 *  interpolation is a number or an enum member — never source text. */
function summarize(
  type: PublicEventType,
  layer: PublicLayer | null,
  metrics: Partial<Record<MetricKey, number>>,
  name: string | null,
): string {
  const where = layer ? `Layer ${layer}` : "An unlabelled layer";
  const fitness =
    typeof metrics.aggregate === "number" ? ` at fitness ${metrics.aggregate.toFixed(3)}` : "";
  // `name` is generated by this file from a hash, so it is safe to interpolate
  // under the same rule as the numbers and enum members around it.
  const who = name ?? "a candidate";
  switch (type) {
    case "evolution.promoted":
      return `${where} promoted ${who}${fitness}.`;
    case "evolution.rejected":
      return `${where} evaluated ${who}${fitness} and kept the incumbent.`;
    case "evolution.halted":
      return `${where} halted a cycle before it reached a decision.`;
  }
}

/**
 * Map one Evolution Journal row to a PublicEvent, or `null` if the row is
 * malformed or carries a decision this schema does not publish.
 *
 * Never throws on bad input: the exporter walks thousands of rows and one
 * corrupt line must not stop the batch. It DOES throw if the finished event
 * fails `assertPublicSafe`, because that means this file has a bug and
 * continuing would publish it.
 */
export function toPublicEvent(entry: unknown, publisher: Publisher): PublicEvent | null {
  if (!entry || typeof entry !== "object") return null;
  const row = entry as Partial<JournalEntry> & Record<string, unknown>;

  if (typeof row.cycleId !== "string" || row.cycleId === "") return null;
  if (typeof row.timestamp !== "number" || !Number.isFinite(row.timestamp)) return null;
  if (row.timestamp <= 0) return null;

  const decided = row.decided as { action?: unknown } | undefined;
  const action = decided && typeof decided === "object" ? decided.action : undefined;
  const type: PublicEventType | null =
    action === "accept"
      ? "evolution.promoted"
      : action === "reject"
        ? "evolution.rejected"
        : action === "halt"
          ? "evolution.halted"
          : null;
  if (!type) return null;

  const experimented = row.experimented as
    | { candidateId?: unknown; layer?: ExperimentLayer }
    | null
    | undefined;
  const layer = takeLayer(experimented?.layer);

  const metrics: Partial<Record<MetricKey, number>> = {};
  takeMetric(metrics, "durationMin", row.durationMin);
  const result = row.result as Record<string, unknown> | null | undefined;
  if (result && typeof result === "object") {
    takeMetric(metrics, "aggregate", result.aggregate);
    takeMetric(metrics, "confidence", result.confidence);
    const fv = result.fitnessVector as Record<string, unknown> | undefined;
    if (fv && typeof fv === "object") {
      takeMetric(metrics, "accuracy", fv.accuracy);
      takeMetric(metrics, "latency", fv.latency);
      takeMetric(metrics, "cost", fv.cost);
      takeMetric(metrics, "toolSuccess", fv.toolSuccess);
      takeMetric(metrics, "hallucination", fv.hallucination);
      takeMetric(metrics, "userSatisfaction", fv.userSatisfaction);
    }
  }

  const checks: PublicEvent["checks"] = {};
  if (typeof result?.tier0 === "string" && (TIER0 as readonly string[]).includes(result.tier0)) {
    checks.tier0 = result.tier0 as (typeof TIER0)[number];
  }
  if (typeof result?.tier1 === "string" && (TIER1 as readonly string[]).includes(result.tier1)) {
    checks.tier1 = result.tier1 as (typeof TIER1)[number];
  }

  const candidateId = experimented?.candidateId;
  const candidateRef =
    typeof candidateId === "string" && candidateId ? publicRef(candidateId) : null;
  const candidateName = candidateRef ? candidateWord(candidateRef) : null;

  const event: PublicEvent = {
    schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
    // Deterministic over the source ROW, so re-exporting the same row yields
    // the same id and replays dedupe instead of duplicating.
    //
    // `cycleId` alone is NOT unique: the live engine writes several rows per
    // cycle (measured ~4.5 on real journals), so keying on it would silently
    // collapse most of the history. Rows written since the L5 hash chain landed
    // carry `hash`, which is a content hash of the row and therefore unique per
    // row — use it. Legacy rows predate the chain, so they fall back to
    // cycle+timestamp+type; that still separates every row except ones written
    // in the same millisecond with the same verdict, which are indistinguishable
    // to a reader anyway.
    //
    // Re-hashed with the publisher prefix rather than published raw, so the
    // public id cannot be correlated against the local chain.
    id: publicRef(
      `${publisher}|${hashPart(row, type)}`,
    ),
    publisher,
    ts: Math.floor(row.timestamp),
    type,
    layer,
    summary: summarize(type, layer, metrics, candidateName),
    candidateRef,
    candidateName,
    cycleRef: publicRef(row.cycleId),
    metrics,
    checks,
  };

  assertPublicSafe(event);
  return event;
}

/** Narrow charset for a version string, so a version can't smuggle prose. */
const VERSION_RE = /^[0-9A-Za-z.\-+]{1,24}$/;

/** Build a heartbeat. `working` is a claim about measured activity — the caller
 *  passes the real answer; this function does not guess. */
export function toPublicHeartbeat(input: {
  publisher: Publisher;
  ts: number;
  working: boolean;
  agentVersion?: string | null;
}): PublicHeartbeat {
  const version =
    typeof input.agentVersion === "string" && VERSION_RE.test(input.agentVersion)
      ? input.agentVersion
      : null;
  const beat: PublicHeartbeat = {
    schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
    publisher: input.publisher,
    ts: Math.floor(input.ts),
    state: input.working ? "working" : "online",
    agentVersion: version,
  };
  assertPublicSafe(beat, "heartbeat");
  return beat;
}
