/**
 * The live status message must never outlive the answer.
 *
 * Observed 2026-08-04 on a real Discord turn: a deep-research reply came back
 * with its first 2000-character chunk replaced by the last status line
 * ("🤝 subagent ✓ read_webpage"), so the report started mid-sentence with no
 * heading. Nothing errored — the status edit was fired without awaiting, sat in
 * discord.js's rate-limit queue, and landed after the answer.
 *
 * These tests model that queue with a slow `edit`, so a regression fails here
 * instead of eating the beginning of someone's answer.
 */

import { describe, expect, test } from "bun:test";
import { statusMessage } from "../src/transports/connectors.ts";

/**
 * A Discord message whose edits take `latencyFor(nth)` to apply. Latency varies
 * per call on purpose: discord.js holds edits behind its own rate limiter, so an
 * edit issued FIRST can be applied LAST. A fixed latency would let a broken
 * implementation pass by accident.
 */
function fakeMessage(latencyFor: number | ((nth: number) => number)) {
  const latency = typeof latencyFor === "number" ? () => latencyFor : latencyFor;
  const applied: string[] = [];
  let issued = 0;
  let content = "";
  const edit = async (text: string) => {
    await new Promise((r) => setTimeout(r, latency(issued++)));
    content = text;
    applied.push(text);
  };
  return { edit, applied, get content() { return content; } };
}

describe("statusMessage", () => {
  test("a status edit still in flight cannot overwrite the answer", async () => {
    // The status edit is rate-limited and held 200ms; the answer would go
    // through in 5ms. This is the exact shape of the observed bug: issue order
    // and apply order disagree, so the answer must WAIT, not just be issued.
    const msg = fakeMessage((nth) => (nth === 0 ? 200 : 5));
    // throttleMs 0 so the status edit fires immediately, like a tool event
    // arriving just before the model's final token.
    const status = statusMessage(msg.edit, { throttleMs: 0 });

    status.set("🤝 subagent ✓ read_webpage");
    await status.settle("THE ANSWER");
    // Asserting the instant settle() resolves would pass even when the held
    // status edit is still coming — which is exactly how this shipped. Wait out
    // the queue: after settle returns, nothing may change the message.
    await new Promise((r) => setTimeout(r, 250));

    expect(msg.content).toBe("THE ANSWER");
    expect(msg.applied.at(-1)).toBe("THE ANSWER");
  });

  test("a status edit queued but not yet fired never fires after settle", async () => {
    const msg = fakeMessage(1);
    const status = statusMessage(msg.edit, { throttleMs: 20 });

    status.set("first"); // fires now (no previous edit)
    status.set("second"); // throttled — waits on a timer
    await status.settle("THE ANSWER");
    // Long enough for the cancelled timer to have fired had it survived.
    await new Promise((r) => setTimeout(r, 60));

    expect(msg.content).toBe("THE ANSWER");
    expect(msg.applied).not.toContain("second");
  });

  test("set() after settle is ignored — the answer owns the message", async () => {
    const msg = fakeMessage(1);
    const status = statusMessage(msg.edit, { throttleMs: 0 });

    await status.settle("THE ANSWER");
    status.set("🐾 thinking…");
    await new Promise((r) => setTimeout(r, 30));

    expect(msg.content).toBe("THE ANSWER");
  });

  test("a failed status edit is reported, not swallowed", async () => {
    const errors: unknown[] = [];
    const status = statusMessage(async () => {
      throw new Error("unknown message");
    }, { throttleMs: 0, onError: (e) => errors.push(e) });

    status.set("🐾 thinking…");
    await status.settle("THE ANSWER"); // must not throw
    expect(errors).toHaveLength(2);
  });

  test("status still shows while the agent works (throttled, not blocked)", async () => {
    const msg = fakeMessage(1);
    const status = statusMessage(msg.edit, { throttleMs: 0 });

    status.set("🔎 searching");
    await new Promise((r) => setTimeout(r, 10));
    status.set("📖 reading");
    await new Promise((r) => setTimeout(r, 10));

    expect(msg.applied).toEqual(["🔎 searching", "📖 reading"]);
  });
});
