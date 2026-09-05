/**
 * Agent identity is an ownership boundary — creating one teammate must never
 * mutate another. `cowork_create_teammate` derives the row id from the NAME
 * (`slugify`), but refuses duplicates by comparing NAMES. Two different names
 * that slug to the same id therefore walked past the guard and landed on
 * `upsert`, whose `ON CONFLICT(id) DO UPDATE` overwrote the existing teammate
 * — role, instructions, tool scope and model pin — while reporting a
 * successful *creation* and while the tool's own refusal message promises
 * "this tool will not overwrite them".
 *
 * The real store is used deliberately. The pre-existing cap test fakes
 * `upsert`, which is exactly why a collision could not be seen there.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { CoworkAgentRepo } from "../src/cowork/agent-store.ts";
import { CoworkMailboxRepo } from "../src/cowork/mailbox.ts";
import { createCoworkCreateTool } from "../src/tools/builtin/cowork-create.ts";

function harness() {
  const { raw: db, close } = openDatabase(":memory:");
  const agents = new CoworkAgentRepo(db);
  const mailbox = new CoworkMailboxRepo(db);
  const tool = createCoworkCreateTool({
    agents,
    mailbox,
    registry: { list: () => [], register: () => {}, has: () => true } as never,
    log: () => {},
  });
  return { agents, mailbox, tool, close };
}

describe("cowork_create_teammate — identity collisions", () => {
  // Every pair below is two names a user could plausibly pick that the id
  // slug flattens onto one row.
  const collisions: Array<[string, string]> = [
    ["Atlas", "Atlas!"],
    ["Atlas", "@tlas"],
    // 32-char truncation: the names differ only past the cut.
    [
      "Senior backend engineering assistant one",
      "Senior backend engineering assistant two",
    ],
    // Nothing sluggable at all — both fall back to the same literal.
    ["!!!", "???"],
  ];

  for (const [first, second] of collisions) {
    test(`"${first}" is not overwritten by "${second}"`, async () => {
      const { agents, tool, close } = harness();
      try {
        delete process.env.CINDERPAW_MAX_COWORKERS;
        const a = await tool.execute({ name: first, role: "the original", instructions: "keep me" });
        expect(a.ok).toBe(true);
        const before = agents.list();
        expect(before).toHaveLength(1);

        const b = await tool.execute({ name: second, role: "the impostor" });

        // Either outcome is acceptable: refuse the clash, or give the new
        // teammate its own id. What is NOT acceptable is silently replacing
        // the first one and calling it a creation.
        const after = agents.list();
        const original = after.find((x) => x.name === first);
        expect(original).toBeDefined();
        expect(original!.role).toBe("the original");
        expect(original!.instructions).toBe("keep me");
        if (b.ok) expect(after).toHaveLength(2);
      } finally {
        close();
      }
    });
  }

  test("a colliding id does not hand over the original's inbox", async () => {
    const { agents, mailbox, tool, close } = harness();
    try {
      delete process.env.CINDERPAW_MAX_COWORKERS;
      await tool.execute({ name: "Atlas", role: "the original" });
      const atlas = agents.list()[0]!;
      mailbox.send({ fromAgentId: "human", toAgentId: atlas.id, threadId: null, body: "secret for Atlas" });

      await tool.execute({ name: "Atlas!", role: "the impostor" });
      const impostor = agents.list().find((x) => x.name === "Atlas!");
      if (impostor) {
        // A brand-new teammate must not inherit messages addressed to another.
        expect(impostor.id).not.toBe(atlas.id);
      }
      // And Atlas still owns its own mail.
      expect(agents.get(atlas.id)?.name).toBe("Atlas");
    } finally {
      close();
    }
  });
});
