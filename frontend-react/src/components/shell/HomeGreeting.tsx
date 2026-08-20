import { useT } from '@/lib/i18n';

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

/** Local wall-clock hour, so the greeting matches the room the user is in. */
export function greetingKey(hour = new Date().getHours()) {
  if (hour < 12) return 'home.morning';
  if (hour < 18) return 'home.afternoon';
  return 'home.evening';
}

export function HomeGreeting() {
  const t = useT();
  return (
    // Three tiers, not two lines of the same size. Every ai-chat home screen
    // worth copying does this: a mark, a quiet line that says WHO is being
    // greeted, and one big line that says what to do next. Two equal lines read
    // as a paragraph, and a paragraph is not an invitation.
    //
    // The mascot stays on the composer, where it belongs: it walks that edge
    // and carries the tool-call stack, which is how anyone sees what is
    // running. What it needed was air above the field, not a new home.
    <div className="mb-8 flex flex-col items-center text-center select-none">
      <p className="text-base text-text-muted">{t(greetingKey())}</p>
      <h1 className="mt-1 text-3xl leading-[1.2] font-semibold tracking-[-0.02em] text-text-primary">
        {t('home.ask')}
      </h1>
    </div>
  );
}
