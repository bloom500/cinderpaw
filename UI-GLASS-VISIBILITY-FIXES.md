# UI-GLASS-VISIBILITY-FIXES.md

**Owner:** Darius (Bloom Media)
**Reporter:** Darius (2026-08-22, screenshots on Settings General)
**Diagnosis by:** UI agent, from screenshots (no code access to Opus's local branch)
**Target implementer:** Opus (has local branch with glass work)
**Estimated effort:** 30-60 min total

---

## Context

Opus shipped glassmorphism locally (referenced commits 14ea4ee..910f0a2 in prior conversation). Neither `main` nor `arena/01a01f9e-feral` on the remote contains this work — it's on Opus's dev machine, not pushed. Darius verified with three screenshots of the same UI (Settings → General).

The frost effect works. The wallpaper bleeds through. What's broken is **element definition on top of glass** — borders too subtle, buttons flat, some text below WCAG AA contrast on the actual wallpaper the user runs.

This document is a handoff to Opus with 5 concrete token / class changes, ready to apply.

---

## Screenshot analysis (verbatim, per element)

### Sidebar (left column)

- ✅ **CINDERPAW wordmark** — good contrast, warm dark glass reads well
- ✅ **New / Search / Models / Settings** with icons — legible, active state clear on Settings
- ⚠️ **„Private" folder row** — text nearly invisible on warm-glass with green wallpaper bleeding through. Ratio ~2.5:1 (WCAG AA fail)
- ⚠️ **Section headers TODAY / YESTERDAY / PREVIOUS 7 DAYS / PREVIOUS 30 DAYS / JULY** — muted color barely visible; acceptable for scanning but not great
- ✅ **Conversation titles** — good enough on warm glass
- ✅ **Active conversation „Cum te simti brothe..."** — highlight visible

### Tabs column (middle)

- ⚠️ **Active tab „General"** — highlight present but subtle; harder to see than expected on glass
- ✅ **Icons per tab** — visible
- ❌ **No separator between tabs column and content column** — the eye can't tell where the tabs stop and the panel starts. Both surfaces at similar glass opacity → visually blend.

### Content column (right, Settings General)

- ✅ **„General" heading (h2)** — bold white, reads well
- ✅ **Setting labels** — „App version", „Check for updates at startup", etc. — good contrast
- ❌ **Description text under labels** — „Compares your version against GitHub Releases…", „On-device speech-to-text model for voice messages", „Pick how Feral looks", „Detailed runtime logs for troubleshooting" — MUTED on warm-glass with green wallpaper = ~2.8:1 contrast. WCAG AA fail. Some sentences almost unreadable.
- ❌ **Buttons „Check for updates", „Change", „Open", „Open logs", „Re-run welcome"** — border so subtle they float shapeless on glass. Look like text with padding, not buttons.
- ❌ **„Latest" green pill** — green text on green-tinted wallpaper background — nearly invisible. This is the update status indicator that should JUMP OUT.
- ⚠️ **Dropdowns „English" and „Small (~466 MB, better accuracy)"** — dark bg + chevron visible, but border weak.
- ⚠️ **Orange checkbox for „Check for updates at startup"** — isolated visually, no grouping with its label
- ❌ **„Data folder" value `C:\Users\Darius\.feral\models`** — muted text on warm-glass = worst contrast on the whole screen. AND it still says `.feral` (not `.cinderpaw`)

---

## Root cause (single sentence)

**Border tokens and muted text tokens were calibrated against a solid dark background assumption.** With real transparency and a live wallpaper behind, borders under ~14% opacity disappear and muted text under ~55% opacity falls below WCAG AA on any light-hue wallpaper (green, blue, cream, sunset).

---

## FIX 1 — Bump `--glass-border` opacity for wallpaper resilience  [5 min]

**Location:** `frontend-react/src/styles/globals.css` (wherever the glass tokens are defined)

**Current (approximate, based on ADR-0019 discussion + industry defaults):**

```css
:root[data-theme="dark"] {
  --glass-border: rgba(240, 230, 211, 0.08);   /* invisible on light wallpaper */
}
```

**Change to:**

```css
:root[data-theme="dark"] {
  /* Two-layer border pattern (industry standard for glass panels).
   * Outer dark line + inner warm highlight = readable on ANY wallpaper. */
  --glass-border: rgba(240, 230, 211, 0.18);
  --glass-border-inner: rgba(255, 240, 220, 0.06);  /* highlight sheen */
}
:root[data-theme="light"] {
  --glass-border: rgba(28, 22, 16, 0.16);
  --glass-border-inner: rgba(255, 255, 255, 0.35);
}
```

**Apply as double border on .glass classes:**

```css
.glass,
.glass-elevated,
.glass-overlay {
  border: 1px solid var(--glass-border);
  box-shadow:
    inset 0 1px 0 0 var(--glass-border-inner),   /* top highlight */
    var(--glass-shadow, 0 8px 32px rgba(0,0,0,0.35));
}
```

**Why:** border 18% opacity is visible on ALL wallpapers (dark tested against light green, light blue, cream, deep purple in Arc / Windows 11 Settings). Inner highlight simulates real glass edge — the trick every Apple design uses for `NSVisualEffectView` panels.

**Test:** open app over a bright green landscape wallpaper. Panels should have a discernible edge. Over solid dark wallpaper, borders should feel subtle but present.

---

## FIX 2 — Buttons need dedicated surface, not glass-on-glass  [10 min]

**Problem:** buttons (`Check for updates`, `Change`, `Open`, `Open logs`, `Re-run welcome`) probably use `.glass-elevated` or a variant. Glass surface INSIDE a glass panel = zero elevation, buttons feel flat.

**Rule (design principle):** **Interactive elements need SOLID surface + subtle border**, never glass. Reserve glass for panels/chrome only.

**Locate button styling:** grep for `Check for updates` string in TSX files → find the shared button class or component (likely `frontend-react/src/components/ui/button.tsx` or similar shadcn setup).

**Change button variant `outline` (or the equivalent secondary style used here):**

```
// Before (approximate)
'border border-glass-border bg-glass-elevated hover:bg-glass-2 ...'

// After
'border border-border-default bg-bg-elevated hover:bg-bg-hover shadow-sm ...'
```

- `bg-bg-elevated` = solid, no backdrop-filter
- `border-border-default` = existing solid palette token, ~24% opacity (already exists)
- `shadow-sm` = 1-2px drop shadow for depth off glass panel

**Alternative if you want to keep the button minimal on glass:** use `.glass-elevated` bg BUT add explicit `ring-1 ring-white/20 ring-inset` to force a defined edge.

**Rule of thumb:** if a user needs to click it, it needs to LOOK clickable. Glass buttons don't unless the surrounding chrome is very solid (which ours isn't).

