/**
 * Session visibility — the one definition of "this session is not the owner".
 *
 * A session running under a RESTRICTED profile is someone else: the public
 * WhatsApp lead mode answers strangers who were never on the allowlist. Three
 * separate subsystems need to know that, and each of them leaked when it did
 * not:
 *   - MemoryExtractor, which would mine "durable facts about the user" from a
 *     stranger's turn (fixed in 43bfec2);
 *   - EpisodicMemory's CROSS-session search, which would surface a lead's
 *     transcript in the owner's `recall`;
 *   - the fractal RAPTOR tree, which indexes `episodic.all()` and is the
 *     backing store for the same `recall` tool.
 *
 * Keeping the predicate in one place is the point. Three copies of "is this
 * the owner?" is three chances for the next public surface to be caught by two
 * of them.
 *
 * `AgentLoop.setSessionProfile` is the single writer; a profile whose
 * `allowedTools` whitelist is absent is a persona-only profile — still the
 * owner in a different voice — and is deliberately NOT restricted.
 *
 * ponytail: a process-global Set, not a column on a sessions table. Restricted
 * sessions are re-marked on every inbound message (the connector calls
 * setSessionProfile before every turn), so a restart that empties this cannot
 * make an old lead session look like the owner — the first message re-marks it
 * before anything is written. The durable half is the `private` column already
 * written on the episodic row.
 */

const restricted = new Set<string>();

/** Record whether `sessionId` runs under a restricted (non-owner) profile. */
export function markSessionRestricted(sessionId: string, isRestricted: boolean): void {
  if (isRestricted) restricted.add(sessionId);
  else restricted.delete(sessionId);
}

/** True when this session is a non-owner (public / restricted profile). */
export function isRestrictedSession(sessionId: string): boolean {
  return restricted.has(sessionId);
}

/** Test helper — drop all marks. */
export function resetSessionVisibility(): void {
  restricted.clear();
}
