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
    // mb-10 is not padding for looks: the mascot perches on the composer's top
    // edge and needs somewhere to sit that is not on top of a word.
    <div className="mb-10 text-center select-none">
      <h1 className="text-[40px] leading-[1.15] font-semibold text-text-primary">
        {t(greetingKey())}
      </h1>
      <p className="text-[40px] leading-[1.15] font-semibold text-text-primary/70">
        {t('home.ask')}
      </p>
    </div>
  );
}
