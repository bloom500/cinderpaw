/**
 * feral_admin — the act half of what the CLI can do.
 *
 * The tests that matter are the refusals: an update replaces the running
 * application, so it gets the same posture as install_capability — confirmed,
 * fails closed, and never self-answered in an unattended run.
 */

import { test, expect, describe } from "bun:test";
import { feralAdminTool } from "../src/tools/builtin/feral-admin.ts";
import type { AskUserAnswer, AskUserQuestion } from "../src/types.ts";

function bridgeWith(responses: Record<string, unknown>) {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    bridge: {
      async request(action: string, params: Record<string, unknown>) {
        calls.push({ action, params });
        return responses[action] ?? null;
      },
    },
  };
}

function asker(label: string, seen: AskUserQuestion[] = []) {
  return {
    seen,
    bridge: {
      async ask(questions: AskUserQuestion[]): Promise<AskUserAnswer[]> {
        seen.push(...questions);
        return [{ question: questions[0]!.question, selected: [label] } as AskUserAnswer];
      },
      cancel() {},
    },
  };
}

describe("feral_admin — availability and arguments", () => {
  test("without the host bridge it says so instead of pretending", async () => {
    const res = await feralAdminTool.execute({ action: "update_check" }, {} as never);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_available");
  });

  test("an unknown action is refused", async () => {
    const { bridge } = bridgeWith({});
    const res = await feralAdminTool.execute(
      { action: "uninstall" },
      { admin: bridge } as never,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bad_args");
  });

  test("model_switch without a model is refused before the host is called", async () => {
    const { bridge, calls } = bridgeWith({});
    const res = await feralAdminTool.execute(
      { action: "model_switch", source: "local" },
      { admin: bridge } as never,
    );
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("feral_admin — updating", () => {
  const AVAILABLE = { available: true, version: "2026.9.1", current: "2026.8.19" };

  test("nothing to install → says so, asks nobody", async () => {
    const { bridge } = bridgeWith({ update_check: { available: false, current: "2026.8.19" } });
    const seen: AskUserQuestion[] = [];
    const ask = asker("Update", seen);
    const res = await feralAdminTool.execute(
      { action: "update_apply" },
      { admin: bridge, askUser: ask.bridge } as never,
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("already up to date");
    expect(seen).toHaveLength(0);
  });

  test("no way to ask → fails closed, installs nothing", async () => {
    const { bridge, calls } = bridgeWith({ update_check: AVAILABLE });
    const res = await feralAdminTool.execute(
      { action: "update_apply" },
      { admin: bridge } as never,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("confirmation_unavailable");
    expect(calls.some((c) => c.action === "update_apply")).toBe(false);
  });

  test("declined → installs nothing", async () => {
    const { bridge, calls } = bridgeWith({ update_check: AVAILABLE });
    const ask = asker("Not now");
    const res = await feralAdminTool.execute(
      { action: "update_apply" },
      { admin: bridge, askUser: ask.bridge } as never,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("declined");
    expect(calls.some((c) => c.action === "update_apply")).toBe(false);
  });

  test("the confirmation names both versions and cannot be self-answered", async () => {
    const { bridge } = bridgeWith({
      update_check: AVAILABLE,
      update_apply: { applied: true, version: "2026.9.1", restart_required: true },
    });
    const seen: AskUserQuestion[] = [];
    const ask = asker("Update", seen);
    const res = await feralAdminTool.execute(
      { action: "update_apply" },
      { admin: bridge, askUser: ask.bridge } as never,
    );
    expect(res.ok).toBe(true);
    expect(seen[0]!.question).toContain("2026.9.1");
    expect(seen[0]!.question).toContain("2026.8.19");
    // An unattended run must not approve its own update.
    expect(seen[0]!.forceEscalate).toBe(true);
    // The restart is stated, because an app vanishing to restart itself
    // mid-conversation is indistinguishable from a crash.
    expect(res.content).toContain("next time Feral starts");
  });
});

describe("feral_admin — models", () => {
  test("switching needs no confirmation — it is cheap and reversible", async () => {
    const { bridge, calls } = bridgeWith({
      model_switch: { switched: true, source: "local", model: "qwen2.5:7b" },
    });
    const seen: AskUserQuestion[] = [];
    const ask = asker("Update", seen);
    const res = await feralAdminTool.execute(
      { action: "model_switch", source: "local", model: "qwen2.5:7b" },
      { admin: bridge, askUser: ask.bridge } as never,
    );
    expect(res.ok).toBe(true);
    expect(seen).toHaveLength(0);
    expect(calls.some((c) => c.action === "model_switch")).toBe(true);
  });

  test("an empty machine is described, not reported as an error", async () => {
    const { bridge } = bridgeWith({ model_list: { local: [], cloud: [] } });
    const res = await feralAdminTool.execute(
      { action: "model_list" },
      { admin: bridge } as never,
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("No models are set up yet");
  });
});