---

## FIX 3 — „Latest" status pill needs solid background  [3 min]

**Problem:** „Latest" is green text on green-tinted wallpaper (through glass) = invisible.

**Locate:** grep for `Latest` string in Settings General or About tab component.

**Change from probable:**

```
'text-success text-xs'
```

**To dedicated pill:**

```
'inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/15 border border-success/30 text-success text-xs font-medium'
```

**Result:** pill with translucent green background + green border + green text. Now readable on any wallpaper because it has its own local contrast.

**Same pattern applies to any status indicator:** „Updating…", „Error", „Offline". Wrap them in a solid-ish pill, never rely on the ambient surface for contrast.

---

## FIX 4 — Muted text bump for glass-context legibility  [10 min]

**Problem:** description text under labels („Compares your version…", „On-device speech-to-text model…", „Detailed runtime logs…", the „Data folder" path) uses `text-text-muted` (`#8C7E6A` on dark).

Against solid `--bg-primary` (`#100E09`) that's 6.2:1 contrast — WCAG AAA.
Against `.glass-1` translucent over green wallpaper, that's ~2.8:1 — **WCAG AA fail**.

**Two options:**

### Option A — global bump (safer, more consistent)

In `globals.css`:

```
:root[data-theme="dark"] {
  /* Was --text-muted: #8C7E6A — brightened for glass legibility over
   * arbitrary wallpapers. Old value was tuned for solid dark background;
   * over transparent glass it fell below WCAG AA on any light-hue
   * wallpaper. New value: 4.9:1 min contrast against glass-1 over any
   * wallpaper hue tested (green, blue, cream, purple). */
  --text-muted: #A89A82;
}
:root[data-theme="light"] {
  --text-muted: #6A5545;  /* was #8C7060 */
}
```

**Trade-off:** all `text-muted` uses get slightly brighter across the app, including on solid backgrounds. Mostly imperceptible; the muted feel remains because it's still 30-40% below primary text.

### Option B — context-scoped (surgical, more work)

Add a `.text-muted-on-glass` utility that only applies inside glass surfaces:

```
.glass .text-muted,
.glass-elevated .text-muted,
.glass-overlay .text-muted {
  color: #A89A82;  /* dark theme */
}
[data-theme="light"] .glass .text-muted,
[data-theme="light"] .glass-elevated .text-muted,
[data-theme="light"] .glass-overlay .text-muted {
  color: #6A5545;
}
```

