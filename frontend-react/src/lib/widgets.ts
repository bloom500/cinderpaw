/**
 * The chat's widgets (spec 7.1), as data.
 *
 * `show_widget` in the sidecar validates and normalises; this reads its
 * result's `data` again, because a saved chat, an older sidecar or a third
 * party can hand the app anything. What does not fit its kind becomes a plain
 * list of the same strings, never a blank.
 */

export type WidgetIcon =
  | 'calendar' | 'clock' | 'map-pin' | 'wallet' | 'users' | 'star'
  | 'check' | 'info' | 'file' | 'link' | 'tag' | 'home';

export type WidgetData =
  | { kind: 'facts'; title?: string; items: { label: string; value: string; icon?: WidgetIcon }[] }
  | { kind: 'checklist'; title?: string; items: { text: string; done: boolean; note?: string }[] }
  | { kind: 'cards'; title?: string; items: { title: string; subtitle?: string; image?: string; imageFile?: string; url?: string }[] }
  | { kind: 'breakdown'; title?: string; total?: number; items: { label: string; value: number }[] }
  | { kind: 'progress'; title?: string; done: number; total: number; label: string }
  | { kind: 'table'; title?: string; columns: { title: string; subtitle?: string; image?: string; imageFile?: string }[]; rows: { label: string; cells: string[] }[] }
  | { kind: 'verdict'; title?: string; text: string }
  /** Not drawn in place: chips at the end of the latest reply (spec 7.5). */
  | { kind: 'followups'; next: string[] }
  | { kind: 'list'; title?: string; lines: string[] };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const https = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  try { return new URL(s).protocol === 'https:' ? s : undefined; } catch { return undefined; }
};
/**
 * A picture the sidecar kept (`image-cache.ts`): a file named by its hash in the
 * profile's image cache, and nothing else. The asset protocol's scope says the
 * same; this keeps a saved chat from naming any other file.
 */
const cached = (v: unknown): string | undefined =>
  typeof v === 'string' && /[\\/]\.cinderpaw[\\/]cache[\\/]images[\\/][0-9a-f]{40}\.(png|jpg|gif|webp|avif)$/.test(v) ? v : undefined;
const ICONS = new Set<string>(['calendar', 'clock', 'map-pin', 'wallet', 'users', 'star', 'check', 'info', 'file', 'link', 'tag', 'home']);

/** Every string in `v`, one line per top-level item: the fallback's content. */
function linesOf(d: Rec): string[] {
  const flat = (v: unknown): string[] => {
    if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
    if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
    if (Array.isArray(v)) return v.flatMap(flat);
    if (isRec(v)) return Object.values(v).flatMap(flat);
    return [];
  };
  const out: string[] = [];
  for (const key of ['label', 'text']) out.push(...flat(d[key]));
  for (const key of ['lines', 'items', 'columns', 'rows', 'next']) {
    const v = d[key];
    if (Array.isArray(v)) for (const item of v) { const l = flat(item).join(' · '); if (l) out.push(l); }
  }
  return out.slice(0, 40);
}

