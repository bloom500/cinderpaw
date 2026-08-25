import { describe, expect, it } from "vitest";
import { CoworkWorkerLoop } from "../src/cowork/worker-loop.js";
import { CoworkAgentRepo } from "../src/cowork/agent-store.js";
import { CoworkMailboxRepo } from "../src/cowork/mailbox.js";
import { CoworkHandoffService } from "../src/cowork/handoff.js";
import { OutboundEvent } from "../src/types.js";

describe("Cowork S3: Worker Loop & A2A Chat Widget Outbound Events", () => {
  it("processes pending messages and emits cowork_event OutboundEvents", async () => {
    let messageStore: any[] = [
      {
        id: "msg_201",
        from_agent_id: "agent_qa",
        to_agent_id: "agent_dev",
        subject: "Bug Report",
        body: "Fix memory leak in RLM REPL",
        payload_json: null,
        status: "pending",
        created_at: new Date().toISOString(),
        read_at: null,
      },
    ];

    const fakeDb = {
      query: (sql: string) => ({
        all: (...args: any[]) => messageStore.filter((m) => m.status === "pending"),
        get: () => null,
        run: (...args: any[]) => {
          if (sql.includes("UPDATE cowork_mailbox")) {
            const id = args[2];
            const msg = messageStore.find((m) => m.id === id);
            if (msg) msg.status = args[0];
          }
          return { changes: 1 };
        },
      }),
    } as any;

    const agentStore = new CoworkAgentRepo(fakeDb);
    const mailbox = new CoworkMailboxRepo(fakeDb);
    const handoffService = new CoworkHandoffService(fakeDb);

    const emittedEvents: OutboundEvent[] = [];
    const onEvent = (e: OutboundEvent) => emittedEvents.push(e);

    const worker = new CoworkWorkerLoop({
      agentStore,
      mailbox,
      handoffService,
      onEvent,
    });

    const result = await worker.processAgentTasks("agent_dev");
    expect(result.processedMessages).toBe(1);

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].type).toBe("cowork_event");
    if (emittedEvents[0].type === "cowork_event") {
      expect(emittedEvents[0].eventType).toBe("message_received");
      expect(emittedEvents[0].agentId).toBe("agent_dev");
      expect(emittedEvents[0].data.subject).toBe("Bug Report");
    }
  });

  it("processes initiated handoffs and emits a2a_chat_notification OutboundEvents", async () => {
    let handoffStore: any[] = [
      {
        id: "handoff_301",
        from_agent_id: "agent_lead",
        to_agent_id: "agent_dev",
        task_description: "Refactor Scene Graph Parser",
        context_json: "{}",
        status: "initiated",
        result_json: null,
        created_at: new Date().toISOString(),
        completed_at: null,
      },
    ];

    const fakeDb = {
      query: (sql: string) => ({
        all: (...args: any[]) => (sql.includes("cowork_mailbox") ? [] : handoffStore),
        get: () => null,
        run: (...args: any[]) => {
          if (sql.includes("UPDATE cowork_handoffs SET status = 'accepted'")) {
            const id = args[0];
            const h = handoffStore.find((m) => m.id === id);
            if (h) h.status = "accepted";
          }
          return { changes: 1 };
        },
      }),
    } as any;

    const agentStore = new CoworkAgentRepo(fakeDb);
    const mailbox = new CoworkMailboxRepo(fakeDb);
    const handoffService = new CoworkHandoffService(fakeDb);

    const emittedEvents: OutboundEvent[] = [];
    const onEvent = (e: OutboundEvent) => emittedEvents.push(e);

    const worker = new CoworkWorkerLoop({
      agentStore,
      mailbox,
      handoffService,
      onEvent,
    });

    const result = await worker.processAgentTasks("agent_dev");
    expect(result.processedHandoffs).toBe(1);

    // Expect 2 events: handoff_received + a2a_chat_notification
    expect(emittedEvents).toHaveLength(2);
    expect(emittedEvents[0].type).toBe("cowork_event");
    expect(emittedEvents[1].type).toBe("cowork_event");

    if (emittedEvents[1].type === "cowork_event") {
      expect(emittedEvents[1].eventType).toBe("a2a_chat_notification");
      expect(emittedEvents[1].data.widgetTitle).toContain("A2A Handoff: agent_lead ➔ agent_dev");
      expect(emittedEvents[1].data.taskDescription).toBe("Refactor Scene Graph Parser");
    }
  });
});
