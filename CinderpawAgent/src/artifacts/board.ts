/**
 * `board` artifacts — the agent sends blocks, the app draws the board.
 *
 * Spec: docs/superpowers/specs/2026-10-01-board-artifacts-design.md. The five
 * reference boards (a system diagram, a GTM plan, performance charts, a trip, a
 * marketing plan) are a set of components a Markdown page cannot express and a
 * model's own HTML will not land on every time. So, as with `show_widget`, the
 * agent writes data and the app draws it: it always matches the theme, it costs
 * few tokens, and it cannot run code.
 *
 * Validation drops what does not fit and NAMES it, so the agent can fix the
 * board with `artifact_edit` instead of the person finding a hole in it. A
 * board with no valid block at all is refused.
 */

export const BOARD_ICONS = [
  "users", "user", "flame", "bar-chart", "line-chart", "pie-chart", "brain", "cog", "file", "database",
  "plane", "bed", "wallet", "map-pin", "calendar", "mail", "search", "megaphone", "heart", "eye",
  "target", "rocket", "tag", "star", "check", "clock", "globe", "camera", "cart", "message",
  "lightbulb", "shield", "leaf", "landmark", "sparkles", "trending-up", "package", "code", "workflow", "book",
] as const;

export const BLOCK_KINDS = [
  "text", "kpis", "line", "bars", "breakdown", "flow", "columns", "pillars", "timeline", "photos", "calendar", "chips",
] as const;

export type Block = Record<string, unknown> & { kind: (typeof BLOCK_KINDS)[number] };

export interface Board {
  title: string;
  subtitle?: string;
  icon?: string;
  status?: "draft" | "in progress" | "ready";
  blocks: Block[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 400): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string" || !v.trim()) return undefined;
  return v.trim().slice(0, max);
};
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // "42K", "2.6%", "$2,400" are what a model writes for a value; keep the number in them.
  if (typeof v === "string") {
    const m = /(-?\d[\d,]*(?:\.\d+)?)\s*([kKmMbB])?/.exec(v);
    if (m) {
      const scale = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
      const n = Number(m[1]!.replace(/,/g, "")) * scale;
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
};
const https = (v: unknown): string | undefined => {
  const s = str(v, 2000);
  if (!s) return undefined;
  try { return new URL(s).protocol === "https:" ? s : undefined; } catch { return undefined; }
};
const icon = (v: unknown): string | undefined =>
  (BOARD_ICONS as readonly string[]).includes(v as string) ? (v as string) : undefined;
const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, 200)).filter((x): x is string => !!x).slice(0, max) : [];
/** The rows of a list, each one shaped by `row`; null when too few survive. */
function rows<T>(v: unknown, min: number, max: number, row: (r: Rec) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter(isRec).map(row).filter((r): r is T => r !== null).slice(0, max);
  return out.length >= min ? out : null;
}
/** Drop the keys whose value is undefined, so the stored JSON stays small and plain. */
const clean = <T extends Rec>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * The block with its kind under `kind`, whichever way the model wrote it.
 * Seen live (1 Oct, DeepSeek v4.1 Flash), reading the brief's `text{text}`
 * notation: `{type:"text", ...}`, then `{text:"..."}` and `{timeline:{...}}`.
 */
function asKinded(b: unknown): Rec | null {
  if (!isRec(b)) return null;
  if (typeof b.kind === "string") return b;
  if (typeof b.type === "string") return { ...b, kind: b.type };
  const keys = Object.keys(b);
  const k = keys.length === 1 ? keys[0]! : "";
  if (!(BLOCK_KINDS as readonly string[]).includes(k)) return b;
  const v = b[k];
  if (isRec(v)) return { ...v, kind: k };
  return k === "text" ? { kind: "text", text: v } : b;
}

