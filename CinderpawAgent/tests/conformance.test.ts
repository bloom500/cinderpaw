/**
 * Provider conformance probe.
 *
 * The case that matters: a provider that answers chat perfectly but cannot emit
 * a parseable tool call. Nothing in setup caught it — the model just described
 * actions in prose, the agent read that as an answer, and tasks came back
 * "done" having never run.
 */

import { describe, expect, test } from "bun:test";
import { probeProvider, type CompleteFn, type ParseFn } from "../src/egress/conformance.ts";
import { parseResponse } from "../src/core/agent-loop.ts";
import type { InferenceResponse } from "../src/types.ts";

/** The real parser — the probe is worthless against a stub of it. */
const parse: ParseFn = (raw) => ({
  calls: parseResponse(raw).toolCalls.map((c) => ({ name: c.name, args: c.args })),
});

function replyWith(replies: string[]): CompleteFn & { calls: number } {
  let calls = 0;
  const fn = (async (): Promise<InferenceResponse> => {
    const content = replies[Math.min(calls, replies.length - 1)] ?? "";
    calls++;
    fn.calls = calls;
    return {
      content,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      model: "probe",
      usedFallback: false,
    };
  }) as CompleteFn & { calls: number };
  fn.calls = 0;
  return fn;
}

describe("probeProvider", () => {
  test("a fully conformant provider is ready with no caveats", async () => {
    const report = await probeProvider(
      replyWith([
        '<tool_call>{"name": "probe_echo", "args": {"value": "hello"}}</tool_call>',
        '<tool_call>{"name": "probe_echo", "args": {"value": "a"}}</tool_call>\n' +
          '<tool_call>{"name": "probe_add", "args": {"a": 2, "b": 3}}</tool_call>',
        '<tool_call>{"name": "probe_echo", "args": {"text": "x"}}</tool_call>',
      ]),
      parse,
    );

    expect(report.ready).toBe(true);
    expect(report.probes.every((p) => p.passed)).toBe(true);
    expect(report.summary).toContain("Ready");
  });

  test("prose instead of a tool call fails the probe that disqualifies", async () => {
    // The exact failure this exists for: a chatty model narrating the action.
    const report = await probeProvider(
      replyWith(["Sure! I'll call probe_echo with the value \"hello\" for you now."]),
      parse,
    );

    expect(report.ready).toBe(false);
    expect(report.probes.find((p) => p.id === "single_tool_call")?.passed).toBe(false);
    expect(report.summary).toContain("NOT usable as an agent");
    // The operator is told what it will look like, not just that it failed.
    expect(report.summary).toContain("describe actions instead of taking them");
  });

  test("one-call-at-a-time is usable, with the limitation named", async () => {
    const report = await probeProvider(
      replyWith([
        '<tool_call>{"name": "probe_echo", "args": {"value": "hello"}}</tool_call>',
        // Only one call when two were asked for.
        '<tool_call>{"name": "probe_echo", "args": {"value": "a"}}</tool_call>',
        '<tool_call>{"name": "probe_echo", "args": {"text": "x"}}</tool_call>',
      ]),
      parse,
    );

    expect(report.ready).toBe(true);
    expect(report.probes.find((p) => p.id === "parallel_tool_calls")?.passed).toBe(false);
    expect(report.summary).toContain("Usable, with limits");
  });

  test("re-issuing the identical failing call is caught", async () => {
    const report = await probeProvider(
      replyWith([
        '<tool_call>{"name": "probe_echo", "args": {"value": "hello"}}</tool_call>',
        '<tool_call>{"name": "probe_echo", "args": {"value": "a"}}</tool_call>\n' +
          '<tool_call>{"name": "probe_add", "args": {"a": 2, "b": 3}}</tool_call>',
        // Told "value" is wrong, sends "value" again.
        '<tool_call>{"name": "probe_echo", "args": {"value": "x"}}</tool_call>',
      ]),
      parse,
    );

    expect(report.ready).toBe(true); // usable, but flagged
    const recovery = report.probes.find((p) => p.id === "error_recovery");
    expect(recovery?.passed).toBe(false);
    expect(recovery?.detail).toContain("re-issued the same failing call");
  });

  test("an unreachable provider reports as not ready instead of throwing", async () => {
    const boom: CompleteFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    const report = await probeProvider(boom, parse);

    expect(report.ready).toBe(false);
    expect(report.probes).toHaveLength(3);
    expect(report.probes[0]?.detail).toContain("ECONNREFUSED");
  });

  test("probes are deterministic and cheap", async () => {
    const seen: Array<{ maxTokens?: number; temperature?: number }> = [];
    const fn: CompleteFn = async (req) => {
      seen.push({ maxTokens: req.maxTokens, temperature: req.temperature });
      return {
        content: '<tool_call>{"name": "probe_echo", "args": {"value": "x"}}</tool_call>',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        model: "probe",
        usedFallback: false,
      };
    };
    await probeProvider(fn, parse);

    expect(seen).toHaveLength(3);
    // temperature 0: a probe that flickers pass/fail teaches operators to ignore it.
    for (const s of seen) {
      expect(s.temperature).toBe(0);
      expect(s.maxTokens).toBeLessThanOrEqual(512);
    }
  });
});
