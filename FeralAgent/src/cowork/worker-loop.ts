/**
 * Cowork Worker Loop (S3 Worker Loop & Outbound A2A Events Emission).
 *
 * Processes pending inbox messages and handoffs for Cowork Agents, emitting
 * `OutboundEvent` (`cowork_event`) so A2A communication is visible directly
 * in chat notifications and UI widgets.
 */

import type { CoworkAgentRepo } from "./agent-store.js";
import type { CoworkMailboxRepo } from "./mailbox.js";
import type { CoworkHandoffService } from "./handoff.js";
import type { OutboundEvent } from "../types.js";

export interface CoworkWorkerOptions {
  agentStore: CoworkAgentRepo;
  mailbox: CoworkMailboxRepo;
  handoffService: CoworkHandoffService;
  onEvent?: (event: OutboundEvent) => void;
}

export class CoworkWorkerLoop {
  private agentStore: CoworkAgentRepo;
  private mailbox: CoworkMailboxRepo;
  private handoffService: CoworkHandoffService;
  private onEvent?: (event: OutboundEvent) => void;

  constructor(opts: CoworkWorkerOptions) {
    this.agentStore = opts.agentStore;
    this.mailbox = opts.mailbox;
    this.handoffService = opts.handoffService;
    this.onEvent = opts.onEvent;
  }

  public async processAgentTasks(agentId: string): Promise<{
    processedMessages: number;
    processedHandoffs: number;
  }> {
    let processedMessages = 0;
    let processedHandoffs = 0;

    // 1. Process Pending Inbox Messages
    const pendingMessages = this.mailbox.getInbox(agentId, "pending");
    for (const msg of pendingMessages) {
      // Emit Outbound Event for UI visibility
      this.emitEvent({
        type: "cowork_event",
        eventType: "message_received",
        agentId,
        data: {
          messageId: msg.id,
          fromAgentId: msg.fromAgentId,
          subject: msg.subject,
          body: msg.body,
        },
      });

      // Update message status to processed
      this.mailbox.updateStatus(msg.id, "processed");
      processedMessages++;
    }

    // 2. Process Initiated Handoffs
    const history = this.handoffService.getHandoffHistory(agentId);
    const pendingHandoffs = history.filter(
      (h) => h.toAgentId === agentId && h.status === "initiated"
    );

    for (const handoff of pendingHandoffs) {
      // Emit handoff received event
      this.emitEvent({
        type: "cowork_event",
        eventType: "handoff_received",
        agentId,
        data: {
          handoffId: handoff.id,
          fromAgentId: handoff.fromAgentId,
          taskDescription: handoff.taskDescription,
        },
      });

      // Emit A2A Chat Widget Event for UI Visibility
      this.emitEvent({
        type: "cowork_event",
        eventType: "a2a_chat_notification",
        agentId,
        data: {
          widgetTitle: `A2A Handoff: ${handoff.fromAgentId} ➔ ${agentId}`,
          handoffId: handoff.id,
          fromAgentId: handoff.fromAgentId,
          taskDescription: handoff.taskDescription,
          status: "accepted",
        },
      });

      // Accept Handoff
      this.handoffService.acceptHandoff(handoff.id);
      processedHandoffs++;
    }

    return { processedMessages, processedHandoffs };
  }

  private emitEvent(event: OutboundEvent): void {
    if (this.onEvent) {
      this.onEvent(event);
    }
  }
}
