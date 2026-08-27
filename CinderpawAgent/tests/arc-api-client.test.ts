/**
 * The ARC-AGI-3 client, against a fake server.
 *
 * Every case here is a way a run can be lost WITHOUT an error: a dropped
 * affinity cookie, a stale action vocabulary, a frame stack read as a grid.
 * None of those raise; they just produce a bad score that looks like a bad
 * agent. That is why they are pinned.
 */

import { describe, expect, test } from "bun:test";
import { openArcGame, openScorecard, parseAction, listGames, ARC_MAX_RETRIES } from "../src/arc/api-client.ts";
import { playLevel } from "../src/arc/play-level.ts";

interface Recorded {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
  cookie: string | undefined;
  apiKey: string | undefined;
}

/** A fake server. `frames` are handed out in order, last one repeating. */
function server(opts: { frames: unknown[]; setCookie?: string[]; status?: number; text?: string }) {
  const seen: Recorded[] = [];
  let n = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers as HeadersInit);
    seen.push({
      url: String(url),
      method: init.method ?? "GET",
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      cookie: headers.get("Cookie") ?? undefined,
      apiKey: headers.get("X-API-Key") ?? undefined,
    });
    const frame = opts.frames[Math.min(n, opts.frames.length - 1)];
    n++;
    const responseHeaders = new Headers();
    for (const c of opts.setCookie ?? []) responseHeaders.append("Set-Cookie", c);
    return new Response(opts.text ?? JSON.stringify(frame), {
      status: opts.status ?? 200,
      headers: responseHeaders,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const frame = (over: Record<string, unknown> = {}) => ({
  game_id: "ls20-test",
  guid: "guid-1",
  frame: [[[0, 0]], [[1, 2]]],
  state: "NOT_FINISHED",
  levels_completed: 0,
  win_levels: 0,
  available_actions: [1, 2],
  ...over,
});

const open = (fetchImpl: typeof fetch) =>
  openArcGame({ apiKey: "k", gameId: "ls20-test", cardId: "card-1", fetchImpl });

describe("session affinity — the failure that looks like a broken agent", () => {
  test("AWSALB cookies are echoed on every request after the first", async () => {
    const { fetchImpl, seen } = server({
      frames: [frame()],
      setCookie: ["AWSALB=abc; Expires=Wed, 01 Jan 2027 00:00:00 GMT; Path=/", "AWSALBCORS=xyz; Path=/"],
    });
    const env = await open(fetchImpl);
    await env.act("ACTION1");
    await env.act("ACTION2");

    expect(seen[0]!.cookie).toBeUndefined(); // nothing to send yet
    for (const request of seen.slice(1)) {
      expect(request.cookie).toContain("AWSALB=abc");
      expect(request.cookie).toContain("AWSALBCORS=xyz");
    }
  });

  test("attributes are stripped — only name=value is replayed", async () => {
    const { fetchImpl, seen } = server({
      frames: [frame()],
      setCookie: ["AWSALB=abc; Expires=Wed, 01 Jan 2027 00:00:00 GMT; Path=/; HttpOnly"],
    });
    const env = await open(fetchImpl);
    await env.act("ACTION1");
    expect(seen[1]!.cookie).toBe("AWSALB=abc");
  });
});

describe("the frame is a stack, and the vocabulary moves", () => {
  test("the policy is given the LAST layer, not the first and not the stack", async () => {
    const { fetchImpl } = server({ frames: [frame()] });
    const env = await open(fetchImpl);
    expect(env.observe().grid).toEqual([[1, 2]]);
    expect(env.last.frameStack).toHaveLength(2);
  });

  test("available_actions is re-read every frame, not fixed at open", async () => {
    const { fetchImpl } = server({
      frames: [frame({ available_actions: [1, 2] }), frame({ available_actions: [3, 6] })],
    });
    const env = await open(fetchImpl);
    expect([...env.actions]).toEqual(["ACTION1", "ACTION2"]);
    await env.act("ACTION1");
    expect([...env.actions]).toEqual(["ACTION3", "ACTION6"]);
  });

  test("an empty frame yields an empty grid rather than undefined", async () => {
    const { fetchImpl } = server({ frames: [frame({ frame: [] })] });
    const env = await open(fetchImpl);
    expect(env.observe().grid).toEqual([]);
  });
});

describe("the wire format", () => {
  test("RESET omits guid on the first call and sends it on a later reset", async () => {
    const { fetchImpl, seen } = server({ frames: [frame()] });
    const env = await open(fetchImpl);
    expect(seen[0]!.url).toBe("https://three.arcprize.org/api/cmd/RESET");
    expect(seen[0]!.body).toEqual({ game_id: "ls20-test", card_id: "card-1" });
    await env.reset();
    expect(seen[1]!.body).toEqual({ game_id: "ls20-test", card_id: "card-1", guid: "guid-1" });
  });

  test("an action posts to its own endpoint carrying game_id and guid", async () => {
    const { fetchImpl, seen } = server({ frames: [frame()] });
    const env = await open(fetchImpl);
    await env.act("ACTION2");
    expect(seen[1]!.url).toBe("https://three.arcprize.org/api/cmd/ACTION2");
    expect(seen[1]!.body).toEqual({ game_id: "ls20-test", guid: "guid-1" });
    expect(seen[1]!.apiKey).toBe("k");
  });

  test("ACTION6 carries x and y, and reasoning rides along when supplied", async () => {
    const { fetchImpl, seen } = server({ frames: [frame({ available_actions: [6] })] });
    const env = await openArcGame({
      apiKey: "k",
      gameId: "ls20-test",
      cardId: "card-1",
      fetchImpl,
      reasoning: () => ({ why: "corner" }),
    });
    await env.act("ACTION6:12,30");
    expect(seen[1]!.body).toEqual({
      game_id: "ls20-test",
      guid: "guid-1",
      x: 12,
      y: 30,
      reasoning: { why: "corner" },
    });
  });

  test("openScorecard returns the card_id and passes competition_mode through", async () => {
    const { fetchImpl, seen } = server({ frames: [{ card_id: "card-9" }] });
    const id = await openScorecard({ apiKey: "k", fetchImpl, competitionMode: true, tags: ["t"] });
    expect(id).toBe("card-9");
    expect(seen[0]!.url).toBe("https://three.arcprize.org/api/scorecard/open");
    expect(seen[0]!.body).toEqual({ tags: ["t"], competition_mode: true });
  });
});

describe("failing loudly instead of scoring badly", () => {
  test("a missing key names the environment variable and where to get one", async () => {
    const previous = process.env.ARC_API_KEY;
    delete process.env.ARC_API_KEY;
    try {
      await expect(listGames({})).rejects.toThrow(/ARC_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.ARC_API_KEY = previous;
    }
  });

  test("an HTTP error carries the server's own explanation", async () => {
    const { fetchImpl } = server({ frames: [], status: 403, text: "scorecard is closed" });
    await expect(open(fetchImpl)).rejects.toThrow(/403.*scorecard is closed/s);
  });

  test("out-of-range coordinates are refused before an action is spent", () => {
    expect(() => parseAction("ACTION6:64,0")).toThrow(/0\.\.63/);
    expect(() => parseAction("ACTION6:1")).toThrow(/0\.\.63/);
    expect(parseAction("ACTION1")).toEqual({ name: "ACTION1" });
  });
});

describe("it is an ArcEnvironment — the loop runs on it unchanged", () => {
  test("playLevel drives the client and stops on WIN", async () => {
    const { fetchImpl, seen } = server({
      frames: [frame(), frame(), frame({ state: "WIN" })],
    });
    const env = await open(fetchImpl);
    const result = await playLevel({ env, policy: () => "ACTION1", maxActions: 10 });
    expect(result.state).toBe("WIN");
    expect(result.actions).toEqual(["ACTION1", "ACTION1"]);
    // One RESET plus exactly the two actions it reported. An extra request here
    // would be an action spent off the books.
    expect(seen).toHaveLength(3);
  });
});

/**
 * Surviving a bad minute.
 *
 * Running 25 games at once, ten died on `500 — the server is overloaded` inside
 * the first minute, most before their second action. One bad response out of
 * hundreds threw away every level of those games.
 */
describe("api-client — retrying a server that is briefly unwell", () => {
  const okFrame = {
    guid: "g1",
    state: "NOT_FINISHED",
    frame: [[[1, 2], [3, 4]]],
    score: 0,
    levels_completed: 0,
    win_levels: 3,
    available_actions: [1],
  };

  function flaky(failures: number, status = 500) {
    let calls = 0;
    const fetchImpl = (async (_url: string, _init: RequestInit) => {
      calls++;
      if (calls <= failures) {
        return new Response("overloaded", { status, statusText: "Internal Server Error" });
      }
      return new Response(JSON.stringify(okFrame), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  test("a transient 500 does not end the game", async () => {
    const f = flaky(2);
    const env = await openArcGame({ gameId: "g", cardId: "c", apiKey: "k", fetchImpl: f.fetchImpl });
    expect(env.last.state).toBe("NOT_FINISHED");
    expect(f.calls()).toBe(3); // two failures, then the answer
  });

  test("a 429 is retried too — being throttled is not being wrong", async () => {
    const f = flaky(1, 429);
    const env = await openArcGame({ gameId: "g", cardId: "c", apiKey: "k", fetchImpl: f.fetchImpl });
    expect(env.last.state).toBe("NOT_FINISHED");
    expect(f.calls()).toBe(2);
  });

  test("a 400 is NOT retried: repeating a wrong request just repeats it", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("bad game id", { status: 400, statusText: "Bad Request" });
    }) as unknown as typeof fetch;
    await expect(
      openArcGame({ gameId: "nope", cardId: "c", apiKey: "k", fetchImpl }),
    ).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  // Generous timeout on purpose: this one walks the REAL backoff ladder
  // (800ms, 1.6s, 3.2s, 6.4s), which is the behaviour under test. Faking the
  // clock here would pin the retry count and prove nothing about the waiting,
  // and the waiting is what stopped 25 processes rebuilding the same spike.
  test("gives up eventually, and says what it last saw", async () => {
    const f = flaky(99);
    await expect(
      openArcGame({ gameId: "g", cardId: "c", apiKey: "k", fetchImpl: f.fetchImpl }),
    ).rejects.toThrow(/500/);
    expect(f.calls()).toBe(ARC_MAX_RETRIES + 1);
  }, 30_000);
});
