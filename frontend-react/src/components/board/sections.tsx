import { useState } from 'react';
import { ArrowRight, Check, MapPin } from 'lucide-react';
import { HUES, hash, tint, type Block, type Hue, type Look } from '@/lib/board';
import { cn } from '@/lib/utils';
import { boardIcon } from './icons';
import { Panel } from './charts';

type Of<K extends Block['kind']> = Extract<Block, { kind: K }>;

/** A remote picture, or the hue's wash with an icon: never a broken-image glyph. */
export function Photo({ src, hue, className, icon }: { src?: string; hue: Hue; className?: string; icon?: string }) {
  const [failed, setFailed] = useState(false);
  const Icon = boardIcon(icon);
  if (!src || failed) {
    return (
      <span className={cn('flex items-center justify-center', className)} style={{ background: tint(hue, 14), color: HUES[hue] }}>
        {Icon && <Icon size={28} strokeWidth={1.5} />}
      </span>
    );
  }
  return <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={cn('block object-cover', className)} />;
}

/** The step number, in the board's style for numbers. */
function Num({ n, look, hue }: { n: number; look: Look; hue: Hue }) {
  if (look.numbers === 'serif') return <span className="font-display text-4xl leading-none" style={{ color: HUES[hue] }}>{n}</span>;
  if (look.numbers === 'pill') {
    return <span className="w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wider" style={{ background: tint(hue, 14), color: HUES[hue] }}>{String(n).padStart(2, '0')}</span>;
  }
  return <span className="flex h-11 w-11 items-center justify-center rounded-full text-lg" style={{ background: tint(hue, 14), color: HUES[hue] }}>{n}</span>;
}

/**
 * What stands for a picture when a column has none: its icon in a tinted tile
 * with two soft circles behind, placed by the column's own hash, so no two
 * columns (and no two boards) draw the same little scene.
 */
function Vignette({ icon, hue, seed }: { icon?: string; hue: Hue; seed: string }) {
  const Icon = boardIcon(icon);
  if (!Icon) return null;
  const h = hash(seed);
  // Beside the tile, never under it: the washes are see-through, and stacked they turn to mud.
  const s = 44 + (h % 14), tile = s + 26;
  const side = h & 1 ? 1 : -1;
  const dy1 = ((h >>> 4) % 40) - 20, dy2 = ((h >>> 9) % 40) - 20;
  return (
    <span className="relative my-3 flex h-24 items-center justify-center" aria-hidden>
      <span className="absolute h-10 w-10 rounded-full" style={{ background: tint(hue, 14), transform: `translate(${side * -(tile / 2 + 24)}px, ${dy1}px)` }} />
      <span className="absolute h-6 w-6 rounded-full" style={{ background: tint(hue, 24), transform: `translate(${side * (tile / 2 + 18)}px, ${dy2}px)` }} />
      <span className="relative flex items-center justify-center rounded-2xl" style={{ width: tile, height: tile, background: tint(hue, 18), color: HUES[hue] }}>
        <Icon size={s * 0.62} strokeWidth={1.6} />
      </span>
    </span>
  );
}

