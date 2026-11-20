import type { CoworkAgent } from "./agent-store.ts";

/** The bot has one account. An explicit name addresses one private teammate. */
export function addressedTeammate(text: string, roster: CoworkAgent[]): { agent: CoworkAgent; body: string } | undefined {
  const match = /^@?([^:\n]{1,80}):\s*([\s\S]+)$/.exec(text.trim());
  if (!match) return;
  const name = match[1]!.trim().toLowerCase();
  const body = match[2]!.trim();
  if (!body) return;
  const byId = roster.filter((agent) => agent.id.toLowerCase() === name);
  const matches = byId.length ? byId : roster.filter((agent) => agent.name.toLowerCase() === name);
  if (matches.length === 1) return { agent: matches[0]!, body };
  return undefined;
}

export function signedTeamMessage(name: string, content: string, address = name): string {
  const excerpt = content.length > 1500 ? `${content.slice(0, 1500)}…` : content;
  return `${name}\n\n${excerpt}\n\nReply with “${address}:” followed by your message.`;
}
