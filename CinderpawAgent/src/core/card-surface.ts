/**
 * Which sessions are, right now, being talked to from a surface that can show
 * cards: the local web page ("web") or the desktop app ("text", typed). Set per
 * inbound message in dispatch, like the surface brief: the same "chat" session
 * is typed into from the terminal and from the page, alternately, and the
 * answer must follow whoever is there now.
 */
export type CardSurface = "web" | "text";

const withCards = new Map<string, CardSurface>();

export function markCardSurface(sessionId: string, surface: string | undefined): void {
  if (surface === "web" || surface === "text") withCards.set(sessionId, surface);
  else withCards.delete(sessionId);
}

export function sessionHasCards(sessionId: string): boolean {
  return withCards.has(sessionId);
}

/** The desktop app can also add an extension; the web page cannot. */
export function sessionCardSurface(sessionId: string): CardSurface | undefined {
  return withCards.get(sessionId);
}
