/**
 * Boards (spec docs/superpowers/specs/2026-10-01-board-artifacts-design.md):
 * the agent writes blocks, the sidecar validates them (CinderpawAgent/src/
 * artifacts/board.ts), the app draws them.
 *
 * This file reads a board again, defensively, because a saved artifact, an older
 * sidecar or a hand edit can hand the app anything, and it derives the board's
 * LOOK from a seed: the same board always looks the same, two boards never look
 * identical (Darius, 1 Oct: "sa nu existe 2 carduri la fel").
 */

export type Trend = 'up' | 'down' | 'flat';

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'kpis'; items: { label: string; value: string; delta?: string; trend?: Trend }[] }
  | { kind: 'line'; title?: string; subtitle?: string; x: string[]; series: { name?: string; values: number[] }[] }
  | { kind: 'bars'; title?: string; subtitle?: string; items: { label: string; value: number }[] }
  | { kind: 'breakdown'; title?: string; subtitle?: string; items: { label: string; value: number }[] }
  | { kind: 'flow'; nodes: { id: string; title: string; lines?: string[]; icon?: string }[]; edges: { from: string; to: string; dashed?: boolean }[] }
  | { kind: 'columns'; title?: string; items: { title: string; text?: string; points?: string[]; icon?: string; image?: string }[] }
  | { kind: 'pillars'; title?: string; items: { title: string; text?: string; icon?: string; checks: string[] }[] }
  | { kind: 'timeline'; title?: string; items: { label: string; title: string; text?: string }[] }
  | { kind: 'photos'; items: { image: string; title: string; subtitle?: string }[] }
  | { kind: 'calendar'; title?: string; range?: string; days: { day: string; date?: string; title: string; image?: string; tag?: string }[] }
  | { kind: 'chips'; items: { label: string; icon?: string }[] };

export interface Board {
  title: string;
  subtitle?: string;
  icon?: string;
  status?: 'draft' | 'in progress' | 'ready';
  blocks: Block[];
}

const KINDS = new Set(['text', 'kpis', 'line', 'bars', 'breakdown', 'flow', 'columns', 'pillars', 'timeline', 'photos', 'calendar', 'chips']);
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);

/**
 * The lists every block draws from, checked once: a block whose list is not a
 * list (a hand edit, an old file) is dropped instead of crashing the card.
 */
function sound(b: Rec): boolean {
  switch (b.kind) {
    case 'text': return typeof b.text === 'string';
    case 'line': return Array.isArray(b.x) && arr(b.series).every((s) => Array.isArray(s.values) && s.values.every((v) => typeof v === 'number'));
    case 'flow': return arr(b.nodes).length >= 2 && Array.isArray(b.edges);
    case 'calendar': return arr(b.days).length > 0;
    case 'bars': case 'breakdown': return arr(b.items).length > 0 && arr(b.items).every((i) => typeof i.value === 'number');
    default: return arr(b.items).length > 0;
  }
}

/** A board from an artifact's text, or null when it is not one. */
export function parseBoard(text: string): Board | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isRec(raw) || !Array.isArray(raw.blocks)) return null;
  const blocks = raw.blocks.filter((b): b is Rec => isRec(b) && KINDS.has(b.kind as string) && sound(b)) as unknown as Block[];
  if (blocks.length === 0) return null;
  return {
    title: typeof raw.title === 'string' ? raw.title : 'Board',
    subtitle: typeof raw.subtitle === 'string' ? raw.subtitle : undefined,
    icon: typeof raw.icon === 'string' ? raw.icon : undefined,
    status: ['draft', 'in progress', 'ready'].includes(raw.status as string) ? (raw.status as Board['status']) : undefined,
    blocks,
  };
}

// --- the procedural look ----------------------------------------------------------------

/**
 * The warm family the boards are drawn in, plus the three cooler friends the
 * Marketing board uses for its channel chips. Each is mixed into the surface by
 * CSS (`color-mix`), so the same hue reads right in the light and dark themes.
 */
export const HUES = {
  ember: '#C2562B', apricot: '#E08A3C', rose: '#C8504B', sand: '#9C7A5B',
  sage: '#6A9E5A', gold: '#C79A2E', lilac: '#8A6FB0', sky: '#4F86C6',
} as const;
export type Hue = keyof typeof HUES;
const WARM: Hue[] = ['ember', 'apricot', 'rose', 'sand', 'gold'];
const ALL: Hue[] = ['ember', 'apricot', 'rose', 'sand', 'sage', 'gold', 'lilac', 'sky'];

export interface Look {
  /** The tint every list of things (nodes, chips, columns) walks through, in order. */
  tints: Hue[];
  /** The board's own colour: its icon tile, numbers, chart line. */
  accent: Hue;
  tile: 'rounded-2xl' | 'rounded-full' | 'blob';
  ornament: 'none' | 'hills' | 'dots' | 'rays';
  numbers: 'circle' | 'serif' | 'pill';
  curve: 'smooth' | 'straight';
  /** Angle of the card's warm wash, in degrees. */
  wash: number;
}

/** FNV-1a: small, stable across runs and machines, good enough to spread a few choices. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The look of one board, from its id and title. Same input, same look; different input, different look. */
export function lookOf(seed: string): Look {
  let h = hash(seed);
  const pick = <T,>(xs: readonly T[]): T => {
    const v = xs[h % xs.length];
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    return v;
  };
  // Sand is a fine tint and a muddy accent: a chart line in it reads as dirt, not ember.
  const accent = pick(['ember', 'ember', 'apricot', 'rose', 'gold'] as const);
  // Warm first, as on every board: the accent, the other warm hues in a seeded
  // order, and only then the cooler friends (sage, lilac, sky) for long lists.
  const warm = WARM.filter((w) => w !== accent);
  for (let i = warm.length - 1; i > 0; i--) {
    const j = pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) % (i + 1);
    [warm[i], warm[j]] = [warm[j], warm[i]];
  }
  const tints: Hue[] = [accent, ...warm, ...ALL.filter((h) => !WARM.includes(h))];
  return {
    accent,
    tints,
    tile: pick(['rounded-2xl', 'rounded-2xl', 'rounded-full', 'blob'] as const),
    ornament: pick(['none', 'hills', 'dots', 'rays'] as const),
    numbers: pick(['circle', 'circle', 'serif', 'pill'] as const),
    curve: pick(['smooth', 'smooth', 'smooth', 'straight'] as const),
    wash: 100 + (pick([0, 1, 2, 3, 4, 5, 6, 7]) * 20),
  };
}

/**
 * A hue as a see-through wash: the tinted fill of a node, chip or tile. Mixed
 * with transparent, not with a surface token, because the surfaces are glass
 * (translucent) and the wash must read the same over light and dark.
 */
export const tint = (hue: Hue, amount = 12): string =>
  `color-mix(in oklab, ${HUES[hue]} ${amount}%, transparent)`;
