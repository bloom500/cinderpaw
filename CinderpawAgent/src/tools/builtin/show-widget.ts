/**
 * show_widget — the agent sends data, the app draws it.
 *
 * Seven kinds (spec 7.1 of docs/superpowers/specs/2026-09-27-app-ui-final-design.md):
 * facts, checklist, cards, breakdown, progress, table, verdict. An eighth,
 * followups, is not drawn in place: up to four next requests the app shows as
 * chips at the end of the reply (spec 7.5, Artifact Dock). The agent never
 * writes their HTML, so they always match the theme, cost few tokens, and
 * cannot run code. The app reads the widget from this tool's `data`, never
 * from its sentence.
 *
 * Bad input is not an error. A widget that fails validation comes back as
 * `kind: "list"`, the same content as plain lines, so the person still sees
 * what the agent meant to show and the turn does not stall on a retry.
 */

import type { CinderpawFetch, Tool, ToolManifest, ToolResult } from "../../types.ts";
import { cacheImage, pagePreviewImage } from "../image-cache.ts";

export const WIDGET_KINDS = ["facts", "checklist", "cards", "breakdown", "progress", "table", "verdict", "followups"] as const;

/** A follow-up chip's longest text: a short request, not a paragraph. */
export const FOLLOWUP_MAX = 80;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

/** The only icons a `facts` row may name; the app draws each one. */
export const WIDGET_ICONS = [
  "calendar", "clock", "map-pin", "wallet", "users", "star", "check", "info", "file", "link", "tag", "home",
] as const;

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const https = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  try { return new URL(s).protocol === "https:" ? s : undefined; } catch { return undefined; }
};
const list = (v: unknown, min: number, max: number): Rec[] | null =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every(isRec) ? (v as Rec[]) : null;

/** The widget, normalised, or null when the data does not fit its kind. */
export function validateWidget(args: Rec): Rec | null {
  const kind = args.kind;
  const title = str(args.title) ?? undefined;
  switch (kind) {
    case "facts": {
      const items = list(args.items, 2, 6);
      if (!items) return null;
      const rows = items.map((it) => {
        const label = str(it.label);
        const value = str(it.value) ?? (num(it.value) !== null ? String(it.value) : null);
        const icon = (WIDGET_ICONS as readonly string[]).includes(it.icon as string) ? (it.icon as string) : undefined;
        return label && value ? { label, value, ...(icon ? { icon } : {}) } : null;
      });
      return rows.every(Boolean) ? { kind, title, items: rows } : null;
    }
    case "checklist": {
      const items = list(args.items, 1, 30);
      if (!items) return null;
      const rows = items.map((it) => {
        const text = str(it.text);
        const note = str(it.note) ?? undefined;
        return text && typeof it.done === "boolean" ? { text, done: it.done, ...(note ? { note } : {}) } : null;
      });
      return rows.every(Boolean) ? { kind, title, items: rows } : null;
    }
    case "cards": {
      const items = list(args.items, 2, 6);
      if (!items) return null;
      const rows = items.map((it) => {
        const t = str(it.title);
        if (!t) return null;
        const subtitle = str(it.subtitle) ?? undefined;
        const image = https(it.image);
        const url = https(it.url);
        return { title: t, ...(subtitle ? { subtitle } : {}), ...(image ? { image } : {}), ...(url ? { url } : {}) };
      });
      return rows.every(Boolean) ? { kind, title, items: rows } : null;
    }
    case "breakdown": {
      const items = list(args.items, 1, 12);
      if (!items) return null;
      const rows = items.map((it) => {
        const label = str(it.label);
        const value = num(it.value);
        return label && value !== null && value >= 0 ? { label, value } : null;
      });
      if (!rows.every(Boolean)) return null;
      const total = num(args.total);
      return { kind, title, items: rows, ...(total !== null && total > 0 ? { total } : {}) };
    }
    case "progress": {
      const done = num(args.done);
      const total = num(args.total);
      const label = str(args.label);
      if (done === null || total === null || !label || total <= 0 || done < 0 || done > total) return null;
      return { kind, title, done, total, label };
    }
    case "table": {
      const columns = list(args.columns, 2, 4);
      const rows = list(args.rows, 1, 20);
      if (!columns || !rows) return null;
      const cols = columns.map((c) => {
        const t = str(c.title);
        if (!t) return null;
        const subtitle = str(c.subtitle) ?? undefined;
        const image = https(c.image);
        return { title: t, ...(subtitle ? { subtitle } : {}), ...(image ? { image } : {}) };
      });
      const body = rows.map((r) => {
        const label = str(r.label);
        const cells = Array.isArray(r.cells) && r.cells.length === columns.length
          ? r.cells.map((c) => (typeof c === "string" ? c : typeof c === "number" ? String(c) : null))
          : null;
        return label && cells && cells.every((c) => c !== null) ? { label, cells } : null;
      });
      return cols.every(Boolean) && body.every(Boolean) ? { kind, title, columns: cols, rows: body } : null;
    }
    case "verdict": {
      const text = str(args.text);
      return text ? { kind, title, text } : null;
    }
    case "followups": {
      const next = Array.isArray(args.next) && args.next.length >= 1 && args.next.length <= 4 ? args.next : null;
      if (!next) return null;
      const texts = next.map((it) => str(it));
      return texts.every((t) => t !== null && t.length <= FOLLOWUP_MAX) ? { kind, next: texts } : null;
    }
    default:
      return null;
  }
}

