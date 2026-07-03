/**
 * TUI rendering primitives — slice 5.1 tests.
 *
 * Every function under test is referentially transparent — no I/O, no
 * globals beyond the optional `useColor` argument. Tests pass `false`
 * to force plain-text output and assert on exact byte content.
 */

import { describe, expect, test } from "bun:test";
import {
  style,
  brand,
  primary,
  muted,
  secondary,
  error,
  success,
  dim,
  horizontalRule,
  horizontalRuleBottom,
  padRight,
  stripAnsi,
  visibleWidth,
  renderStatusBar,
  renderHelpLine,
  renderYouPrompt,
  renderFeralPrompt,
} from "../src/tui/render.ts";

// ---------------------------------------------------------------------------
// Style helpers — useColor = false
// ---------------------------------------------------------------------------

describe("style (no color)", () => {
  test("returns text unchanged", () => {
    expect(style("hello", "\x1b[31m", false)).toBe("hello");
  });
});

describe("brand", () => {
  test("plain text when useColor=false", () => {
    expect(brand("feral", false)).toBe("feral");
  });
  test("wraps in ANSI when useColor=true", () => {
    const out = brand("test", true);
    expect(out).toContain("\x1b[");
    expect(out).toContain("test");
    expect(out).toMatch(/\x1b\[0m$/); // ends with reset
  });
});

describe("primary / muted / secondary / error / success / dim (no color)", () => {
  const fns = [primary, muted, secondary, error, success, dim];
  for (const fn of fns) {
    test(`${fn.name || "fn"} returns text unchanged`, () => {
      expect(fn("x", false)).toBe("x");
    });
  }
});

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  test("strips foreground codes", () => {
    expect(stripAnsi("\x1b[38;2;196;132;58mhello\x1b[0m")).toBe("hello");
  });
  test("strips background codes", () => {
    expect(stripAnsi("\x1b[48;2;16;14;9mbg\x1b[0m")).toBe("bg");
  });
  test("strips bold/dim/italic", () => {
    expect(stripAnsi("\x1b[1mbold\x1b[0m \x1b[2mdim\x1b[0m")).toBe("bold dim");
  });
  test("identity on plain text", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
});

describe("visibleWidth", () => {
  test("plain text width", () => {
    expect(visibleWidth("hello")).toBe(5);
  });
  test("ANSId text width", () => {
    expect(visibleWidth("\x1b[1mabc\x1b[0m")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// String padding
// ---------------------------------------------------------------------------

describe("padRight", () => {
  test("pads shorter string", () => {
    expect(padRight("ab", 5)).toBe("ab   ");
  });
  test("does not pad exact string", () => {
    expect(padRight("abc", 3)).toBe("abc");
  });
  test("does not truncate longer string", () => {
    expect(padRight("abcdef", 3)).toBe("abcdef");
  });
});

// ---------------------------------------------------------------------------
// Box-drawing
// ---------------------------------------------------------------------------

describe("horizontalRule", () => {
  test("produces corner + dashes + corner", () => {
    const r = horizontalRule(10);
    expect(r.length).toBe(10);
    expect(r[0]).toBe("╭");
    expect(r[r.length - 1]).toBe("╮");
    expect(r.slice(1, -1)).toBe("─".repeat(8));
  });

  test("ascii mode", () => {
    const r = horizontalRule(6, { ascii: true });
    expect(r[0]).toBe("+");
    expect(r[r.length - 1]).toBe("+");
    expect(r.slice(1, -1)).toBe("-".repeat(4));
  });

  test("minimum width 2", () => {
    expect(horizontalRule(2)).toBe("╭╮");
    expect(horizontalRule(1)).toBe("╭╮"); // Math.max(0, -1) → 0
  });
});

describe("horizontalRuleBottom", () => {
  test("produces bottom corners", () => {
    const r = horizontalRuleBottom(6, { ascii: true });
    expect(r[0]).toBe("+");
    expect(r[r.length - 1]).toBe("+");
  });
});

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

describe("renderStatusBar (no color)", () => {
  test("contains wordmark and content", () => {
    const r = renderStatusBar("hello world", 40, false);
    expect(r).toContain("◉ FERAL");
    expect(r).toContain("hello world");
    // Full-width rule, no orphaned box corners.
    expect(r).not.toContain("╭");
    expect(r).not.toContain("╮");
    expect(r).toContain("─");
  });

  test("truncates long content with ellipsis, stays within width", () => {
    const r = renderStatusBar("x".repeat(100), 40, false);
    expect(r).toContain("…");
    expect(visibleWidth(r)).toBeLessThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// Help line
// ---------------------------------------------------------------------------

describe("renderHelpLine (no color)", () => {
  test("renders items joined by separator", () => {
    const r = renderHelpLine(["/help", "/exit"], 40, false);
    expect(r).toContain("/help");
    expect(r).toContain("/exit");
    expect(r).not.toContain("╰");
    expect(r).not.toContain("╯");
  });

  test("does not truncate items that fit (visible-width math)", () => {
    // Regression: old code measured ANSI byte length, cutting early.
    const items = ["/help", "/clear", "/model", "/exit", "Ctrl+C"];
    const r = renderHelpLine(items, 72, true);
    for (const it of items) expect(r).toContain(it);
    expect(visibleWidth(r)).toBeLessThanOrEqual(72);
  });
});

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

describe("renderYouPrompt (no color)", () => {
  test("produces 'You › '", () => {
    expect(renderYouPrompt(false)).toBe("You › ");
  });

  test("ends with trailing space", () => {
    expect(renderYouPrompt(false).endsWith(" ")).toBe(true);
  });
});

describe("renderFeralPrompt (no color)", () => {
  test("produces 'Feral › '", () => {
    expect(renderFeralPrompt(false)).toBe("Feral › ");
  });
});