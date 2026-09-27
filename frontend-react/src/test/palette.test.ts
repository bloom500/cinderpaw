/**
 * The rebrand palette (27 Sep 2026), pinned where a stranger meets it first.
 *
 * glass.test.ts decides whether a colour is READABLE. This file pins which
 * colours the brand IS, and that the first paint (index.html, before React)
 * uses the same grounds as the app, so a fresh install never flashes a colour
 * the palette no longer has.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

const CSS = readFileSync('src/styles/globals.css', 'utf8');
const HTML = readFileSync('index.html', 'utf8');

/** Same reading as glass.test.ts: at-rules cut out, later theme blocks win. */
function withoutAtRules(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '@' || !/^@(media|supports)\b/.test(source.slice(i, i + 12))) {
      out += source[i];
      continue;
    }
    let depth = 0;
    for (i = source.indexOf('{', i); i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) break;
    }
  }
  return out;
}

function themeTokens(theme: 'dark' | 'light'): Record<string, string> {
  const source = withoutAtRules(CSS);
  const selector = `:root[data-theme="${theme}"] {`;
  const out: Record<string, string> = {};
  for (let at = source.indexOf(selector); at > -1; at = source.indexOf(selector, at + 1)) {
    const body = source.slice(at, source.indexOf('\n}', at));
    for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[name] = value.trim();
  }
  return out;
}

describe('the rebrand palette', () => {
  const light = themeTokens('light');
  const dark = themeTokens('dark');

  test('the grounds are Paper and Charcoal', () => {
    expect(light['--bg-primary']).toBe('#F6EFE6');
    expect(dark['--bg-primary']).toBe('#2F2A26');
  });

  test('one button colour with white text, in both themes', () => {
    for (const t of [light, dark]) {
      expect(t['--brand']).toBe('#B15129');
      expect(t['--brand-foreground']).toBe('#FFFFFF');
    }
  });

  test('brand words and the user bubble follow the palette', () => {
    expect(light['--brand-text']).toBe('#9A4421');
    // Spec 3.1 said #FF8A3D; one 3% lightness step up, because glass.test
    // measured it at 4.46:1 over a white wallpaper in Glass mode.
    expect(dark['--brand-text']).toBe('#FF934C');
    // The bubble is the palette's `active` colour, in both themes.
    expect(light['--bubble-user']).toBe('#F2DDCC');
    expect(dark['--bubble-user']).toBe('#4A3528');
  });

  test('the shared Button writes in the button colour\'s white, not in the ground', () => {
    // Charcoal on the ember fill measures 2.76:1; no dark colour clears 4.5 on it.
    for (const t of [light, dark]) expect(t['--primary-foreground']).toBe('var(--brand-foreground)');
  });

  test('in Solid, the pane is tinted with its own ground', () => {
    // .app-pane paints --scene-surface over --bg-primary, so with no window
    // effect this is the colour a stranger reads on. A tint from the old
    // palette would pull Paper or Charcoal back toward it. (Glass mode keeps
    // its own tint over the wallpaper; glass.test.ts decides that one.)
    const rgb = (value: string) => value.startsWith('#')
      ? [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)).join(', ')
      : /rgba\((\d+),\s*(\d+),\s*(\d+),/.exec(value)?.slice(1).join(', ');
    for (const t of [light, dark]) expect(rgb(t['--scene-surface'])).toBe(rgb(t['--bg-primary']));
  });
});

describe('the first paint uses the same grounds', () => {
  test('index.html paints each theme on its --bg-primary', () => {
    const light = themeTokens('light')['--bg-primary'];
    const dark = themeTokens('dark')['--bg-primary'];
    expect(HTML).toContain(`html { background-color: ${dark}; }`);
    expect(HTML).toContain(`html[data-theme="light"] { background-color: ${light}; }`);
    // No ground from the old palette survives in the first paint.
    expect(HTML).not.toMatch(/#1C1814|#FAF6F0/i);
  });
});
