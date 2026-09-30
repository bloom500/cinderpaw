import type { CoworkExchange } from '@/stores/coworkTranscript';

/** One teammate card in the Coworker Strip. */
export interface StripTeammate {
  agentId: string;
  name: string;
  state: 'working' | 'answered';
  /** What it was asked: the request it is working on, or the one it answered. */
  task: string | null;
  /** When the work began (live exchanges only). */
  since: number;
  /** Tools it called on that request, oldest first. */
  tools: { name: string; done: boolean }[];
  /** The answer, once there is one. */
  answer: string | null;
  /** The exchange the answer belongs to, for marking it read. */
  exchangeId: string;
}

/**
 * The teammates the strip shows for one chat (spec 7.5): each one working on
 * something now, or with an answer the person has not opened yet. Only what
 * ran while the app was watching counts (`startedAt` is set live, never from
 * history), so reopening a chat does not bring back yesterday's answers as new.
 */
export function stripTeammates(
  exchanges: readonly CoworkExchange[],
  threadId: string | null,
  seen: Readonly<Record<string, true>>,
): StripTeammate[] {
  if (!threadId) return [];
  const latest = new Map<string, CoworkExchange>();
  for (const e of exchanges) {
    if (e.threadId !== threadId || e.kind === 'approval' || e.toAgentId === 'human' || !e.startedAt) continue;
    const prev = latest.get(e.toAgentId);
    if (!prev || e.status === 'running' || prev.status !== 'running') latest.set(e.toAgentId, e);
  }
  const out: StripTeammate[] = [];
  for (const [agentId, e] of latest) {
    const working = e.status === 'running';
    const unread = e.status === 'done' && !!e.responseText && !seen[e.id];
    if (!working && !unread) continue;
    out.push({
      agentId,
      name: e.toName?.trim() || agentId.split(':').pop() || agentId,
      state: working ? 'working' : 'answered',
      task: e.requestText,
      since: e.startedAt!,
      tools: e.tools ?? [],
      answer: working ? null : e.responseText,
      exchangeId: e.id,
    });
  }
  return out;
}
