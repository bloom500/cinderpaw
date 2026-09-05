/**
 * Public-journal serializer + exporter.
 *
 * The subject under test is a privacy boundary, so most of these tests are
 * adversarial: they hand `toPublicEvent` a journal row carrying the things that
 * must never reach the internet — filesystem paths, prompt text, model output,
 * API keys — and assert the published event does not contain them anywhere.
 *
 * The rows used below are shaped like real ones from `~/.cinderpaw/rsi/journal/`,
 * including the fields the engine leaves empty in practice.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPublicSafe,
  METRIC_RANGES,
  publicRef,
  PUBLIC_EVENT_SCHEMA_VERSION,
  toPublicEvent,
  toPublicHeartbeat,
} from "../src/public-journal/public-event.ts";
import {
  assertTransportSafe,
  buildPayload,
  collectEvents,
  readCursor,
  WORKING_WINDOW_MS,
  writeCursor,
} from "../src/public-journal/exporter.ts";

/** A row in the exact shape the live engine writes. */
function journalRow(overrides: Record<string, unknown> = {}) {
  return {
    cycleId: "c-2026-08-11T08:33:47.800Z",
    timestamp: 1786437227900,
    durationMin: 0.0005,
    observed: [],
    hypothesized: [],
    experimented: { candidateId: "seed-conservative", change: "", layer: "L1" },
    result: {
      fitnessVector: {
        accuracy: 0.5,
        latency: 0.5,
        cost: 0.5,
        toolSuccess: 0,
        hallucination: 0.923,
        userSatisfaction: 0.5,
      },
      aggregate: 0.5,
      confidence: 1,
      tier0: "passed",
      tier1: "no_regression",
    },
    decided: { action: "reject", reason: "ratchet declined: candidate scored 50, main already scores 62 (strictly greater required)", nextStep: "try another" },
    budgetRemaining: { wallClockMin: 30, tokens: 100000, cpuPct: 50, ramMb: 2048, diskMb: 5120 },
    prevHash: "GENESIS",
    hash: "3a722a6c99de2e206c31d7cb7d3ff70c95cbd18a65a3825a361960d704954b24",
    ...overrides,
  };
}

/** Everything in the event, flattened, for "does this string appear anywhere". */
function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe("toPublicEvent — mapping", () => {
  test("maps a real reject row", () => {
    const event = toPublicEvent(journalRow(), "cubby")!;
    expect(event).not.toBeNull();
    expect(event.type).toBe("evolution.rejected");
    expect(event.layer).toBe("L1");
    expect(event.publisher).toBe("cubby");
    expect(event.ts).toBe(1786437227900);
    expect(event.schemaVersion).toBe(PUBLIC_EVENT_SCHEMA_VERSION);
    expect(event.metrics.aggregate).toBe(0.5);
    expect(event.metrics.confidence).toBe(1);
    expect(event.checks.tier0).toBe("passed");
    expect(event.checks.tier1).toBe("no_regression");
  });

  test("maps accept and halt to their own types", () => {
    const accepted = toPublicEvent(
      journalRow({ decided: { action: "accept", reason: "ratcheted" } }),
      "cubby",
    )!;
    expect(accepted.type).toBe("evolution.promoted");

    const halted = toPublicEvent(
      journalRow({ decided: { action: "halt", reason: "budget", stage: "evaluate" } }),
      "cubby",
    )!;
    expect(halted.type).toBe("evolution.halted");
  });

  test("event id is deterministic, so a replayed row is the same event", () => {
    const a = toPublicEvent(journalRow(), "cubby")!;
    const b = toPublicEvent(journalRow(), "cubby")!;
    expect(a.id).toBe(b.id);
  });

  test("rows sharing a cycleId are distinct events — the engine writes several per cycle", () => {
    const a = toPublicEvent(journalRow({ hash: "aaaa1111" }), "cubby")!;
    const b = toPublicEvent(journalRow({ hash: "bbbb2222" }), "cubby")!;
    expect(a.id).not.toBe(b.id);
  });

  test("legacy rows with no hash fall back to cycle+timestamp+decision", () => {
    const a = toPublicEvent(journalRow({ hash: undefined, timestamp: 1786437227900 }), "cubby")!;
    const b = toPublicEvent(journalRow({ hash: undefined, timestamp: 1786437227901 }), "cubby")!;
    expect(a.id).not.toBe(b.id);

    const repeat = toPublicEvent(journalRow({ hash: undefined, timestamp: 1786437227900 }), "cubby")!;
    expect(repeat.id).toBe(a.id);
  });

  test("the raw chain hash is never published", () => {
    const event = toPublicEvent(journalRow({ hash: "deadbeefcafe1234" }), "cubby")!;
    expect(serialized(event)).not.toContain("deadbeefcafe");
  });

  test("the same cycle published by a different publisher is a different event", () => {
    const cubby = toPublicEvent(journalRow(), "cubby")!;
    const paw = toPublicEvent(journalRow(), "paw")!;
    expect(cubby.id).not.toBe(paw.id);
  });

  test("summary is generated, never copied from the row", () => {
    const event = toPublicEvent(journalRow(), "cubby")!;
    expect(event.summary).toBe("Layer L1 evaluated a candidate at fitness 0.500 and kept the incumbent.");
  });
});

