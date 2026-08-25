import { describe, expect, it } from "vitest";
import { CoworkAgentRepo } from "../src/cowork/agent-store.js";

describe("Cowork Agent Store (S1 Agent Entity)", () => {
  it("fresh install contract: zero agents by default", () => {
    const fakeDb = {
      query: (sql: string) => ({
        all: () => [],
        get: () => null,
        run: () => ({ changes: 0 }),
      }),
    } as any;

    const repo = new CoworkAgentRepo(fakeDb);
    const agents = repo.list();
    expect(agents).toHaveLength(0);
  });

  it("upserts and retrieves cowork agent entity", () => {
    let storedRow: any = null;

    const fakeDb = {
      query: (sql: string) => ({
        all: () => (storedRow ? [storedRow] : []),
        get: (id: string) => (storedRow && storedRow.id === id ? storedRow : null),
        run: (...args: any[]) => {
          if (sql.includes("INSERT")) {
            storedRow = {
              id: args[0],
              name: args[1],
              role: args[2],
              instructions: args[3],
              model_pin: args[4],
              created_at: args[5],
              updated_at: args[6],
            };
          }
          return { changes: 1 };
        },
      }),
    } as any;

    const repo = new CoworkAgentRepo(fakeDb);
    const created = repo.upsert({
      id: "agent_dev_1",
      name: "CodeReviewer",
      role: "Reviewer",
      instructions: "Review all PRs for security and quality",
      modelPin: "qwen-38-27b",
    });

    expect(created.id).toBe("agent_dev_1");
    expect(created.name).toBe("CodeReviewer");
    expect(created.modelPin).toBe("qwen-38-27b");

    const fetched = repo.get("agent_dev_1");
    expect(fetched).not.toBeNull();
    expect(fetched?.role).toBe("Reviewer");
  });
});
