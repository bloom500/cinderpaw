/**
 * When each stage of a call actually happened, on the browser's own clock.
 *
 * Built on the User Timing API rather than on a timing module of our own for
 * two reasons that both matter more than the twenty lines it saves. The clock
 * is monotonic, so a call is not mismeasured by an NTP correction landing
 * mid-connection. And the marks show up in the browser's performance timeline
 * next to the layout, script and network work they overlap with, which is the
 * difference between "the call took 15s" and knowing which 15s.
 *
 * Nothing here is sent anywhere, and nothing here carries content: the names
 * below are stages, never transcripts, never keys, never audio. What a person
 * said is not diagnostic data.
 */

/** The stages worth naming, in the order a healthy call passes them. */
export const CALL_MARKS = [
  'call_requested',
  'call_ui_ready',
  'room_join_started',
  'room_joined',
  'microphone_ready',
  'agent_session_started',
  'first_transcript',
  'first_agent_response',
  'call_disconnected',
] as const;

export type CallMark = (typeof CALL_MARKS)[number];

const PREFIX = 'cinderpaw/call/';
const started = `${PREFIX}call_requested`;

/**
 * Record that a stage has been reached.
 *
 * `call_requested` starts a new timeline and clears the last one, so a second
 * call is measured as a second call rather than as a continuation of the first.
 * Every later mark is also measured back to it, because the number anybody
 * actually asks for is "how long after I pressed the button".
 *
 * A stage that is reached twice is recorded once. `first_transcript` means the
 * first one; a mark that moved every turn would answer a different question
 * from the one it is named after.
 */
export function callMark(mark: CallMark): void {
  // Absent in a non-DOM environment and, historically, behind a flag. A missing
  // stopwatch must never be the reason a call does not start.
  const p = globalThis.performance;
  if (!p?.mark) return;
  const name = PREFIX + mark;
  try {
    if (mark === 'call_requested') {
      p.clearMarks?.();
      p.clearMeasures?.();
    } else if (p.getEntriesByName(name, 'mark').length > 0) {
      return;
    }
    p.mark(name);
    if (mark !== 'call_requested' && p.getEntriesByName(started, 'mark').length > 0) {
      p.measure?.(`${PREFIX}since_click/${mark}`, started, name);
    }
  } catch {
    // A timeline that has been cleared under us is not worth a broken call.
  }
}

/** Milliseconds from the button press to each stage this call has reached. */
export function callTimeline(): { mark: CallMark; ms: number }[] {
  const p = globalThis.performance;
  if (!p?.getEntriesByType) return [];
  const by = new Map(
    p
      .getEntriesByType('measure')
      .filter((e) => e.name.startsWith(`${PREFIX}since_click/`))
      .map((e) => [e.name.slice(`${PREFIX}since_click/`.length), Math.round(e.duration)]),
  );
  return CALL_MARKS.filter((m) => by.has(m)).map((m) => ({ mark: m, ms: by.get(m)! }));
}

/* ------------------------------------------------------------------------ *
 * Per turn, for the question the marks above cannot answer.
 *
 * Those measure entering a call, once. The other complaint is that a call gets
 * slower the longer it lasts, and that needs the same three spans measured
 * again on every turn so turn 1 and turn 100 can be put side by side.
 *
 * Four moments are observable from the event stream we already receive, and
 * nothing here invents a fifth:
 *
 *   heard(partial)  the first words appear on screen
 *   heard(final)    the transcript has settled
 *   state=speaking  the answer starts coming back
 *   said            the answer is complete
 *
 * All three spans are measured from the first partial, which is the earliest
 * evidence anywhere in this process that a person started talking. It is not
 * the moment they opened their mouth: that happens in a microphone, on the
 * other side of a vendor's endpointer, and claiming to measure it would be
 * inventing a number. What this does measure is every millisecond that is
 * ours, plus the vendor's, which is enough to see one of them grow.
 * ------------------------------------------------------------------------ */

const TURN = 'cinderpaw/turn/';

/** The stages of one spoken turn, in order. */
export type TurnStage = 'heard' | 'transcribed' | 'answering' | 'answered';

let turnNo = 0;
let turnStarted = false;

/**
 * Record a stage of the current turn, and start a new turn on the first
 * `heard` after one has finished.
 *
 * Returns the completed turn's timings on `answered`, and `null` otherwise, so
 * a caller can report a turn without keeping its own state.
 */
export function turnMark(stage: TurnStage): { turn: number; spans: Record<string, number> } | null {
  const p = globalThis.performance;
  if (!p?.mark) return null;
  try {
    if (stage === 'heard') {
      if (turnStarted) return null; // still the same utterance, several times a second
      turnNo += 1;
      turnStarted = true;
      p.mark(`${TURN}${turnNo}/start`);
      return null;
    }
    if (!turnStarted) return null; // a stage with no turn behind it
    const from = `${TURN}${turnNo}/start`;
    if (p.getEntriesByName(from, 'mark').length === 0) return null;
    p.measure(`${TURN}${turnNo}/${stage}`, from, p.mark(`${TURN}${turnNo}/${stage}/at`).name);
    if (stage !== 'answered') return null;

    turnStarted = false;
    const spans: Record<string, number> = {};
    for (const s of ['transcribed', 'answering', 'answered']) {
      const [m] = p.getEntriesByName(`${TURN}${turnNo}/${s}`, 'measure');
      if (m) spans[s] = Math.round(m.duration);
    }
    // Only the turn just finished is kept. A hundred turns of marks is a
    // hundred turns of entries in a buffer the browser caps anyway, and the
    // number that matters is printed before they go.
    for (const s of ['start', 'transcribed', 'answering', 'answered']) {
      p.clearMarks?.(`${TURN}${turnNo}/${s}`);
      p.clearMarks?.(`${TURN}${turnNo}/${s}/at`);
      p.clearMeasures?.(`${TURN}${turnNo}/${s}`);
    }
    return { turn: turnNo, spans };
  } catch {
    return null;
  }
}

/** Forget which turn we are on. A new call starts at turn one. */
export function resetTurns(): void {
  turnNo = 0;
  turnStarted = false;
}