/** One block, normalised, or null when it does not fit its kind. */
export function validateBlock(raw: unknown): Block | null {
  const b = asKinded(raw);
  if (!b) return null;
  const title = str(b.title, 120);
  const subtitle = str(b.subtitle, 160);
  switch (b.kind) {
    case "text": {
      const text = str(b.text, 1200);
      return text ? { kind: "text", text } : null;
    }
    case "kpis": {
      const items = rows(b.items, 1, 4, (r) => {
        const label = str(r.label, 60); const value = str(r.value, 30);
        const trend = ["up", "down", "flat"].includes(r.trend as string) ? r.trend : undefined;
        return label && value ? clean({ label, value, delta: str(r.delta, 60), trend }) : null;
      });
      return items ? { kind: "kpis", items } : null;
    }
    case "line": {
      const x = strings(b.x, 60);
      const series = rows(b.series, 1, 3, (r) => {
        const values = Array.isArray(r.values) ? r.values.map(num) : [];
        return values.length === x.length && values.every((v) => v !== undefined) ? clean({ name: str(r.name, 40), values }) : null;
      });
      return x.length >= 2 && series ? clean({ kind: "line" as const, title, subtitle, x, series }) : null;
    }
    case "bars":
    case "breakdown": {
      const items = rows(b.items, 2, 8, (r) => {
        const label = str(r.label, 40); const value = num(r.value);
        return label && value !== undefined && value >= 0 ? { label, value } : null;
      });
      return items ? clean({ kind: b.kind, title, subtitle, items }) : null;
    }
    case "flow": {
      const nodes = rows(b.nodes, 2, 8, (r) => {
        const id = str(r.id, 40); const t = str(r.title, 40);
        return id && t ? clean({ id, title: t, lines: strings(r.lines, 4), icon: icon(r.icon) }) : null;
      });
      if (!nodes) return null;
      const ids = new Set(nodes.map((n) => n.id));
      const edges = rows(b.edges, 1, 16, (r) => {
        const from = str(r.from, 40); const to = str(r.to, 40);
        return from && to && ids.has(from) && ids.has(to) && from !== to ? clean({ from, to, dashed: r.dashed === true ? true : undefined }) : null;
      });
      return edges ? { kind: "flow", nodes, edges } : null;
    }
    case "columns": {
      const items = rows(b.items, 2, 4, (r) => {
        const t = str(r.title, 60);
        return t ? clean({ title: t, text: str(r.text, 300), points: strings(r.points, 4), icon: icon(r.icon), image: https(r.image) }) : null;
      });
      return items ? clean({ kind: "columns" as const, title, items }) : null;
    }
    case "pillars": {
      const items = rows(b.items, 2, 3, (r) => {
        const t = str(r.title, 40); const checks = strings(r.checks, 5);
        return t && checks.length > 0 ? clean({ title: t, text: str(r.text, 160), icon: icon(r.icon), checks }) : null;
      });
      return items ? clean({ kind: "pillars" as const, title, items }) : null;
    }
    case "timeline": {
      const items = rows(b.items, 2, 10, (r) => {
        const label = str(r.label, 20); const t = str(r.title, 80);
        return label && t ? clean({ label, title: t, text: str(r.text, 160) }) : null;
      });
      return items ? clean({ kind: "timeline" as const, title, items }) : null;
    }
    case "photos": {
      const items = rows(b.items, 2, 4, (r) => {
        const image = https(r.image); const t = str(r.title, 60);
        return image && t ? clean({ image, title: t, subtitle: str(r.subtitle, 80) }) : null;
      });
      return items ? { kind: "photos", items } : null;
    }
    case "calendar": {
      const days = rows(b.days, 1, 7, (r) => {
        const day = str(r.day, 12); const t = str(r.title, 60);
        return day && t ? clean({ day, date: str(r.date, 20), title: t, image: https(r.image), tag: str(r.tag, 20) }) : null;
      });
      return days ? clean({ kind: "calendar" as const, title, range: str(b.range, 40), days }) : null;
    }
    case "chips": {
      const items = rows(b.items, 1, 6, (r) => {
        const label = str(r.label, 30);
        return label ? clean({ label, icon: icon(r.icon) }) : null;
      });
      return items ? { kind: "chips", items } : null;
    }
    default:
      return null;
  }
}

/**
 * A board from what the agent wrote (a JSON string or an object), and the
 * blocks that were dropped, named by position and kind so they can be fixed.
 */
export function validateBoard(input: unknown, fallbackTitle = ""): { board: Board | null; dropped: string[]; error?: string } {
  let raw: unknown = input;
  if (typeof input === "string") {
    try { raw = JSON.parse(input); } catch (e) {
      return { board: null, dropped: [], error: `the content is not JSON (${(e as Error).message})` };
    }
  }
  if (!isRec(raw)) return { board: null, dropped: [], error: "the content must be a JSON object with a blocks array" };
  const list = Array.isArray(raw.blocks) ? raw.blocks.slice(0, 12) : [];
  const blocks: Block[] = [];
  const dropped: string[] = [];
  list.forEach((b, i) => {
    const ok = validateBlock(b);
    if (ok) blocks.push(ok);
    else dropped.push(`#${i + 1} (${isRec(b) ? String(b.kind ?? b.type ?? Object.keys(b)[0]) : typeof b})`);
  });
  if (blocks.length === 0) {
    return { board: null, dropped, error: "no block fits its shape" };
  }
  const status = ["draft", "in progress", "ready"].includes(raw.status as string) ? (raw.status as Board["status"]) : undefined;
  const board = clean({
    title: str(raw.title, 120) ?? (fallbackTitle || "Board"),
    subtitle: str(raw.subtitle, 120),
    icon: icon(raw.icon),
    status,
    blocks,
  }) as Board;
  return { board, dropped };
}

