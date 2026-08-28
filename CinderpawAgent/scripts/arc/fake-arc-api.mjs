/**
 * A fake three.arcprize.org, and the games to play on it.
 *
 * Lives in its own file because two callers need it and neither should have to
 * run the other: `stress_100.mjs` drives the client library a hundred times,
 * and `fake-arc-preload.mjs` swaps it in for the global `fetch` so
 * `run_arc_agi3.mjs` — the script that actually spends the money — can be run
 * end to end for free before it is trusted with any.
 *
 * It is an AUDITOR, not a stub. It refuses any action that was not in the frame
 * it just sent, any action after a terminal state, a bare ACTION6, a guid it
 * never issued, and any request that lost the session cookie. Each refusal is
 * pushed onto the `violations` array the caller hands in, so a leak that a
 * client-side assertion would have to guess at arrives as a 4xx from the only
 * party that knows the truth.
 */

/** Deterministic RNG. Same seed, same hundred games, forever. */
export function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export const GRID = 10;
const EMPTY = 0, WALL = 1, AGENT = 3, GOAL = 4, MARK = 5;
const MAX_STEPS = 60;

/**
 * One game: an agent walks to a goal, three levels deep.
 *
 * Winnable by a greedy walker on purpose. The question this script asks is not
 * whether the policy is clever, it is whether a hundred games leave anything of
 * themselves behind in the hundred-and-first.
 */
export function makeGame(id, rnd) {
  /**
   * A colour unique to this game, painted in one cell of every frame. If it
   * ever appears in another game's frames, state crossed a boundary that has
   * no bridge — and unlike a counter, a colour cannot be explained away.
   */
  const brand = 6 + (id % 10);
  const walls = [];
  for (let i = 0; i < 8; i++) walls.push([1 + Math.floor(rnd() * (GRID - 2)), 1 + Math.floor(rnd() * (GRID - 2))]);
  // Every seventh game is UNWINNABLE: the goal is bricked in. Without a few of
  // these the GAME_OVER path, the RESET, and the retry after it are never
  // reached, and a hundred clean wins would prove nothing about the branch that
  // actually runs when a real game goes wrong.
  const impossible = id % 7 === 0;
  if (impossible) walls.push([GRID - 2, GRID - 1], [GRID - 1, GRID - 2]);
  const build = () => {
    const g = Array.from({ length: GRID }, () => Array(GRID).fill(EMPTY));
    for (const [r, c] of walls) g[r][c] = WALL;
    g[GRID - 1][GRID - 1] = GOAL;
    g[0][GRID - 1] = brand;
    g[0][0] = AGENT;
    return g;
  };
  return { id: `game-${id}`, index: id, brand, build, levels: 3, impossible };
}

