/**
 * Somebody else's script, running inside our turn.
 *
 * Every property here is about what happens when THEIR code is wrong: a hook
 * that hangs must not hang the agent, a failing notification must not fail the
 * work it reports on, and a hook that cannot even start must not silently
 * become a policy that blocks everything.
 *
 * The one case that is about their code being RIGHT: a `before_*` hook that
 * exits non-zero blocks the operation and its stderr becomes the reason the
 * agent is given — that is the change-freeze case, and the reason hooks are
 * worth more than a webhook.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRegistry } from "../src/core/hook-registry.ts";
import { installUserHooks, userHooksPath } from "../src/core/user-hooks.ts";

const saved = process.env.FERAL_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.FERAL_HOME;
  else process.env.FERAL_HOME = saved;
});

/** A scratch ~/.feral containing this hooks file. Returns the directory. */
async function withHooks(contents: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "feral-uhooks-"));
  process.env.FERAL_HOME = home;
  await writeFile(
    userHooksPath(),
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
  return home;
}

/** A node one-liner as an argv array. */
function node(script: string): string[] {
  return [process.execPath, "-e", script];
}

describe("user hooks", () => {
  test("an after_tool_call hook runs and is handed the event on stdin", async () => {
    const home = await mkdtemp(join(tmpdir(), "feral-uhooks-out-"));
    const out = join(home, "seen.json");
    await withHooks({
      after_tool_call: [
        {
          match: "write_file",
          command: node(
            `require("fs").writeFileSync(${JSON.stringify(out)}, require("fs").readFileSync(0, "utf8"))`,
          ),
        },
      ],
    });

    const registry = new HookRegistry();
    expect(installUserHooks(registry)).toBe(1);
    await registry.fire("after_tool_call", {
      tool: "write_file",
      args: {},
      result: { ok: true, content: "" },
      sessionId: "s1",
    });

    const seen = JSON.parse(await readFile(out, "utf8"));
    expect(seen.event).toBe("after_tool_call");
    expect(seen.tool).toBe("write_file");
    expect(seen.sessionId).toBe("s1");
  });

  test("`match` keeps a hook off tools it was not written for", async () => {
    const home = await mkdtemp(join(tmpdir(), "feral-uhooks-nm-"));
    const out = join(home, "must-not-exist");
    await withHooks({
      after_tool_call: [
        { match: "write_file", command: node(`require("fs").writeFileSync(${JSON.stringify(out)}, "x")`) },
      ],
    });

    const registry = new HookRegistry();
    installUserHooks(registry);
    await registry.fire("after_tool_call", {
      tool: "read_file",
      args: {},
      result: { ok: true, content: "" },
      sessionId: "s1",
    });
    await expect(readFile(out, "utf8")).rejects.toThrow();
  });

  test("a before_ hook that exits non-zero blocks, and its stderr is the reason", async () => {
    await withHooks({
      before_tool_call: [
        {
          match: "write_file",
          command: node(`process.stderr.write("change freeze until Monday"); process.exit(1)`),
        },
      ],
    });

    const registry = new HookRegistry();
    installUserHooks(registry);
    const result = await registry.fire("before_tool_call", {
      tool: "write_file",
      args: {},
      sessionId: "s1",
    });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("change freeze until Monday");
  });

  test("an after_ hook that fails does NOT block — the thing already happened", async () => {
    await withHooks({
      after_tool_call: [{ command: node("process.exit(2)") }],
    });

    const registry = new HookRegistry();
    installUserHooks(registry);
    const result = await registry.fire("after_tool_call", {
      tool: "write_file",
      args: {},
      result: { ok: true, content: "" },
      sessionId: "s1",
    });
    expect(result).toBeNull();
  });

  test("a hook that hangs is killed, and does not block by timing out", async () => {
    const logged: string[] = [];
    await withHooks({
      before_tool_call: [{ command: node("setTimeout(() => {}, 60000)"), timeoutMs: 300 }],
    });

    const registry = new HookRegistry();
    installUserHooks(registry, (m) => logged.push(m));
    const started = Date.now();
    const result = await registry.fire("before_tool_call", { tool: "x", args: {}, sessionId: "s1" });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(logged.join(" ")).toContain("killed");
    // A hook that never answered did not refuse. Blocking on silence would turn
    // one wedged script into an agent that can do nothing at all.
    expect(result).toBeNull();
  });

  test("a command that cannot start is a config error, not a veto", async () => {
    const logged: string[] = [];
    await withHooks({
      before_tool_call: [{ command: ["definitely-not-a-real-program-xyz"] }],
    });

    const registry = new HookRegistry();
    installUserHooks(registry, (m) => logged.push(m));
    const result = await registry.fire("before_tool_call", { tool: "x", args: {}, sessionId: "s1" });
    expect(result).toBeNull();
    expect(logged.join(" ")).toMatch(/could not start|failed/);
  });

  test("a broken hooks file is reported rather than read as 'no hooks'", async () => {
    const logged: string[] = [];
    await withHooks("{ not json at all");
    const registry = new HookRegistry();
    expect(installUserHooks(registry, (m) => logged.push(m))).toBe(0);
    expect(logged.join(" ")).toContain("ignored");
  });

  test("no file at all installs nothing, silently", async () => {
    const home = await mkdtemp(join(tmpdir(), "feral-uhooks-none-"));
    process.env.FERAL_HOME = home;
    const logged: string[] = [];
    const registry = new HookRegistry();
    expect(installUserHooks(registry, (m) => logged.push(m))).toBe(0);
    expect(logged).toHaveLength(0);
  });
});
