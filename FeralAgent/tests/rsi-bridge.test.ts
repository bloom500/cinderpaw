/**
 * Faza 1 — Async RSI Engine: protocol (a) bridge (sidecar → Rust).
 *
 * The sidecar never computes its own score or touches the git substrate;
 * it sends a request over stdout and Rust replies over stdin. This is
 * the request/response client: it assigns a correlation id, sends
 * `{type:"rsi_request", id, method, params}`, and resolves the matching
 * Promise when `onResponse` receives `{type:"rsi_response", id, ok, ...}`.
 *
 * Modeled on the proven desktop_control bridge (feral_agent.rs).
 */

import { describe, expect, test } from "bun:test";
import { RsiBridge } from "../src/rsi/infra/bridge.ts";

describe("RSI protocol-(a) bridge client", () => {
  test("request sends a correlated rsi_request and resolves on a matching ok response", async () => {
    const sent: Record<string, unknown>[] = [];
    const bridge = new RsiBridge({ send: (m) => sent.push(m) });

    const p = bridge.request("rsi_score", { outcomes: [{ tier: 0 }] });

    expect(sent.length).toBe(1);
    expect(sent[0]!.type).toBe("rsi_request");
    expect(sent[0]!.method).toBe("rsi_score");
    expect(sent[0]!.params).toEqual({ outcomes: [{ tier: 0 }] });
    const id = sent[0]!.id as string;
    expect(typeof id).toBe("string");

    bridge.onResponse({ type: "rsi_response", id, ok: true, data: { score: 73 } });
    expect(await p).toEqual({ score: 73 });
  });

  test("an ok:false response rejects with the error message", async () => {
    const sent: Record<string, unknown>[] = [];
    const bridge = new RsiBridge({ send: (m) => sent.push(m) });

    const p = bridge.request("rsi_commit_genome", {});
    bridge.onResponse({ type: "rsi_response", id: sent[0]!.id as string, ok: false, error: "repo locked" });

    await expect(p).rejects.toThrow("repo locked");
  });

  test("concurrent requests get distinct ids and resolve independently", async () => {
    const sent: Record<string, unknown>[] = [];
    const bridge = new RsiBridge({ send: (m) => sent.push(m) });

    const p1 = bridge.request("a", {});
    const p2 = bridge.request("b", {});
    const id1 = sent[0]!.id as string;
    const id2 = sent[1]!.id as string;
    expect(id1).not.toBe(id2);

    // Resolve out of order.
    bridge.onResponse({ type: "rsi_response", id: id2, ok: true, data: 2 });
    bridge.onResponse({ type: "rsi_response", id: id1, ok: true, data: 1 });

    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
  });

  test("a response for an unknown id is ignored without throwing", () => {
    const bridge = new RsiBridge({ send: () => {} });
    expect(() =>
      bridge.onResponse({ type: "rsi_response", id: "ghost", ok: true, data: 1 }),
    ).not.toThrow();
  });

  test("a request with a timeout rejects when no response arrives (no infinite hang)", async () => {
    // Safety net for the embed-bridge deadlock: a lost/corrupted response line
    // (e.g. interleaved stdout writes mangling the request id) must surface as
    // an error so the caller falls back, not hang the tree build forever.
    const bridge = new RsiBridge({ send: () => {} });
    const p = bridge.request("embed_text", { texts: ["x"] }, 20);
    await expect(p).rejects.toThrow(/timed out/);
  });

  test("a response that arrives before the timeout clears it and resolves", async () => {
    const sent: Record<string, unknown>[] = [];
    const bridge = new RsiBridge({ send: (m) => sent.push(m) });
    const p = bridge.request("embed_text", { texts: ["x"] }, 1000);
    bridge.onResponse({ type: "rsi_response", id: sent[0]!.id as string, ok: true, data: [[1, 2]] });
    expect(await p).toEqual([[1, 2]]);
    // If the timer were still armed it would reject a settled promise (no-op)
    // but also keep the event loop alive; the clear is asserted by the test
    // completing without an unhandled late rejection.
  });
});
