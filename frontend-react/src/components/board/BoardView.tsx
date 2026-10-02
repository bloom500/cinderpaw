import { useMemo } from 'react';
import { LayoutGrid } from 'lucide-react';
import { HUES, lookOf, tint, type Block, type Board, type Look } from '@/lib/board';
import { cn } from '@/lib/utils';
import { boardIcon } from './icons';
import { Bars, Breakdown, Kpis, Line } from './charts';
import { Flow, layoutFlow, nodeHues } from './Flow';
import { Calendar, Chips, Columns, Photos, Pillars, Timeline } from './sections';

/** Blocks that sit two to a row when they come one after the other (bars beside their breakdown). */
const HALF = new Set<Block['kind']>(['bars', 'breakdown', 'timeline']);
/** A board about a place gets a pin under its pictures. */
const PLACES = new Set(['map-pin', 'plane', 'landmark', 'globe', 'bed']);

/** The faint drawing behind the header, one of four, picked by the board's look. */
function Ornament({ kind, look }: { kind: Look['ornament']; look: Look }) {
  if (kind === 'none') return null;
  const c = HUES[look.accent];
  return (
    <svg viewBox="0 0 240 120" className="pointer-events-none absolute right-0 top-0 h-32 w-64 opacity-[0.06]" aria-hidden>
      {kind === 'hills' && (
        <>
          <path d="M0 90 C60 60 110 100 170 72 S240 60 240 60 V0 H0Z" fill="none" />
          <path d="M40 120 C90 80 140 110 190 84 S240 76 240 76 V120Z" fill={c} />
          <path d="M100 120 C140 96 190 118 240 98 V120Z" fill={c} opacity="0.7" />
        </>
      )}
      {kind === 'dots' && Array.from({ length: 6 * 12 }, (_, i) => (
        <circle key={i} cx={240 - (i % 12) * 18} cy={8 + Math.floor(i / 12) * 18} r={2.2 - Math.floor(i / 12) * 0.25} fill={c} />
      ))}
      {kind === 'rays' && Array.from({ length: 9 }, (_, i) => (
        <path key={i} d={`M240 0 L${240 - Math.cos((i * 10 * Math.PI) / 180) * 240} ${Math.sin((i * 10 * Math.PI) / 180) * 240}`} stroke={c} strokeWidth="6" />
      ))}
    </svg>
  );
}

function Tile({ look, icon }: { look: Look; icon?: string }) {
  const Icon = boardIcon(icon) ?? LayoutGrid;
  const shape = look.tile === 'blob' ? 'rounded-[42%_58%_55%_45%/48%_44%_56%_52%]' : look.tile;
  return (
    <span className={cn('flex h-16 w-16 shrink-0 items-center justify-center', shape)} style={{ background: tint(look.accent, 15), color: HUES[look.accent] }}>
      <Icon size={28} strokeWidth={1.7} />
    </span>
  );
}

/** The pill in the corner: the board's own word when it gave one, else what the store knows. */
function Status({ text, look }: { text: string; look: Look }) {
  const warm = /draft|progress/i.test(text);
  return (
    <span
      className={cn('flex shrink-0 items-center gap-2 rounded-full px-4 py-1.5 text-base font-medium', !warm && 'bg-success/12 text-success')}
      style={warm ? { background: tint(look.accent, 14), color: HUES[look.accent] } : undefined}
    >
      <span className={cn('h-2.5 w-2.5 rounded-full', !warm && 'bg-success')} style={warm ? { background: HUES[look.accent] } : undefined} />
      {text}
    </span>
  );
}

function BlockView({ b, look, id, pin, onSection }: { b: Block; look: Look; id: string; pin: boolean; onSection?: (t: string) => void }) {
  switch (b.kind) {
    case 'text': return <p className="text-lg leading-relaxed text-text-secondary">{b.text}</p>;
    case 'kpis': return <Kpis b={b} />;
    case 'line': return <Line b={b} look={look} id={id} />;
    case 'bars': return <Bars b={b} look={look} />;
    case 'breakdown': return <Breakdown b={b} look={look} />;
    case 'flow': return <Flow b={b} look={look} />;
    case 'columns': return <Columns b={b} look={look} onPick={onSection} />;
    case 'pillars': return <Pillars b={b} look={look} />;
    case 'timeline': return <Timeline b={b} look={look} />;
    case 'photos': return <Photos b={b} look={look} pin={pin} />;
    case 'calendar': return <Calendar b={b} look={look} />;
    default: return null;
  }
}

