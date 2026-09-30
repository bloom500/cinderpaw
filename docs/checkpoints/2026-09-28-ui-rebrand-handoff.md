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
| `claude/rebrand-spec-f87jrk` | this file | slice 4 (4a Tools menu + chips, 4b header, 4c perch + Agent Pulse) slice 5 (5a message shapes, 5b logo head, 5c artifact card) slice 6 (6a Activity Strip, 6b helpers + chips) slice 7 (7a `show_widget` in the sidecar, 7b the seven renderers) and slice 8 (image cache, real card pictures) slice 9 (9a source chips, 9b pasted-text card, 9c drop overlay) slice 10 (10a `memory_used` in the sidecar, 10b Memory Peek) slice 11 (Home) slice 12 (Connect step) slice 13 (approval cards) slice 14 (14a Context tab, 14b Artifact Dock, 14c follow-up chips) and slice 15 (15a error card, 15b Dreaming card, 15c Coworker Strip) |

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

## Owed before merging slices 1-15

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

## Slice 9 decisions to keep (28 Sep)

- Sources: `lib/sources.ts` (`normalizeUrl`, `sourcesOf`, `citedSources`) and `chat/Sources.tsx`.
  Markdown's `a` is `SourceAwareLink`, which reads the reply's hits from `SourcesContext` (set in
  MessageItem), so `COMPONENTS` stays a module constant. The "Sources" list holds only the results
  the answer cited, never every hit.
- Pasted text: `isLongPaste` / `pastedText` in `AttachedFileChip.tsx`; the card is an ordinary text
  attachment with a `clipboard://pasted-` path, so `buildUserContent` sends it in full on both paths.
- Drop: one overlay in `ChatPage` (`dropping` state); the composer's own words were removed, its
  dashed edge stays.

## Slice 10 decisions to keep (28 Sep)

- Sidecar: `RecallResult.used` (`MemoryUsed` in `memory/recall.ts`) lists what the injected block
  holds; facts carry their mirrored graph edge (`#mirrorEdge`) for `memory_forget`. Filled by
  RecallEngine and the fractal path (`knownFactsDetailed`). The loop emits `memory_used` for items
  that survived `CINDERPAW_RECALL_INJECTION_MAX_CHARS`. `fractal-recall.test.ts` pins the key set.
- `memory_used` is in the Rust outbound list; `memory_notes` was added to Rust's inbound list in the
  same commit, which made `protocol_drift` green again (it was red on main since 3a30c69).
- App: `ChatMessage.memoryUsed`, set live by `useCinderpaw` only while the chat is on screen, and
  NOT persisted (the saved message shape has no field for it). `MemoryPeek.tsx` also lists a recall
  tool's `facts` (no Forget: they are sentences, no edge).

## Slice 11 decisions to keep (28 Sep)

- `--text-display` (56/64) was added to globals.css for the home greeting (spec 3.2 display step);
  below `sm` it falls back to `text-3xl`. The rotating day line (`homeLines`) stays, as the quiet
  second line: it is what "What can I help you with?" became before the spec.
- Intents are cards (label via `aria-label`, hint keys `home.intent.*.hint` in i18n); `SUGGESTIONS`
  in HomeIntents.tsx. Both only fill the composer.
- `saveUserName` in stores/onboarding.ts persists only when `hasOnboardedBefore`.

## Slice 12 decisions to keep (28 Sep)

- `components/onboarding/ConnectStep.tsx`, step 3 of 6 (`STEP_IDS` gained `connect`). `TOOL_IDS` and
  `CHAT_IDS` name the cards and their order; other transports sit behind "N more"; `coming_soon`
  ones are never shown.
- "+" opens a dialog with the Settings forms (`CatalogCard` from ExtensionsPage, `ConnectorCard`
  from ConnectorsPage, both now exported), so connecting here is real.
- Google Docs is shown without a button: `google.connect()` opens consent in the Browser panel,
  which the wizard covers.

## Slice 13 decisions to keep (28 Sep)

- `ApprovalCard.tsx`, rendered by MessageList for `coworkTranscript` approvals whose `threadId` is
  the `activeThreadId`. The Cowork panel no longer lists approvals (its tests moved to
  ApprovalCard.test). `CoworkExchange.outcome` tells a denial from an expiry.
- Only cowork approvals exist on the desktop: the app has no handler for the sidecar's `tool_request`,
  so there is no class-less tool-approval card yet.