describe("toPublicEvent — rejects rows it cannot publish", () => {
  const badRows: ReadonlyArray<[string, unknown]> = [
    ["null", null],
    ["a string", "not a row"],
    ["an array", []],
    ["a row with no cycleId", journalRow({ cycleId: undefined })],
    ["a row with a non-string cycleId", journalRow({ cycleId: 42 })],
    ["a row with no timestamp", journalRow({ timestamp: undefined })],
    ["a row with a NaN timestamp", journalRow({ timestamp: NaN })],
    ["a row with a negative timestamp", journalRow({ timestamp: -1 })],
    ["a row with no decision", journalRow({ decided: undefined })],
    ["a row with an unknown decision", journalRow({ decided: { action: "explode" } })],
  ];

  for (const [name, row] of badRows) {
    test(`returns null for ${name}`, () => {
      expect(toPublicEvent(row, "cubby")).toBeNull();
    });
  }
});

describe("toPublicEvent — the privacy boundary", () => {
  test("free-text journal fields never appear in the event", () => {
    const secrets = {
      observed: ["user asked about C:\\Users\\Darius\\taxes.xlsx"],
      hypothesized: ["the system prompt should mention his employer"],
      experimented: {
        candidateId: "patch-for-/home/darius/.ssh/config",
        change: "rewrote the prompt to say 'you are Darius from Bloom Media'",
        layer: "L3",
      },
      decided: {
        action: "reject",
        reason: "failed on OPENAI_API_KEY=sk-abcdefghijklmnop",
        nextStep: "email darius@bloommedia.example",
      },
    };
    const event = toPublicEvent(journalRow(secrets), "cubby")!;
    const text = serialized(event);

    expect(text).not.toContain("taxes.xlsx");
    expect(text).not.toContain("Darius");
    expect(text).not.toContain("employer");
    expect(text).not.toContain(".ssh");
    expect(text).not.toContain("sk-abcdefghijklmnop");
    expect(text).not.toContain("bloommedia");
    expect(text).not.toContain("Bloom Media");
    expect(text).not.toContain("rewrote the prompt");
  });

  test("candidateId is published as a hash, not a name", () => {
    const event = toPublicEvent(
      journalRow({ experimented: { candidateId: "seed-conservative", layer: "L1" } }),
      "cubby",
    )!;
    expect(event.candidateRef).toBe(publicRef("seed-conservative"));
    expect(event.candidateRef).not.toContain("seed");
    expect(event.candidateRef).toMatch(/^[0-9a-f]{12}$/);
  });

  test("the published object has exactly the schema's keys and no others", () => {
    const event = toPublicEvent(journalRow({ secretSideChannel: "sk-leakleakleak" }), "cubby")!;
    expect(Object.keys(event).sort()).toEqual(
      [
        "candidateRef",
        "checks",
        "cycleRef",
        "id",
        "layer",
        "metrics",
        "publisher",
        "schemaVersion",
        "summary",
        "ts",
        "type",
      ].sort(),
    );
    expect(serialized(event)).not.toContain("leakleak");
  });

  test("an unknown layer publishes as null rather than as itself", () => {
    const event = toPublicEvent(
      journalRow({ experimented: { candidateId: "x", layer: "L9-internal-debug" } }),
      "cubby",
    )!;
    expect(event.layer).toBeNull();
    expect(serialized(event)).not.toContain("internal-debug");
  });
});