/** Numbered columns joined by arrows: the GTM board. */
export function Columns({ b, look, onPick }: { b: Of<'columns'>; look: Look; onPick?: (title: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      {b.title && <h3 className="font-display text-2xl text-text-primary">{b.title}</h3>}
      <div className="grid auto-cols-[minmax(11rem,1fr)] grid-flow-col gap-5 overflow-x-auto pb-1">
        {b.items.map((c, i) => {
          const hue = look.tints[i % look.tints.length];
          return (
            <button
              key={c.title}
              type="button"
              onClick={() => onPick?.(c.title)}
              className="relative flex flex-col gap-2 rounded-2xl border border-border-subtle bg-bg-elevated/40 p-5 text-left transition-colors hover:border-brand/40"
            >
              <Num n={i + 1} look={look} hue={hue} />
              <span className="mt-1 font-display text-2xl leading-tight text-text-primary">{c.title}</span>
              {c.text && <span className="text-base leading-snug text-text-muted">{c.text}</span>}
              {c.image
                ? <Photo src={c.image} hue={hue} icon={c.icon} className="my-2 aspect-[4/3] w-full rounded-xl" />
                : <Vignette icon={c.icon} hue={hue} seed={`${c.title}${i}`} />}
              {c.points && c.points.length > 0 && (
                <ul className="mt-auto flex flex-col gap-2 border-t border-border-subtle pt-3">
                  {c.points.map((p) => (
                    <li key={p} className="flex gap-2.5 text-sm leading-snug text-text-secondary">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: HUES[look.accent] }} />
                      {p}
                    </li>
                  ))}
                </ul>
              )}
              {i < b.items.length - 1 && (
                <ArrowRight size={20} className="absolute -right-[17px] top-1/2 z-10 -translate-y-1/2 text-text-muted" aria-hidden />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Pillars with an icon and checks: the Marketing board's Awareness / Conversion / Retention. */
export function Pillars({ b, look }: { b: Of<'pillars'>; look: Look }) {
  return (
    <div className="flex flex-col gap-3">
      {b.title && <h3 className="font-display text-2xl text-text-primary">{b.title}</h3>}
      <div className="grid gap-4 @2xl:grid-cols-3">
        {b.items.map((p, i) => {
          const hue = look.tints[i % look.tints.length];
          const Icon = boardIcon(p.icon);
          return (
            <div key={p.title} className="rounded-2xl border p-5" style={{ background: tint(hue, 7), borderColor: tint(hue, 20) }}>
              <div className="flex items-start gap-3.5">
                {Icon && (
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full" style={{ background: tint(hue, 16), color: HUES[hue] }}>
                    <Icon size={28} strokeWidth={1.7} />
                  </span>
                )}
                <span className="flex flex-col gap-1">
                  <span className="font-display text-2xl leading-tight text-text-primary">{p.title}</span>
                  {p.text && <span className="text-sm leading-snug text-text-muted">{p.text}</span>}
                </span>
              </div>
              <ul className="mt-4 flex flex-col gap-3 border-t pt-4" style={{ borderColor: tint(hue, 20) }}>
                {p.checks.map((c) => (
                  <li key={c} className="flex gap-3 text-base leading-snug text-text-secondary">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full" style={{ background: tint(hue, 18), color: HUES[hue] }}>
                      <Check size={14} strokeWidth={2.5} />
                    </span>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Days or months down a line: the Trip board's itinerary, the GTM board's Jan / Feb / Mar. */
export function Timeline({ b, look }: { b: Of<'timeline'>; look: Look }) {
  const accent = HUES[look.accent];
  return (
    <Panel title={b.title} className="bg-transparent">
      <ol className={cn('flex flex-col', b.title && 'mt-4')}>
        {b.items.map((t, i) => (
          <li key={`${t.label}${i}`} className="grid grid-cols-[1.5rem_1fr] gap-3">
            <span className="relative flex justify-center">
              <span
                className="z-10 mt-1 h-4 w-4 rounded-full border-2"
                style={i === 0 ? { background: accent, borderColor: accent } : { borderColor: 'color-mix(in oklab, var(--text-muted) 45%, transparent)', background: 'var(--bg-surface)' }}
              />
              {i < b.items.length - 1 && <span className="absolute bottom-0 top-5 w-0.5" style={{ background: i === 0 ? accent : 'var(--border-default)' }} />}
            </span>
            <span className="flex flex-col pb-5">
              <span className="text-sm font-semibold" style={{ color: i === 0 ? accent : 'var(--text-primary)' }}>{t.label}</span>
              <span className="font-display text-lg leading-snug text-text-primary">{t.title}</span>
              {t.text && <span className="text-sm text-text-muted">{t.text}</span>}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** Pictures with a name under each: the Trip board's top strip. */
export function Photos({ b, look, pin }: { b: Of<'photos'>; look: Look; pin: boolean }) {
  return (
    <div className={cn('grid gap-4', b.items.length === 2 ? 'grid-cols-2' : b.items.length === 4 ? 'grid-cols-2 @2xl:grid-cols-4' : 'grid-cols-3')}>
      {b.items.map((p, i) => {
        const hue = look.tints[i % look.tints.length];
        return (
          <div key={p.title} className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-elevated/50">
            <Photo src={p.image} hue={hue} icon="camera" className="aspect-[4/3] w-full" />
            <div className="flex items-start gap-2 px-4 py-3">
              {pin && <MapPin size={20} className="mt-0.5 shrink-0" style={{ color: HUES[look.accent] }} />}
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-display text-lg leading-tight text-text-primary">{p.title}</span>
                {p.subtitle && <span className="truncate text-sm text-text-muted">{p.subtitle}</span>}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A tag's hue, from its own words, so "Reels" is the same colour every day it appears. */
function tagHue(tag: string, look: Look): Hue {
  return look.tints[hash(tag.toLowerCase()) % look.tints.length];
}

/** A week of posts with a picture each: the Marketing board's content calendar. */
export function Calendar({ b, look }: { b: Of<'calendar'>; look: Look }) {
  return (
    <section className="rounded-2xl border border-border-subtle bg-bg-elevated/30">
      {(b.title || b.range) && (
        <header className="flex items-center gap-3 border-b border-border-subtle px-5 py-4">
          {b.title && <h3 className="flex-1 font-display text-2xl text-text-primary">{b.title}</h3>}
          {b.range && <span className="rounded-full border border-border-default px-4 py-1.5 text-sm text-text-primary">{b.range}</span>}
        </header>
      )}
      <div className="grid auto-cols-[minmax(6.5rem,1fr)] grid-flow-col divide-x divide-border-subtle overflow-x-auto">
        {b.days.map((d, i) => {
          const hue = look.tints[i % look.tints.length];
          const th = d.tag ? tagHue(d.tag, look) : hue;
          return (
            <div key={`${d.day}${i}`} className="flex flex-col items-center gap-2 px-2.5 py-4 text-center">
              <span className="text-sm font-medium text-text-primary">{d.day}</span>
              {d.date && <span className="-mt-1.5 text-xs text-text-muted">{d.date}</span>}
              <Photo src={d.image} hue={hue} icon="camera" className="aspect-square w-full rounded-xl" />
              <span className="text-sm leading-snug text-text-primary">{d.title}</span>
              {d.tag && <span className="rounded-full px-2.5 py-0.5 text-xs font-medium" style={{ background: tint(th, 16), color: HUES[th] }}>{d.tag}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The footer row of tinted chips, with their icons: every board's last line. */
export function Chips({ items, hues }: { items: { label: string; icon?: string }[]; hues: Hue[] }) {
  return (
    <>
      {items.map((c, i) => {
        const hue = hues[i % hues.length];
        const Icon = boardIcon(c.icon);
        return (
          <span key={c.label} className="flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-base" style={{ background: tint(hue, 13), color: HUES[hue] }}>
            {Icon && <Icon size={16} strokeWidth={1.8} />}
            <span className="text-text-primary/85">{c.label}</span>
          </span>
        );
      })}
    </>
  );
}
