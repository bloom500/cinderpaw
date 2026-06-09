/**
 * time_date — pure date/time arithmetic, no side effects.
 *
 * Operations:
 *   - `now`         → current ISO-8601 UTC + epoch ms
 *   - `format`      → format a given (or now) date in a given pattern
 *   - `parse`       → parse an ISO/RFC-2822 string to epoch ms
 *   - `diff`        → difference between two dates in a chosen unit
 *
 * The pattern syntax is intentionally minimal: `YYYY-MM-DD HH:mm:ss`
 * with literal passthrough. We don't pull in a 200KB date library for
 * a handful of tokens.
 */

import type { Tool, ToolManifest } from "../../types.ts";

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

type Action = "now" | "format" | "parse" | "diff";

const VALID_ACTIONS: ReadonlySet<Action> = new Set(["now", "format", "parse", "diff"]);

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

function formatDate(date: Date, pattern: string): string {
  // Literal-passthrough formatter. We replace YYYY/YY/MM/DD/HH/mm/ss
  // case-insensitively; everything else is preserved.
  const Y = date.getUTCFullYear();
  const M = date.getUTCMonth() + 1;
  const D = date.getUTCDate();
  const h = date.getUTCHours();
  const m = date.getUTCMinutes();
  const s = date.getUTCSeconds();
  return pattern
    .replace(/YYYY/g, String(Y))
    .replace(/YY/g, String(Y).slice(-2))
    .replace(/MM/g, pad(M, 2))
    .replace(/DD/g, pad(D, 2))
    .replace(/HH/g, pad(h, 2))
    .replace(/mm/g, pad(m, 2))
    .replace(/ss/g, pad(s, 2));
}

function parseDate(input: string): Date | null {
  // Try native Date first (handles ISO-8601, RFC-2822, and a few others).
  const native = new Date(input);
  if (!isNaN(native.getTime())) return native;
  // Fallback: our own minimal YYYY-MM-DD[ HH:MM:SS] parser.
  const m = ISO_PATTERN.exec(input);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, ms, tz] = m;
  let iso = `${y}-${mo}-${d}T${hh ?? "00"}:${mm ?? "00"}:${ss ?? "00"}${ms ? `.${ms.padEnd(3, "0")}` : ""}`;
  if (tz) {
    if (tz === "Z") iso += "Z";
    else iso += tz;
  } else {
    iso += "Z"; // assume UTC when no zone is given
  }
  const d2 = new Date(iso);
  return isNaN(d2.getTime()) ? null : d2;
}

export function createTimeDateTool(): Tool {
  const manifest: ToolManifest = {
    name: "time_date",
    description:
      "Pure date/time helpers. Actions: `now` (current UTC + epoch ms), " +
      "`format` (render a date in a YYYY-MM-DD HH:mm:ss pattern), `parse` " +
      "(ISO or YYYY-MM-DD[ HH:MM:SS] → epoch ms), `diff` (between two " +
      "dates in seconds/minutes/hours/days). No side effects.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      action: {
        type: "string",
        description: "One of: 'now' (default), 'format', 'parse', 'diff'.",
        required: false,
      },
      date: {
        type: "string",
        description: "For 'format' or 'parse': an ISO-8601 or YYYY-MM-DD[ HH:MM:SS] string.",
        required: false,
      },
      pattern: {
        type: "string",
        description: "For 'format': the output pattern. Tokens: YYYY YY MM DD HH mm ss.",
        required: false,
      },
      date_a: { type: "string", description: "For 'diff': the first date.", required: false },
      date_b: { type: "string", description: "For 'diff': the second date.", required: false },
      unit: {
        type: "string",
        description: "For 'diff': the unit — 'seconds' (default), 'minutes', 'hours', or 'days'.",
        required: false,
      },
    },
    async execute(args) {
      const action = (typeof args.action === "string" && args.action.trim()
        ? args.action : "now") as Action;
      if (!VALID_ACTIONS.has(action)) {
        return { ok: false, content: `time_date: unknown action "${action}".`, error: "bad_args" };
      }

      switch (action) {
        case "now": {
          const d = new Date();
          return {
            ok: true,
            content: `${formatDate(d, "YYYY-MM-DD HH:mm:ss")}Z (epoch ${d.getTime()})`,
            data: { iso: d.toISOString(), epochMs: d.getTime() },
          };
        }
        case "format": {
          const date = typeof args.date === "string" && args.date.trim() ? args.date : new Date().toISOString();
          const d = parseDate(date);
          if (!d) return { ok: false, content: `time_date: cannot parse "${date}"`, error: "bad_args" };
          const pattern = typeof args.pattern === "string" && args.pattern.trim()
            ? args.pattern
            : "YYYY-MM-DD HH:mm:ss";
          return {
            ok: true,
            content: formatDate(d, pattern),
            data: { formatted: formatDate(d, pattern), input: date, epochMs: d.getTime() },
          };
        }
        case "parse": {
          const date = typeof args.date === "string" && args.date.trim() ? args.date : "";
          if (!date) return { ok: false, content: "time_date parse: 'date' is required.", error: "bad_args" };
          const d = parseDate(date);
          if (!d) return { ok: false, content: `time_date: cannot parse "${date}"`, error: "bad_args" };
          return {
            ok: true,
            content: `${d.toISOString()} (epoch ${d.getTime()})`,
            data: { iso: d.toISOString(), epochMs: d.getTime() },
          };
        }
        case "diff": {
          const a = typeof args.date_a === "string" && args.date_a.trim() ? args.date_a : "";
          const b = typeof args.date_b === "string" && args.date_b.trim() ? args.date_b : "";
          if (!a || !b) return { ok: false, content: "time_date diff: 'date_a' and 'date_b' are required.", error: "bad_args" };
          const da = parseDate(a);
          const db = parseDate(b);
          if (!da || !db) return { ok: false, content: "time_date diff: invalid date(s).", error: "bad_args" };
          const unit = (typeof args.unit === "string" && args.unit.trim()
            ? args.unit : "seconds").toLowerCase();
          const ms = Math.abs(da.getTime() - db.getTime());
          let value: number;
          switch (unit) {
            case "seconds": value = ms / 1000; break;
            case "minutes": value = ms / 60_000; break;
            case "hours":   value = ms / 3_600_000; break;
            case "days":    value = ms / 86_400_000; break;
            default:
              return { ok: false, content: `time_date: unknown unit "${unit}".`, error: "bad_args" };
          }
          return {
            ok: true,
            content: `${value} ${unit}`,
            data: { ms, value, unit, a: da.toISOString(), b: db.toISOString() },
          };
        }
      }
    },
  };
}
