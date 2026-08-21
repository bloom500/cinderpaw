/**
 * The material contract.
 *
 * Glassmorphism here is not a component or a class — it is two colour tokens.
 * `--bg-surface` and `--bg-elevated` are translucent, so every one of the ~120
 * `bg-bg-surface` / `bg-bg-elevated` call sites in the app is made of glass
 * without knowing it. That is the whole design, and it has exactly three ways
 * to break silently:
 *
 *  1. Someone "fixes" a contrast complaint by putting a hex back. Every panel
 *     in the app goes solid at once and the window underneath is still
 *     transparent — a see-through frame around an opaque app.
 *  2. Someone makes `--bg-primary` translucent to match. It is also
 *     `--scene-base`, the opaque ground under a `transparent: true` window, and
 *     `--primary-foreground`, the text on brand buttons. Translucent there puts
 *     the app's words directly on the user's wallpaper.
 *  3. The reduced-transparency and no-backdrop-filter escapes get dropped in a
 *     refactor, and the machine that asked for less transparency, or cannot
 *     paint a blur at all, is left with unreadable panels and no way back.
 *
 * None of the three shows up in a build or a console. They show up on somebody
 * else's desktop.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Read from disk rather than importing: Vite runs the stylesheet through
// PostCSS on import, and a test of what the tokens SAY has to see the file the
// author edits, not the transform's output.
const CSS = readFileSync('src/styles/globals.css', 'utf8');

/**
 * The stylesheet with every `@media` / `@supports` block cut out.
 *
 * The escapes below redeclare the same palette inside at-rules, so a naive
 * scan of the file reports the reduced-transparency values as the app's
 * values — the tokens would look solid in a test while shipping translucent.
 * The unconditional palette is what is left when the conditions are removed.
 */
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

/**
 * Every `--token: value;` a theme ends up with.
 *
 * A theme is declared across SEVERAL `:root[data-theme="…"]` blocks — the
 * palette, the scene, the two dials — and later ones override earlier ones,
 * exactly as the cascade does. Reading only the first block is how a token
 * looks correct in a test and wrong in the window.
 */
function themeTokens(
  theme: 'dark' | 'light',
  source = withoutAtRules(CSS),
): Record<string, string> {
  const selector = `:root[data-theme="${theme}"] {`;
  const out: Record<string, string> = {};
  let found = false;
  for (let at = source.indexOf(selector); at > -1; at = source.indexOf(selector, at + 1)) {
    found = true;
    const body = source.slice(at, source.indexOf('\n}', at));
    for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      out[name] = value.trim();
    }
  }
  expect(found, `no ${theme} block`).toBe(true);
  return out;
}

/** Alpha of an `rgba()` / `rgb()` value; hex and everything else is opaque. */
function alpha(value: string): number {
  const m = /rgba?\([^)]*?,\s*([\d.]+)\s*\)/.exec(value);
  return m ? Number(m[1]) : 1;
}

/** The stylesheet text inside an at-rule, e.g. a `@media (…)` block. */
function atRule(prelude: string): string {
  const start = CSS.indexOf(prelude);
  expect(start, `no ${prelude} block`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = CSS.indexOf('{', start); i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(start, i);
  }
  throw new Error(`unterminated ${prelude}`);
}

describe.each(['dark', 'light'] as const)('%s palette', (theme) => {
  const tokens = themeTokens(theme);

  test('the surfaces the app paints with are translucent', () => {
    // Below ~0.9 the desktop is genuinely visible; at 1.0 there is no glass at
    // all. The upper bound is what makes this a test rather than a comment.
    expect(alpha(tokens['--bg-surface'])).toBeLessThan(0.9);
    expect(alpha(tokens['--bg-elevated'])).toBeLessThan(0.9);
  });

  test('the pane is the ground, and it is opaque enough to read on', () => {
    // The sheets above are thin on purpose; this is the layer that has to
    // carry the contrast, because it is the one text lands on when no panel
    // is involved — Settings, the Models list, the greeting. There is no
    // alpha floor on the sheets any more for the same reason: legibility is
    // asserted by measurement below, not by guessing at opacities.
    expect(alpha(tokens['--scene-surface'])).toBeGreaterThanOrEqual(0.78);
    // …and still translucent, or none of this is glass at all.
    expect(alpha(tokens['--scene-surface'])).toBeLessThan(0.95);
  });

  test('--bg-primary is fully opaque: it is also the ground and a foreground', () => {
    expect(alpha(tokens['--bg-primary'])).toBe(1);
    expect(tokens['--scene-base']).toBe('var(--bg-primary)');
    expect(tokens['--primary-foreground']).toBe('var(--bg-primary)');
  });
});