describe("toPublicEvent — metric validation", () => {
  test("drops metrics that are not finite numbers", () => {
    const event = toPublicEvent(
      journalRow({
        result: {
          aggregate: NaN,
          confidence: Infinity,
          fitnessVector: { accuracy: "0.9", latency: null, cost: undefined },
          tier0: "passed",
        },
      }),
      "cubby",
    )!;
    expect(event.metrics.aggregate).toBeUndefined();
    expect(event.metrics.confidence).toBeUndefined();
    expect(event.metrics.accuracy).toBeUndefined();
    expect(event.metrics.latency).toBeUndefined();
    expect(event.metrics.cost).toBeUndefined();
  });

  test("drops out-of-range metrics rather than clamping them", () => {
    const event = toPublicEvent(
      journalRow({ result: { aggregate: 42, confidence: -1, tier0: "passed" } }),
      "cubby",
    )!;
    expect(event.metrics.aggregate).toBeUndefined();
    expect(event.metrics.confidence).toBeUndefined();
  });

  test("every declared metric range is a valid interval", () => {
    for (const [key, [lo, hi]] of Object.entries(METRIC_RANGES)) {
      expect(lo, `${key} lower bound`).toBeLessThan(hi);
    }
  });

  test("rounds to four decimals", () => {
    const event = toPublicEvent(
      journalRow({ result: { aggregate: 0.9230769230769231, tier0: "passed" } }),
      "cubby",
    )!;
    expect(event.metrics.aggregate).toBe(0.9231);
  });

  test("drops unknown tier verdicts", () => {
    const event = toPublicEvent(
      journalRow({ result: { aggregate: 0.5, tier0: "probably fine", tier1: "who knows" } }),
      "cubby",
    )!;
    expect(event.checks.tier0).toBeUndefined();
    expect(event.checks.tier1).toBeUndefined();
  });
});

describe("assertPublicSafe", () => {
  const forbidden: ReadonlyArray<[string, string]> = [
    ["windows path", "C:\\Users\\Darius"],
    ["unix path", "read /home/darius/notes.md"],
    ["openai key", "sk-abcdefghijklmnopqrstuv"],
    ["github token", "ghp_abcdefghijklmnopqrst"],
    ["slack token", "xoxb-1234567890-abcdef"],
    ["aws key", "AKIAIOSFODNN7EXAMPLE"],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
    ["jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload"],
    ["env var", "set ${DATABASE_URL} first"],
    ["email", "darius@example.com"],
    ["ip address", "192.168.1.14"],
    ["auth header", "Bearer sometokenvalue"],
  ];

  for (const [name, value] of forbidden) {
    test(`throws on a ${name}`, () => {
      expect(() => assertPublicSafe({ summary: value })).toThrow();
    });
  }

  test("finds a secret nested anywhere", () => {
    expect(() => assertPublicSafe({ a: [{ b: { c: "sk-abcdefghijklmnop" } }] })).toThrow();
  });

  test("passes a clean generated event", () => {
    expect(() => assertPublicSafe(toPublicEvent(journalRow(), "cubby"))).not.toThrow();
  });
});

describe("toPublicHeartbeat", () => {
  test("reports working when told the runtime is working", () => {
    const beat = toPublicHeartbeat({ publisher: "cubby", ts: 1786437227900, working: true });
    expect(beat.state).toBe("working");
  });

  test("reports online when idle — never sleeping", () => {
    const beat = toPublicHeartbeat({ publisher: "cubby", ts: 1786437227900, working: false });
    expect(beat.state).toBe("online");
  });

  test("drops a version string that is not version-shaped", () => {
    const beat = toPublicHeartbeat({
      publisher: "cubby",
      ts: 1786437227900,
      working: false,
      agentVersion: "built from C:\\dev\\cinderpaw",
    });
    expect(beat.agentVersion).toBeNull();
  });

  test("keeps a normal version", () => {
    const beat = toPublicHeartbeat({
      publisher: "cubby",
      ts: 1786437227900,
      working: false,
      agentVersion: "2026.8.11",
    });
    expect(beat.agentVersion).toBe("2026.8.11");
  });
});

