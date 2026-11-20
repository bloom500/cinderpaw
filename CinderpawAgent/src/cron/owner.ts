import type { AgentLoop } from "../core/agent-loop.ts";
import type { CoworkAgent } from "../cowork/agent-store.ts";

type ProfileHost = Pick<AgentLoop, "registerProfile" | "setSessionProfile" | "clearSessionProfile">;

export function applyCoworkProfile(agent: ProfileHost, teammate: CoworkAgent, sessionId: string): void {
  const profileId = `cowork:${teammate.id}`;
  agent.registerProfile(profileId, {
    systemPrompt: [
      `You are ${teammate.name}${teammate.role ? `, ${teammate.role}` : ""}.`,
      teammate.instructions,
      "You are a teammate inside someone's Cinderpaw install. You answer the message you were sent and stop; you do not invent follow-up work.",
    ].filter(Boolean).join("\n\n"),
    allowedTools: teammate.tools,
    owner: true,
  });
  agent.setSessionProfile(sessionId, profileId);
}

/** Keep the isolated cron session and budget, but use the teammate's profile. */
export async function withCronOwner<T>(
  agent: ProfileHost & Pick<AgentLoop, "resetSession">,
  activeOwners: Map<string, string>,
  teammate: CoworkAgent | undefined,
  sessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!teammate) return run();
  // Working memory caches the system prompt. Drop any prior owner's prompt
  // before this run and clear this teammate's prompt before a later main run.
  agent.resetSession(sessionId);
  applyCoworkProfile(agent, teammate, sessionId);
  activeOwners.set(sessionId, teammate.id);
  try {
    return await run();
  } finally {
    agent.clearSessionProfile(sessionId);
    agent.resetSession(sessionId);
    activeOwners.delete(sessionId);
  }
}