/**
 * The rule that cost an afternoon.
 *
 * This stylesheet is loaded AFTER `@tailwind utilities`, so at equal
 * specificity — and a bare class selector is exactly equal to a Tailwind
 * utility — every declaration in here wins on source order. A single
 * `position: relative` on `.liquid-glass-rim` therefore beat the `fixed` on
 * the navigation rail: the rail dropped out of its corner into normal flow and
 * grew down the page with no bottom to stop it.
 *
 * Nothing in the build says so. The class was added to make a decorative edge
 * work and it silently repositioned an unrelated component two files away.
 * Material properties — colour, blur, shadow, border, background — are what
 * belongs in a bare class here. Where an element LIVES belongs to the markup.
 */
describe('bare class rules never take a layout property from a utility', () => {
  const FORBIDDEN = /^\s*(position|inset(-\w+)?|top|right|bottom|left|float|border)\s*:/;

  test.each(
    [...withoutAtRules(CSS).matchAll(/(^|\n)(\.[\w-]+(?:\s*,\s*\.[\w-]+)*)\s*\{([^}]*)\}/g)]
      .map(([, , selector, body]) => ({ selector: selector.trim(), body })),
  )('$selector', ({ body }) => {
    const offenders = body
      .split(';')
      .filter((decl) => FORBIDDEN.test(decl))
      .map((decl) => decl.trim());
    expect(offenders).toEqual([]);
  });
});

/**
 * What happens once the window is genuinely see-through.
 *
 * `transparent: true` plus a real OS blur is only half of it. The other half is
 * that everything WE paint full-screen has to stand down, and that half has now
 * been missed three times: the stylesheet made `body`'s background-color
 * transparent and left the two decorative layers above it — three overscanned
 * radial lights and a grain tile — running at full strength. The result is not
 * a desktop seen through glass, it is a mauve field: amber, blue-violet and
 * purple overlapping across the whole canvas and averaging out. It looks like
 * a tinted pane, so every attempt to fix it reaches for the pane's alpha, and
 * the alpha was never what was in the way.
 *
 * Same for the blur. The OS has already blurred the desktop; a second
 * `blur(28px)` over it is what turns a wallpaper into one colour.
 *
 * None of this is visible on a machine where the effect never applies, which is
 * every CI runner and every Linux desktop — so the file is the only place it
 * can be checked.
 */
describe('when the OS really is blurring behind the window', () => {
  const rules = [
    ...withoutAtRules(CSS).matchAll(/html\.has-window-effect\s+([^{]+)\{([^}]*)\}/g),
  ].map(([, selector, body]) => ({ selector: selector.trim(), body }));

  const ruleFor = (selector: string) => {
    const found = rules.find((r) => r.selector === selector);
    expect(found, `nothing stands down for "${selector}"`).toBeDefined();
    return found!.body;
  };

  test('the atmospheric lights stand down', () => {
    expect(ruleFor('body::before')).toMatch(/opacity:\s*0?\.[0-4]/);
  });

  test('the grain is scaled from its token, never replaced by a flat number', () => {
    // Its normal opacity is ~0.02. A literal here would multiply it, not
    // reduce it.
    expect(ruleFor('body::after')).toContain('var(--scene-grain-opacity)');
  });

  // The pane's own filter is theme-scoped now (dark darkens, light lifts), so
  // it no longer matches the un-themed prefix the rules above share.
  test.each(['dark', 'light'])('%s pane stops blurring what the OS already blurred', (theme) => {
    const at = CSS.indexOf(`html.has-window-effect[data-theme="${theme}"] .app-pane`);
    expect(at, `no pane filter for ${theme}`).toBeGreaterThan(-1);
    const open = CSS.indexOf('{', at);
    const body = CSS.slice(open + 1, CSS.indexOf('}', open));
    expect(body).toMatch(/backdrop-filter:/);
    expect(body).not.toContain('blur(');
  });
});