/** Every string in the input, one line per item, for the fallback list. */
export function fallbackLines(args: Rec): string[] {
  const flat = (v: unknown): string[] => {
    if (typeof v === "string") return v.trim() ? [v.trim()] : [];
    if (typeof v === "number" || typeof v === "boolean") return [String(v)];
    if (Array.isArray(v)) return v.flatMap(flat);
    if (isRec(v)) return Object.values(v).flatMap(flat);
    return [];
  };
  const lines: string[] = [];
  for (const key of ["label", "text"]) lines.push(...flat(args[key]));
  for (const key of ["items", "columns", "rows", "next"]) {
    const v = args[key];
    if (Array.isArray(v)) for (const item of v) {
      const line = flat(item).join(" · ");
      if (line) lines.push(line);
    }
  }
  if (num(args.done) !== null && num(args.total) !== null) lines.push(`${args.done} of ${args.total}`);
  return lines.slice(0, 40);
}

/**
 * Give each card (and table column) a real picture, kept in the profile.
 *
 * A card's picture is the `image` the agent named or, when it named none but
 * linked a page, the preview image that page names for itself (og:image), the
 * picture any link preview shows. Each goes through `cacheImage` (egress door,
 * https raster only, size-capped). The app shows `imageFile`; an image that
 * could not be kept is dropped, and the card shows its placeholder.
 */
export async function attachImages(widget: Rec, fetch: CinderpawFetch, dir?: string): Promise<number> {
  let found = 0;
  const one = async (target: Rec, page?: unknown): Promise<void> => {
    const named = typeof target.image === "string" ? target.image : null;
    const src = named ?? (typeof page === "string" ? await pagePreviewImage(page, fetch) : null);
    const file = src ? await cacheImage(src, fetch, dir) : null;
    if (file) {
      target.image = src;
      target.imageFile = file;
      found += 1;
    } else {
      delete target.image;
    }
  };
  if (widget.kind === "cards") await Promise.all((widget.items as Rec[]).map((it) => one(it, it.url)));
  if (widget.kind === "table") await Promise.all((widget.columns as Rec[]).map((c) => one(c)));
  return found;
}

const OBJ_ITEMS = { type: "array", items: { type: "object" } };

export function createShowWidgetTool(): Tool {
  const manifest: ToolManifest = {
    name: "show_widget",
    description:
      "Show structured information to the user as a themed widget in the chat, instead of a markdown list. " +
      "Kinds: `facts` (items: 2-6 {label, value, icon?}), `checklist` (items: {text, done, note?}), " +
      "`cards` (items: 2-6 {title, subtitle?, image?, url?}, https only; a card with a url and no image gets " +
      "the picture that page shows in link previews, so link the real product or place page), `breakdown` (items: {label, value}, total?), " +
      "`progress` (done, total, label), `table` (columns: 2-4 {title, subtitle?, image?}, rows: {label, cells[]} " +
      "with one cell per column), `verdict` (text, one per answer: your take under a comparison), " +
      "`followups` (next: 1-4 short strings, next requests the user might send, in their voice; only after a finished task, last). " +
      `Icons: ${WIDGET_ICONS.join(", ")}. Say in your text what the widget shows; do not repeat its contents. ` +
      "A board, dashboard, itinerary or plan the user asked for is not a widget: make it with artifact_create, kind `board`.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      kind: { type: "string", description: `One of: ${WIDGET_KINDS.join(", ")}.`, required: true,
        schema: { type: "string", enum: [...WIDGET_KINDS] } },
      title: { type: "string", description: "Optional heading.", required: false },
      items: { type: "array", description: "Rows for facts, checklist, cards, breakdown.", required: false, schema: OBJ_ITEMS },
      next: { type: "array", description: "followups: 1-4 short next requests.", required: false,
        schema: { type: "array", items: { type: "string" } } },
      columns: { type: "array", description: "Table columns.", required: false, schema: OBJ_ITEMS },
      rows: { type: "array", description: "Table rows: {label, cells}.", required: false, schema: OBJ_ITEMS },
      total: { type: "number", description: "breakdown total, or progress total.", required: false },
      done: { type: "number", description: "progress: how many are done.", required: false },
      label: { type: "string", description: "progress label.", required: false },
      text: { type: "string", description: "verdict text.", required: false },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const widget = validateWidget(args);
      if (widget) {
        // `typeof`: a test double may pass a context without a fetch.
        const pictures = typeof ctx?.fetch === "function" && (widget.kind === "cards" || widget.kind === "table")
          ? await attachImages(widget, ctx.fetch)
          : 0;
        const note = pictures > 0 ? ` ${pictures} with a picture.` : "";
        return { ok: true, content: `Shown to the user as a ${widget.kind} widget.${note}`, data: widget };
      }
      const title = str(args.title) ?? undefined;
      const lines = fallbackLines(args);
      return {
        ok: true,
        content:
          `The ${String(args.kind)} widget did not fit its shape, so the user sees it as a plain list ` +
          `(${lines.length} line${lines.length === 1 ? "" : "s"}). Check the shape in the tool description next time.`,
        data: { kind: "list", title, lines },
      };
    },
  };
}
