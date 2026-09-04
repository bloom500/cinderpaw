/**
 * The failure this whole feature exists to prevent, in miniature: a long run,
 * many compactions, and an early fact that must still be present at the end.
 *
 * The summary block is append-only and blind-truncated head+tail once it
 * outgrows its reserve, so a fact from the MIDDLE of a run is exactly what falls
 * out of it. The notebook is not subject to that, which is the property under
 * test.
 */
import { expect, test } from "bun:test";
import { WorkingMemory } from "../src/memory/working.ts";

test("a fact written to the notebook early survives many compactions", async () => {
  const mem = new WorkingMemory("sys", { maxTokens: 2_000, keepRecent: 4 });
  const NOTEBOOK = [
    { key: "note:db-path", value: "the real database is ~/.cinderpaw/agent/cinderpaw.db" },
  ];

  let compactions = 0;
  const summarize = async () => {
    compactions++;
    return `### Established facts\n- compaction ${compactions} happened\n\n### Position\nstep ${compactions}`;
  };

  for (let turn = 0; turn < 40; turn++) {
    // The notebook is re-projected every turn — this is what the agent loop does.
    mem.setNotebook(NOTEBOOK);
    mem.addUser(`turn ${turn}: ${"filler ".repeat(80)}`);
    mem.addAssistant(`did some work ${"more filler ".repeat(80)}`);
    await mem.maybeCompress(summarize, 2_000);
  }

  expect(compactions).toBeGreaterThan(3);
  // The notebook rides on the last USER-role message (P1 prompt-cache layout —
  // see WorkingMemory.render()), not necessarily the structurally last message:
  // the loop's last call is addAssistant, so .at(-1) would be the assistant turn.
  const rendered = mem.render();
  const lastUser = [...rendered].reverse().find((m) => m.role === "user");
  // The whole point: an early fact is still in the prompt at the end.
  expect(lastUser?.content).toContain("~/.cinderpaw/agent/cinderpaw.db");
});
