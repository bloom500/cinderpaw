import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { HUES, type Block, type Hue, type Look } from '@/lib/board';
import { cn } from '@/lib/utils';

type Of<K extends Block['kind']> = Extract<Block, { kind: K }>;

/** A bordered card inside the board: the Performance board's panels. */
export function Panel({ title, subtitle, className, children }: { title?: string; subtitle?: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={cn('rounded-2xl border border-border-subtle bg-bg-elevated/40 p-5', className)}>
      {title && <h3 className="font-display text-2xl leading-tight text-text-primary">{title}</h3>}
      {subtitle && <p className="mt-0.5 text-sm text-text-muted">{subtitle}</p>}
      {children}
    </section>
  );
}

/** 12000 -> "12K": axis and bar labels, short enough to sit above a bar. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return `${+n.toFixed(1)}`;
}

/** A round top for an axis: 11.3K -> 12K, so the gridlines land on readable numbers. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s * p >= max) ?? 10;
  return step * p;
}

/** The ramp the bars and the share dots walk down: the accent, then lighter. */
export function ramp(hue: Hue, i: number, n: number): string {
  const strength = Math.round(100 - (i / Math.max(1, n - 1)) * 62);
  return `color-mix(in oklab, ${HUES[hue]} ${strength}%, #F7D9BF)`;
}

export function Kpis({ b }: { b: Of<'kpis'> }) {
  return (
    <div className={cn('grid gap-4', b.items.length >= 3 ? 'grid-cols-2 @2xl:grid-cols-3' : 'grid-cols-2', b.items.length === 4 && '@2xl:grid-cols-4')}>
      {b.items.map((k) => {
        const Trend = k.trend === 'down' ? ArrowDownRight : k.trend === 'flat' ? Minus : ArrowUpRight;
        const tone = k.trend === 'down' ? 'bg-error/10 text-error' : k.trend === 'flat' ? 'bg-bg-active text-text-muted' : 'bg-success/12 text-success';
        return (
          <div key={k.label} className="relative rounded-2xl border border-border-subtle bg-bg-elevated/40 p-5">
            <p className="pr-10 text-sm text-text-secondary">{k.label}</p>
            <p className="mt-2 font-display text-4xl leading-none text-text-primary">{k.value}</p>
            {k.delta && <p className="mt-2 text-sm text-text-muted">{k.delta}</p>}
            {k.trend && (
              <span className={cn('absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full', tone)}>
                <Trend size={16} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Catmull-Rom through the points, as cubic Béziers: the board's soft line. */
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 3) return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const [p1, p2] = [pts[i], pts[i + 1]];
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  return d;
}

export function Line({ b, look, id }: { b: Of<'line'>; look: Look; id: string }) {
  const W = 640, H = 240, L = 44, R = 26, T = 12, B = 30;
  const max = niceMax(Math.max(...b.series.flatMap((s) => s.values), 0));
  const x = (i: number) => L + (i / Math.max(1, b.x.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const every = Math.max(1, Math.ceil(b.x.length / 7));
  const hues = [look.accent, ...look.tints.filter((h) => h !== look.accent)];
  const grad = `area-${id}`;
  return (
    <Panel title={b.title} subtitle={b.subtitle}>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 w-full" role="img" aria-label={b.title ?? 'Line chart'}>
        <defs>
          <linearGradient id={grad} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={HUES[look.accent]} stopOpacity="0.26" />
            <stop offset="100%" stopColor={HUES[look.accent]} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--border-default)" strokeDasharray={t ? '4 5' : undefined} />
            <text x={L - 10} y={y(t) + 4} textAnchor="end" fontSize="12" fill="var(--text-muted)">{compact(t)}</text>
          </g>
        ))}
        {b.x.map((l, i) => (i % every === 0 || i === b.x.length - 1) && (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="12" fill="var(--text-muted)">{l}</text>
        ))}
        {b.series.map((s, si) => {
          const pts = s.values.map((v, i) => [x(i), y(v)] as [number, number]);
          const d = look.curve === 'smooth' ? smoothPath(pts) : pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px},${py}`).join(' ');
          const last = pts[pts.length - 1];
          const color = HUES[hues[si % hues.length]];
          return (
            <g key={si}>
              {si === 0 && <path d={`${d} L${last[0]},${y(0)} L${pts[0][0]},${y(0)} Z`} fill={`url(#${grad})`} />}
              <path d={d} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              {si === 0 && (
                <>
                  <circle cx={last[0]} cy={last[1]} r="11" fill={color} opacity="0.18" />
                  <circle cx={last[0]} cy={last[1]} r="5" fill={color} />
                </>
              )}
            </g>
          );
        })}
      </svg>
      {b.series.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-4">
          {b.series.map((s, si) => (
            <span key={si} className="flex items-center gap-1.5 text-xs text-text-secondary">
              <span className="h-2 w-2 rounded-full" style={{ background: HUES[hues[si % hues.length]] }} />
              {s.name ?? `Series ${si + 1}`}
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function Bars({ b, look }: { b: Of<'bars'>; look: Look }) {
  const max = Math.max(...b.items.map((i) => i.value), 1);
  return (
    <Panel title={b.title} subtitle={b.subtitle}>
      <div className="mt-5 flex h-44 items-end gap-3 border-b border-border-default px-1">
        {b.items.map((it, i) => (
          <div key={it.label} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <span className="text-sm text-text-primary">{compact(it.value)}</span>
            <span
              className="w-full max-w-[4.5rem] rounded-t-lg"
              style={{ height: `${Math.max(4, (it.value / max) * 100) * 0.78}%`, background: ramp(look.accent, i, b.items.length) }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-3 px-1">
        {b.items.map((it) => <span key={it.label} className="flex-1 truncate text-center text-sm text-text-muted">{it.label}</span>)}
      </div>
    </Panel>
  );
}

export function Breakdown({ b, look }: { b: Of<'breakdown'>; look: Look }) {
  const total = b.items.reduce((n, i) => n + i.value, 0) || 1;
  return (
    <Panel title={b.title} subtitle={b.subtitle}>
      <ul className="mt-4 flex flex-col">
        {b.items.map((it, i) => (
          <li key={it.label} className="flex items-center gap-3 border-b border-border-subtle py-2.5 last:border-b-0">
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: ramp(look.accent, i, b.items.length) }} />
            <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{it.label}</span>
            <span className="text-sm text-text-primary">{`${Math.round((it.value / total) * 100)}%`}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