/** The shape, in the fewest words that still let a model write one. Rides in artifact_create. */
export const BOARD_BRIEF =
  `board = a one-screen visual: a plan, dashboard, diagram or itinerary. Content is JSON ` +
  `{title, subtitle, icon, status?:"draft"|"in progress"|"ready", blocks:[...]}, blocks drawn by the app in order. ` +
  `Each block names its kind in "kind": {"kind":"timeline","items":[...]}. Kinds and their fields: ` +
  `text{text} | kpis{items:[{label,value,delta?,trend?:up|down|flat}]} | line{title?,x:[..],series:[{name,values:[..]}]} | ` +
  `bars{title?,items:[{label,value}]} | breakdown{title?,items:[{label,value}]} (shares) | ` +
  `flow{nodes:[{id,title,lines?:[..],icon?}],edges:[{from,to,dashed?}]} | columns{items:[{title,text?,points?:[..],icon?,image?}]} | ` +
  `pillars{items:[{title,text?,icon?,checks:[..]}]} | timeline{items:[{label,title,text?}]} | photos{items:[{image,title,subtitle?}]} | ` +
  `calendar{range?,days:[{day,date?,title,image?,tag?}]} | chips{items:[{label,icon?}]} (footer). ` +
  `Images: https addresses from find_images. Icons: ${BOARD_ICONS.join(" ")}.`;

/** A board as Markdown, for PDF and Word: the words of every block, in order. */
export function boardToMarkdown(b: Board): string {
  const out: string[] = [`# ${b.title}`];
  if (b.subtitle) out.push(`_${b.subtitle}_`);
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  for (const k of b.blocks as Rec[]) {
    const head = typeof k.title === "string" ? `## ${k.title}` : "";
    const items = (Array.isArray(k.items) ? k.items : []) as Rec[];
    switch (k.kind) {
      case "text": out.push(String(k.text)); break;
      case "kpis": out.push(list(items.map((i) => `**${i.label}**: ${i.value}${i.delta ? ` (${i.delta})` : ""}`))); break;
      case "line": {
        const x = k.x as string[];
        out.push([head, ...(k.series as Rec[]).map((s) => `${s.name ? `${s.name}: ` : ""}${x.map((l, i) => `${l} ${(s.values as number[])[i]}`).join(", ")}`)].filter(Boolean).join("\n\n"));
        break;
      }
      case "bars":
      case "breakdown": {
        const total = items.reduce((n, i) => n + (i.value as number), 0) || 1;
        out.push([head, list(items.map((i) => `${i.label}: ${i.value}${k.kind === "breakdown" ? ` (${Math.round(((i.value as number) / total) * 100)}%)` : ""}`))].filter(Boolean).join("\n\n"));
        break;
      }
      case "flow": {
        const nodes = k.nodes as Rec[];
        const name = (id: unknown) => nodes.find((n) => n.id === id)?.title ?? String(id);
        out.push(list(nodes.map((n) => `**${n.title}**${(n.lines as string[] | undefined)?.length ? `: ${(n.lines as string[]).join(", ")}` : ""}`)));
        out.push(list((k.edges as Rec[]).map((e) => `${name(e.from)} → ${name(e.to)}`)));
        break;
      }
      case "columns":
      case "pillars":
        for (const i of items) {
          out.push(`## ${i.title}`);
          if (i.text) out.push(String(i.text));
          const pts = (i.points ?? i.checks) as string[] | undefined;
          if (pts?.length) out.push(list(pts));
        }
        break;
      case "timeline": out.push([head, list(items.map((i) => `**${i.label}** ${i.title}${i.text ? `: ${i.text}` : ""}`))].filter(Boolean).join("\n\n")); break;
      case "photos": out.push(list(items.map((i) => `${i.title}${i.subtitle ? `, ${i.subtitle}` : ""}`))); break;
      case "calendar": out.push([head, list((k.days as Rec[]).map((d) => `**${d.day}${d.date ? ` ${d.date}` : ""}** ${d.title}${d.tag ? ` (${d.tag})` : ""}`))].filter(Boolean).join("\n\n")); break;
      case "chips": out.push(items.map((i) => i.label).join(" · ")); break;
    }
  }
  return out.filter(Boolean).join("\n\n");
}
