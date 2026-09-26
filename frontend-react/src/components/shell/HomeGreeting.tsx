import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { useOnboarding } from '@/stores/onboarding';
import { pickHomeLine } from '@/lib/homeLines';

const LAST_LINE_KEY = 'cinderpaw.homeLine.last';

/** Today's line, remembered so the next visit gets a different one. Storage
 *  can be missing (private window, blocked site data); the line still shows. */
function chooseLine(): string {
  let last: string | null = null;
  try { last = localStorage.getItem(LAST_LINE_KEY); } catch { /* no storage */ }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  const line = pickHomeLine(new Date(), zone, last);
  try { localStorage.setItem(LAST_LINE_KEY, line); } catch { /* no storage */ }
  return line;
}

/**
 * The time of day, then the one question.
 *
 * It renders inside the composer's own wrapper rather than floating above it.
 * The wrapper is what gets centred, and the centring is done on its measured
 * height, so anything placed outside it has to guess that height a second
 * time — which is exactly what the greeting did, in a `pb-64` that was right
 * until the type got bigger and then put "What can I help you with?" straight
 * through the top of the field.
 */

/**
 * Local wall-clock hour, so the greeting matches the room the user is in.
 * Past 23:00 and before 5:00 it is the night owl's hour, in any locale, and
 * the line says so instead of a stiff "Good evening"; two variants, picked
 * by the day of the month so it changes from night to night, not per render.
 */
export function greetingKey(hour = new Date().getHours(), day = new Date().getDate()) {
  if (hour >= 23 || hour < 5) return day % 2 === 0 ? 'home.night.1' : 'home.night.2';
  if (hour < 12) return 'home.morning';
  if (hour < 18) return 'home.afternoon';
  return 'home.evening';
}

export function HomeGreeting() {
  const t = useT();
  const name = useOnboarding((s) => s.userName);
  // Chosen once per visit: a line that changed while you looked at it would be
  // a screensaver, not a greeting.
  const [line] = useState(chooseLine);
  const key = greetingKey();
  const hello = name && !key.startsWith('home.night') ? `${t(key)}, ${name}` : t(key);
  return (
    // Three tiers, not two lines of the same size. Every ai-chat home screen
    // worth copying does this: a mark, a quiet line that says WHO is being
    // greeted, and one big line that says what to do next. Two equal lines read
    // as a paragraph, and a paragraph is not an invitation.
    //
    // The mascot stays on the composer, where it belongs: it walks that edge
    // and carries the tool-call stack, which is how anyone sees what is
    // running. What it needed was air above the field, not a new home: it
    // perches 104px tall on the field's edge, and with mb-8 it stood through
    // "What can" on the first screen a new install shows (23 Sep). mb-28
    // clears it with a few px to spare and lifts the question, which sat low.
    <div className="mb-28 flex flex-col items-center text-center select-none">
      <p className="text-base text-text-muted">{hello}</p>
      <h1 className="mt-1 text-3xl leading-[1.2] font-semibold tracking-[-0.02em] text-text-primary">
        {line}
      </h1>
    </div>
  );
}
