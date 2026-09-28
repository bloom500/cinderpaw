# UI slice 1: foundation (palette, theme, Young Serif, Solid) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app wears the rebrand: Paper and Charcoal grounds, the #B15129 button, warm text tiers, Young Serif available for display text, the theme following the OS on a fresh install, and the Solid window background as the default.

**Architecture:** Tokens only. Every component already paints through CSS custom properties in `frontend-react/src/styles/globals.css`, so changing the palette blocks re-skins the app without touching components. Two defaults move (theme `'dark'` to `'system'` in the store and the prepaint script; `window_solid` false to true in the Rust settings). Young Serif is vendored as woff2 files, like Geist is bundled, because the app's CSP allows fonts only from `'self'`.

**Tech Stack:** React 19 + Vite + Tailwind 4 (CSS-first `@theme`), Zustand, Vitest (pool `threads`), Rust (`cinderpaw-core` crate, serde).

**Spec:** `docs/superpowers/specs/2026-09-27-app-ui-final-design.md` (sections 3.1, 3.2, 3.5; slice 1 in section 12).

## Global Constraints

- Work in `D:/cp-rebrand` on branch `feat/ui-s1-foundation`, cut from `feat/rebrand-2026-09`. Never in `D:\Cinderpaw Agent` (Astra's branch).
- Palette (spec 3.1): Paper `#F6EFE6`, Charcoal `#2F2A26`, button `#B15129` with white text in both themes, brand text `#9A4421` on light and `#FF8A3D` on dark, active `#F2DDCC` light / `#4A3528` dark.
- Fonts (spec 3.2): Young Serif for display only, one weight (400), never bold or italic; Geist stays for all UI and running text.
- `frontend-react/src/test/glass.test.ts` is the contrast gate: every text tier must clear 4.5:1 over white and black wallpaper. A value that fails is adjusted, never the test.
- Fill and text stay separate tokens (`--brand` fills, `--brand-text` words).
- UI copy stays English. No em-dashes in comments or commit messages.
- A commit touches 3 files or fewer (AGENTS.md); each task below is one commit.
- Heavy runs starve Darius's running app: run only the test files named in a step; `./scripts/verify.sh` runs once, at the end, with his permission.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Fresh install, OS in light mode:** no `cinderpaw-ui` in storage, Windows set to light. Expect the first paint, the startup screen and the app to be Paper, never a dark flash. Pinned by Task 2's prepaint test and Task 1's prepaint-colour test.
2. **Returning user who picked dark:** stored `theme: 'dark'`. Expect dark, unchanged by the new default. Pinned by Task 2 (the existing "stamps the theme" test plus a dark case).
3. **Corrupt settings in storage:** expect the OS theme, not a hard-coded dark. Pinned by Task 2.
4. **Old `settings.json` with no `window_solid` key:** expect Solid (the new default), while a file that says `false` keeps Glass. Pinned by Task 4's Rust test.
5. **A name with Romanian letters in Young Serif** ("Ștefan"): expect the glyphs from the latin-ext file, not a fallback font mid-word. Pinned by Task 3's test that both subsets are declared.

---

### Task 0: Branch

- [ ] **Step 1: Cut the branch**

```bash
git -C D:/cp-rebrand status --short        # must print nothing
git -C D:/cp-rebrand switch -c feat/ui-s1-foundation feat/rebrand-2026-09
```

Expected: `Switched to a new branch 'feat/ui-s1-foundation'`.

---

### Task 1: The rebrand palette

**Files:**
- Create: `frontend-react/src/test/palette.test.ts`
- Modify: `frontend-react/src/styles/globals.css` (dark palette block from `:root[data-theme="dark"] {` near line 524; light palette block near line 673; the solid and no-backdrop-filter escape blocks near lines 1254 to 1296; the light pane near lines 1012 and 1049)
- Modify: `frontend-react/index.html` (the prepaint and startup-screen ground colours)

**Interfaces:**
- Produces: tokens later slices use by name: `--bg-primary`, `--bubble-user`, `--brand`, `--brand-hover`, `--brand-muted`, `--brand-foreground`, `--brand-text`, the four `--text-*` tiers, `--border-subtle`, `--border-default`.

- [ ] **Step 1: Write the failing test**

Create `frontend-react/src/test/palette.test.ts`:

```ts
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
    expect(dark['--brand-text']).toBe('#FF8A3D');
    expect(light['--bubble-user']).toBe('#F2DDCC');
    expect(dark['--bubble-user']).toBe('#4A3A30');
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd D:/cp-rebrand/frontend-react && npx vitest run src/test/palette.test.ts`
Expected: FAIL, e.g. `expected '#FAF6F0' to be '#F6EFE6'`.

- [ ] **Step 3: Change the dark palette block** (`:root[data-theme="dark"] {` near line 524)

Replace each value, keeping every comment:

| Token | Old | New |
|---|---|---|
| `--bg-primary` | `#1C1814` | `#2F2A26` |
| `--bubble-user` | `color-mix(in oklab, var(--brand) 26%, var(--bg-primary))` | `#4A3A30` |
| `--surface-typing` | `rgba(24, 21, 17, 0.94)` | `rgba(52, 46, 41, 0.94)` |
| `--bg-surface` | `rgba(28, 25, 22, 0.24)` | `rgba(54, 48, 43, 0.24)` |
| `--bg-elevated` | `rgba(37, 33, 25, 0.34)` | `rgba(58, 52, 48, 0.34)` |
| `--bg-hover` | `rgba(44, 40, 32, 0.46)` | `rgba(68, 60, 54, 0.46)` |
| `--bg-active` | `rgba(53, 48, 39, 0.58)` | `rgba(74, 53, 40, 0.58)` |
| `--border-subtle` | `#2C2820` | `#3F3732` |
| `--border-default` | `#3A342B` | `#4A413A` |
| `--text-primary` | `#EDE4D3` | `#F6EFE6` |
| `--text-secondary` | `#E6DCCB` | `#E6DACE` |
| `--text-muted` | `#DDD2BF` | `#CDBFB2` |
| `--text-disabled` | `#C2B7A5` | `#A8998C` |
| `--brand` | `#C4843A` | `#B15129` |
| `--brand-hover` | `#D4944A` | `#C65A2E` |
| `--brand-muted` | `#6B4820` | `#4A3528` |
| `--brand-foreground` | `#1C1814` | `#FFFFFF` |
| `--brand-text` | `#EC9E44` | `#FF8A3D` |

Replace the comment above `--bubble-user` (it says one definition serves both themes) with:

```css
  /* The user's bubble: the palette's `active` peach (light) and its dark twin,
     set per theme rather than mixed from --brand, because the button colour is
     now a deep ember and a quarter of it reads as a stain, not a bubble. */
```

- [ ] **Step 4: Change the light palette block** (`:root[data-theme="light"] {` near line 673)

| Token | Old | New |
|---|---|---|
| `--bg-primary` | `#FAF6F0` | `#F6EFE6` |
| `--bubble-user` | `color-mix(in oklab, var(--brand) 26%, var(--bg-primary))` | `#F2DDCC` |
| `--surface-typing` | `rgba(252, 248, 243, 0.95)` | `rgba(255, 253, 250, 0.95)` |
| `--bg-surface` | `rgba(245, 235, 224, 0.34)` | `rgba(251, 247, 241, 0.34)` |
| `--bg-elevated` | `rgba(255, 255, 255, 0.46)` | `rgba(255, 253, 250, 0.46)` |
| `--bg-hover` | `rgba(235, 224, 210, 0.58)` | `rgba(241, 232, 221, 0.58)` |
| `--bg-active` | `rgba(224, 208, 192, 0.70)` | `rgba(242, 221, 204, 0.70)` |
| `--border-subtle` | `#E8DCC9` | `#ECE1D5` |
| `--border-default` | `#D4C4B0` | `#E4D6C8` |
| `--text-primary` | `#1C1610` | `#2F2A26` |
| `--text-secondary` | `#2E251C` | `#4A3D34` |
| `--text-muted` | `#2B2119` | `#6F5747` |
| `--text-disabled` | `#5E5649` | `#7A5F4E` |
| `--brand` | `#925E22` | `#B15129` |
| `--brand-hover` | `#8B5820` | `#9A4421` |
| `--brand-muted` | `#E8D4B8` | `#F2DDCC` |
| `--brand-text` | `#834805` | `#9A4421` |

`--brand-foreground` stays `#FFFFFF`.

- [ ] **Step 5: Change the escape blocks** (the `@supports not (backdrop-filter …)` block near line 1254 and the solid / reduced-transparency block near line 1284)

Near-opaque block (no backdrop-filter):

```css
  :root[data-theme="dark"] {
    --bg-surface:  rgba(54, 48, 43, 0.96);
    --bg-elevated: rgba(58, 52, 48, 0.95);
    --bg-hover:    rgba(68, 60, 54, 0.97);
    --bg-active:   rgba(74, 53, 40, 0.98);
  }
  :root[data-theme="light"] {
    --bg-surface:  rgba(251, 247, 241, 0.97);
    --bg-elevated: rgba(255, 253, 250, 0.96);
    --bg-hover:    rgba(241, 232, 221, 0.98);
    --bg-active:   rgba(242, 221, 204, 0.99);
  }
```

Solid block:

```css
  :root[data-theme="dark"] {
    --bg-surface:  #36302B;
    --bg-elevated: #3A3430;
    --bg-hover:    #443C36;
    --bg-active:   #4A3528;
    --scene-surface: var(--bg-primary);
  }
  :root[data-theme="light"] {
    --bg-surface:  #FBF7F1;
    --bg-elevated: #FFFDFA;
    --bg-hover:    #F1E8DD;
    --bg-active:   #F2DDCC;
    --scene-surface: var(--bg-primary);
  }
```

Light pane: `html.has-window-effect[data-theme="light"] { --scene-surface: rgba(250, 246, 240, 0.35); }` becomes `rgba(246, 239, 230, 0.35)`, and the light scene block's `--scene-surface: rgba(255, 245, 238, 0.88);` becomes `rgba(246, 239, 230, 0.88)`.

- [ ] **Step 6: Change the first paint**

In `frontend-react/index.html` replace every `#1C1814` with `#2F2A26` and every `#FAF6F0` with `#F6EFE6` (the `html`, `body` and `#cinderpaw-startup` grounds):

```bash
cd D:/cp-rebrand/frontend-react
sed -i 's/#1C1814/#2F2A26/g; s/#FAF6F0/#F6EFE6/g' index.html
grep -nE "#1C1814|#FAF6F0" index.html   # expect no output
```

- [ ] **Step 7: Run the palette test and the contrast gate**

Run: `npx vitest run src/test/palette.test.ts src/test/glass.test.ts src/test/prepaint.test.ts`
Expected: all PASS.

If a `glass.test.ts` contrast case fails, it names the token and the measured ratio. Fix only that token: move its lightness 3% toward more contrast (light theme: darker, dark theme: lighter), keep the hue, rerun; repeat until it passes. Write the final value into the palette table of the spec (section 3.1) and into the commit body. Never change the test.

- [ ] **Step 8: Commit**

```bash
git add frontend-react/src/test/palette.test.ts frontend-react/src/styles/globals.css frontend-react/index.html
git commit -m "feat(ui): the rebrand palette, Paper and Charcoal with the ember button

Grounds #F6EFE6 / #2F2A26, button #B15129 with white text in both themes,
brand text #9A4421 / #FF8A3D, warm text tiers held by glass.test.
palette.test.ts pins the brand colours and that index.html's first paint
uses the same grounds.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The theme follows the OS on a fresh install

**Files:**
- Modify: `frontend-react/src/stores/ui.ts:163-178`
- Modify: `frontend-react/public/cinderpaw-prepaint.js:40-67`
- Modify: `frontend-react/src/test/prepaint.test.ts` and `frontend-react/src/stores/__tests__/ui.test.ts` (tests for the two defaults)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `useUI.getState().theme` defaults to `'system'`; the prepaint script resolves a missing or unreadable preference against `prefers-color-scheme`.

- [ ] **Step 1: Write the failing tests**

In `frontend-react/src/test/prepaint.test.ts`, add this helper under the imports:

```ts
/** jsdom has no matchMedia; stand in for the OS colour-scheme preference. */
function osPrefers(scheme: 'dark' | 'light'): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('dark') ? scheme === 'dark' : scheme === 'light',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}
```

Replace the test `falls back to dark when the persisted theme is corrupt` with:

```ts
  test('a fresh install follows the OS: light', () => {
    osPrefers('light');
    runPrepaint();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  test('a fresh install follows the OS: dark', () => {
    osPrefers('dark');
    runPrepaint();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  test('a corrupt preference falls back to the OS, not to a fixed theme', () => {
    osPrefers('light');
    localStorage.setItem('cinderpaw-ui', '{not json');
    runPrepaint();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  test('a stored choice still wins over the OS', () => {
    osPrefers('light');
    localStorage.setItem('cinderpaw-ui', JSON.stringify({ state: { theme: 'dark' } }));
    runPrepaint();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
```

In the existing `frontend-react/src/stores/__tests__/ui.test.ts` (it already imports `useUI`), add:

```ts
describe('theme default', () => {
  test('a fresh install follows the OS', () => {
    // The initial state, before any setTheme: what a stranger starts with.
    expect(useUI.getInitialState().theme).toBe('system');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/test/prepaint.test.ts src/stores/__tests__/ui.test.ts`
Expected: FAIL: the light cases get `'dark'`, and the store test gets `'dark'`.

- [ ] **Step 3: Change the prepaint fallback**

In `frontend-react/public/cinderpaw-prepaint.js`:

```js
  var THEME_KEY = 'cinderpaw-ui';
  var LEGACY_THEME_KEY = 'feral-ui';
  /* No preference stored, or one we cannot read: follow the OS, like the
   * store's own default. A fixed 'dark' here painted a light-mode stranger's
   * first frame dark. */
  var FALLBACK_PREF = 'system';
```

and in `readThemePref()` return `FALLBACK_PREF` in the three places that returned `FALLBACK_THEME`. Make the resolver safe where `matchMedia` is missing:

```js
  function resolveTheme(pref) {
    if (pref !== 'system') return pref;
    var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    return mq && mq.matches ? 'dark' : 'light';
  }
```

Update the header comment line that says the fallback is dark to say it is the OS preference.

- [ ] **Step 4: Change the store default**

In `frontend-react/src/stores/ui.ts`:

```ts
const getSystemTheme = (): ResolvedTheme =>
  window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
```

and in the store's initial state:

```ts
      theme: 'system',
      resolvedTheme: getSystemTheme(),
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/test/prepaint.test.ts src/stores/__tests__/ui.test.ts src/test/palette.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend-react/src/stores/ui.ts frontend-react/public/cinderpaw-prepaint.js frontend-react/src/test/prepaint.test.ts frontend-react/src/stores/__tests__/ui.test.ts
git commit -m "feat(ui): a fresh install follows the OS theme

The store defaulted to dark and the prepaint script fell back to dark, so a
stranger in light mode met a dark app. Both now resolve against
prefers-color-scheme; a stored choice still wins.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Young Serif, bundled

**Files:**
- Create: `frontend-react/src/assets/fonts/young-serif/young-serif-latin-400.woff2`, `young-serif-latin-ext-400.woff2`, `OFL.txt`
- Modify: `frontend-react/src/styles/globals.css` (after the Geist import at the top, and the `@theme` block)
- Modify: `frontend-react/src/components/shell/HomeGreeting.tsx:65`
- Test: `frontend-react/src/test/palette.test.ts` (extend)

**Interfaces:**
- Produces: the Tailwind utility `font-display` (from `--font-display` in `@theme`), used by slices 3, 11 and 12 for the wordmark, the greeting and setup titles.

- [ ] **Step 1: Write the failing test**

Append to `frontend-react/src/test/palette.test.ts` (add `existsSync` to the `node:fs` import and `import { resolve } from 'node:path';`):

```ts
describe('Young Serif', () => {
  const faces = [...CSS.matchAll(/@font-face\s*{[^}]*}/g)].map((m) => m[0]).filter((f) => f.includes("'Young Serif'"));

  test('is bundled for latin and latin-ext, from our own files', () => {
    expect(faces.length).toBe(2);
    for (const face of faces) {
      const url = /url\('([^']+)'\)/.exec(face)?.[1] ?? '';
      expect(url).not.toMatch(/^https?:/);
      expect(existsSync(resolve('src/styles', url)), url).toBe(true);
      expect(face).toMatch(/font-weight:\s*400/);
      expect(face).toMatch(/unicode-range:/);
    }
  });

  test('is exposed as font-display', () => {
    expect(CSS).toMatch(/--font-display:\s*'Young Serif'/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/test/palette.test.ts`
Expected: FAIL, `expected 0 to be 2`.

- [ ] **Step 3: Vendor the files**

```bash
cd D:/cp-rebrand/frontend-react
mkdir -p src/assets/fonts/young-serif
curl -fsSL -o src/assets/fonts/young-serif/young-serif-latin-400.woff2 https://cdn.jsdelivr.net/fontsource/fonts/young-serif@latest/latin-400-normal.woff2
curl -fsSL -o src/assets/fonts/young-serif/young-serif-latin-ext-400.woff2 https://cdn.jsdelivr.net/fontsource/fonts/young-serif@latest/latin-ext-400-normal.woff2
curl -fsSL -o src/assets/fonts/young-serif/OFL.txt https://raw.githubusercontent.com/google/fonts/main/ofl/youngserif/OFL.txt
curl -fsSL https://cdn.jsdelivr.net/npm/@fontsource/young-serif/index.css | grep unicode-range
```

The last command prints fontsource's two `unicode-range` values; they must equal the ones in Step 4 (if fontsource changed them, use theirs). Check the three files are non-empty (`ls -l`). If a download fails, stop and report; do not substitute another font.

- [ ] **Step 4: Declare the font**

In `globals.css`, directly after `@import '@fontsource-variable/geist' layer(base);`:

```css
/* Young Serif: display only (logo, greetings, page and document titles).
   One weight, no italic, so it never sets running text: a bold or italic
   Young Serif would be faked by the browser. Vendored under OFL like Geist is
   bundled, because the CSP allows fonts from 'self' only. */
@font-face {
  font-family: 'Young Serif';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('../assets/fonts/young-serif/young-serif-latin-ext-400.woff2') format('woff2');
  unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;
}
@font-face {
  font-family: 'Young Serif';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('../assets/fonts/young-serif/young-serif-latin-400.woff2') format('woff2');
  unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
}
```

(Ranges are fontsource's, read on 27 Sep from `@fontsource/young-serif/index.css`; Step 3's last command prints them again to confirm they still match.)

In the `@theme {` block, after the type scale:

```css
  /* Display face. `font-display` in markup; never with font-semibold/bold. */
  --font-display: 'Young Serif', Georgia, serif;
```

- [ ] **Step 5: Use it once, where a stranger sees it first**

`frontend-react/src/components/shell/HomeGreeting.tsx:65`: the heading's classes

```tsx
      <h1 className="mt-1 text-3xl leading-[1.2] font-semibold tracking-[-0.02em] text-text-primary">
```

become

```tsx
      <h1 className="mt-1 font-display text-3xl leading-[1.2] font-normal tracking-[-0.01em] text-text-primary">
```

(`font-normal` because Young Serif has no bold. Slice 11 swaps which line is the big one.)

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/test/palette.test.ts src/components/shell`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend-react/src/assets/fonts/young-serif frontend-react/src/styles/globals.css frontend-react/src/components/shell/HomeGreeting.tsx frontend-react/src/test/palette.test.ts
git commit -m "feat(ui): Young Serif bundled for display text

latin and latin-ext woff2 under OFL, exposed as font-display, first used on
the Home heading. One weight, so it is never set bold.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Solid is the default window background

Rust change: `tauri dev` may rebuild and restart Darius's running app. Ask him before Step 4.

**Files:**
- Modify: `crates/cinderpaw-core/src/settings.rs:99-103, 105, 124` and its `mod tests`
- Modify: `frontend-react/src/components/settings/AppearanceTab.tsx:24`

**Interfaces:**
- Produces: `Settings::default().window_solid == true`; a settings file without the key deserializes to `true`.

- [ ] **Step 1: Write the failing Rust test**

In `crates/cinderpaw-core/src/settings.rs`, inside `mod tests`:

```rust
    /// Solid is the product's default look. A file written before the key
    /// existed gets it too; a file that says `false` keeps the glass.
    #[test]
    fn window_solid_defaults_to_true_and_an_explicit_false_is_kept() {
        assert!(Settings::default().window_solid);

        let mut json = serde_json::to_value(Settings::default()).unwrap();
        json.as_object_mut().unwrap().remove("window_solid");
        let old: Settings = serde_json::from_value(json.clone()).unwrap();
        assert!(old.window_solid);

        json.as_object_mut().unwrap().insert("window_solid".into(), serde_json::Value::Bool(false));
        let glass: Settings = serde_json::from_value(json).unwrap();
        assert!(!glass.window_solid);
    }
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd D:/cp-rebrand && cargo test -p cinderpaw-core --lib window_solid_defaults`
Expected: FAIL at `assert!(Settings::default().window_solid)`.

- [ ] **Step 3: Change the default**

```rust
    /// Appearance: paint the app on its own solid background instead of the
    /// see-through window material. On by default since the Paper/Charcoal
    /// rebrand; Glass stays one click away in Appearance.
    #[serde(default = "default_window_solid")]
    pub window_solid: bool,
```

next to `default_rsi_budget`:

```rust
fn default_window_solid() -> bool { true }
```

and in `impl Default for Settings`: `window_solid: true,`.

- [ ] **Step 4: Run the Rust test**

Run: `cargo test -p cinderpaw-core --lib window_solid_defaults`
Expected: PASS.

- [ ] **Step 5: The Appearance tab reads the same default**

`frontend-react/src/components/settings/AppearanceTab.tsx:24`:

```tsx
  useEffect(() => { void tauri.settings.get().then((s) => setSolid(s.window_solid ?? true)).catch(() => setSolid(true)); }, []);
```

Update the comment above it: Solid is the default, Glass the option.

- [ ] **Step 6: Typecheck**

Run: `cd frontend-react && npx tsc --noEmit`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add crates/cinderpaw-core/src/settings.rs frontend-react/src/components/settings/AppearanceTab.tsx
git commit -m "feat(ui): Solid is the default window background, Glass the option

A fresh install and a settings file without the key get Solid; a file that
chose Glass keeps it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Verify and hand over

- [ ] **Step 1: The frontend gate**

Run: `cd D:/cp-rebrand/frontend-react && npx tsc --noEmit && npx vitest run src/test src/stores src/components/shell src/components/settings`
Expected: tsc silent, all listed tests PASS. Report any failure with its output; do not call the slice done.

- [ ] **Step 2: The full gate, with Darius's go-ahead**

`./scripts/verify.sh` compiles Rust and runs every suite; it starves his running app. Ask first, then run it and report the summary line of each stack.

- [ ] **Step 3: Darius looks at it in the real app**

Tell him how to start this branch (`D:/cp-rebrand`, `cargo tauri dev`), and ask him to check: light and dark (switch Windows theme), the Home heading in Young Serif, a primary button, the user bubble, Settings > Appearance showing Solid selected. No simulated shell.

- [ ] **Step 4: Lesson**

Per his CLAUDE.md: one concept from this diff, guess first. The owed concept 17 (default parameter) is first in line; `?? true` in `AppearanceTab.tsx` is `??` which he already holds, so it is a recognition check, not a new concept.
