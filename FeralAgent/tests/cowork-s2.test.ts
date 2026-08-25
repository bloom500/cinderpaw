import { describe, expect, it } from "vitest";
import { CoworkMailboxRepo } from "../src/cowork/mailbox.js";
import { CoworkHandoffService } from "../src/cowork/handoff.js";

describe("Cowork S2: Mailbox Messaging & Handoff Protocol", () => {
  it("sends message and lists inbox/outbox", () => {
    let storedMessages: any[] = [];

    const fakeDb = {
      query: (sql: string) => ({
        all: (...args: any[]) => {
          if (sql.includes("to_agent_id = ?")) {
            return storedMessages.filter((m) => m.to_agent_id === args[0]);
          }
          if (sql.includes("from_agent_id = ?")) {
            return storedMessages.filter((m) => m.from_agent_id === args[0]);
          }
          return storedMessages;
        },
        get: (id: string) => storedMessages.find((m) => m.id === id) ?? null,
        run: (...args: any[]) => {
          if (sql.includes("INSERT INTO cowork_mailbox")) {
            storedMessages.push({
              id: args[0],
              from_agent_id: args[1],
              to_agent_id: args[2],
              subject: args[3],
              body: args[4],
              payload_json: args[5],
              status: args[6],
              created_at: args[7],
              read_at: args[8],
            });
          }
          return { changes: 1 };
        },
      }),
    } as any;

    const mailbox = new CoworkMailboxRepo(fakeDb);
    const msg = mailbox.sendMessage({
      id: "msg_1",
      fromAgentId: "agent_a",
      toAgentId: "agent_b",
      subject: "Code Review Required",
      body: "Please review PR #42 for security vulnerabilities.",
    });

    expect(msg.id).toBe("msg_1");
    expect(msg.status).toBe("pending");

    const inbox = mailbox.getInbox("agent_b");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].subject).toBe("Code Review Required");

    const outbox = mailbox.getOutbox("agent_a");
    expect(outbox).toHaveLength(1);
  });

  it("manages complete handoff protocol lifecycle (initiate -> accept -> complete)", () => {
    let handoffState: any = null;

    const fakeDb = {
      query: (sql: string) => ({
        all: (...args: any[]) => [handoffState].filter(Boolean),
        get: (id: string) => (handoffState && handoffState.id === id ? handoffState : null),
        run: (...args: any[]) => {
          if (sql.includes("INSERT INTO cowork_handoffs")) {
            handoffState = {
              id: args[0],
              from_agent_id: args[1],
              to_agent_id: args[2],
              task_description: args[3],
              context_json: args[4],
              status: args[5],
              result_json: args[6],
              created_at: args[7],
              completed_at: args[8],
            };
          } else if (sql.includes("UPDATE cowork_handoffs SET status = 'accepted'")) {
            if (handoffState) handoffState.status = "accepted";
          } else if (sql.includes("UPDATE cowork_handoffs\n         SET status = 'completed'")) {
            if (handoffState) {
              handoffState.status = "completed";
              handoffState.result_json = args[0];
              handoffState.completed_at = args[1];
            }
          }
          return { changes: 1 };
        },
      }),
    } as any;

    const service = new CoworkHandoffService(fakeDb);

    // 1. Initiate Handoff
    const handoff = service.initiateHandoff({
      id: "handoff_100",
      fromAgentId: "agent_lead",
      toAgentId: "agent_tester",
      taskDescription: "Run full E2E test suite on production build",
      contextData: { prNumber: 42 },
    });

    expect(handoff.id).toBe("handoff_100");
    expect(handoff.status).toBe("initiated");

    // 2. Accept Handoff
    const accepted = service.acceptHandoff("handoff_100");
    expect(accepted).toBe(true);

    // 3. Complete Handoff
    const completed = service.completeHandoff("handoff_100", { passedTests: 42, failedTests: 0 });
    expect(completed).toBe(true);

    const history = service.getHandoffHistory("agent_tester");
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("completed");
    expect(history[0].resultJson).toContain("passedTests");
  });
});
