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

