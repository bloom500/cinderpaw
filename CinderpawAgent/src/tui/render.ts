/**
 * TUI rendering primitives — Cinderpaw headless slice 5.1.
 *
 * Pure ANSI helpers. No I/O. Test-friendly: every function is referentially
 * transparent so we can assert on exact byte output.
 *
 * Brand palette (matches docs/superpowers/specs/...feral-react-migration-spec1):
 *   bg-primary     #100E09   deep warm black
 *   bg-surface     #1C1916
 *   text-primary   #F0E6D3   warm cream
 *   text-muted     #8C7E6A
 *   brand          #C4843A   warm rust orange — the Cinderpaw accent
 *   error          #C0472A
 *   success        #6A9E5A
 *
 * Color detection: NO_COLOR env (https://no-color.org/) disables ANSI.
 * Piped stdout (`!process.stdout.isTTY`) also disables — keeps logs
 * readable when the user does `feral chat | tee session.log`.
 *
 * Unicode box-drawing chars are used for the status bar and frames.
 * Terminals that can't render them (rare) get ASCII fallback via the
 * {@link frameBox} helper's `ascii` option.
 */

// ---------------------------------------------------------------------------
// Color detection
// ---------------------------------------------------------------------------

/** True when ANSI escape codes should be emitted. */
export function shouldUseColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FERAL_NO_COLOR !== undefined) return false;
  // No TTY = piped/redirected. Logs should be readable as plain text.
  if (!process.stdout.isTTY) return false;
  return true;
}

// ---------------------------------------------------------------------------
// ANSI codes
// ---------------------------------------------------------------------------

/** ANSI reset. */
export const RESET = "\x1b[0m";
/** ANSI bold. */
export const BOLD = "\x1b[1m";
/** ANSI dim. */
export const DIM = "\x1b[2m";
/** ANSI italic. */
export const ITALIC = "\x1b[3m";

/** Foreground color helpers — 24-bit (true) color. */
function fg(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

export const COLORS = {
  bgPrimary: "\x1b[48;2;16;14;9m",
  bgSurface: "\x1b[48;2;28;25;22m",
  bgElevated: "\x1b[48;2;37;33;25m",
  textPrimary: fg(240, 230, 211),
  textSecondary: fg(184, 172, 149),
  textMuted: fg(140, 126, 106),
  brand: fg(196, 132, 58),
  brandBright: fg(212, 148, 74),
  error: fg(192, 71, 42),
  success: fg(106, 158, 90),
  warning: fg(212, 160, 58),
} as const;

// ---------------------------------------------------------------------------
// Style helpers — wrap text in color/style codes only when color is on.
// ---------------------------------------------------------------------------

/** Wrap `text` in the given style if color is enabled. */
export function style(text: string, styleCode: string, useColor = shouldUseColor()): string {
  return useColor ? `${styleCode}${text}${RESET}` : text;
}

/** Brand-orange coloured text. Used for the Cinderpaw wordmark + accents. */
export function brand(text: string, useColor = shouldUseColor()): string {
  return style(text, COLORS.brand + BOLD, useColor);
}

/** Cream "primary" text. */
export function primary(text: string, useColor = shouldUseColor()): string {
  return style(text, COLORS.textPrimary, useColor);
}

/** Muted (low-emphasis) text. */
export function muted(text: string, useColor = shouldUseColor()): string {
  return style(text, COLORS.textMuted, useColor);
}

/** Secondary text — between primary and muted. */
export function secondary(text: string, useColor = shouldUseColor()): string {
  return style(text, COLORS.textSecondary, useColor);
}

/** Error text — used for error events. */
export function error(text: string, useColor = shouldUseColor()): string {
  return style(text, COLORS.error, useColor);
}

/** Success text — used for OK / dream-cycle-finished events. */
export function success(text: string, useColor = shouldUseColor()): string {
  return style(text, COLORS.success, useColor);
}

/** Dim text — used for the help line at the bottom of the TUI. */
export function dim(text: string, useColor = shouldUseColor()): string {
  return style(text, DIM + COLORS.textMuted, useColor);
}

// ---------------------------------------------------------------------------
// Box-drawing primitives
// ---------------------------------------------------------------------------

/** Unicode box-drawing chars. For terminals that can't render, see {@link frameBox}. */
const BOX = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│",
} as const;

/** ASCII fallback for non-unicode terminals. */
const BOX_ASCII = {
  tl: "+", tr: "+", bl: "+", br: "+",
  h: "-", v: "|",
} as const;

/**
 * Render a single horizontal rule (top or bottom of a box) of `width`
 * characters using either Unicode or ASCII box-drawing. Pure.
 */
export function horizontalRule(width: number, opts: { ascii?: boolean } = {}): string {
  const chars = opts.ascii ? BOX_ASCII : BOX;
  return chars.tl + chars.h.repeat(Math.max(0, width - 2)) + chars.tr;
}

