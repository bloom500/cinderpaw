/**
 * The ARC-AGI-3 client — the thing three checkpoints in a row recorded as
 * missing from every branch.
 *
 * It implements `ArcEnvironment`, so `playLevel` and `createFrugalPolicy` run
 * against the real scorecard without knowing anything changed. That was the
 * point of writing the seam first.
 *
 * Endpoints, from docs.arcprize.org — none of these are guessed:
 *   GET  /api/games                  list games
 *   POST /api/scorecard/open         -> { card_id }
 *   POST /api/scorecard/close        { card_id }
 *   POST /api/cmd/RESET              { game_id, card_id, guid? }
 *   POST /api/cmd/ACTION1..7         { game_id, guid, [x, y], reasoning? }
 * Auth is `X-API-Key` on every request.
 *
 * THREE THINGS THE DOCS SAY THAT ARE EASY TO MISS, each of which silently
 * ruins a run rather than failing loudly:
 *
 * 1. SESSION AFFINITY. The server is behind an AWS load balancer and sets
 *    `AWSALB*` cookies that MUST be echoed on every subsequent request for the
 *    session. `fetch` does not keep a cookie jar. Without this the requests
 *    scatter across backends and the game state appears to reset at random —
 *    which reads exactly like a broken agent, not a broken client. There is a
 *    jar below, and it is the main reason this file is not twenty lines.
 *
 *    AND IT STARTS AT `/api/scorecard/open`, NOT AT THE FIRST RESET. This was
 *    the bug: the card was opened with no jar, so its cookies were dropped, and
 *    RESET went to a different backend which had never heard of that card. The
 *    server does not say "wrong backend" — it says `game <id> not found` for an
 *    id that came out of `/api/games` one second earlier, and
 *    `scorecard <id> not found` for a card it issued itself. Both messages send
 *    you looking in exactly the wrong place. One jar now spans open -> play ->
 *    close, which is the whole session.
 *
 * 2. `available_actions` CHANGES PER FRAME. It is not a fixed vocabulary per
 *    game. `ArcEnvironment.actions` is therefore a getter that reflects the
 *    latest frame, which `playLevel` re-reads every iteration — so a policy is
 *    never offered an action the game is not currently accepting, and
 *    `playLevel`'s invalid-action guard measures the real thing.
 *
 * 3. `frame` IS A STACK OF GRIDS, `number[][][]`, not one grid. The last layer
 *    is the current view; earlier layers are the animation leading to it. We
 *    hand the policy the last layer and keep the whole stack on the
 *    observation for anything that wants it.
 *
 * ACTION6 takes x/y coordinates, so an action here is either `"ACTION1"` or
 * `"ACTION6:x,y"`. That encoding keeps `ArcPolicy` a plain string function
 * rather than making every policy in the codebase learn a payload type for the
 * benefit of one action.
 *
 * BENCHMARK MODE. When `CINDERPAW_BENCHMARK_RUN_ID` is set the network narrows to
 * `CINDERPAW_BENCHMARK_ALLOW_HOSTS` at both exits (Val 2.3). `three.arcprize.org`
 * must be in that list or every request here fails closed — which is the
 * correct behaviour, and this comment exists so the failure is diagnosable in
 * one read instead of one afternoon.
 */

import type { ArcEnvironment, ArcGrid, ArcLevelState, ArcObservation } from "./environment.ts";

const BASE_URL = "https://three.arcprize.org";

/** What the server returns from RESET and from every ACTION. */
interface FrameResponse {
  game_id: string;
  guid: string;
  frame: number[][][];
  state: ArcLevelState;
  levels_completed: number;
  win_levels: number;
  available_actions: number[];
  full_reset?: boolean;
}

export interface ArcObservationWithFrame extends ArcObservation {
  /** Every layer the server sent, newest last. `grid` is the last of these. */
  frameStack: number[][][];
  levelsCompleted: number;
  winLevels: number;
}

