/**
 * Public-journal exporter — the one outbound path from this machine to the
 * public Cubby Journal.
 *
 * Direction matters: nothing reaches in. The landing page never connects to
 * this instance, never sees the gateway, the RPC socket, or the filesystem.
 * This process reads the local Evolution Journal, converts rows into
 * `PublicEvent`s (see `public-event.ts` for why that conversion is a rebuild
 * and not a filter), and POSTs them to an authenticated HTTPS endpoint. If the
 * machine is off, the endpoint simply stops hearing from it — which is exactly
 * the signal the page needs to say Cubby is asleep.
 *
 * Resumption is a timestamp cursor at `~/.feral/public-journal/cursor.json`.
 * It is an optimisation, not a correctness mechanism: event ids are
 * deterministic over the source row, so a lost, stale, or replayed cursor
 * causes re-sends that the store dedupes, never duplicates on the page.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultJournalDir } from "../rsi/infra/journal.ts";
import { feralHome } from "../config.ts";
import {
  assertPublicSafe,
  PUBLIC_EVENT_SCHEMA_VERSION,
  toPublicEvent,
  toPublicHeartbeat,
  type PublicEvent,
  type PublicPayload,
  type Publisher,
} from "./public-event.ts";

/** Most events to send in one run. A first export over months of journal would
 *  otherwise be a multi-megabyte POST; the cursor advances and the next run
 *  picks up the rest. */
export const DEFAULT_BATCH_LIMIT = 200;

/** Journal activity newer than this means the runtime is "working" rather than
 *  merely "online". One dream cycle per few minutes is the normal busy rate. */
export const WORKING_WINDOW_MS = 10 * 60_000;

export interface ExportCursor {
  /** Highest source timestamp already published. */
  lastTimestamp: number;
}

const CURSOR_ZERO: ExportCursor = { lastTimestamp: 0 };

export function cursorPath(): string {
  return join(feralHome(), "public-journal", "cursor.json");
}

export function readCursor(path: string): ExportCursor {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ExportCursor>;
    const ts = raw?.lastTimestamp;
    // A corrupt or absurd cursor resets to zero rather than skipping history:
    // over-sending is deduped, under-sending would silently lose events.
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 0) return CURSOR_ZERO;
    return { lastTimestamp: ts };
  } catch {
    return CURSOR_ZERO;
  }
}

export function writeCursor(path: string, cursor: ExportCursor): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cursor), "utf8");
}

/** Journal files, oldest first. Names are `journal-YYYY-MM-DD.jsonl`, so a
 *  lexical sort is a chronological sort. */
export function journalFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

export interface CollectResult {
  events: PublicEvent[];
  /** Cursor to persist after a successful publish. */
  cursor: ExportCursor;
  /** Rows skipped because they were malformed or carried no publishable
   *  decision. Reported so a silent drop is visible in the run output. */
  skipped: number;
  /** Newest source timestamp seen, published or not — drives `working`. */
  newestTimestamp: number;
}

/**
 * Read journal rows newer than `since` and convert them.
 *
 * Malformed lines are counted and skipped, never thrown: the journal is an
 * append-only file written best-effort by a live engine, so a torn last line
 * during a crash is expected and must not stop the export.
 */
export function collectEvents(opts: {
  journalDir: string;
  publisher: Publisher;
  since: number;
  limit?: number;
}): CollectResult {
  const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;
  const events: PublicEvent[] = [];
  let skipped = 0;
  let lastTimestamp = opts.since;
  let newestTimestamp = 0;

  outer: for (const file of journalFiles(opts.journalDir)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      skipped++;
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let row: unknown;
      try {
        row = JSON.parse(trimmed);
      } catch {
        skipped++;
        continue;
      }

      const ts = (row as { timestamp?: unknown })?.timestamp;
      if (typeof ts === "number" && Number.isFinite(ts) && ts > newestTimestamp) {
        newestTimestamp = ts;
      }
      if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= opts.since) continue;

      const event = toPublicEvent(row, opts.publisher);
      if (!event) {
        skipped++;
        continue;
      }
      events.push(event);
      if (event.ts > lastTimestamp) lastTimestamp = event.ts;
      if (events.length >= limit) break outer;
    }
  }

  return { events, cursor: { lastTimestamp }, skipped, newestTimestamp };
}

