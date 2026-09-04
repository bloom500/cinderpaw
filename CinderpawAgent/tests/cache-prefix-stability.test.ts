/**
 * The prefix a provider caches must not move.
 *
 * Prompt caching is a prefix match: a single byte changed anywhere before a
 * breakpoint invalidates everything after it, silently — no error, no warning,
 * just full price on every request forever. So declaring `cachePrefix` is only
 * half the work; the other half is that nothing in the transcript builder may
 * rewrite what it already sent.
 *
 * This is not a hypothetical. The failure has a known shape: compact the OLDEST
 * tool results first and you rewrite messages[k] for small k on every turn past
 * the threshold, which kills the cache from that point onward, every time. The
 * discipline that prevents it is the one asserted here — volatile content lives
 * at the END, and everything before the last user message is frozen.
 */
import { describe, expect, test } from "bun:test";
import { WorkingMemory } from "../src/memory/working.ts";

/** Everything a provider would cache: the system prompt and the settled turns. */
function frozenPart(rendered: { role: string; content: string }[]): string[] {
  const lastUser = rendered.map((m) => m.role).lastIndexOf("user");
  return rendered.slice(0, lastUser).map((m) => `${m.role}:${m.content}`);
}

describe("the cached prefix stays byte-identical", () => {
  test("appending a turn does not rewrite anything before it", () => {
    const mem = new WorkingMemory("SYSTEM PROMPT");
    mem.addUser("first question");
    mem.addAssistant("first answer");
    mem.addUser("second question");
    const before = frozenPart(mem.render());

    mem.addAssistant("second answer");
    mem.addUser("third question");
    const after = frozenPart(mem.render());

    // The new turn extends the transcript; it must not edit the old one.
    // Element-wise, so a single rewritten message fails loudly and points at
    // which one — a whole-string compare would only say "different".
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBe(before[i]!);
    }
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });

  test("rendering twice with nothing added is identical", () => {
    // A prefix that changes just by being rendered again would mean the cache
    // never hits at all — the most expensive possible bug, and invisible.
    const mem = new WorkingMemory("SYSTEM PROMPT");
    mem.addUser("hello");
    mem.addAssistant("hi");
    mem.addToolResult("read_file", "the file contents");
    mem.addUser("and now?");
    expect(JSON.stringify(mem.render())).toBe(JSON.stringify(mem.render()));
  });

  test("per-turn context is appended to the last user message, not the system prompt", () => {
    // The whole layout depends on this: everything that changes every turn — the
    // todo list, the skill menu, recalled context — must land at the END. Put
    // any of it in the system prompt and the entire conversation is uncacheable,
    // on every provider at once.
    const mem = new WorkingMemory("SYSTEM PROMPT");
    mem.addUser("question");
    const systemBefore = mem.render()[0]!.content;

    mem.setTodoList([{ id: 1, text: "do the thing", status: "pending" } as never]);
    const rendered = mem.render();
    expect(rendered[0]!.content).toBe(systemBefore);
    expect(rendered[rendered.length - 1]!.role).toBe("user");
  });

  test("the notebook drawer moves with the last user message, not the frozen prefix", () => {
    // The notebook (this plan's new drawer) has to obey the same discipline as
    // todo/skill/memory above: it is volatile per-turn content, so it belongs at
    // the END, never inserted ahead of settled history where it would shift
    // every later message's position and kill the cache from that point on.
    const mem = new WorkingMemory("SYSTEM PROMPT");
    mem.addUser("first question");
    mem.addAssistant("first answer");
    mem.addUser("second question");
    const before = frozenPart(mem.render());

    // Setting the notebook between turns must not rewrite anything already frozen.
    mem.setNotebook([{ key: "note:db-path", value: "~/.cinderpaw/agent/cinderpaw.db" }]);
    mem.addAssistant("second answer");
    mem.addUser("third question");
    const after = frozenPart(mem.render());

    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBe(before[i]!);
    }
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });
});
