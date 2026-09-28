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
| `feat/ui-s3-sidebar` | 9b220c6 | slice 3: sidebar + starred chats, plus the docs and design sources |
| `claude/rebrand-spec-f87jrk` | this file | slice 4 (4a Tools menu + chips, 4b header, 4c perch + Agent Pulse) slice 5 (5a message shapes, 5b logo head, 5c artifact card) slice 6 (6a Activity Strip, 6b helpers + chips) slice 7 (7a `show_widget` in the sidecar, 7b the seven renderers) and slice 8 (image cache, real card pictures) |

`claude/rebrand-spec-f87jrk` contains everything above it. Continue from there, one branch per slice.

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

## Owed before merging slices 1-8

1. Darius looks at them in the running app (from this branch).
2. `./scripts/verify.sh` green.

Known test noise: `markdownBlocks.test.tsx` "at every point while it streams" times out (~7.5 s) in the
full parallel run and passes alone; it is on `main` since 874bd73 and unrelated to the UI work.
`DownloadStatus.test.tsx` once failed to load `react` on a cold run and passed on rerun.

## Slice 4 decisions to keep (28 Sep)

- The Tools menu is Chat mode only. Agent mode sends through the sidecar, which picks its own
  tools and takes no per-message switch (`cinderpaw_send_message` carries temperature and
  max_tokens only), so a menu there would do nothing. Deep research is left out for the same
  reason. Adding them means a per-message field through Rust and the sidecar: ask Darius first.
- Think is `reasoningMode`: on = `auto`, off = `off`, hidden when `modelSupportsThinking` is false.
  The two settings stay unpersisted (see the comment in `stores/ui.ts`).
- The Call button stays in the composer, not the header: the call's state lives in `ChatInput`
  and `useCallSession.ts` is on AGENTS.md's do-not-touch list.
- Agent Pulse reads the turn (`baseState`, `agentTool`, a cowork entry with `approval` in
  `toolCallStream`), never the pose. Mapping in `mascot/pulse.ts`.

## Slice 5 decisions to keep (28 Sep)

- User bubble: the canvas's 20 20 6 20 on the radius steps (`rounded-2xl rounded-br-sm`), no tail.
  `BubbleTail.tsx` stays: `CoworkTranscriptPanel` still uses it. Replies are `text-base` (15 px).
- The logo head (`ReplyHead` in `MessageItem.tsx`) is decided in `MessageList`: after the latest
  assistant message only, `writing` while streaming, `still` once there is content, none for an
  empty reply. Before the first token it is `StreamingIndicator`'s icon instead (new `icon` prop).
- Hover actions and the time beside them already met the spec; nothing changed there.
- Artifact card (`ArtifactCard.tsx`): finished artifact tools only; running or failed stay tool rows.
  Thumbnails are NOT done: the artifacts store can only read an artifact by opening it (`wanted`),
  so a thumbnail needs a read that does not replace what the panel shows.

## Screenshots without the desktop app

Darius cannot always run the app. `bunx vite --port 5199` in `frontend-react`, then Playwright
(Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` in cloud sessions) with an init
script that defines `window.__TAURI_INTERNALS__` (`invoke` returning a completed
`get_onboarding_record`, `[]` for `load_*`/`list_*`, null otherwise; `transformCallback`,
`metadata`) and `__TAURI_EVENT_PLUGIN_INTERNALS__`, and sets `cinderpaw.alphaNotice=never` and
`cinderpaw.whatsNew.seen` in localStorage. Seed state from the page with
`(await import('/src/stores/chat.ts')).useChat.setState(...)`: Vite serves the same module
instance the app uses. A screenshot is a preview, not the "Darius sees it in the running app" gate.

## Slice 6 decisions to keep (28 Sep)

- The strip is `MessageChain.tsx`, restyled in place (same props, same open/fold rules), one card per
  tool group of the timeline, as on the canvas. The vendored `ai-elements/chain-of-thought.tsx` was
  removed (no other user). Words per step: `stepTitle` / `stepDetail`; time: `workedSeconds`
  (null, shown as "Worked", when a step has no `endedAt`).
- No progress bar: the stream has no step total, so a bar would be made up.
- Helpers (`rlm()` workers) belong to the session and run after the reply that started them, so only
  the latest reply's last strip (`head` set in MessageItem) gets them. Open question for Darius:
  WorkersCard still lists the same helpers above the composer (with answers); the spec keeps the
  answers there, but the duplicate lines could go.

## Slice 7 decisions to keep (28 Sep, go-ahead from Darius for more than 3 files)

- Sidecar `src/tools/builtin/show-widget.ts`: validates per kind; bad data is `ok: true` with
  `data.kind = "list"` (every string of the input as lines), never an error. In `ALWAYS_TOOLS`,
  documented in `PRODUCT.md`, copied by hand into `CORE` in `tool-intent.test.ts` (its own rule).
- `todo_write` add/set/remove now also return `data.items` (the whole list).
- App: `lib/widgets.ts` re-reads the data (`parseWidget`, `widgetOf`), `ToolActivity.widget` is
  optional so older rows load, `ChatWidget.tsx` draws the kinds. In a reply, every show_widget and
  only the LAST todo_write plan are drawn in place of their step (`drawn` in MessageItem).
- Card and column images are never loaded yet: a warm placeholder until slice 8's image cache.

## Slice 8 decisions to keep (28 Sep, go-ahead from Darius, plus "real pictures in cards")

- No Rust code. The cache is the sidecar's `src/tools/image-cache.ts` (`cacheImage`, through
  `ctx.fetch`, https, raster by magic bytes, never SVG, 2 MB each, 200 MB total, oldest pruned),
  files at `<profile>/cache/images/<sha256[:40]>.<ext>`. `pagePreviewImage` reads a page's
  og:image / twitter:image / image_src. `show_widget`'s `attachImages` gives cards (named image, or
  the linked page's preview) and table columns a kept file as `imageFile`.
- The app shows `imageFile` with `convertFileSrc`; `tauri.conf.json` gained the cache folder in the
  asset scope and `asset: http://asset.localhost` in img-src. A config change: Darius's dev app needs
  a restart to pick it up. The scope is `$HOME/.cinderpaw/...` like voice, so a custom
  `CINDERPAW_HOME` shows placeholders. `lib/widgets.ts` accepts only a hash-named cache file.
- Favicons for source chips and the Context drawer (7.1) can reuse `cacheImage` when those slices land.
- `PRODUCT.md` has a 20 KiB cap (`product-info.test.ts`); slice 7a's paragraph had crossed it, cut here.

## Next

Slice 9: source chips + pasted-text card + drop overlay (spec 6). Frontend only.

## Open question: the mascot medium

`scripts/mascot/v3/` builds the clay character in Blender (`build_character.py`, headless ~40 s;
the `.blend` is made read-only after each build). Darius finds that pass stiff. On 28 Sep he brought
seven flat poses (`docs/design/moodboard/SVG/`) and the suggestion that an SVG character is easier to
animate than Blender frames. Not decided yet; the spec keeps the app side independent of it
(only `sheet.webp` / `frames.ts` change).

## Working with Darius

He is the product owner and is learning to read TypeScript. Write to him in Romanian, no em-dashes.
After each task, a short lesson on ONE TypeScript concept from that diff: he guesses first
(two or three options work best), then the explanation. Done: default parameter,
on `renderChatRows(items, withStar = false)` in `SideNav.tsx`. Current: `?.` and `??`, on
`s.cloudModel?.modelId ?? s.loaded?.name ?? ''` in `ToolsMenu.tsx` (asked 28 Sep, answer pending).