describe('the escapes', () => {
  test('reduced transparency returns every surface to solid', () => {
    const block = atRule('@media (prefers-reduced-transparency: reduce)');
    for (const theme of ['dark', 'light'] as const) {
      const tokens = themeTokens(theme, block);
      for (const name of ['--bg-surface', '--bg-elevated', '--bg-hover', '--bg-active']) {
        expect(alpha(tokens[name]), `${theme} ${name}`).toBe(1);
      }
    }
    // …and the window stops being see-through, rather than just being covered.
    expect(block).toContain('html.has-window-effect body { background-color: var(--scene-base); }');
    expect(block).toContain('backdrop-filter: none');
  });

  test('no backdrop-filter support means near-opaque surfaces', () => {
    const block = atRule('@supports not ((backdrop-filter: blur(1px))');
    for (const theme of ['dark', 'light'] as const) {
      const tokens = themeTokens(theme, block);
      // Not fully solid — the scene below still gives depth — but far enough
      // that text never sits on an unblurred desktop.
      expect(alpha(tokens['--bg-surface']), theme).toBeGreaterThanOrEqual(0.95);
      expect(alpha(tokens['--bg-elevated']), theme).toBeGreaterThanOrEqual(0.95);
    }
  });
});

/**
 * Contrast, against a background we do not control.
 *
 * On an opaque app you check text against a known colour. Here the surfaces are
 * translucent, so what a word is actually read against is partly the user's
 * WALLPAPER — and that can be anything. A palette tuned on one desk is not
 * evidence about anyone else's.
 *
 * So every token is measured against BOTH extremes, white and black, and held
 * to the worse of the two. That is the only claim that survives shipping: not
 * "it looks fine here", but "there is no desktop picture on which this is
 * unreadable".
 *
 * This is what caught the real bug. At the alpha the surfaces started with,
 * dark-theme secondary text over a pale wallpaper measured 2.23:1 and muted
 * 1.50:1 — light letters on a light panel, reported as "a lot of text is not
 * visible". Nothing in a build or a screenshot on a dark desktop shows that.
 */
