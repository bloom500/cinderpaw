import { test, expect } from "bun:test";
import { createCoworkCreateTool } from "../src/tools/builtin/cowork-create.ts";

function toolWithRoster(n: number) {
  const roster = Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `T${i}`, role: "r" }));
  return createCoworkCreateTool({
    agents: { list: () => roster, upsert: (a: any) => ({ ...a, id: "new" }) },
    mailbox: {} as any,
    registry: { list: () => [], register: () => {}, has: () => true } as any,
    log: () => {},
  } as any);
}

test("cap 1 refuses the second teammate", async () => {
  process.env.CINDERPAW_MAX_COWORKERS = "1";
  const r = await toolWithRoster(1).execute({ name: "Atlas", role: "dev" });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("coworker_limit");
  expect(r.content).toContain("limit for this run is 1");
});

test("cap 1 still allows the first", async () => {
  process.env.CINDERPAW_MAX_COWORKERS = "1";
  const r = await toolWithRoster(0).execute({ name: "Atlas", role: "dev" });
  expect(r.error).not.toBe("coworker_limit");
});

test("unset cap does not limit", async () => {
  delete process.env.CINDERPAW_MAX_COWORKERS;
  const r = await toolWithRoster(9).execute({ name: "Atlas", role: "dev" });
  expect(r.error).not.toBe("coworker_limit");
});
