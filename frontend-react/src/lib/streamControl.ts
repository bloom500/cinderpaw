/**
 * The one stop entry point for UI code: the Stop button, a call's barge-in.
 *
 * Chat mode had its own stream manager, and the Stop button once called that
 * one while the agent kept generating. Only the agent streams now; this stays
 * the single place a stop goes through, so a future change lands once.
 */

import { requestCinderpawStop } from './cinderpawAgentStream';

/**
 * Stop whatever is streaming for `sessionId`. A no-op when nothing is in
 * flight for that session (the sidecar latches a stop for a session it is not
 * running).
 */
export async function stopActiveStream(sessionId: string): Promise<void> {
  await requestCinderpawStop(sessionId).catch(() => {});
}