export interface ArcApiOptions {
  /** Defaults to `process.env.ARC_API_KEY`. */
  apiKey?: string;
  /** e.g. `ls20-016295f7601e`. Get one from `listGames()`. */
  gameId: string;
  /** From `openScorecard()`. Every action is billed to it. */
  cardId: string;
  /**
   * The jar the scorecard was opened with. Required in practice: without it
   * RESET reaches a backend that does not know this card and answers
   * `game <id> not found`.
   */
  jar?: CookieJar;
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Attached to each ACTION as `reasoning`, capped by the server at 16 KB. */
  reasoning?: () => unknown;
}

/**
 * A cookie jar, because the load balancer needs one and `fetch` has none.
 *
 * Deliberately dumb: it keeps `name=value` and replays all of them. No domain
 * matching, no expiry, no path scoping — this jar talks to exactly one host for
 * the length of one game, and a correct RFC 6265 implementation here would be
 * code nobody needs and everybody has to read.
 */
export class CookieJar {
  #jar = new Map<string, string>();

  absorb(response: Response): void {
    // getSetCookie() is the only way to see multiple Set-Cookie headers; older
    // runtimes fold them into one string, so fall back to that.
    const raw =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie") ?? ""].filter(Boolean);
    for (const line of raw) {
      const pair = line.split(";", 1)[0]?.trim();
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.#jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  header(): string | undefined {
    if (this.#jar.size === 0) return undefined;
    return [...this.#jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function requireKey(apiKey: string | undefined): string {
  const key = apiKey ?? process.env.ARC_API_KEY;
  if (!key || key.trim() === "") {
    // A stranger's first run lands here. The message has to say what to do, on
    // their screen, without reading this file.
    throw new Error(
      "ARC-AGI-3: no API key. Set ARC_API_KEY (get one at https://three.arcprize.org) " +
        "or pass { apiKey } — every endpoint requires the X-API-Key header.",
    );
  }
  return key;
}

/**
 * Statuses worth trying again: the server is busy or briefly broken, not the
 * request wrong. A 4xx other than 429 is our fault and retrying repeats it.
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** How many times to retry, and the base for exponential backoff. */
export const ARC_MAX_RETRIES = 4;
const RETRY_BASE_MS = 800;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function call<T>(
  path: string,
  init: { method: string; body?: unknown; apiKey: string; jar?: CookieJar; fetchImpl?: typeof fetch },
): Promise<T> {
  const doFetch = init.fetchImpl ?? fetch;
  let lastError = "";

  // RETRY, AND WHY IT IS WORTH THE ONE RISK IT CARRIES.
  //
  // A single 500 used to end a game. Running 25 games at once, ten of them died
  // on `500 Internal Server Error — the server is overloaded` inside the first
  // minute, most of them before their second action. Hours of run and every
  // level of those games, thrown away by one bad response out of hundreds.
  //
  // The risk is real and worth stating: a 500 on an ACTION is ambiguous. The
  // server may have applied the press before failing to answer, so a retry can
  // spend the same press twice, and presses are the score. But the alternative
  // is losing the entire game — every level, weighted highest at the end — to
  // protect against one duplicated action. A wasted press costs a fraction of
  // one level's ratio; a lost game costs all of them. Retry wins, and it is not
  // close.
  //
  // Backoff is exponential with jitter because the failure mode we actually met
  // was self-inflicted load: 25 processes retrying in lockstep would rebuild
  // the same spike that knocked them over.
  for (let attempt = 0; attempt <= ARC_MAX_RETRIES; attempt++) {
    const cookie = init.jar?.header();
    let response: Response;
    try {
      response = await doFetch(`${BASE_URL}${path}`, {
        method: init.method,
        headers: {
          "X-API-Key": init.apiKey,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (err) {
      // A dropped connection is the same class of problem as a 503.
      lastError = `network error: ${String(err)}`;
      if (attempt === ARC_MAX_RETRIES) break;
      await sleep(RETRY_BASE_MS * 2 ** attempt + Math.random() * 400);
      continue;
    }
    init.jar?.absorb(response);
    if (response.ok) return (await response.json()) as T;

    // The body usually says why (bad key, closed scorecard, unknown game). It
    // is worth more than the status code alone and costs one await.
    const detail = await response.text().catch(() => "");
    lastError =
      `${response.status} ${response.statusText}` + (detail ? ` — ${detail.slice(0, 400)}` : "");
    if (!RETRYABLE.has(response.status) || attempt === ARC_MAX_RETRIES) break;
    // Honour Retry-After when the server bothers to say; it knows better.
    const after = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(after) && after > 0
      ? after * 1000
      : RETRY_BASE_MS * 2 ** attempt + Math.random() * 400;
    await sleep(waitMs);
  }

  throw new Error(`ARC-AGI-3 ${init.method} ${path} failed: ${lastError}`);
}

export interface ArcGameSummary {
  game_id: string;
  title?: string | null;
  tags?: string[] | null;
}

export async function listGames(options: { apiKey?: string; fetchImpl?: typeof fetch } = {}): Promise<ArcGameSummary[]> {
  return call<ArcGameSummary[]>("/api/games", {
    method: "GET",
    apiKey: requireKey(options.apiKey),
    fetchImpl: options.fetchImpl,
  });
}

export interface OpenScorecardOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  sourceUrl?: string;
  tags?: string[];
  /** Custom metadata, ≤16 KB serialised. The run manifest belongs here. */
  opaque?: Record<string, unknown>;
  competitionMode?: boolean;
  /**
   * The session's cookie jar. Pass the SAME one to `openArcGame` and
   * `closeScorecard`: the load balancer pins this card to one backend and every
   * later call has to reach it. Omit it and the card is unusable — see the
   * affinity note at the top of this file.
   */
  jar?: CookieJar;
}

/**
 * Open a scorecard.
 *
 * TWO OPERATIONAL RULES LIVE ON THIS CALL, and neither is enforceable here —
 * both belong to whatever drives the campaign, so they are written down at the
 * call it constrains rather than in a document nobody opens:
 *
 * 1. **The 15-minute auto-close is NOT a clock on play.** The docs say a card
 *    auto-closes after fifteen minutes, and the obvious reading — that play
 *    stops there — is wrong. Measured against the live API: 220 actions over
 *    17 minutes, every one returning 200, and the close reported `actions: 220`
 *    with `level_actions: [220,0,...]`. Everything after minute fifteen was
 *    recorded. The auto-close finalises an ABANDONED card so its results show
 *    up, which is the same thing rule 2 is about from the other side. Do not
 *    reintroduce a deadline: it cost fifty presses a game for nothing.
 *
 * 2. **Killing the run loses the results.** The docs are explicit that
 *    premature termination stops the scorecard results from being displayed.
 *    Every path out — finishing, throwing, Ctrl-C, SIGTERM — has to reach
 *    `closeScorecard`. A `finally` covers the first two; the signals need
 *    handlers, because Node's default for SIGINT is to exit without unwinding.
 */
export async function openScorecard(options: OpenScorecardOptions = {}): Promise<string> {
  const body = await call<{ card_id: string }>("/api/scorecard/open", {
    method: "POST",
    apiKey: requireKey(options.apiKey),
    fetchImpl: options.fetchImpl,
    jar: options.jar,
    body: {
      ...(options.sourceUrl ? { source_url: options.sourceUrl } : {}),
      ...(options.tags ? { tags: options.tags } : {}),
      ...(options.opaque ? { opaque: options.opaque } : {}),
      ...(options.competitionMode !== undefined ? { competition_mode: options.competitionMode } : {}),
    },
  });
  return body.card_id;
}

/** Close a card. See `openScorecard`: this must run on EVERY exit path, or the
 *  run produces no score at all. */
export async function closeScorecard(
  cardId: string,
  options: { apiKey?: string; fetchImpl?: typeof fetch; jar?: CookieJar } = {},
): Promise<unknown> {
  return call("/api/scorecard/close", {
    method: "POST",
    apiKey: requireKey(options.apiKey),
    fetchImpl: options.fetchImpl,
    jar: options.jar,
    body: { card_id: cardId },
  });
}

export interface ArcApiEnvironment extends ArcEnvironment {
  /** The session id the server assigned. Needed to reset this same game. */
  readonly guid: string;
  /** Restart the level. Costs no action, but the server counts the RESET. */
  reset(): Promise<ArcObservationWithFrame>;
  /** Everything the last frame carried, beyond what ArcObservation exposes. */
  readonly last: ArcObservationWithFrame;
}

/**
 * Open a game and return it as an environment ready for `playLevel`.
 *
 * The RESET happens here rather than lazily inside `observe()`, because
 * `observe()` is contractually forbidden from advancing the game and RESET
 * does — a lazy first observe would be a rule this file's own interface says
 * it must not break.
 */
export async function openArcGame(options: ArcApiOptions): Promise<ArcApiEnvironment> {
  const apiKey = requireKey(options.apiKey);
  // The caller's jar when there is one — it already holds the affinity cookies
  // the scorecard was opened on, and a fresh jar here would land this game on a
  // backend that has never seen that card.
  const jar = options.jar ?? new CookieJar();
  const { gameId, cardId, fetchImpl } = options;

  let latest: ArcObservationWithFrame | null = null;
  let available: string[] = [];
  let guid = "";

  const absorb = (body: FrameResponse): ArcObservationWithFrame => {
    guid = body.guid;
    const stack = Array.isArray(body.frame) ? body.frame : [];
    // Last layer is the current view; a frame with no layers would otherwise
    // hand the policy `undefined` and crash it one call later, far from here.
    const grid: ArcGrid = stack.length > 0 ? stack[stack.length - 1]! : [];
    available = (body.available_actions ?? []).map(actionName);
    latest = {
      grid,
      state: body.state,
      frameStack: stack,
      levelsCompleted: body.levels_completed,
      winLevels: body.win_levels,
    };
    return latest;
  };

  /** After the constructor's RESET this is never null; the cast is that fact. */
  const current = (): ArcObservationWithFrame => latest as ArcObservationWithFrame;

  const reset = async (): Promise<ArcObservationWithFrame> =>
    absorb(
      await call<FrameResponse>("/api/cmd/RESET", {
        method: "POST",
        apiKey,
        jar,
        fetchImpl,
        body: { game_id: gameId, card_id: cardId, ...(guid ? { guid } : {}) },
      }),
    );

  await reset();

  return {
    // A getter, not a snapshot: available_actions changes with every frame and
    // playLevel re-reads this each iteration. See the header.
    get actions(): readonly string[] {
      return available;
    },
    get guid(): string {
      return guid;
    },
    get last(): ArcObservationWithFrame {
      return current();
    },
    observe: () => current(),
    reset,
    act: async (action: string): Promise<ArcObservation> => {
      const parsed = parseAction(action);
      const reasoning = options.reasoning?.();
      return absorb(
        await call<FrameResponse>(`/api/cmd/${parsed.name}`, {
          method: "POST",
          apiKey,
          jar,
          fetchImpl,
          body: {
            game_id: gameId,
            guid,
            ...(parsed.x !== undefined ? { x: parsed.x, y: parsed.y } : {}),
            ...(reasoning !== undefined ? { reasoning } : {}),
          },
        }),
      );
    },
  };
}

/** `6` -> `"ACTION6"`. The server speaks integers; policies speak names. */
function actionName(id: number): string {
  return `ACTION${id}`;
}

/**
 * `"ACTION6:12,30"` -> `{ name: "ACTION6", x: 12, y: 30 }`.
 *
 * Coordinates are validated here, at the boundary, rather than trusted from a
 * policy: the server's range is 0-63 and an out-of-range pair spends a real
 * action to be told so.
 */
export function parseAction(action: string): { name: string; x?: number; y?: number } {
  const colon = action.indexOf(":");
  if (colon === -1) return { name: action };
  const name = action.slice(0, colon);
  const [xs, ys] = action.slice(colon + 1).split(",");
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 63 || y < 0 || y > 63) {
    throw new Error(
      `ARC-AGI-3: "${action}" — coordinates must be two integers in 0..63, e.g. "ACTION6:12,30"`,
    );
  }
  return { name, x, y };
}
