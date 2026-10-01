import { CinderpawMascot } from '@/components/chat/mascot/CinderpawMascot';
import type { MascotState } from '@/components/chat/mascot/frames';
import { cn } from '@/lib/utils';

/** What the mascot is doing on the cover, by the kind of thing it made. */
const POSE: Record<string, MascotState> = {
  document: 'writing', markdown: 'writing', pdf: 'reading', code: 'building', app: 'building',
  html: 'building', image: 'cool', table: 'thinking', file: 'idle',
};

/**
 * The cover Darius's Artifact board draws: the title in the serif on a warm
 * ground, rolling hills in the brand orange, and the mascot at work beside
 * them. Drawn, not rendered from the content, so every artifact has one, a
 * blank page included, and it looks the same in a list of fifty.
 *
 * `size="sm"` is the tile for a list or a menu: hills and mascot, no words.
 */
export function ArtifactCover({ title, kind, size = 'lg', className }: {
  title: string;
  kind: string;
  size?: 'lg' | 'sm';
  className?: string;
}) {
  const lg = size === 'lg';
  return (
    <div className={cn('relative overflow-hidden bg-[color-mix(in_oklab,var(--brand)_8%,var(--bg-elevated))]', className)} aria-hidden={!lg}>
      <svg viewBox="0 0 400 220" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <path d="M0 150 C 70 120, 130 165, 210 140 S 340 110, 400 132 L400 220 L0 220 Z" fill="var(--brand)" opacity="0.18" />
        <path d="M0 178 C 90 150, 160 196, 250 168 S 360 150, 400 162 L400 220 L0 220 Z" fill="var(--brand)" opacity="0.4" />
        <path d="M0 204 C 110 184, 190 214, 290 196 S 380 188, 400 194 L400 220 L0 220 Z" fill="var(--brand)" opacity="0.85" />
      </svg>
      {lg && (
        <div className="absolute left-5 top-5 max-w-[62%]">
          <p className="line-clamp-3 font-display text-3xl leading-[1.05] text-text-primary">{title}</p>
          <p className="mt-2 text-micro font-medium uppercase tracking-[0.18em] text-text-secondary">
            {kind === 'markdown' ? 'document' : kind}
          </p>
        </div>
      )}
      <span className={cn('absolute', lg ? 'bottom-1 right-3' : 'bottom-0 right-0.5')}>
        <CinderpawMascot state={POSE[kind] ?? 'idle'} width={lg ? 132 : 30} />
      </span>
    </div>
  );
}