/**
 * Render the BOTTOM half of a box rule (using `╰` / `╯`). Same semantics as
 * {@link horizontalRule} but with the bottom corners.
 */
export function horizontalRuleBottom(width: number, opts: { ascii?: boolean } = {}): string {
  const chars = opts.ascii ? BOX_ASCII : BOX;
  return chars.bl + chars.h.repeat(Math.max(0, width - 2)) + chars.br;
}

/**
 * Pad a string to `width` characters, padding with spaces on the right.
 * Negative or zero width returns the original string.
 */
export function padRight(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

/**
 * Strip ANSI escape codes from a string. Useful when measuring visible
 * width (the cursor position needs the actual character count, not the
 * escape sequence length).
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Visible width of a string — strips ANSI before measuring. */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

// ---------------------------------------------------------------------------
// Status bar — the persistent header at the top of the TUI
// ---------------------------------------------------------------------------

/**
 * Truncate `text` (which may contain ANSI) to at most `max` VISIBLE
 * columns, appending "…" when it had to cut. Measures with
 * {@link visibleWidth} so escape bytes never count toward the limit.
 *
 * ponytail: naive slice on visible chars — fine because callers pass
 * either plain text or a single-color string; it won't split a color
 * run mid-sequence in practice. If we ever truncate rich multi-color
 * content, swap for an ANSI-aware slicer.
 */
function truncateVisible(text: string, max: number): string {
  if (visibleWidth(text) <= max) return text;
  if (max <= 1) return "…";
  return stripAnsi(text).slice(0, max - 1) + "…";
}

/**
 * Render the header line at the top of the TUI — a full-width rule with
 * the wordmark on the left and live status on the right:
 *
 *   ◉ FERAL ─────────────────────  MiniMax-M3 · balanced · 12.4k ─
 *
 * No box corners: a scrolling chat can't be framed, so orphaned corners
 * would just read as broken. A single full-width rule reads as an
 * intentional header on its own. `content` is truncated (visible width)
 * when the line would overflow.
 */
export function renderStatusBar(
  content: string,
  width: number,
  useColor = shouldUseColor(),
): string {
  const safeWidth = Math.max(24, width);
  const wordmark = "◉ FERAL";
  // Reserve: wordmark + " " + (≥3 dashes) + " " + status + " " + tail dash.
  const fixed = wordmark.length + 1 + 1 + 1 + 1; // spaces around dashes + status + tail
  const room = safeWidth - fixed - 3; // 3 = minimum dash run
  const status = room > 0 ? truncateVisible(content, room) : "";
  const dashes = Math.max(
    3,
    // total = wordmark + " " + dashes + " " + status + " " + tail(1)
    safeWidth - wordmark.length - 4 - visibleWidth(status),
  );
  const rule = BOX.h.repeat(dashes);
  return (
    `${brand(wordmark, useColor)} ` +
    `${muted(rule, useColor)} ` +
    `${secondary(status, useColor)} ` +
    `${muted(BOX.h, useColor)}`
  );
}

/**
 * Render the footer hint at the bottom of the session — a dim, full-width
 * rule with the command list embedded on the left, mirroring the header:
 *
 *   ─ /help · /clear · /model · /exit · Ctrl+C ───────────────────
 *
 * Items are joined by " · " and truncated (visible width) when they
 * overflow. Dim throughout so it recedes behind the conversation.
 */
export function renderHelpLine(
  items: string[],
  width: number,
  useColor = shouldUseColor(),
): string {
  const safeWidth = Math.max(24, width);
  const text = items.join(" · ");
  // Reserve: leading dash + two spaces + trailing (≥3) dash run.
  const room = safeWidth - 1 - 2 - 3;
  const shown = room > 0 ? truncateVisible(text, room) : "";
  const trailing = Math.max(3, safeWidth - 3 - visibleWidth(shown));
  return dim(
    `${BOX.h} ${shown} ${BOX.h.repeat(trailing)}`,
    useColor,
  );
}

// ---------------------------------------------------------------------------
// Prompt rendering — "You › " and "Cinderpaw › " lines
// ---------------------------------------------------------------------------

/**
 * Render the "You › " prompt. The trailing space is intentional —
 * `readline` consumes it as part of the prompt.
 */
export function renderYouPrompt(useColor = shouldUseColor()): string {
  return `${brand("You ", useColor)}${muted("›", useColor)} `;
}

/**
 * Render the "Cinderpaw › " response marker. Used at the start of every
 * assistant message.
 */
export function renderFeralPrompt(useColor = shouldUseColor()): string {
  return `${primary("Cinderpaw ", useColor)}${muted("›", useColor)} `;
}

// ---------------------------------------------------------------------------
// Terminal width detection
// ---------------------------------------------------------------------------

/** Get the current terminal width. Falls back to 80 on any failure. */
export function terminalWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols === "number" && cols > 0) return cols;
  return 80;
}