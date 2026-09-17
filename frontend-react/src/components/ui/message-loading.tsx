/**
 * Three dots that hop while the agent works.
 *
 * From jakobhoeg/shadcn-chat's `message-loading` (MIT), unchanged except:
 * `currentColor` from the parent instead of a fixed `text-foreground`, so it
 * takes the muted tone of the line it sits in; and still dots when the person
 * asked for reduced motion, because SMIL animation ignores that setting on its own.
 */
export function MessageLoading({ className }: { className?: string }) {
  const reduced =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const hop = (begin: string, id?: string) =>
    reduced ? null : (
      <animate
        {...(id ? { id } : {})}
        begin={begin}
        attributeName="cy"
        calcMode="spline"
        dur="0.6s"
        values="12;6;12"
        keySplines=".33,.66,.66,1;.33,0,.66,.33"
      />
    );
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden className={className}>
      <circle cx="4" cy="12" r="2" fill="currentColor">{hop('0;dotsLast.end+0.25s', 'dotsFirst')}</circle>
      <circle cx="12" cy="12" r="2" fill="currentColor">{hop('dotsFirst.begin+0.1s')}</circle>
      <circle cx="20" cy="12" r="2" fill="currentColor">{hop('dotsFirst.begin+0.2s', 'dotsLast')}</circle>
    </svg>
  );
}
