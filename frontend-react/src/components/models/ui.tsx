import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ModelLogo } from '@/lib/modelLogos';
import { extractQuant } from '@/lib/modelUtils';
import type { HfModelSummary } from '@/lib/tauri';

/**
 * The small pieces the Models tabs share: the section header, pills and
 * chips, maker marks, buttons, and the few name helpers that turn a GGUF
 * filename into what a person calls a model.
 */

export const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-xl bg-brand text-primary-foreground text-sm font-medium ' +
  'shadow-sm hover:bg-brand-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
export const BTN_OUTLINE =
  'inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-xl border border-border-default bg-bg-surface text-sm ' +
  'font-medium text-text-primary shadow-sm hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
export const BTN_ICON =
  'inline-flex items-center justify-center size-9 rounded-xl border border-border-subtle bg-bg-surface text-text-secondary ' +
  'hover:bg-bg-hover hover:text-text-primary transition-colors disabled:opacity-50';

export const CARD = 'rounded-2xl border border-border-subtle bg-bg-surface shadow-sm';

export function SectionHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h2 className="font-display text-2xl text-text-primary">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-text-secondary">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'success' | 'brand' | 'warning' | 'error';
const TONE: Record<Tone, { pill: string; dot: string }> = {
  neutral: { pill: 'bg-bg-elevated text-text-secondary border-border-subtle', dot: 'bg-text-muted' },
  success: { pill: 'bg-success/10 text-success border-success/20', dot: 'bg-success' },
  brand:   { pill: 'bg-brand/10 text-brand border-brand/20', dot: 'bg-brand' },
  warning: { pill: 'bg-warning/10 text-warning border-warning/20', dot: 'bg-warning' },
  error:   { pill: 'bg-error/10 text-error border-error/20', dot: 'bg-error' },
};

export function Pill({ tone = 'neutral', dot = false, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-2xs font-medium whitespace-nowrap', TONE[tone].pill, className)}>
      {dot && <span aria-hidden className={cn('size-1.5 rounded-full', TONE[tone].dot)} />}
      {children}
    </span>
  );
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-text-muted', success: 'text-success', brand: 'text-brand', warning: 'text-warning', error: 'text-error',
};