/** The blocks in rows: one per row, or two when two half-width blocks meet. */
function rowsOf(blocks: Block[]): Block[][] {
  const rows: Block[][] = [];
  for (const b of blocks) {
    const last = rows[rows.length - 1];
    if (last && last.length === 1 && HALF.has(last[0].kind) && HALF.has(b.kind)) last.push(b);
    else rows.push([b]);
  }
  return rows;
}

/**
 * A board, drawn: header (tile, serif title, subtitle, status), the blocks in
 * the order the agent wrote them, and the footer of chips beside `actions`.
 * Everything that is not the agent's data (colours, tile shape, ornament,
 * number style, chart curve, wash) comes from `lookOf(seed)`.
 */
export function BoardView({ board, seed, status, actions, onSection, className }: {
  board: Board;
  seed: string;
  status: string;
  actions?: React.ReactNode;
  onSection?: (title: string) => void;
  className?: string;
}) {
  const look = useMemo(() => lookOf(seed), [seed]);
  const body = board.blocks.filter((b) => b.kind !== 'chips');
  const given = board.blocks.flatMap((b) => (b.kind === 'chips' ? b.items : []));
  // No chips given and a diagram on the board: its main nodes are the legend, in their colours (the Diagram board).
  const flow = body.find((b): b is Extract<Block, { kind: 'flow' }> => b.kind === 'flow');
  const fromFlow = !given.length && flow ? layoutFlow(flow).main.map((id) => flow.nodes.find((n) => n.id === id)!) : [];
  const chips = given.length ? given : fromFlow.map((n) => ({ label: n.title, icon: n.icon }));
  const chipHues = given.length || !flow ? look.tints : fromFlow.map((n) => nodeHues(flow, look)[n.id]);
  const pin = PLACES.has(board.icon ?? '');
  const label = board.status ? board.status[0].toUpperCase() + board.status.slice(1) : status;

  return (
    <div
      className={cn('@container relative overflow-hidden rounded-[28px] border border-border-default bg-bg-surface shadow-[0_18px_40px_-22px_rgba(120,60,20,0.35)]', className)}
      style={{ backgroundImage: `linear-gradient(${look.wash}deg, ${tint(look.accent, 6)}, transparent 55%)` }}
    >
      <Ornament kind={look.ornament} look={look} />
      <header className="relative flex items-start gap-5 p-6 pb-5 @2xl:p-8 @2xl:pb-6">
        <Tile look={look} icon={board.icon} />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[2rem] leading-[1.05] text-text-primary @2xl:text-[2.85rem]">{board.title}</h2>
          {board.subtitle && <p className="mt-1.5 text-lg text-text-muted">{board.subtitle}</p>}
        </div>
        <Status text={label} look={look} />
      </header>

      <div className="relative flex flex-col gap-5 px-6 pb-6 @2xl:px-8 @2xl:pb-7">
        {rowsOf(body).map((row, i) => (
          <div
            key={i}
            className={cn(
              row.length === 2 && 'grid items-start gap-5 @2xl:grid-cols-2',
              row.length === 2 && row[0].kind === 'bars' && row[1].kind === 'breakdown' && '@2xl:grid-cols-[1.4fr_1fr]',
            )}
          >
            {row.map((b, j) => <BlockView key={j} b={b} look={look} id={`${hashId(seed)}-${i}-${j}`} pin={pin} onSection={onSection} />)}
          </div>
        ))}
      </div>

      {(chips.length > 0 || actions) && (
        <footer className="relative flex items-center gap-3 border-t border-border-subtle px-6 py-4 @2xl:px-8">
          <div className="flex min-w-0 flex-1 flex-wrap gap-3">
            <Chips items={chips} hues={chipHues} />
          </div>
          {actions}
        </footer>
      )}
    </div>
  );
}

/** A short id safe for SVG gradient ids. */
function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `b${(h >>> 0).toString(36)}`;
}