describe('text stays readable on any wallpaper', () => {
  const srgbToLinear = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]: number[]) =>
    0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  const contrast = (fg: number[], bg: number[]) => {
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  };
  /** Composite a translucent colour over an opaque one. */
  const over = (top: number[], under: number[]) =>
    [0, 1, 2].map((i) => top[3] * top[i] + (1 - top[3]) * under[i]);

  /** `rgba(…)` or `#rrggbb` → [r, g, b, a]. */
  const parse = (value: string): number[] => {
    const fn = /rgba?\(([^)]+)\)/.exec(value);
    if (fn) {
      const parts = fn[1].split(',').map((p) => Number(p.trim()));
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    }
    const hex = /#([0-9a-f]{6})/i.exec(value);
    expect(hex, `cannot parse colour "${value}"`).not.toBeNull();
    const h = hex![1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  };

  const WALLPAPERS = { white: [255, 255, 255], black: [0, 0, 0] };

  // Everything a person reads is held to AA, with no exceptions and no tier
  // graded on a curve.
  //
  // The two faint tiers used to be held to 3:1, on the argument that they
  // carry labels and timestamps rather than paragraphs. That was the wrong
  // trade twice over: a timestamp nobody can read is not a smaller problem
  // than a sentence nobody can read, and "3:1 is enough here" is what every
  // one of these tokens was originally justified with. They clear 4.5 now
  // (dark 5.52 / 4.62, light 4.76 / 4.74), so the exemption buys nothing.
  // `--text-disabled` is in the list on purpose: its call sites are
  // informational text, not disabled controls, so the WCAG exemption that
  // name implies does not apply to it.
  //
  // The five `-text` roles are the accents — see the palette in globals.css
  // for why they are separate colours from the fills they are named after.
  // They are the reason this list grew: `text-error` is 41 places where the
  // app explains a failure, and it measured 2.55:1.
  const FLOORS: Record<string, number> = {
    '--text-primary': 4.5,
    '--text-secondary': 4.5,
    '--text-muted': 4.5,
    '--text-disabled': 4.5,
    '--brand-text': 4.5,
    '--error-text': 4.5,
    '--success-text': 4.5,
    '--warning-text': 4.5,
    '--info-text': 4.5,
  };

  /**
   * The pane, as the compositor actually builds it, in the see-through case.
   *
   * Backdrop order is: the wallpaper, then the `backdrop-filter` on `.app-pane`,
   * then that element's own background colour on top. Modelling only the tint —
   * which this test used to do — measures a pane that does not exist and passes
   * a design that is unreadable, because the filter is where nearly all of the
   * protection now lives.
   *
   * `contrast()` and `brightness()` are read out of the shipped rule rather
   * than restated here, so nudging `brightness(0.30)` upward in the stylesheet
   * fails this test instead of quietly failing a person with a pale wallpaper.
   */
  /** The body of the first rule whose selector starts with `prefix`. */
  const ruleBody = (prefix: string): string => {
    // Plain string search, not a built regex. A selector this full of `.`, `[`
    // and `"` needs escaping that does not survive being written into a
    // template literal — the first version of this silently turned
    // `[data-theme="light"]` into a character class, matched the wrong rule,
    // and reported the light theme as having no filter at all.
    const at = CSS.indexOf(prefix);
    expect(at, `no rule for "${prefix}"`).toBeGreaterThan(-1);
    const open = CSS.indexOf('{', at);
    return CSS.slice(open + 1, CSS.indexOf('}', open));
  };

  /** `name(0.30)` inside a declaration block, or `fallback` when absent. */
  const filterAmount = (body: string, name: string, fallback: number): number => {
    const at = body.indexOf(`${name}(`);
    if (at === -1) return fallback;
    const start = at + name.length + 1;
    return Number(body.slice(start, body.indexOf(')', start)));
  };

  const paneRule = (theme: string) =>
    ruleBody(`html.has-window-effect[data-theme="${theme}"] .app-pane`);

  const glassPane = (theme: 'dark' | 'light', wallpaper: number[]): number[] => {
    const body = paneRule(theme);
    const contrastAmount = filterAmount(body, 'contrast', 1);
    const brightness = filterAmount(body, 'brightness', 1);
    // Saturation is deliberately not modelled: it is held at or below 1 in the
    // stylesheet, and desaturating can only move a channel toward the pixel's
    // own luminance — never above it. That is asserted separately below.
    const filtered = wallpaper.map((c) => {
      const x = (c / 255 - 0.5) * contrastAmount + 0.5;
      return Math.max(0, Math.min(1, x * brightness)) * 255;
    });

    // The brace is part of the search on purpose: the `.app-pane` rule shares
    // this selector's prefix and sits earlier in the file, so a prefix-only
    // match would read the filter block and find no tint in it.
    const tintBody = ruleBody(`html.has-window-effect[data-theme="${theme}"] {`);
    const decl = /--scene-surface:\s*([^;]+);/.exec(tintBody);
    expect(decl, `no see-through --scene-surface for ${theme}`).not.toBeNull();
    return over(parse(decl![1].trim()), filtered);
  };

  describe.each(['dark', 'light'] as const)('%s', (theme) => {
    const t = themeTokens(theme);

    test('the pane never brightens what is behind it', () => {
      // Above 1, a saturated wallpaper can come out brighter than the solved
      // worst case, and every number in this file stops being a bound.
      expect(filterAmount(paneRule(theme), 'saturate', 1)).toBeLessThanOrEqual(1);
    });

    // `null` is the bare pane — no panel at all. It belongs here because most
    // of the app's text is on it: every Settings row, the Models table, the
    // empty-state greeting. Measuring only the panelled surfaces is how a
    // contrast pass came back green while the pages a person actually reads
    // were unreadable.
    const GROUNDS: (string | null)[] = [null, '--bg-surface', '--bg-elevated'];

    test.each(Object.entries(FLOORS))('%s clears %s:1 everywhere', (token, floor) => {
      const measured = GROUNDS.flatMap((surface) =>
        Object.values(WALLPAPERS).map((wall) => {
          const ground = glassPane(theme, wall);
          return contrast(
            parse(t[token]),
            surface ? over(parse(t[surface]), ground) : ground,
          );
        }),
      );
      expect(Math.min(...measured)).toBeGreaterThanOrEqual(floor);
    });

    test('and on a machine with no window effect, where the ground is ours', () => {
      // No OS blur: `body` keeps `--scene-base`, opaque, and the pane tint from
      // the palette sits on that. Different stack, same requirement.
      const ground = over(parse(t['--scene-surface']), parse(t['--bg-primary']));
      for (const [token, floor] of Object.entries(FLOORS)) {
        const worst = Math.min(
          ...[null, '--bg-surface', '--bg-elevated'].map((surface) =>
            contrast(parse(t[token]), surface ? over(parse(t[surface]), ground) : ground),
          ),
        );
        expect(worst, token).toBeGreaterThanOrEqual(floor);
      }
    });
  });
});