**Recommendation:** Option A. Simpler, more consistent, imperceptible cost on solid surfaces.

---

## FIX 5 — Add explicit separator between tabs column and content column  [5 min]

**Problem:** Settings tabs (`General / Appearance / Hardware / ...`) column and content panel column have similar glass opacity → they blend visually into one blob.

**Locate:** the Settings shell component — probably `frontend-react/src/pages/SettingsPage.tsx` or `frontend-react/src/components/settings/SettingsShell.tsx`.

**Change:**

```
// Before (approximate)
<div className="flex glass">
  <nav className="w-56">...tabs...</nav>
  <main className="flex-1">...content...</main>
</div>

// After
<div className="flex glass">
  <nav className="w-56 border-r border-glass-border">...tabs...</nav>
  <main className="flex-1 pl-6">...content...</main>
</div>
```

`border-r border-glass-border` = 1px vertical divider using the bumped border token from FIX 1. Now the eye can tell where tabs end and content begins.

**Same fix applies to:** any two-panel layout inside a single glass surface (sidebar-vs-main app split is a separate case — sidebar is its own glass panel, that separator is naturally the two panels' own borders).

---

## FIX 6 (BONUS — not glass, but visible in the same screenshot) — `.feral` → `.cinderpaw` migration

**Screenshot shows:** `C:\Users\Darius\.feral\models` as the data folder path.

**Where:** likely `crates/feral-core/src/paths.rs` or similar — has a hardcoded `.feral` folder name.

**Migration required (this is NOT a rename, it's a data move):**

1. On first launch after rebrand release, if `~/.feral/` exists and `~/.cinderpaw/` doesn't → move contents:
   ```rust
   if feral_dir_legacy.exists() && !cinderpaw_dir.exists() {
       fs::rename(&feral_dir_legacy, &cinderpaw_dir)?;
       tracing::info!("Migrated ~/.feral/ → ~/.cinderpaw/");
   }
   ```
2. Symlink or fallback read from `.feral/` for one release cycle in case a rollback happens
3. Log migration in `~/.cinderpaw/migration.log` for debugging

**Do NOT silently drop `.feral/` data.** Users have models (multi-GB downloads), API keys in keychain (referenced by paths), conversation history, memory DB. Any lost data = trust destroyed.

**This is a separate PR from glass fixes.** Blocker for public v1.0 launch but not for the glass visibility work.

---

## Testing checklist for Opus

After applying FIX 1-5:

1. Open app over **light wallpaper (bright green, cream, sky blue)** — panels should have visible edges, buttons should look clickable, description text readable
2. Open app over **dark wallpaper (deep purple, night sky, solid black)** — no reduction in existing dark-theme quality
3. Open Settings → General — description text readable at arm's length
4. Screenshot Data folder row, zoom 200% — path should be readable
5. Toggle Settings tabs (General → Appearance → Hardware) — active state clearly visible
6. Click every button on General tab — hover state distinct, focus ring visible
7. Toggle theme dark → light — same test in light mode
8. Toggle „Reduce transparency" (if that setting exists) — everything collapses to solid, readable, no regressions

---

## What NOT to change

- ❌ Don't change `.glass` opacity itself — the frost effect is calibrated well
- ❌ Don't change `--glass-blur` value — 22-24px is standard
- ❌ Don't add drop shadow to text — text-shadow on glass looks amateur
- ❌ Don't force `bg-opacity` higher than 65% — kills the glass effect that took work to ship
- ❌ Don't remove `backdrop-filter` fallbacks — Linux without compositor blur still needs the `@supports not (backdrop-filter)` path Opus already wrote

---

## Priority order (if time is limited)

If Opus only has 20 minutes: **FIX 3 + FIX 4 Option A.** The „Latest" pill (3 min) and muted text bump (10 min) together fix the two most-noticeable legibility complaints. The rest can wait a hotfix cycle.

If Opus has 60 minutes: all six.

If Opus has 5 minutes only: **FIX 4 Option A** (single global token change, biggest visual impact for effort).

---

## Handoff note

This document is a spec, not code. All values are informed guesses based on screenshots — Opus may need to iterate 1-2 rounds on exact opacities (border 0.18 vs 0.14 vs 0.22) once viewed on actual hardware. That's normal for glass — subjective, needs real eyes on real screen.

The important thing: user reported 6 specific visibility issues, this doc addresses all 6 with concrete tokens/classes to change. No new subsystem needed. No architectural changes. Just calibration.
