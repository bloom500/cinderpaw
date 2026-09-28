# UI rebrand: handoff, 28 Sep 2026

For the next session (a cloud session that only sees this repo). Read this, then
`AGENTS.md`, then the spec. Nothing here is merged into `main`.

## Where the work is

Branch chain, each stacked on the previous:

| Branch | Head | What |
|---|---|---|
| `main` | cf82492 | base |
| `feat/rebrand-2026-09` | b5532f1 | logo trace, v3 clay mascot in Blender |
| `feat/ui-s1-foundation` | 0049db0 | slice 1: palette, OS theme default, Young Serif, Solid default |
| `feat/ui-s2-brand-logos` | 096eec4 | slice 2: 41 bundled brand logos, `<BrandLogo>` |
| `feat/ui-s3-sidebar` | this file | slice 3: sidebar + starred chats, plus the docs and design sources |

`feat/ui-s3-sidebar` contains everything above it. Continue from there, one branch per slice.

## What to read

- Spec (the contract): `docs/superpowers/specs/2026-09-27-app-ui-final-design.md`, 20 slices in section 12.
- Look: the canvas, exported to `docs/design/canvas/` (live: https://claude.ai/artifact/33TzhEqAGZjxuXJ1MPkXTN).
  Behaviour follows the spec, look follows the canvas. `docs/design/README.md` explains the files.
- Slice 1 plan and ledger: `docs/superpowers/plans/2026-09-27-ui-s1-foundation.md`,
  `.superpowers/sdd/2026-09-27-ui-s1-foundation/progress.md`.

## Gates that caught real mistakes (run them, do not trust the eye)

- `frontend-react/src/test/scale.test.ts`: no `text-[Npx]`, icon `size={}` only 12/14/16/20/28.
  The canvas uses 11.5/14/14.5 px; map to the scale (labels `text-2xs`, rows `text-sm`, wordmark `text-2xl`).
- `frontend-react/src/test/glass.test.ts`: every text tier over every ground, both wallpaper extremes.
  A new background token goes into its `GROUNDS` lists (see `--bg-side`).
- `frontend-react/src/test/palette.test.ts`: nothing before the last `@import` in `globals.css`
  (an `@font-face` above it once unstyled the whole app while every test passed).
- `SideNav.test.tsx` bans Memory/Connectors/Skills rows in the sidebar; that is a product rule.
- Before merge: `./scripts/verify.sh` (all stacks). Commands: `cd frontend-react && bunx vitest run`,
  `bunx tsc --noEmit -p .`.

## Spec tokens to CSS classes

`text-2` = `text-text-muted`, `text-3` = `text-text-disabled`, `surface` = `bg-bg-surface`,
`raised` = `bg-bg-elevated`, `side` = `bg-bg-side`, `active` = `bg-bg-active`,
`brand-text` = `text-brand`, `button` = `bg-brand` + `text-brand-foreground`, borders
`border-border-default` / `border-border-subtle`. On the sidebar ground `bg-bg-hover` is invisible in
light (same colour); use `hover:bg-text-primary/5`.

## Slice 3 decisions to keep

- The sidebar is flush (256 px, `border-r`), not the old floating glass card; its header carries
  `data-tauri-drag-region` because it covers that corner of the window's drag band.
- New chat is one click; New project sits behind the chevron beside it, because a fresh install
  has no PROJECTS heading to hang it on.
- Stars: `starredChats` in the persisted `stores/ui.ts`; Star/Unstar in `ConversationActions`, so it
  appears wherever a chat menu does. Pruned once, at the first successful non-empty list read: a
  failed read also ends with an empty list, and Undo after a delete must keep the star.

## Owed before merging slices 1-3

1. Darius looks at them in the running app (from this branch).
2. `./scripts/verify.sh` green.

Known test noise: `markdownBlocks.test.tsx` "at every point while it streams" times out (~7.5 s) in the
full parallel run and passes alone; it is on `main` since 874bd73 and unrelated to the UI work.
`DownloadStatus.test.tsx` once failed to load `react` on a cold run and passed on rerun.

## Next

Slice 4: conversation header + composer (Tools menu with Deep research / Think / Web search chips,
`reasoningMode`, `enabledTools`) + the mascot perch on the composer's top-right corner and its state
label (Agent Pulse, states from `useMascotState`). Read `docs/design/canvas/Main.dc.html` (the chat
half) and `Activity.dc.html` first. AGENTS.md: more than 3 files means ask Darius first.

## Open question: the mascot medium

`scripts/mascot/v3/` builds the clay character in Blender (`build_character.py`, headless ~40 s;
the `.blend` is made read-only after each build). Darius finds that pass stiff. On 28 Sep he brought
seven flat poses (`docs/design/moodboard/SVG/`) and the suggestion that an SVG character is easier to
animate than Blender frames. Not decided yet; the spec keeps the app side independent of it
(only `sheet.webp` / `frames.ts` change).

## Working with Darius

He is the product owner and is learning to read TypeScript. Write to him in Romanian, no em-dashes.
After each task, a short lesson on ONE TypeScript concept from that diff: he guesses first
(two or three options work best), then the explanation. Current concept: default parameter,
on `renderChatRows(items, withStar = false)` in `SideNav.tsx`.
