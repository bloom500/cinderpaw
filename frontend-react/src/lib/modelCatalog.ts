/**
 * Where a cloud model's real context window comes from.
 *
 * It used to come from a regex table in `contextWindow.ts`, which answered
 * 32,768 for every model nobody had thought to add. That is most of them: GLM,
 * Kimi, Grok, MiniMax, every model released after the table was written, and
 * every model a user types into Settings by hand. A 1M-token model drew a ring
 * that filled up after a long file.
 *
 * A hand-kept table cannot be right on a machine that installs the app a year
 * from now, so the number is asked for instead. OpenRouter publishes
 * `context_length` for the ~450 models it routes, the endpoint needs no API key
 * and carries no user data, and the answers are exact (Gemini 2.5 Pro 1,048,576;
 * `tokenlens`, the package AI Elements uses for this, answered 128,000 for that
 * same model, which is the bug we are fixing wearing a different coat).
 *
 * Rules this file keeps, because a stranger's machine is the one that matters:
 * - Nothing is fetched for a local model, or for a cloud model the built-in
 *   table already knows. An offline install never makes a request.
 * - One request per day at most, cached in localStorage.
 * - When the answer is not known, the caller is told `null`, NOT a plausible
 *   default. The ring says so on screen rather than drawing a confident lie.
 */

const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_KEY = 'cinderpaw-model-context-limits';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CatalogCache {
  fetchedAt: number;
  /** model id (lowercase, as the provider spells it) -> context window in tokens */
  limits: Record<string, number>;
}

let memo: CatalogCache | null | undefined;
let inflight: Promise<CatalogCache | null> | null = null;

function readCache(): CatalogCache | null {
  if (memo !== undefined) return memo;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as CatalogCache) : null;
    memo = parsed && typeof parsed.fetchedAt === 'number' && parsed.limits ? parsed : null;
  } catch {
    // Private window, cleared site data, quota: a cache we cannot read is a
    // cache we do not have. Never a crash.
    memo = null;
  }
  return memo;
}

function writeCache(cache: CatalogCache): void {
  memo = cache;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* the in-memory copy still serves this session */
  }
}

export function isStale(cache: CatalogCache | null, now = Date.now()): boolean {
  return !cache || now - cache.fetchedAt > MAX_AGE_MS;
}

/**
 * Find a model in the catalog.
 *
 * Providers spell the same model differently: OpenRouter says `z-ai/glm-4.6`,
 * a direct Z.ai key wants `glm-4.6`, and a user may type either. So an exact
 * match is tried first, then the part after the last slash on both sides. The
 * suffix match is deliberately last: `gpt-4o` must not win over `openai/gpt-4o`
 * when both are present.
 */
export function lookupLimit(limits: Record<string, number>, modelId: string): number | null {
  const id = modelId.trim().toLowerCase();
  if (!id) return null;
  if (limits[id]) return limits[id];

  const bare = id.slice(id.lastIndexOf('/') + 1);
  if (limits[bare]) return limits[bare];
  for (const [key, value] of Object.entries(limits)) {
    if (key.slice(key.lastIndexOf('/') + 1) === bare) return value;
  }
  return null;
}

/** The limit already on disk, without touching the network. `null` = not known here. */
export function cachedLimitFor(modelId: string | undefined): number | null {
  if (!modelId) return null;
  const cache = readCache();
  return cache ? lookupLimit(cache.limits, modelId) : null;
}

export function catalogFetchedAt(): number | null {
  return readCache()?.fetchedAt ?? null;
}

interface CatalogRow {
  id?: unknown;
  context_length?: unknown;
}

export function parseCatalog(payload: unknown): Record<string, number> {
  const rows = (payload as { data?: CatalogRow[] })?.data;
  const limits: Record<string, number> = {};
  if (!Array.isArray(rows)) return limits;
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id.toLowerCase() : null;
    const len = typeof row?.context_length === 'number' ? row.context_length : null;
    if (id && len && len > 0) limits[id] = len;
  }
  return limits;
}

/**
 * Refresh the catalog if it is stale. Concurrent callers share one request, and
 * a failure keeps whatever is cached rather than emptying it: yesterday's real
 * numbers beat no numbers.
 */
export async function refreshCatalog(): Promise<CatalogCache | null> {
  const cache = readCache();
  if (!isStale(cache)) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch(CATALOG_URL, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`${res.status}`);
      const limits = parseCatalog(await res.json());
      if (Object.keys(limits).length === 0) throw new Error('empty catalog');
      const fresh: CatalogCache = { fetchedAt: Date.now(), limits };
      writeCache(fresh);
      return fresh;
    } catch {
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
