/**
 * Cowork Agent Contracts (S1-S3).
 *
 * Shared interfaces for Cowork Agents, Mailbox Messaging, and Task Handoff Protocol.
 */

export interface CoworkAgent {
  id: string;
  name: string;
  role: string;
  instructions: string;
  modelPin?: string | null;
  createdAt: string | number;
  updatedAt: string | number;
}

export type MessageStatus = "pending" | "read" | "processed" | "rejected";

export interface CoworkMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string | "human"; // "human" is a valid target recipient
  subject: string;
  body: string;
  payloadJson?: string | null;
  status: MessageStatus;
  createdAt: string | number;
  readAt?: string | number | null;
}

export type HandoffStatus = "initiated" | "accepted" | "completed" | "failed";

export interface CoworkHandoff {
  id: string;
  fromAgentId: string;
  toAgentId: string | "human";
  taskDescription: string;
  contextJson: string;
  status: HandoffStatus;
  resultJson?: string | null;
  createdAt: string | number;
  completedAt?: string | number | null;
}
