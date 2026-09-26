/**
 * Which sessions are, right now, being talked to from a surface that can show
 * cards (the local web page). Set per inbound message in dispatch, like the
 * surface brief: the same "chat" session is typed into from the terminal and
 * from the page, alternately, and the answer must follow whoever is there now.
 */
const withCards = new Set<string>();

export function markCardSurface(sessionId: string, on: boolean): void {
  if (on) withCards.add(sessionId);
  else withCards.delete(sessionId);
}

export function sessionHasCards(sessionId: string): boolean {
  return withCards.has(sessionId);
}