describe("collectEvents", () => {
  /** A journal directory with the given files, each an array of rows. */
  function fixtureDir(files: Record<string, unknown[]>): string {
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-journal-"));
    for (const [name, rows] of Object.entries(files)) {
      writeFileSync(dir + "/" + name, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    }
    return dir;
  }

  test("returns nothing for a missing directory", () => {
    const result = collectEvents({
      journalDir: join(tmpdir(), "definitely-not-here-" + Date.now()),
      publisher: "cubby",
      since: 0,
    });
    expect(result.events).toEqual([]);
    expect(result.cursor.lastTimestamp).toBe(0);
  });

  test("only collects rows newer than the cursor", () => {
    const dir = fixtureDir({
      "journal-2026-08-10.jsonl": [
        journalRow({ cycleId: "old", timestamp: 1000000000000 }),
        journalRow({ cycleId: "new", timestamp: 1786437227900 }),
      ],
    });
    const result = collectEvents({ journalDir: dir, publisher: "cubby", since: 1500000000000 });
    expect(result.events).toHaveLength(1);
    expect(result.cursor.lastTimestamp).toBe(1786437227900);
  });

  test("skips malformed lines instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-journal-"));
    writeFileSync(
      join(dir, "journal-2026-08-11.jsonl"),
      [
        JSON.stringify(journalRow({ cycleId: "good", timestamp: 1786437227900 })),
        "{ this is not json",
        "",
        JSON.stringify({ cycleId: "no-decision", timestamp: 1786437227901 }),
        JSON.stringify(journalRow({ cycleId: "good2", timestamp: 1786437227902 })),
      ].join("\n"),
      "utf8",
    );
    const result = collectEvents({ journalDir: dir, publisher: "cubby", since: 0 });
    expect(result.events).toHaveLength(2);
    expect(result.skipped).toBe(2);
  });

  test("honours the batch limit and leaves the rest for the next run", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      journalRow({ cycleId: `c${i}`, timestamp: 1786437227900 + i }),
    );
    const dir = fixtureDir({ "journal-2026-08-11.jsonl": rows });
    const result = collectEvents({ journalDir: dir, publisher: "cubby", since: 0, limit: 4 });
    expect(result.events).toHaveLength(4);
    expect(result.cursor.lastTimestamp).toBe(1786437227903);
  });

  test("reads files in chronological order", () => {
    const dir = fixtureDir({
      "journal-2026-08-11.jsonl": [journalRow({ cycleId: "later", timestamp: 1786437227999 })],
      "journal-2026-08-09.jsonl": [journalRow({ cycleId: "earlier", timestamp: 1786437227111 })],
    });
    const result = collectEvents({ journalDir: dir, publisher: "cubby", since: 0 });
    expect(result.events.map((e) => e.ts)).toEqual([1786437227111, 1786437227999]);
  });
});

describe("cursor", () => {
  test("a missing cursor reads as zero, so nothing is skipped", () => {
    expect(readCursor(join(tmpdir(), "nope-" + Date.now()))).toEqual({ lastTimestamp: 0 });
  });

  test("a corrupt cursor resets to zero rather than skipping history", () => {
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-cursor-"));
    const file = join(dir, "cursor.json");
    writeFileSync(file, "{ not json", "utf8");
    expect(readCursor(file)).toEqual({ lastTimestamp: 0 });

    writeFileSync(file, JSON.stringify({ lastTimestamp: "yesterday" }), "utf8");
    expect(readCursor(file)).toEqual({ lastTimestamp: 0 });
  });

  test("round-trips a written cursor", () => {
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-cursor-"));
    const file = join(dir, "nested", "cursor.json");
    writeCursor(file, { lastTimestamp: 1786437227900 });
    expect(readCursor(file)).toEqual({ lastTimestamp: 1786437227900 });
  });
});

describe("buildPayload", () => {
  const now = 1786437300000;

  test("says working when the journal moved recently", () => {
    const payload = buildPayload({
      publisher: "cubby",
      events: [],
      now,
      newestTimestamp: now - 1000,
      agentVersion: null,
    });
    expect(payload.heartbeat.state).toBe("working");
  });

  test("says online when the last activity is outside the window", () => {
    const payload = buildPayload({
      publisher: "cubby",
      events: [],
      now,
      newestTimestamp: now - WORKING_WINDOW_MS - 1,
      agentVersion: null,
    });
    expect(payload.heartbeat.state).toBe("online");
  });

  test("a zero-event payload is still valid — it is the liveness signal", () => {
    const payload = buildPayload({
      publisher: "cubby",
      events: [],
      now,
      newestTimestamp: 0,
      agentVersion: "2026.8.11",
    });
    expect(payload.events).toEqual([]);
    expect(payload.heartbeat.publisher).toBe("cubby");
  });
});

describe("assertTransportSafe", () => {
  test("allows https", () => {
    expect(() => assertTransportSafe("https://cinderpaw.example/api/x")).not.toThrow();
  });

  test("allows plain http on localhost, for the local demo", () => {
    expect(() => assertTransportSafe("http://localhost:3000/api/x")).not.toThrow();
    expect(() => assertTransportSafe("http://127.0.0.1:3000/api/x")).not.toThrow();
  });

  test("refuses to send the token over plain http to a remote host", () => {
    expect(() => assertTransportSafe("http://cinderpaw.example/api/x")).toThrow(/plain HTTP/);
  });

  test("refuses a URL it cannot parse", () => {
    expect(() => assertTransportSafe("not a url")).toThrow();
  });
});
