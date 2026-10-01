import { useLayoutEffect, useRef, useState } from 'react';
import { HUES, tint, type Block, type Look } from '@/lib/board';
import { boardIcon } from './icons';

type FlowBlock = Extract<Block, { kind: 'flow' }>;

/**
 * The main row and what hangs below it (the Diagram board): nodes joined by
 * solid edges form the row, left to right in the order the edges walk; nodes
 * reached only by dashed edges sit below, centred, like "External Tools".
 */
export function layoutFlow(b: FlowBlock): { main: string[]; side: string[] } {
  const solid = b.edges.filter((e) => !e.dashed);
  const inSolid = new Set(solid.flatMap((e) => [e.from, e.to]));
  const ids = b.nodes.map((n) => n.id);
  const side = ids.filter((id) => !inSolid.has(id) && b.edges.some((e) => e.dashed && (e.from === id || e.to === id)));
  const main: string[] = [];
  const next = (id: string) => solid.find((e) => e.from === id && !main.includes(e.to))?.to;
  for (const start of ids.filter((id) => !side.includes(id) && !solid.some((e) => e.to === id))) {
    for (let id: string | undefined = start; id && !main.includes(id); id = next(id)) main.push(id);
  }
  for (const id of ids) if (!side.includes(id) && !main.includes(id)) main.push(id);
  return { main, side };
}

/** The hue of each node: the board's tints in node order, so the chips can match them. */
export function nodeHues(b: FlowBlock, look: Look): Record<string, Look['tints'][number]> {
  return Object.fromEntries(b.nodes.map((n, i) => [n.id, look.tints[i % look.tints.length]]));
}

type Box = { x: number; y: number; w: number; h: number };

export function Flow({ b, look }: { b: FlowBlock; look: Look }) {
  const { main, side } = layoutFlow(b);
  const hue = nodeHues(b, look);
  const node = (id: string) => b.nodes.find((n) => n.id === id)!;
  const wrap = useRef<HTMLDivElement>(null);
  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  const [boxes, setBoxes] = useState<Record<string, Box>>({});

  // The dashed links are drawn between the boxes where they actually landed,
  // so they follow the layout at any width.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // Layout offsets, not screen rectangles: they stay right under any zoom.
    const measure = () => {
      const next: Record<string, Box> = {};
      for (const [id, n] of Object.entries(refs.current)) {
        if (!n) continue;
        let x = 0, y = 0;
        for (let e: HTMLElement | null = n; e && e !== el; e = e.offsetParent as HTMLElement | null) { x += e.offsetLeft; y += e.offsetTop; }
        next[id] = { x, y, w: n.offsetWidth, h: n.offsetHeight };
      }
      setBoxes(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [b]);

  const dashed = b.edges.filter((e) => e.dashed && (side.includes(e.from) || side.includes(e.to)));
  const linked = (a: string, c: string) => b.edges.some((e) => !e.dashed && ((e.from === a && e.to === c) || (e.from === c && e.to === a)));

  return (
    <div ref={wrap} className="relative rounded-2xl border border-border-default p-5 @2xl:p-7">
      <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
        {main.map((id, i) => {
          const n = node(id);
          const Icon = boardIcon(n.icon);
          return (
            <div key={id} className="flex min-w-[8.5rem] flex-1 items-center gap-1">
              {i > 0 && (
                <svg width="34" height="14" viewBox="0 0 34 14" className="shrink-0" aria-hidden>
                  {linked(main[i - 1], id) && (
                    <path d="M2 7 H30 M24 2 L30 7 L24 12" fill="none" stroke="var(--text-muted)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  )}
                </svg>
              )}
              <div
                ref={(el) => { refs.current[id] = el; }}
                className="flex h-full min-w-0 flex-1 flex-col gap-1.5 rounded-2xl border p-4"
                style={{ background: tint(hue[id], 9), borderColor: tint(hue[id], 26) }}
              >
                {Icon && (
                  <span className="mb-2 flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: tint(hue[id], 16), color: HUES[hue[id]] }}>
                    <Icon size={22} strokeWidth={1.8} />
                  </span>
                )}
                <span className="text-xl font-medium leading-tight text-text-primary">{n.title}</span>
                {(n.lines ?? []).map((l) => <span key={l} className="text-base leading-snug text-text-muted">{l}</span>)}
              </div>
            </div>
          );
        })}
      </div>

      {side.length > 0 && (
        <div className="mt-16 flex flex-wrap justify-center gap-4">
          {side.map((id) => {
            const n = node(id);
            const Icon = boardIcon(n.icon);
            return (
              <div
                key={id}
                ref={(el) => { refs.current[id] = el; }}
                className="flex items-center gap-4 rounded-2xl border border-border-default bg-bg-elevated/60 px-6 py-4"
              >
                {Icon && <Icon size={30} strokeWidth={1.5} className="shrink-0 text-text-secondary" />}
                <span className="flex flex-col">
                  <span className="text-xl font-medium leading-tight text-text-primary">{n.title}</span>
                  {n.lines && n.lines.length > 0 && <span className="text-base text-text-muted">{n.lines.join(' • ')}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {dashed.length > 0 && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          <defs>
            <marker id="flow-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M1 1 L8 5 L1 9" fill="none" stroke="var(--text-muted)" strokeWidth="1.6" />
            </marker>
          </defs>
          {dashed.map((e, i) => {
            const a = boxes[e.from], c = boxes[e.to];
            if (!a || !c) return null;
            // From the bottom of the upper box to the top of the lower one, an elbow.
            const down = a.y < c.y;
            const top = down ? a : c, low = down ? c : a;
            const x1 = top.x + top.w / 2 + (down ? -top.w * 0.1 : top.w * 0.1);
            const x2 = low.x + low.w / 2 + (x1 < low.x + low.w / 2 ? -low.w * 0.2 : low.w * 0.2);
            const y1 = top.y + top.h + 4, y2 = low.y - 4, mid = (y1 + y2) / 2;
            const d = down
              ? `M${x1},${y1} V${mid} H${x2} V${y2}`
              : `M${x2},${y2} V${mid} H${x1} V${y1}`;
            return <path key={i} d={d} fill="none" stroke="var(--text-muted)" strokeWidth="1.6" strokeDasharray="5 5" markerEnd="url(#flow-head)" />;
          })}
        </svg>
      )}
    </div>
  );
}