/**
 * The exception to the whole design.
 *
 * Every other surface can be thin because the only thing behind it is the pane
 * and, through that, scenery. The composer is positioned OVER the transcript,
 * so what is behind it is the conversation — and any alpha low enough to look
 * like glass lets a second column of text slide around under the field you are
 * typing into.
 */
describe('the typing bar is the one surface text cannot read through', () => {
  test.each(['dark', 'light'] as const)('%s', (theme) => {
    const value = themeTokens(theme)['--surface-typing'];
    expect(value, 'no --surface-typing token').toBeDefined();
    expect(alpha(value)).toBeGreaterThanOrEqual(0.9);
    // Not 1: it still catches the desktop's colour, and it still has a blur
    // and a rim, so it stays part of the same material as everything else.
    expect(alpha(value)).toBeLessThan(1);
  });
});

/**
 * The accents, and why none of them may be a raw Tailwind colour.
 *
 * Every token above is measured against both extremes of wallpaper. A literal
 * `text-emerald-400` is measured against nothing — it is the same green in
 * both themes, and in light theme it lands on a pale panel at 1.26:1. There
 * were 82 of them, spread over 24 files, and the light theme was where they
 * all failed at once: amber-400 at 1.09, green-400 at 1.14, sky-400 at 1.41.
 * Nothing in a build says so, and on a dark desktop nothing on screen does
 * either.
 *
 * So the palette is closed for TEXT. Fills keep their literals — a solid
 * `bg-emerald-500` brings its own ground and the only thing that has to clear
 * a threshold is the label on it — but a word takes its colour from a token
 * that this file has measured.
 */
describe('no component writes text in a raw Tailwind colour', () => {
  const FAMILIES =
    'emerald|green|lime|teal|rose|red|pink|amber|yellow|orange|sky|blue|cyan|indigo|violet|purple|fuchsia';
  const OFFENDER = new RegExp(String.raw`(?<![\w-])(?:[a-z-]+:)*text-(?:${FAMILIES})-\d{2,3}(?:/\d{1,3})?(?![\w-])`, 'g');

  test('src/**/*.tsx', async () => {
    const { globSync } = await import('node:fs');
    const files = globSync('src/**/*.{ts,tsx}').filter((f) => !f.includes('test'));
    const offenders = files.flatMap((file) => {
      const hits = readFileSync(file, 'utf8').match(OFFENDER) ?? [];
      return hits.map((hit) => `${file}: ${hit}`);
    });
    // Use text-success / text-error / text-warning / text-info / text-brand.
    expect(offenders).toEqual([]);
  });
});
