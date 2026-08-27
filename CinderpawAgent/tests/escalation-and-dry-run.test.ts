/**
 * The two guards for actions that cannot be undone.
 *
 * They sit at different layers on purpose, because each covers the other's
 * blind spot:
 *
 *   `force_escalate` is AGENT-declared. It protects against a conscientious
 *   agent's hard call — "should I raise this budget?" — by making walk-away
 *   mode refuse to answer for itself. It does nothing about an agent that
 *   never realises the call was expensive, because that agent will not set
 *   the flag.
 *
 *   The egress guards are OPERATOR-declared and consult the agent about
 *   nothing: a sensitive host cannot be written to unattended, and dry-run
 *   sends no state change at all. These hold whatever the agent believes.
 *
 * The tests name which layer they are exercising, so a future change cannot
 * quietly collapse the two into one and lose half the coverage.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { createAskUserTool } from "../src/tools/builtin/ask-user.ts";
import type { AuditEntry, ToolContext, ToolManifest } from "../src/types.ts";

const manifest: ToolManifest = {
  name: "http_request",
  description: "t",
  permissions: [],
  networkAccess: true,
  allowedDomains: ["*"],
};

function proxy(overrides = {}) {
  const audit: AuditEntry[] = [];
  const p = new EgressProxy((e) => audit.push(e), {
    underlyingFetch: async () => new Response(JSON.stringify({ sent: true }), { status: 200 }),
    ...overrides,
  });
  return { p, audit };
}

const AUTONOMOUS = "CINDERPAW_AUTONOMOUS";
afterEach(() => {
  delete process.env[AUTONOMOUS];
});

// ─────────────────────────────────────────── layer 1: agent-declared

/** ask_user with no interactive bridge — the walk-away shape. */
function askCtx(): ToolContext {
  return { sessionId: "s", manifest, audit: () => {} } as unknown as ToolContext;
}

describe("force_escalate: walk-away mode may not answer for a human", () => {
  const money = {
    question: "Raise the daily budget of summer_sale to $500?",
    options: [{ label: "Yes, raise it" }, { label: "No" }],
    multiSelect: false,
    force_escalate: true,
  };

  test("an escalated question is refused rather than auto-answered", async () => {
    process.env[AUTONOMOUS] = "true";
    const res = await createAskUserTool().execute({ questions: [money] }, askCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("escalation_required");
    // The agent must be able to act on the refusal, not just retry it.
    expect(res.content).toMatch(/needs a human/i);
    expect(res.content).toMatch(/do the parts/i);
  });

  test("an ordinary question is still auto-answered — walk-away still works", async () => {
    process.env[AUTONOMOUS] = "true";
    const res = await createAskUserTool().execute(
      {
        questions: [
          {
            question: "Which format for the report?",
            options: [{ label: "Markdown", recommended: true }, { label: "HTML" }],
            multiSelect: false,
          },
        ],
      },
      askCtx(),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("Markdown");
  });

  test("one escalated question escalates the whole batch", async () => {
    process.env[AUTONOMOUS] = "true";
    const res = await createAskUserTool().execute(
      {
        questions: [
          { question: "Which format?", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
          money,
        ],
      },
      askCtx(),
    );
    // Answering half a batch would half-decide something consequential.
    expect(res.ok).toBe(false);
    expect(res.error).toBe("escalation_required");
  });

  test("with a human present, an escalated question is simply asked", async () => {
    process.env[AUTONOMOUS] = "true";
    const asked: unknown[] = [];
    const ctx = {
      sessionId: "s",
      manifest,
      audit: () => {},
      askUser: {
        ask: async (qs: unknown[]) => {
          asked.push(...qs);
          return [{ question: money.question, selected: ["No"] }];
        },
        cancel: () => {},
      },
    } as unknown as ToolContext;
    const res = await createAskUserTool().execute({ questions: [money] }, ctx);
    expect(asked).toHaveLength(1);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("No");
  });
});

// ─────────────────────────────────── layer 2: operator-declared, agent-proof

describe("sensitive hosts cannot be CHANGED unattended", () => {
  const opts = { unattended: true, unattendedWriteDenyHosts: ["graph.facebook.com"] };

  test("a write to a declared host is refused while nobody is watching", async () => {
    const { p } = proxy(opts);
    const f = p.forTool(manifest, "s");
    await expect(
      f("https://graph.facebook.com/v19.0/act_1/campaigns", { method: "POST" }),
    ).rejects.toThrow(/may not be CHANGED while running unattended/i);
  });

  test("reading it is still fine — the agent can look, it just cannot touch", async () => {
    const { p } = proxy(opts);
    const f = p.forTool(manifest, "s");
    const res = await f("https://graph.facebook.com/v19.0/act_1/insights");
    expect(res.ok).toBe(true);
  });

  test("subdomains are covered, unrelated hosts are not", async () => {
    const { p } = proxy(opts);
    const f = p.forTool(manifest, "s");
    await expect(f("https://a.graph.facebook.com/x", { method: "POST" })).rejects.toThrow(
      /unattended/i,
    );
    const ok = await f("https://example.com/x", { method: "POST" });
    expect(ok.ok).toBe(true);
  });

  test("with a human at the machine the same write goes through", async () => {
    const { p } = proxy({ ...opts, unattended: false });
    const f = p.forTool(manifest, "s");
    const res = await f("https://graph.facebook.com/v19.0/act_1/campaigns", { method: "POST" });
    expect(res.ok).toBe(true);
  });
});

describe("dry run records the intent and sends nothing", () => {
  test("a write is not sent, and the agent is TOLD so", async () => {
    let sent = 0;
    const { p } = proxy({
      dryRunWrites: true,
      underlyingFetch: async () => {
        sent++;
        return new Response("{}", { status: 200 });
      },
    });
    const f = p.forTool(manifest, "s");
    const res = await f("https://graph.facebook.com/x", { method: "POST" });
    expect(sent).toBe(0);
    // Crucially NOT a fake success: an agent that believes the write landed
    // builds its next step on a fiction.
    const body = (await res.json()) as { dry_run?: boolean; message?: string };
    expect(body.dry_run).toBe(true);
    expect(body.message).toMatch(/NOT sent/i);
    expect(res.headers["x-feral-dry-run"]).toBe("1");
  });

  test("reads are unaffected — the agent still sees real data", async () => {
    let sent = 0;
    const { p } = proxy({
      dryRunWrites: true,
      underlyingFetch: async () => {
        sent++;
        return new Response(JSON.stringify({ real: true }), { status: 200 });
      },
    });
    const f = p.forTool(manifest, "s");
    const res = await f("https://graph.facebook.com/insights");
    expect(sent).toBe(1);
    expect(await res.json()).toEqual({ real: true });
  });

  test("the skipped write is auditable — you can read what it would have done", async () => {
    const { p, audit } = proxy({ dryRunWrites: true });
    const f = p.forTool(manifest, "s");
    await f("https://graph.facebook.com/campaigns", { method: "POST" });
    const row = audit.find((e) => e.actionType === "network_write");
    expect(row?.blockedReason).toMatch(/dry run/i);
    expect(row?.argsJson).toContain("dryRun");
  });
});