/** The fake three.arcprize.org. Auditor, not stub. */
export function makeServer(games, violations) {
  const cards = new Map();
  const sessions = new Map();
  let ids = 0;
  let requests = 0;
  const say = (what) => violations.push(what);

  /**
   * available_actions CHANGES PER FRAME — the docs say so and the client's
   * `actions` getter exists for it. ACTION5 is offered only on even steps, so
   * anything caching the first frame's list gets caught red-handed.
   */
  const availableFor = (s) => (s.steps % 2 === 0 ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 6]);

  const place = (s) => {
    s.grid = s.game.build();
    s.pos = { r: 0, c: 0 };
    s.steps = 0;
    s.available = availableFor(s);
  };

  const frameOf = (s) => ({
    game_id: s.gameId,
    guid: s.guid,
    // A STACK of grids, newest last: the shape the real server sends, and the
    // one place a client that assumes number[][] breaks silently.
    frame: [s.grid.map((r) => [...r])],
    state: s.state,
    levels_completed: s.levelsCompleted,
    win_levels: s.game.levels,
    available_actions: s.available,
  });

  const json = (body, status = 200, setCookie) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (setCookie) headers.append("set-cookie", setCookie);
    return new Response(JSON.stringify(body), {
      status,
      statusText: status === 200 ? "OK" : "ERR",
      headers,
    });
  };

  return async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    const headers = init.headers ?? {};
    const cookie = headers.Cookie ?? headers.cookie;
    if (!headers["X-API-Key"]) {
      say("request carried no X-API-Key");
      return json({ error: "no key" }, 401);
    }

    if (path === "/api/games") {
      return json([...games.values()].map((g) => ({ game_id: g.id, title: `fake ${g.id}` })));
    }
    if (path === "/api/scorecard/open") {
      const id = `card-${++ids}`;
      cards.set(id, { closed: false, actionsByGame: new Map() });
      return json({ card_id: id }, 200, `AWSALB=${id}; Path=/; HttpOnly`);
    }
    if (path === "/api/scorecard/close") {
      const card = cards.get(body.card_id);
      if (!card) {
        say(`close of unknown card ${body.card_id}`);
        return json({ error: "no card" }, 404);
      }
      if (card.closed) say(`card ${body.card_id} closed twice`);
      card.closed = true;
      return json({
        card_id: body.card_id,
        actions: [...card.actionsByGame.values()].reduce((a, b) => a + b, 0),
        per_game: Object.fromEntries(card.actionsByGame),
      });
    }

    /** Session affinity: every play request must echo the card's cookie. */
    const pinned = /AWSALB=([^;]+)/.exec(cookie ?? "")?.[1];

    if (path === "/api/cmd/RESET") {
      const card = cards.get(body.card_id);
      if (!card) {
        say(`RESET on unknown card ${body.card_id}`);
        return json({ error: "scorecard not found" }, 400);
      }
      if (card.closed) {
        say(`RESET on a CLOSED card ${body.card_id}`);
        return json({ error: "closed" }, 400);
      }
      if (pinned !== body.card_id) {
        say(`RESET reached the wrong backend: cookie said ${pinned}, card is ${body.card_id}`);
        return json({ error: `game ${body.game_id} not found` }, 400);
      }
      let s = body.guid ? sessions.get(body.guid) : null;
      if (body.guid && !s) {
        say(`RESET with a guid the server never issued: ${body.guid}`);
        return json({ error: "no guid" }, 400);
      }
      if (!s) {
        const game = games.get(body.game_id);
        if (!game) {
          say(`RESET on unknown game ${body.game_id}`);
          return json({ error: "game not found" }, 400);
        }
        s = {
          guid: `guid-${++ids}`,
          gameId: body.game_id,
          cardId: body.card_id,
          game,
          state: "NOT_FINISHED",
          levelsCompleted: 0,
        };
        sessions.set(s.guid, s);
      } else {
        // A retry is a LEVEL reset in competition mode: cleared levels stay
        // cleared, which is exactly what run_arc_agi3.mjs relies on.
        s.state = "NOT_FINISHED";
      }
      place(s);
      return json(frameOf(s));
    }

    const m = /^\/api\/cmd\/ACTION(\d)$/.exec(path);
    if (m) {
      // A flaky server, on a schedule rather than at random, so the retry
      // ladder is exercised identically on every seed.
      requests++;
      if (requests % 37 === 0) return json({ error: "the server is overloaded" }, 500);

      const s = sessions.get(body.guid);
      if (!s) {
        say(`ACTION with a guid the server never issued: ${body.guid}`);
        return json({ error: "no guid" }, 400);
      }
      if (pinned !== s.cardId) {
        say(`ACTION reached the wrong backend: cookie said ${pinned}, card is ${s.cardId}`);
        return json({ error: "game not found" }, 400);
      }
      const card = cards.get(s.cardId);
      if (card.closed) {
        say("ACTION on a CLOSED card");
        return json({ error: "closed" }, 400);
      }
      const n = Number(m[1]);
      if (!s.available.includes(n)) {
        say(`STALE ACTION: ACTION${n} on ${s.gameId} step ${s.steps}, offered ${s.available.join("/")}`);
        return json({ error: "action not available" }, 400);
      }
      if (s.state === "WIN" || s.state === "GAME_OVER") {
        say(`ACTION after terminal state ${s.state} on ${s.gameId}`);
        return json({ error: "terminal" }, 400);
      }
      if (n === 6 && (body.x === undefined || body.y === undefined)) {
        say("a bare ACTION6 reached the server");
        return json({ error: "internal" }, 500);
      }
      if (n === 6 && !(Number.isInteger(body.x) && Number.isInteger(body.y) && body.x >= 0 && body.x <= 63 && body.y >= 0 && body.y <= 63)) {
        say(`ACTION6 out of range: ${body.x},${body.y}`);
        return json({ error: "range" }, 400);
      }

      card.actionsByGame.set(s.gameId, (card.actionsByGame.get(s.gameId) ?? 0) + 1);
      s.steps++;

      const delta = { 1: [-1, 0], 2: [1, 0], 3: [0, -1], 4: [0, 1] }[n];
      if (delta) {
        const r = Math.min(GRID - 1, Math.max(0, s.pos.r + delta[0]));
        const c = Math.min(GRID - 1, Math.max(0, s.pos.c + delta[1]));
        if (s.grid[r][c] !== WALL) {
          s.grid[s.pos.r][s.pos.c] = EMPTY;
          s.pos = { r, c };
        }
      } else if (n === 5) {
        s.grid[s.pos.r][s.pos.c] = MARK;
      }

      if (s.pos.r === GRID - 1 && s.pos.c === GRID - 1) {
        s.levelsCompleted++;
        s.state = "WIN";
        // Not the last level: the next one is dealt immediately, and the state
        // stays WIN so the runner's "keep playing after a WIN" loop is the
        // thing being tested rather than a convenience.
        if (s.levelsCompleted < s.game.levels) place(s);
        s.state = "WIN";
      } else if (s.steps >= MAX_STEPS) {
        s.state = "GAME_OVER";
        s.grid[s.pos.r][s.pos.c] = AGENT;
      } else {
        s.grid[s.pos.r][s.pos.c] = AGENT;
      }
      s.available = availableFor(s);
      return json(frameOf(s));
    }

    say(`unexpected path ${path}`);
    return json({ error: "no route" }, 404);
  };
}