function strict(d: Rec): WidgetData | null {
  const title = str(d.title);
  const items = Array.isArray(d.items) && d.items.every(isRec) ? (d.items as Rec[]) : null;
  switch (d.kind) {
    case 'facts': {
      if (!items || items.length < 1) return null;
      const rows = items.map((it) => ({ label: str(it.label), value: str(it.value) ?? (num(it.value) !== undefined ? String(it.value) : undefined), icon: ICONS.has(it.icon as string) ? (it.icon as WidgetIcon) : undefined }));
      return rows.every((r) => r.label && r.value) ? { kind: 'facts', title, items: rows as { label: string; value: string; icon?: WidgetIcon }[] } : null;
    }
    case 'checklist': {
      if (!items || items.length < 1) return null;
      const rows = items.map((it) => ({ text: str(it.text), done: it.done, note: str(it.note) }));
      return rows.every((r) => r.text && typeof r.done === 'boolean') ? { kind: 'checklist', title, items: rows as { text: string; done: boolean; note?: string }[] } : null;
    }
    case 'cards': {
      if (!items || items.length < 1) return null;
      const rows = items.map((it) => ({ title: str(it.title), subtitle: str(it.subtitle), image: https(it.image), imageFile: cached(it.imageFile), url: https(it.url) }));
      return rows.every((r) => r.title) ? { kind: 'cards', title, items: rows as { title: string }[] } : null;
    }
    case 'breakdown': {
      if (!items || items.length < 1) return null;
      const rows = items.map((it) => ({ label: str(it.label), value: num(it.value) }));
      if (!rows.every((r) => r.label && r.value !== undefined && r.value >= 0)) return null;
      const total = num(d.total);
      return { kind: 'breakdown', title, items: rows as { label: string; value: number }[], ...(total && total > 0 ? { total } : {}) };
    }
    case 'progress': {
      const done = num(d.done); const total = num(d.total); const label = str(d.label);
      return done !== undefined && total !== undefined && label && total > 0 && done >= 0 && done <= total
        ? { kind: 'progress', title, done, total, label } : null;
    }
    case 'table': {
      const cols = Array.isArray(d.columns) && d.columns.every(isRec) ? (d.columns as Rec[]) : null;
      const rows = Array.isArray(d.rows) && d.rows.every(isRec) ? (d.rows as Rec[]) : null;
      if (!cols || cols.length < 2 || cols.length > 4 || !rows || rows.length < 1) return null;
      const c = cols.map((x) => ({ title: str(x.title), subtitle: str(x.subtitle), image: https(x.image), imageFile: cached(x.imageFile) }));
      const r = rows.map((x) => ({ label: str(x.label), cells: Array.isArray(x.cells) ? x.cells.map((v) => (typeof v === 'number' ? String(v) : v)) : null }));
      const ok = c.every((x) => x.title) && r.every((x) => x.label && x.cells && x.cells.length === cols.length && x.cells.every((v) => typeof v === 'string'));
      return ok ? { kind: 'table', title, columns: c as { title: string }[], rows: r as { label: string; cells: string[] }[] } : null;
    }
    case 'verdict': {
      const text = str(d.text);
      return text ? { kind: 'verdict', title, text } : null;
    }
    case 'followups': {
      const next = Array.isArray(d.next) ? d.next.filter((l): l is string => typeof l === 'string' && l.trim() !== '').map((l) => l.trim()) : [];
      return next.length > 0 ? { kind: 'followups', next: next.slice(0, 4) } : null;
    }
    case 'list': {
      const lines = Array.isArray(d.lines) ? d.lines.filter((l): l is string => typeof l === 'string' && l.trim() !== '') : [];
      return lines.length > 0 ? { kind: 'list', title, lines } : null;
    }
    default:
      return null;
  }
}

/** A widget from untrusted data: its kind when it fits, a list when not, null when there is nothing to show. */
export function parseWidget(data: unknown): WidgetData | null {
  if (!isRec(data)) return null;
  const w = strict(data);
  if (w) return w;
  const lines = linesOf(data);
  return lines.length > 0 ? { kind: 'list', title: str(data.title), lines } : null;
}

/**
 * The widget a finished tool shows in place of its step, or null.
 * `show_widget` draws what it sent; `todo_write` draws the agent's plan, the
 * whole list, as a checklist (a status of "done" is ticked).
 */
export function widgetOf(tool: string, result: unknown): WidgetData | null {
  const data = (result as { data?: unknown } | null)?.data;
  if (tool === 'show_widget') return parseWidget(data);
  if (tool === 'todo_write' && isRec(data) && Array.isArray(data.items)) {
    // The store lists newest change first; a plan reads in the order it was written.
    const byCreation = (data.items as unknown[]).filter(isRec)
      .sort((a, b) => (num(a.createdAt) ?? 0) - (num(b.createdAt) ?? 0));
    const items = byCreation.flatMap((it) => {
      const text = str(it.content);
      return text ? [{ text, done: it.status === 'done' }] : [];
    });
    return items.length > 0 ? { kind: 'checklist', title: 'Plan', items } : null;
  }
  return null;
}