- GOTCHA: `cn()` is plain tailwind-merge, which does not know the custom sizes (`text-micro`,
  `text-2xs`, `text-display`) and drops them when a text colour follows in the same `cn()`. Put the
  size outside `cn()` in that case (see the ApprovalCard badge), or teach `cn` with
  `extendTailwindMerge` in its own change.

## Slice 14 decisions to keep (28 Sep)

- The side panel has tabs Artifacts | Context (`panelTab` in stores/artifacts.ts; a new artifact on
  screen switches back to Artifacts). The Browser keeps its own panel until slice 18; the canvas's
  third tab is not drawn yet. The Context tab opens from a button in ChatHeader ("Chat context").
- `lib/chatContext.ts` reads the chat's messages: files (the `[File: ]` markers), sources (only the
  hits a reply cited, plus `read_webpage`/`fetch_url` pages), memories (Memory Peek's two sources),
  artifact ids (newest first). Pending approvals come from coworkTranscript, and ApprovalCard is
  reused there, so a request can be answered from the chat or from Context. Tools: the Chat mode
  switches (`SwitchRow`/`CHAT_TOOLS` exported from ToolsMenu); Agent mode says it picks its own.
- Favicons use LinkChip's `SiteIcon` (the site's /favicon.ico, then DuckDuckGo), not the image cache.
- Dock: the Artifacts list puts this chat's artifacts first ("In this chat", large cards, "Document,
  12 KB", Export, Open), the rest under "Everything else". No thumbnails, no page counts (nothing
  reads them yet); Export is the only download on the desktop, so there is no second button.
- Follow-ups: `show_widget` kind `followups` with its own `next: string[]` (1-4, 80 chars), so the
  schema stays strict. Not drawn in place, not a step; `FollowUps.tsx` under the LATEST finished
  reply only (`onFollowUp` from ChatPage through MessageList), a chip fills the composer.
- verify.sh in the cloud session: agent tests + tsc, React tests + tsc, TUI tests + build green. The
  web-app step fails (bun 1.3.11 cannot read `web-app/bun.lock` v2) and `cargo check` cannot build
  here (no `gdk-3.0` in the container). Slice 14 touches neither web-app nor Rust; run the full
  script on Darius's machine before merging.

## Darius on the Browser (28 Sep)

The Browser keeps working exactly as it does today; its look may change, its behaviour may not.
Slice 18 (spec 12: "Browser: tabs, agent badge, page summary; voice pill; done toast") must stay
within that: restyle and add the summary button, but keep its own panel, wide mode and navigation
as they are. Ask him before folding it into the side panel's tabs.

## Slice 15 decisions to keep (28 Sep)

- Error card: `humanizeError` has a `title` per rule; the card adds "Your message is safe, nothing
  was lost." after the message (the turn stays in the chat; Try again resends it).
- Dreaming card: `components/layout/DreamingCard.tsx`, last thing in the sidebar, only while
  `useDream().dreaming`. Words per stage; the bar is the stage's place among the five that fire.
  The start toast was removed (the card replaces it); the end-of-cycle summary toast stays.
- Coworker Strip: `lib/coworkStrip.ts` (`stripTeammates`) + `CoworkerStrip.tsx`, above the
  transcript in ChatPage. Counts only live exchanges (`startedAt`), one card per teammate (running
  beats an older answer). `seenAnswers`/`markSeen` in coworkTranscript, not persisted; an answer is
  marked read when its popover closes after View answer. Same clay for every teammate for now.
- The floating CoworkTranscriptPanel is unchanged, so an answer can show there and in the strip.

## Next

## Slice 16 decisions to keep (28 Sep, local session, branch `feat/ui-s16-settings`)

Done on Darius's machine, not in the cloud: `feat/ui-s16-settings` is stacked on 9bb941d.
Pull it before slice 17 or the two histories fork.

- Team (`TeammatesSection.tsx`): cards with Working (a running exchange addressed to the teammate
  in `coworkTranscript`) or Idle; "Can use" stays on the card (a teammate with `tools: null` can
  do anything). Message and "Add a teammate" open a NEW chat with words in the box: ChatPage
  reads `location.state.compose` once and clears it. The canvas's second "New teammate" header
  button was left out (the Add card does the same). The Settings entry is "Agent and team".
- Appearance: theme cards draw Paper/Charcoal with fixed hex (the preview must not follow the
  current theme). "follows Windows" names the OS from the user agent. `chatFont` ('geist' |
  'system', persisted) sets `fontFamily` on the message column in MessageList only.
