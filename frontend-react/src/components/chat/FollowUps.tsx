/**
 * Up to four follow-up chips closing a finished reply (spec 7.5, Artifact
 * Dock): the agent's `show_widget` `followups`. A chip fills the composer and
 * stops, like the Home intents; nothing is sent until the person sends it.
 */
export function FollowUps({ next, onPick }: { next: string[]; onPick: (text: string) => void }) {
  if (next.length === 0) return null;
  return (
    <div role="group" aria-label="Follow-ups" className="flex flex-wrap gap-2">
      {next.slice(0, 4).map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => onPick(text)}
          className="rounded-full border border-border-default px-3 py-1 text-sm text-text-muted transition-colors hover:bg-text-primary/5 hover:text-text-primary cursor-pointer"
        >
          {text}
        </button>
      ))}
    </div>
  );
}