export interface ExporterConfig {
  url: string;
  token: string;
  publisher: Publisher;
  journalDir: string;
  cursorFile: string;
  agentVersion: string | null;
  limit: number;
}

/** Read config from the environment. Throws with an actionable message rather
 *  than half-configuring — a publisher that silently no-ops is worse than one
 *  that refuses to start. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ExporterConfig {
  const url = env.FERAL_PUBLIC_JOURNAL_URL?.trim();
  const token = env.FERAL_PUBLIC_JOURNAL_TOKEN?.trim();
  if (!url) throw new Error("FERAL_PUBLIC_JOURNAL_URL is not set");
  if (!token) throw new Error("FERAL_PUBLIC_JOURNAL_TOKEN is not set");
  assertTransportSafe(url);

  const publisher = (env.FERAL_PUBLIC_JOURNAL_PUBLISHER?.trim() || "cubby") as Publisher;
  if (publisher !== "cubby" && publisher !== "paw") {
    throw new Error(`unknown publisher "${publisher}" (expected "cubby" or "paw")`);
  }

  const limitRaw = Number(env.FERAL_PUBLIC_JOURNAL_LIMIT ?? DEFAULT_BATCH_LIMIT);
  return {
    url,
    token,
    publisher,
    journalDir: env.FERAL_PUBLIC_JOURNAL_DIR?.trim() || defaultJournalDir(),
    cursorFile: cursorPath(),
    agentVersion: env.FERAL_PUBLIC_JOURNAL_VERSION?.trim() || null,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_BATCH_LIMIT,
  };
}

/** Refuse to send a bearer token over plaintext. `localhost` is exempt so the
 *  end-to-end demo can run against `next dev` without a certificate. */
export function assertTransportSafe(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`FERAL_PUBLIC_JOURNAL_URL is not a valid URL: ${url}`);
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !local) {
    throw new Error("refusing to send the publish token over plain HTTP (use https, or localhost)");
  }
}

/** Assemble the payload. Separated from the POST so tests can assert on the
 *  exact bytes that would go out without a server. */
export function buildPayload(opts: {
  publisher: Publisher;
  events: PublicEvent[];
  now: number;
  newestTimestamp: number;
  agentVersion: string | null;
}): PublicPayload {
  const payload: PublicPayload = {
    schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
    publisher: opts.publisher,
    heartbeat: toPublicHeartbeat({
      publisher: opts.publisher,
      ts: opts.now,
      working: opts.now - opts.newestTimestamp < WORKING_WINDOW_MS,
      agentVersion: opts.agentVersion,
    }),
    events: opts.events,
  };
  // Final gate before the bytes leave the process. Every event was already
  // checked at construction; this catches a payload assembled some other way.
  assertPublicSafe(payload, "payload");
  return payload;
}

export interface ExportResult {
  sent: number;
  skipped: number;
  status: number;
  accepted: number;
  duplicates: number;
}

/**
 * One export pass: collect, publish, advance the cursor.
 *
 * The cursor advances only after a 2xx. A failed publish leaves it untouched so
 * the next run retries the same rows.
 */
export async function runExport(
  config: ExporterConfig,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<ExportResult> {
  const cursor = readCursor(config.cursorFile);
  const collected = collectEvents({
    journalDir: config.journalDir,
    publisher: config.publisher,
    since: cursor.lastTimestamp,
    limit: config.limit,
  });

  const payload = buildPayload({
    publisher: config.publisher,
    events: collected.events,
    now,
    newestTimestamp: collected.newestTimestamp,
    agentVersion: config.agentVersion,
  });

  const res = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(payload),
  });

  const body = (await res.json().catch(() => ({}))) as { accepted?: number; duplicates?: number };
  if (!res.ok) {
    throw new Error(`publish failed: HTTP ${res.status}`);
  }

  writeCursor(config.cursorFile, collected.cursor);

  return {
    sent: collected.events.length,
    skipped: collected.skipped,
    status: res.status,
    accepted: typeof body.accepted === "number" ? body.accepted : 0,
    duplicates: typeof body.duplicates === "number" ? body.duplicates : 0,
  };
}
