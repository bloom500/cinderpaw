/**
 * Phase 2 — the rules the capability tools exist to enforce.
 *
 * These are not "does install work" tests. They are the four ways the agent
 * must NOT be able to install something:
 *   - with no host bridge to check provenance
 *   - with no way to ask the person
 *   - when the person says no
 *   - by handing content to the host itself
 *
 * See docs/specs/2026-08-19-phase-2-capability-lifecycle.md.
 */

import { test, expect, describe } from "bun:test";
import {
  inspectCapabilityTool,
  installCapabilityTool,
} from "../src/tools/builtin/capability.ts";
import type { AskUserAnswer, AskUserQuestion } from "../src/types.ts";

const ENTRY = {
  id: "excel-reader",
  name: "Excel Reader",
  description: "Reads xlsx files",
  trust_label: "community",
  install_status: "not_installed",
};

/** A bridge that records every call so the test can assert on what crossed. */
function fakeBridge(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    bridge: {
      async request(action: string, params: Record<string, unknown>) {
        calls.push({ action, params });
        if (action === "inspect") return { meta: ENTRY, content: "---\nname: x\n---\nbody" };
        if (action === "install") return ENTRY;
        if (action === "list") return [ENTRY];
        return null;
      },
      ...overrides,
    },
  };
}

function askUserReturning(label: string, seen: AskUserQuestion[] = []) {
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

describe("install_capability — the ways it must refuse", () => {
  test("no host bridge → refuses, does not improvise", async () => {
    const ask = askUserReturning("Add it");
    const res = await installCapabilityTool.execute(
      { name: "excel-reader" },
      { askUser: ask.bridge } as never,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_available");
  });

  test("no askUser bridge → fails CLOSED", async () => {
    // The absence of a way to ask is not permission to proceed quietly.
    const { bridge, calls } = fakeBridge();
    const res = await installCapabilityTool.execute(
      { name: "excel-reader" },
      { capabilities: bridge } as never,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("confirmation_unavailable");
    expect(calls.some((c) => c.action === "install")).toBe(false);
  });

  test("the person declines → nothing is installed", async () => {
    const { bridge, calls } = fakeBridge();
    const ask = askUserReturning("Not now");
    const res = await installCapabilityTool.execute(
      { name: "excel-reader" },
      { capabilities: bridge, askUser: ask.bridge } as never,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("declined");
    expect(calls.some((c) => c.action === "install")).toBe(false);
  });

  test("the question times out or is cancelled → nothing is installed", async () => {
    const { bridge, calls } = fakeBridge();
    const askUser = {
      async ask(): Promise<AskUserAnswer[]> {
        throw new Error("ask_user timed out");
      },
      cancel() {},
    };
    const res = await installCapabilityTool.execute(
      { name: "excel-reader" },
      { capabilities: bridge, askUser } as never,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_confirmed");
    expect(calls.some((c) => c.action === "install")).toBe(false);
  });

  test("an unknown capability is refused before anyone is asked", async () => {
    const { bridge } = fakeBridge({
      async request() {
        return { meta: undefined };
      },
    });
    const seen: AskUserQuestion[] = [];
    const ask = askUserReturning("Add it", seen);
    const res = await installCapabilityTool.execute(
      { name: "does-not-exist" },
      { capabilities: bridge, askUser: ask.bridge } as never,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_found");
    // Asking about something we could not resolve produces a question nobody
    // can answer well.
    expect(seen).toHaveLength(0);
  });
});

describe("install_capability — what crosses the boundary", () => {
  test("only a name is ever sent to the host", async () => {
    const { bridge, calls } = fakeBridge();
    const ask = askUserReturning("Add it");
    const res = await installCapabilityTool.execute(
      { name: "excel-reader", reason: "so I can read your spreadsheet" },
      { capabilities: bridge, askUser: ask.bridge } as never,
    );
    expect(res.ok).toBe(true);

    const install = calls.find((c) => c.action === "install")!;
    expect(install.params).toEqual({ name: "excel-reader" });
    // The old install_skill took meta + content + overwrite from its caller.
    // Nothing of the sort may ever cross this wire again.
    for (const call of calls) {
      expect(call.params).not.toHaveProperty("content");
      expect(call.params).not.toHaveProperty("meta");
      expect(call.params).not.toHaveProperty("trust_label");
    }
  });

  test("the confirmation names the capability and its origin", async () => {
    // A prompt that does not say what is being added, or where it came from,
    // is not a decision the person can actually make.
    const { bridge } = fakeBridge();
    const seen: AskUserQuestion[] = [];
    const ask = askUserReturning("Add it", seen);
    await installCapabilityTool.execute(
      { name: "excel-reader" },
      { capabilities: bridge, askUser: ask.bridge } as never,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.question).toContain("Excel Reader");
    expect(seen[0]!.question).toContain("community");
    // Walk-away mode answers its own questions; this one must be exempt, or
    // an unattended agent approves its own installs.
    expect(seen[0]!.forceEscalate).toBe(true);
  });
});

describe("inspect_capability", () => {
  test("reads without installing", async () => {
    const { bridge, calls } = fakeBridge();
    const res = await inspectCapabilityTool.execute(
      { name: "excel-reader" },
      { capabilities: bridge } as never,
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("Excel Reader");
    expect(calls.every((c) => c.action !== "install")).toBe(true);
  });

  test("needs no confirmation — reading is not acquiring", async () => {
    const { bridge } = fakeBridge();
    const res = await inspectCapabilityTool.execute(
      { name: "excel-reader" },
      { capabilities: bridge } as never,
    );
    expect(res.ok).toBe(true);
  });
});
