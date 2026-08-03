/**
 * Provider conformance probe — does this model actually drive the agent?
 *
 * "Connect any provider you like" is only true if a failure to speak the
 * agent's protocol is visible at setup. It was not. A provider that answers
 * chat perfectly but cannot emit a parseable tool call looks completely healthy:
 * the connection test passes, replies stream, and the model simply *describes*
 * the tool call in prose. The agent reads that as an answer, reports the task
 * done, and nothing anywhere is marked wrong. Half-finished tasks with a
 * confident summary is what that looks like from the outside — the exact
 * symptom that gets filed as "the agent hallucinates".
 *
 * The probes below are the three protocol facts the agent loop depends on, in
 * increasing order of how often they break across providers:
 *
 *   1. it can emit ONE tool call in a form `parseResponse` accepts,
 *   2. it can emit TWO in one turn (parallel calls — several providers can only
 *      manage one, which silently halves throughput on multi-step tasks),
 *   3. it reacts to a tool ERROR by changing course rather than re-issuing the
 *      identical call (the loop-detector exists because of this).
 *
 * Cheap by construction: three short completions with a tiny token cap, run
 * once when a provider is configured — not per turn.
 *
 * This checks the PROTOCOL, not the model's intelligence. A provider that
 * passes can still be bad at your work; one that fails will waste your evening
 * no matter how good it is.
 */

import type { ChatMessage, InferenceResponse } from "../types.ts";

/** Injected so this module needs neither the router's construction nor network in tests. */
export type CompleteFn = (req: {
  sessionId: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}) => Promise<InferenceResponse>;

/** Parses a model reply into tool calls — `AgentLoop.parseResponse`, injected. */
export type ParseFn = (raw: string) => { calls: Array<{ name: string; args: Record<string, unknown> }> };

export interface ProbeResult {
  id: "single_tool_call" | "parallel_tool_calls" | "error_recovery";
  /** What this probe proves, for the setup UI. */
  title: string;
  passed: boolean;
  /** Why it failed, or what was seen. Shown verbatim to the operator. */
  detail: string;
}

export interface ConformanceReport {
  /** False when any REQUIRED probe failed — the provider should not be marked ready. */
  ready: boolean;
  probes: ProbeResult[];
  /** One-line verdict for a status surface. */
  summary: string;
}

/**
 * The tool the probes ask for. Deliberately trivial and side-effect free: any
 * model that understands tool calling at all can call it, so a failure is
 * evidence about the protocol rather than about task difficulty.
 */
const PROBE_TOOL = {
  name: "probe_echo",
  description: "Echo a value back. Used only to verify tool-calling works.",
  parameters: {
    type: "object",
    properties: { value: { type: "string", description: "Any string." } },
    required: ["value"],
  },
};

const PROBE_TOOL_2 = {
  name: "probe_add",
  description: "Add two numbers.",
  parameters: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
};

/** The instruction block. Mirrors what the real system prompt teaches. */
function probeSystemPrompt(tools: unknown[]): string {
  return [
    "You are a tool-using agent under an automated protocol check.",
    "To call a tool, emit the call inside <tool_call> tags, one JSON object per",
    'block: <tool_call>{"name": "tool_name", "args": {…}}</tool_call>',
    "Emit the tool call and nothing else. Do not explain, do not apologise.",
    "",
    "Available tools:",
    JSON.stringify(tools, null, 2),
  ].join("\n");
}

async function ask(
  complete: CompleteFn,
  tools: unknown[],
  turns: ChatMessage[],
): Promise<string> {
  const res = await complete({
    sessionId: "conformance-probe",
    messages: [{ role: "system", content: probeSystemPrompt(tools) }, ...turns],
    maxTokens: 512,
    // Deterministic: a probe that passes on one sample and fails on the next
    // is worse than no probe, because it teaches the operator to ignore it.
    temperature: 0,
  });
  return res.content ?? "";
}

/** Trim a model reply for display without dumping a wall into the UI. */
function excerpt(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat || "(empty reply)";
}