- Memory: the category is not in the graph. `memory_notes_result` gained `categories` (node id
  -> semantic category) from `semantic.all("")`; no new message, no Rust. Projects = goal,
  decision, commitment, event; everything else, and no category, is Fact. Tiers and count tiles
  are gone; Notes and Dreams stay. Until the sidecar is rebuilt, every row reads Fact.

## Slice 17 decisions to keep (28 Sep, local, branch `feat/ui-s17-palette` on top of s16)

- `lib/commands.ts` is the one list of the six named commands; SearchOverlay and
  useGlobalHotkeys both run them. Keys: Ctrl N, Ctrl Shift A (new chat with "Create "),
  Ctrl B (browser; not inside a contenteditable, where the editor's bold wins), Ctrl M
  (Models; Ctrl on every OS because Cmd+M minimises on a Mac), Ctrl ,. Search memory
  opens Settings > Memory and has no key. The old "Models" palette row is folded into
  Switch model; slice 19 may point Switch model at the new switcher instead.
- Browsing (nothing typed) shows the six under CREATE / EXPLORE / CONFIGURE, then RECENT.
  Enter on an empty field runs New chat.

## Context and Dock look (28 Sep, same branch, 1e2330d)

Slice 14 built them without an artboard, so they kept the old shell; Darius sent a Context
board (tabs All/Files/Links/Memory with counts, search, grouped rows with tiles, "+ Add",
"..." menus). Built to it, keeping only rows with data: no "Current file", no filter button.
"+ Add" fills the composer (files via the dialog + `attachPaths`, "Read this page: ",
"Remember that "). The panel-level Artifacts/Context underline tabs stay above the heading.

## Slice 18 decisions to keep (28 Sep, local, `feat/ui-s18-browser`)

- Browser: the agent bar keeps floating over the toolbar (a row of its own reflowed the page on
  every action, 17 Sep); it gained the head and Stop (`requestCinderpawStop()` with no session:
  the browser event carries none, and Stop must stop what drives the page). No Stop while paused.
  "Summarize this page" fills the composer with the address (opens the drawer in wide mode); the
  summary is the reply. NOT built: a summary card inside the panel, and the head peeking over the
  page (the page is a native view and paints over React).
- Call pill: look only, Charcoal fixed hex in both themes, head, a breathing Flame waveform (no
  audio level reaches the pill). useCallSession.ts untouched.
- Done toast: a `success` toast with an `action` is drawn as the canvas's done toast. Its trigger
  is new: an artifact `created` off screen (other chat, Telegram, call) pushes "<title> is ready"
  with Open (panel + `router.navigate('/chat')`, router imported late; tests mock `@/router`).

## Slice 19 decisions to keep (28 Sep, local, `feat/ui-s19-model-roles`)

- `lib/modelRoles.ts` (types, ROLES, `resolveRole`, `sameModel`); `roles` persisted in
  `stores/model.ts`. Defaults: Primary = the model answering now, Local = first chat model on
  disk; Fast/Deep empty until chosen. Nothing routes on roles; Brain Stack stays the router.
- The pill's menu is the Model Switcher; the old Local/Cloud list is behind "All models".
  Empty roles have their own "Choose a model" / "Download a model" button: a row press never
  leaves the chat (22 Sep complaint). Models page gained a Roles tab (`RolesTab.tsx`).

## Slice 20 decisions to keep (28 Sep night, local, `feat/ui-s20-projects`)

Darius chose "write now, verify after" (cargo would fight his running dev build).

- No per-message field after all: a chat's session id IS its conversation id, and the sidecar
  reads `projects.json` itself each turn (`CinderpawAgent/src/projects.ts`), into a WorkingMemory
  project slot on the system prompt. Chat mode adds the same block (`lib/projectPrompt.ts`).
- Files are copied to `<profile>/workspace/projects/<id>/`: the sidecar's self-protection wall
  denies every other path under the profile, so a copy anywhere else could never be read.
- `save_project` takes `instructions` / `files` as `Option`: left out, the stored values stay
  (every old caller only renames or moves chats). New commands `project_add_file`,
  `project_remove_file`; count 193.
- **OWED before merge:** `cargo test -p cinderpaw` (projects tests + command count) with his app
  closed; then his look. Moving D:/cp-rebrand onto this branch touches `src-tauri/`, so the
  running `cargo tauri dev` rebuilds and restarts his app: do it only when he says.

All 20 slices are written. Then: the micro-management list (memory `micro-management-list-after-slices`).

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
Next after it: the type predicate `(r): r is ArtifactRow => !!r` in the Dock (`ArtifactsPanel.tsx`),
asked 28 Sep with slice 14.