/** A status line: coloured dot, then the word. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', TONE_TEXT[tone])}>
      <span aria-hidden className={cn('size-2 rounded-full', TONE[tone].dot)} />
      {children}
    </span>
  );
}

export function Chip({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-center rounded-md border px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap',
      accent ? 'border-brand/25 bg-brand/10 text-brand' : 'border-border-subtle bg-bg-elevated text-text-secondary',
    )}>
      {children}
    </span>
  );
}

/** A thin rounded meter; `value` is 0..1. */
export function Meter({ value, tone = 'brand', label }: { value: number; tone?: Tone; label?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-elevated" role="meter" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full rounded-full transition-[width] duration-500', TONE[tone].dot)} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── Makers ───────────────────────────────────────────────────────────────────

export interface Maker {
  /** A key the logo set knows (see MAKER_TO_LOGO), or '' when it has no mark. */
  key: string;
  label: string;
  /** The mark's own colour; absent means "the text colour", for black marks. */
  color?: string;
}

const MAKERS: [RegExp, Maker][] = [
  [/llama|meta/i, { key: 'meta', label: 'Meta', color: '#0866FF' }],
  [/qwen|qwq/i, { key: 'qwen', label: 'Alibaba', color: '#615CED' }],
  [/\bphi[-_ ]?\d|\bphi\b/i, { key: 'microsoft', label: 'Microsoft', color: '#00A4EF' }],
  [/mistral|mixtral|ministral|codestral|devstral|magistral/i, { key: 'mistral', label: 'Mistral AI', color: '#FA520F' }],
  [/gemma/i, { key: 'gemma', label: 'Google', color: '#3186FF' }],
  [/deepseek/i, { key: 'deepseek', label: 'DeepSeek', color: '#4D6BFE' }],
  [/granite/i, { key: 'ibm', label: 'IBM', color: '#0F62FE' }],
  [/smollm/i, { key: 'huggingface', label: 'Hugging Face', color: '#FF9D00' }],
  [/\bglm|chatglm/i, { key: 'zhipu', label: 'Zhipu AI', color: '#3859FF' }],
  [/kimi|moonshot/i, { key: 'moonshotai', label: 'Moonshot AI' }],
  [/minimax/i, { key: 'minimax', label: 'MiniMax', color: '#F23F5D' }],
  [/nemotron|nvidia/i, { key: 'nvidia', label: 'NVIDIA', color: '#76B900' }],
  [/gpt-oss|whisper|openai/i, { key: 'openai', label: 'OpenAI' }],
  [/hermes|nous/i, { key: 'nousresearch', label: 'Nous Research' }],
  [/olmo|allenai/i, { key: 'allenai', label: 'Ai2', color: '#F0529C' }],
  [/\blfm|liquid/i, { key: 'liquid', label: 'Liquid AI' }],
  [/command-r|\baya\b|cohere/i, { key: 'cohere', label: 'Cohere', color: '#39594D' }],
  [/\bbge\b|baai/i, { key: '', label: 'BAAI' }],
  [/nomic/i, { key: '', label: 'Nomic' }],
];

/** Who made a model, guessed from its name (or a repo's author). */
export function makerFor(name: string): Maker | null {
  for (const [re, maker] of MAKERS) if (re.test(name)) return maker;
  return null;
}

/** The maker's mark on a soft tile; the initial when the set has no mark. */
export function MakerTile({ maker, fallback, className }: { maker: Maker | null; fallback?: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border-subtle bg-bg-elevated text-text-primary', className)}
      style={maker?.color ? { color: maker.color } : undefined}
    >
      {maker?.key
        ? <ModelLogo provider={maker.key} className="size-6" />
        : <span className="font-display text-lg">{(maker?.label ?? fallback ?? '?').charAt(0).toUpperCase()}</span>}
    </span>
  );
}

// ── Names ────────────────────────────────────────────────────────────────────

/** "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf" reads as "Meta Llama 3.1 8B Instruct". */
export function prettyModelName(filename: string): string {
  let n = filename.replace(/\.gguf$/i, '');
  const quant = extractQuant(filename);
  if (quant !== '-') n = n.replace(new RegExp(`[-._]?${quant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '');
  return n
    .split(/[-_ ]+/)
    .filter(Boolean)
    // Short all-lowercase words are initialisms ("bge", "it"); longer ones are words.
    .map((w) => (/^[a-z]{1,3}$/.test(w) ? w.toUpperCase() : /^[a-z]+$/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** The parameter count in a model's name ("8B", "0.5B", "8x7B", "335M"), if it says. */
export function paramsOf(name: string): string | null {
  const m = name.match(/(?:^|[^a-z0-9.])((?:\d+x)?\d+(?:\.\d+)?)([bm])(?=[^a-z]|$)/i);
  return m ? `${m[1]}${m[2].toUpperCase()}` : null;
}

/** The parameter count in billions, for sorting and the "small" filter. */
export function billionsOf(name: string): number | null {
  const p = paramsOf(name);
  if (!p) return null;
  const m = p.match(/(?:(\d+)x)?(\d+(?:\.\d+)?)([BM])/);
  if (!m) return null;
  const n = Number(m[2]) * (m[1] ? Number(m[1]) : 1);
  return m[3] === 'M' ? n / 1000 : n;
}

// ── Hub filters ──────────────────────────────────────────────────────────────

export type Filter = 'all' | 'text' | 'embed' | 'vision' | 'audio' | 'small';

/** What a repo is for, read off its Hub tags (and its name, for size). */
export function kindsOf(m: HfModelSummary): Set<Filter> {
  const t = new Set(m.tags.map((s) => s.toLowerCase()));
  const kinds = new Set<Filter>();
  if (t.has('text-generation') || t.has('conversational')) kinds.add('text');
  if (t.has('feature-extraction') || t.has('sentence-similarity') || /embed|bge|e5-|gte-/i.test(m.id)) kinds.add('embed');
  if (t.has('image-text-to-text') || t.has('image-to-text') || t.has('vision') || t.has('multimodal')) kinds.add('vision');
  if (t.has('automatic-speech-recognition') || t.has('text-to-speech') || t.has('audio') || /whisper/i.test(m.id)) kinds.add('audio');
  const b = billionsOf(m.id.split('/').pop() ?? m.id);
  if ((b !== null && b <= 4) || /mini|small|tiny/i.test(m.id)) kinds.add('small');
  return kinds;
}