/**
 * Run the probes against a provider.
 *
 * Never throws: a transport failure is reported as a failed probe with the
 * error text, because "the provider is unreachable" and "the provider cannot
 * emit tool calls" are both things the operator needs to see at setup, and
 * neither should take down whatever called this.
 */
export async function probeProvider(
  complete: CompleteFn,
  parse: ParseFn,
): Promise<ConformanceReport> {
  const probes: ProbeResult[] = [];

  // 1. One tool call.
  try {
    const raw = await ask(complete, [PROBE_TOOL], [
      { role: "user", content: 'Call probe_echo with value "hello".' },
    ]);
    const calls = parse(raw).calls;
    const ok = calls.length >= 1 && calls[0]!.name === "probe_echo";
    probes.push({
      id: "single_tool_call",
      title: "Emits a tool call the agent can parse",
      passed: ok,
      detail: ok
        ? "called probe_echo"
        : `no parseable tool call — the model replied with: ${excerpt(raw)}`,
    });
  } catch (err) {
    probes.push({
      id: "single_tool_call",
      title: "Emits a tool call the agent can parse",
      passed: false,
      detail: `request failed: ${String(err)}`,
    });
  }

  // 2. Two tool calls in one turn.
  try {
    const raw = await ask(complete, [PROBE_TOOL, PROBE_TOOL_2], [
      {
        role: "user",
        content:
          'In ONE reply, make both calls: probe_echo with value "a", and probe_add with a=2 and b=3.',
      },
    ]);
    const calls = parse(raw).calls;
    const ok = calls.length >= 2;
    probes.push({
      id: "parallel_tool_calls",
      title: "Emits two tool calls in one turn",
      passed: ok,
      detail: ok
        ? `emitted ${calls.length} calls`
        : `only ${calls.length} call(s) parsed — multi-step tasks will run one step per turn, ` +
          `which is slower and burns more context, but still works`,
    });
  } catch (err) {
    probes.push({
      id: "parallel_tool_calls",
      title: "Emits two tool calls in one turn",
      passed: false,
      detail: `request failed: ${String(err)}`,
    });
  }

  // 3. Reacts to a tool error instead of repeating the call.
  try {
    const raw = await ask(complete, [PROBE_TOOL], [
      { role: "user", content: 'Call probe_echo with value "x".' },
      { role: "assistant", content: '<tool_call>{"name": "probe_echo", "args": {"value": "x"}}</tool_call>' },
      {
        role: "tool",
        name: "probe_echo",
        content: 'ERROR: probe_echo does not accept "value". Use "text" instead.',
      },
      { role: "user", content: "Continue." },
    ]);
    const calls = parse(raw).calls;
    // Passing means it adapted: it used the corrected argument name rather than
    // re-sending the exact call that just failed.
    const repeated = calls.some((c) => "value" in c.args && !("text" in c.args));
    const adapted = calls.some((c) => "text" in c.args);
    const ok = adapted || (calls.length > 0 && !repeated);
    probes.push({
      id: "error_recovery",
      title: "Changes course after a tool error",
      passed: ok,
      detail: ok
        ? "adjusted its call after the error"
        : `re-issued the same failing call — long tasks with this provider will lean on the ` +
          `loop detector to stop. Reply: ${excerpt(raw)}`,
    });
  } catch (err) {
    probes.push({
      id: "error_recovery",
      title: "Changes course after a tool error",
      passed: false,
      detail: `request failed: ${String(err)}`,
    });
  }

  // Only the first probe is disqualifying. A provider that manages one call at
  // a time is slower, not broken; one that cannot emit a call at all cannot
  // run this agent, and saying so at setup is the whole point.
  const single = probes.find((p) => p.id === "single_tool_call");
  const ready = single?.passed === true;
  const failed = probes.filter((p) => !p.passed);

  return {
    ready,
    probes,
    summary: ready
      ? failed.length === 0
        ? "Ready — tool calling, parallel calls and error recovery all work."
        : `Usable, with limits: ${failed.map((p) => p.title.toLowerCase()).join("; ")}.`
      : "NOT usable as an agent: this provider cannot emit a tool call the agent can parse. " +
        "It will answer chat normally and silently describe actions instead of taking them.",
  };
}
