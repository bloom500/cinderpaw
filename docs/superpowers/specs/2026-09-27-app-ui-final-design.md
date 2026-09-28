# Cinderpaw app UI, final design

Date: 27 September 2026. Status: approved by Darius (27 Sep, section 14). Slices 1 to 3 built 27-28 Sep; state and next
steps in `docs/checkpoints/2026-09-28-ui-rebrand-handoff.md`. A copy of the canvas lives in
`docs/design/canvas/`, the moodboards in `docs/design/moodboard/`.

Design source: the Design canvas "Cinderpaw UI final",
https://claude.ai/artifact/33TzhEqAGZjxuXJ1MPkXTN (13 artboards). The canvas is the picture;
this file is the contract. Where they disagree, this file wins and the canvas gets fixed.

Inputs: Darius's five AI moodboards (`Desktop\Cinderpaw Moodboard\`: 204996bf dashboard,
ae5fc52e "Plan launch tasks" light, e81cb049 the same in dark, d2a86ea2 "Hey Darius" hero,
0d29dc85 brand and onboarding), ten component boards (`Desktop\Cinderpaw Moodboard\Components\`,
section 7.5), and the 27 Sep rebrand decisions (logo, palette, fonts, clay mascot).

## 1. What this is for

Cinderpaw should feel as calm and comfortable as the Claude app, so people stay because it is
good. Three tests apply to every screen below:

1. **Cozy.** One reading column, few choices on screen, nothing moves unless something happened.
2. **Nothing fake on a stranger's screen.** Every button does something today. No feature is drawn
   that the product does not have. The moodboards' old model names, people photos, Share button,
   tasks with owners, and permanent CPU/token meters are out for that reason.
3. **Works on a machine that was never set up.** Every screen has a first-run state (section 11).
   The full states on the canvas are the second thing a stranger sees, not the first.

## 2. Decisions already taken (by Darius, 27 Sep)

| Topic | Decision |
|---|---|
| Skeleton | Calm (moodboard 2): sidebar, one reading column, right panel only on demand. Not an always-on activity rail. |
| Sidebar | Today's rows, restyled. Memory and Connectors stay in Settings; the SideNav test that bans them stays. |
| Right panel | Tabs: Artifacts, Browser, Context. Context exists for every chat (section 7.5). |
| Brand logos | Every company shown in the UI (Google, Notion, GitHub, Slack, OpenRouter, ...) uses its official logo, bundled locally as SVG (section 3.6). |
| "What is it doing now" | One system, not five: the Activity Strip in the message, the state on the composer mascot, the Coworker Strip only with active teammates (section 7.5). |
| Fonts | Young Serif for the logo, greetings, page and document titles. Geist for everything else, replies included. Young Serif has one weight and no italic, so it never sets running text. |
| Widgets | All four groups: chat widget kit, Connect your world, agent activity, small details. |
| Claude-style additions | All: head at the end of the latest reply, one Tools button, sources in answers, pasted-text card, name in greeting, chat font setting, starred chats, model roles (8), projects with instructions and files. |
| Theme | Follows the OS by default. Light = Paper, dark = Charcoal. |
| Mascot | Head icon for small places; full clay body perched on the composer. The 3D rework is a separate task and not part of this spec. |
| Voice call | Stays its own panel (24 Sep ruling). Only the pill is restyled. |
| Language | UI stays English this release. |

## 3. Foundations

### 3.1 Colour tokens

Every text pairing below is measured, not picked by eye. `frontend-react/src/test/glass.test.ts`
remains the gate and is updated to these values.

| Token | Light | Dark | Use |
|---|---|---|---|
| bg | #F6EFE6 (Paper) | #2F2A26 (Charcoal) | page |
| side | #F1E8DD | #28231F | sidebar, right panel |
| surface | #FBF7F1 | #36302B | cards |
| raised | #FFFDFA | #3A3430 | composer, open document |
| border | #E4D6C8 | #4A413A | card edges |
| border-soft | #ECE1D5 | #3F3732 | dividers |
| text | #2F2A26 | #F6EFE6 | primary text (12.4:1) |
| text-2 | #6F5747 | #CDBFB2 | secondary (5.9:1 / 7.9:1) |
| text-3 | #715848 | #B5A89D | labels, hints (5.2:1 / 5.1:1) |
| active | #F2DDCC | #4A3528 | selected row, user bubble, icon tiles |
| brand-text | #9A4421 | #FF934C | text on `active` (B15129 there is only 3.9:1) |
| link | #B15129 | #FF8A3D | links, active tab line (4.5:1 / 6.1:1) |
| button | #B15129 | #B15129 | primary button fill, white text (5.2:1) |
| ember | #C65A2E | #C65A2E | chart bars, progress fills (not text) |
| ok / ok-bg | #3F7A4A / #E1ECDB | #8FC79A / #34402F | done ticks, "Connected" |

Slice 1 (27 Sep) moved three values one to two 3% lightness steps after `glass.test.ts` measured them
in Glass mode over a white or black wallpaper: text-3 #7A5F4E to #715848 (was 4.23:1), text-3 dark
#A8998C to #B5A89D (was 3.79:1), brand-text dark #FF8A3D to #FF934C (was 4.46:1). The link row keeps
#FF8A3D until the slice that adds the link token measures it.

Orange is for actions and progress only. Fill and text stay separate tokens (existing convention).

### 3.2 Type

Geist for UI and replies: replies 15.5/25, UI 13 to 15, labels 11.5 uppercase with 0.08em
tracking. Young Serif: logo 24, home greeting 56/64, setup titles 48/56, document titles 26/32.
The existing nine-step scale in `globals.css` is kept; Young Serif sizes are added as display steps.
Young Serif is bundled locally like Geist (the app's CSP allows `font-src 'self' data:` only).

### 3.3 Shape and depth

Radii keep the three existing steps (6 / 10 / 18) plus 24 for the composer and pill-shaped chips.
Light shadows are warm and faint (`0 10px 30px rgba(70,45,25,.07)`); dark keeps the current recipe.

### 3.4 Motion

- Nothing moves unless something happened. No idle bobbing, no looping shimmer on static text.
- Transitions are fades and short slides, 150 to 200 ms.
- The mascot idles quietly and acts on events (a reply starts, a tool runs, a task finishes).
- `prefers-reduced-motion` turns every animation into a cut, the mascot included.

### 3.5 Theme and window

`stores/ui.ts` default `theme` changes from `'dark'` to `'system'` (the type already allows it).
Window background: **Solid** becomes the default for the Paper look; Glass stays as an option in
Appearance.

### 3.6 Brand logos

Any company or product named in the UI (connectors, model providers, Google Docs export, MCP
presets, the Models page) shows its official logo. Logos are SVG files bundled in the app, one
folder, one lookup keyed by the same id the connector or provider already uses, so nothing is
fetched at runtime (the MCP presets link `favicon.ico` URLs today; those are replaced). Source per
logo, in order: the company's own brand or press kit, then Simple Icons (CC0 artwork) where the
company has no kit. Each brand's guidelines apply: original colours, no recolouring, no distortion,
clear space kept; a monochrome version only where the guidelines allow one. A company with no logo in
the folder falls back to a neutral monogram tile, never a broken image. Web sources in the Context
drawer and source chips use the site's favicon, loaded through the engine's image cache (7.1).

## 4. Shell

**Sidebar (256 px).** Logo head + "Cinderpaw" in Young Serif, collapse button. "New chat" row on
`active` with the Ember plus and `Ctrl N` hint (the New menu keeps "New project"). Rows: Search
(`Ctrl K`), Artifacts, Browser, Models, Settings. Then STARRED, PROJECTS, and dated groups
(TODAY, YESTERDAY, ...). Collapsed still means gone.

**Starred chats.** A star in each chat's row menu. Stored as a list of ids in the persisted UI store
(per machine); a starred id whose chat was deleted is dropped when the list loads. The section is
hidden when empty.

**Conversation header (60 px).** Title + rename chevron, the project name when there is one,
then on the right: Call and More. Teammates at work appear in the Coworker Strip under the header
(7.5); the chat's own activity lives in the Activity Strip.

**Composer.** Rounded 24, `raised`, faint shadow. Row: Attach, Agent/Chat mode (exists), **Tools**,
spacer, model pill, Voice message, Send/Stop. The Tools button opens one menu of switches:
Deep research, Think, Web search, and the chat-mode tool list that exists today (`enabledTools`).
A switch that is on appears as a small chip in the row (the canvas's Activity board shows
"Deep research" on). Think maps to the existing `reasoningMode` (`auto` / `on` / `off`); it is
hidden for a model that cannot think (`modelSupportsThinking`).

**Mascot perch.** The clay body stands on the composer's top-right corner (the left is where the
greeting and text sit). Home shows the wave, chat shows idle and the states `useMascotState` maps.

## 5. Home

Greeting in Young Serif: "Good evening, Darius" using `userName` from onboarding (it is already
asked and stored, and not used today). No name, no comma: "Good evening". Under it, the existing
"What can I help you with?". Then the composer, the four existing intents (Research, Create,
Analyze, Automate) as cards with a one-line hint, and a row of suggestion chips (Plan my week,
Summarize a PDF, Compare three laptops, Draft an email, Explain a topic simply). Intents and
chips fill the composer and stop; they never send (existing contract).

Settings > General gains "What should Cinderpaw call you?" so the name can be set or changed later.

## 6. Chat

**Messages.** User: `active` bubble, radius 20 20 6 20. Assistant: no bubble, no avatar, full
column (max 700 px). The logo head appears once: at the end of the latest reply, animated while
it is being written, still once it is done. It replaces the separate streaming spinner.

**Message actions.** Copy, Edit, Try again already exist (`MessageActions.tsx`); they are restyled
and shown on hover and keyboard focus, with the message time (`created_at`) beside them.

**Activity Strip** (replaces the step card; section 7.5).

**Artifact card.** Icon tile or thumbnail, title, one-line description, Open. Thumbnails: images show
the image; documents show a drawing made from their real headings; everything else keeps its icon.

**Sources.** When an answer used web results, links to those results render as small source chips
(site name) inline, and a "Sources" list closes the answer. Data comes from the search tool's
`hits` (`title`, `url`, `host`, `snippet`), already on `ToolActivity`. A link the model wrote that is
not one of the hits stays a normal link: a chip means "Cinderpaw read this".

**Pasted text.** A paste longer than 1,200 characters or 20 lines becomes an attachment card
"Pasted text, N lines" instead of filling the composer. Click opens it; the text is sent in full.
Short pastes and the existing link-to-chip behaviour are unchanged.

**Drop anywhere.** Dropping files anywhere on the chat shows one overlay, "Drop to add to this chat".
The drop handlers exist; this is the overlay only.

**Error card.** `StreamErrorNotice` restyled: what happened in plain words, that the message is
safe, Try again, and "Show details" for the technical text.

## 7. Widgets

### 7.1 The chat widget kit

Typed widgets the agent sends as data and the app draws. The agent never writes their HTML, so they
always match the theme, cost few tokens, and cannot run code. `app` artifacts (sandboxed HTML,
ECharts) stay for anything bespoke.

A new builtin tool, `show_widget`, takes `{ kind, title?, ...data }` and returns the same data in its
result `data`. The app reads it from the tool's `data`, never from its English sentence (the rule the
`artifact` field on `ToolActivity` already follows), and draws it in place of the tool row.

| Kind | Data | Examples |
|---|---|---|
| `facts` | 2 to 6 `{ label, value, icon? }` | trip overview, what is in a repo, a contract's key terms |
| `checklist` | `{ items: [{ text, done, note? }] }` + automatic "N of M" and bar | bookings, packing, launch plan |
| `cards` | 2 to 6 `{ title, subtitle?, image?, url? }` | places, products, recipes, search results |
| `breakdown` | `{ total?, items: [{ label, value }] }` horizontal bars | budget, spending, time per task |
| `progress` | `{ done, total, label }` | stand-alone progress |
| `table` | `{ columns: [{ title, subtitle?, image? }], rows: [{ label, cells: string[] }] }`, 2 to 4 columns | comparing laptops, plans, offers |
| `verdict` | `{ title?, text }`, one per answer | the "My take" box under a comparison |

Rules: unknown `kind` or invalid data renders as a plain text list of the same data, never a blank.
Icons come from a fixed set named in the tool schema. `todo_write` (the agent's own plan) renders
with the `checklist` widget too, so the plan the agent keeps is finally visible.

**Images in cards.** The CSP already allows `https:` images. They are still loaded through the
engine (fetched once, cached in the profile, size-capped), so they pass the same egress door as
every other request, work offline once seen, and send no referrer. A card with no image or a failed
image shows a warm placeholder, never a broken-image icon.

**Tabbed documents.** A document artifact with three or more `##` sections shows them as tabs in the
right panel (Overview, Day by day, Food, Budget on the canvas). Fewer sections: one scrolling page.
No map tab: maps need third-party tiles.

### 7.2 Agent activity

- **Helpers.** `rlm()` workers show inside the Activity Strip as "2 helpers" with their lines and
  times (data: what `WorkersCard.tsx` reads); their answers stay in the in-chat card.
- **Dreaming card.** At the bottom of the sidebar, only while the dream cycle runs: sleeping mascot,
  "Dreaming", what it is doing, a thin bar. Gone when it ends.
- **Team.** Settings > Agent and team shows Cowork teammates (`TeammatesSection.tsx`) as cards:
  head, name, role, status (Working: what / Idle), Message; plus an "Add a teammate" card.

### 7.3 Connect your world (onboarding)

A new step in `OnboardingWizard.tsx` after the provider step. Two groups, real integrations only:
"Your tools" from the MCP presets in `src-tauri/src/mcp.rs` (Notion, GitHub, Linear, Todoist, Jira,
Airtable, ...) plus Google Docs (send-only, `drive.file`), and "Where you chat" from the chat
transports (Slack, Discord, Telegram, WhatsApp, Google Chat, and a "N more" card that opens the full
list). Every card shows the company's official logo (3.6). Nothing is pre-selected; "Skip for now" is always there;
the mascot's line says the rest waits in Settings > Accounts. Gmail, Google Drive and Figma are not
offered: they do not exist.

### 7.4 Small details

- Browser tab: while the agent drives the page, a bar "Cinderpaw is using this page" with Stop,
  and the head peeking from the bottom edge of the page.
- Appearance: theme cards with small previews (Light, Dark, System, System selected by default),
  chat font (Geist default, or the system font), window background (Solid, Glass).
- Memory: filter chips by type (All, Preferences, Facts, Projects), a coloured tag per row, time,
  and Forget (exists).
- Voice pill: Charcoal pill with the head, "Listening…", Flame waveform, Mute, Pause, End (red).
- Done toast: the head peeking over the top edge, what finished, Open, dismiss.

### 7.5 Components from the second board set (27 Sep)

Ten boards in `Desktop\Cinderpaw Moodboard\Components\`, agreed with Darius as follows. Anything
fake in them (old model names, "Share", a user avatar, email sending, a risk score) is out.

- **Activity Strip** (2bf99865). One line under the user's message while a turn runs: the clay
  mascot at the laptop, what it is doing ("Researching · 4 sources · 12s"), a thin progress bar,
  and chips for side activities (Using memory, Generating artifact, 2 helpers). Expands into the
  step timeline (each step: title, one-line detail, count or "3/4 complete", status ring). When the
  turn ends it collapses to "Worked for 42 seconds". It replaces the step card, the deep-research
  Working card and the "browsing the web" card: one piece for every turn. Data: the turn's
  `ToolActivity` list.
- **Agent Pulse, on the mascot** (d8aff151). No floating pill. The composer mascot shows the live
  state with its expression and a small label beside it: Thinking, Searching, Using memory, Running
  tool, Waiting for approval, Done. The states come from `useMascotState`.
- **Coworker Strip** (90449a97). A row of teammate cards at the top of the chat (name, state,
  mascot in the teammate's colour), shown only when at least one teammate is working or has an
  unread answer. A card opens a popover: what it is doing, recent progress, "View answer". Teammate
  colour variants of the mascot are made in the mascot task, not here.
- **Memory Peek** (f69470a0). "3 memories used" under a reply, collapsible, listing only the
  memories that were actually put into that turn's context (the memory lookup's `facts` and the
  injected memory block), each with Forget. Nothing is shown when none were used.
- **Context drawer** (b80e7338). The Context tab exists for every chat: Files attached, Sources read
  (favicon, title, host), Memory used, Tools with their on/off state, pending Approvals; for a chat
  in a project, the project's instructions and files on top (section 9).
- **Artifact Dock** (8654985a). The Artifacts tab lists this chat's artifacts with large
  thumbnails, type and size ("PDF, 12 pages", "Chart, interactive"), Open, Export, Download. After a
  finished task the reply may end with up to four follow-up chips ("Add more charts"); they fill the
  composer and stop, like the Home intents.
- **Approval cards** (58150f71). An action waiting for a yes shows as a card in the chat: icon,
  what will happen, the details (the command text, the file path, the recipient), Deny and Approve,
  expand for more. The badge is the real escalation class from `cowork/approval.ts` (Send, Publish,
  Delete, Purchase, Production change) coloured by weight (Delete, Purchase, Production change
  red; Send, Publish amber); a tool-approval request that has no class shows no badge. There is no
  invented risk score. Expiry denies (existing fail-closed rule) and the card says so.
- **Command palette** (1fb5ccc7). The existing palette (`SearchOverlay.tsx`) restyled into
  sections Create / Explore / Configure with shortcuts: New chat `Ctrl N`, Create artifact
  `Ctrl Shift A`, Open browser `Ctrl B`, Switch model `Ctrl M`, Settings `Ctrl ,`. The palette
  itself opens with `Ctrl K`; "Search memory" gets no second `Ctrl K`.
- **Mini browser** (2383b440). The Browser tab shows the browser's real tabs (the store has them),
  the address bar, the page, and a "Summarize this page" button that produces a page summary card
  with topic chips. The summary is made only when asked, never on every page.
- **Comparison table and "My take"** (b80e7338). The `table` and `verdict` widget kinds (7.1).

Left out on purpose: like/dislike under replies (nothing would read them yet), the user avatar and
the corner theme button (no accounts; theme is in the palette and Settings).

## 8. Models: roles

The model pill opens a **Model Switcher** (421c5cf9) with roles instead of raw names:

| Role | Line | Model |
|---|---|---|
| Primary | Balanced for most tasks | the model the person chose as primary |
| Fast | Quick answers to quick questions | the model chosen for Fast |
| Deep | Careful reasoning for hard problems | the model chosen for Deep |
| Local | Runs on your device, private and offline | a downloaded local model |

Each row shows the model it is set to. The roles are set on the Models page. A role with nothing
set says what to do ("Choose a model"), and Local on a machine with no local model says
"Download a model"; neither row is ever blank. "Manage models" opens the Models page. The clay
mascot peeks over the popover's top edge.

## 9. Projects, like Claude's

Today a project is `{ id, name, conversation_ids }` (`src-tauri/src/projects.rs`). It gains:

- `instructions: String` (empty by default), added to the system prompt of every chat in the project.
- files: copied into the project's folder in the profile and listed to the agent, which reads them
  with its file tools. Nothing is embedded or uploaded.

For chats in a project, the Context tab (7.5) shows the instructions (editable) and files (add,
remove) above the chat's own context. Old `projects.json` files load with empty instructions and
no files.

## 10. What is new and what already exists

| Exists, restyled or moved | New code |
|---|---|
| sidebar, library, New menu, Search | tokens, fonts, theme default, bundled brand logos |
| step chain, artifact card, message actions | Activity Strip, `show_widget` tool + seven renderers |
| WorkersCard, deep_research, dream cycle, teammates | helpers in the strip, Dreaming card, Coworker Strip |
| onboarding wizard, userName, MCP presets, transports | Connect step, name in greeting, "call you" setting |
| reasoningMode, enabledTools | Tools menu + chips |
| memory Forget, memory `facts`, Glass/Solid, CallPill | Memory Peek, Memory filters and tags, theme previews, chat font |
| drop and paste handlers | pasted-text card, drop overlay, source chips |
| cowork approvals, ask-user channel | approval cards in the chat |
| palette actions, browser tabs | palette sections and shortcuts, page summary |
| projects (name + chats) | instructions, files, Context tab for every chat |
| | starred chats, model roles, image cache, follow-up chips |

## 11. First run: every screen empty

| Screen | What a stranger sees |
|---|---|
| Home, no model | the existing setup card in place of the intents; composer disabled with the reason on screen |
| Sidebar, no chats | no STARRED, no PROJECTS, no dated groups; one quiet line "Your chats will appear here" |
| Artifacts, none | "Things Cinderpaw makes for you land here" + one example prompt |
| Connect step | every card on "+", nothing connected, Skip visible |
| Team, none | only the "Add a teammate" card, with one sentence on what a teammate is |
| Memory, empty | "Nothing yet. Tell me about yourself, or just chat and I will learn." |
| Coworker Strip | not shown |
| Memory Peek | not shown when no memory was used |
| Context tab, new chat | "Nothing here yet. Files you add, pages Cinderpaw reads and memories it uses will show up here." |
| Context tab, new project | empty instructions box with a placeholder example, "Add a file" |
| Model Switcher, nothing set | each role says "Choose a model"; Local says "Download a model" |
| Approval card, expired | "Timed out, so nothing was done" in place of the buttons |
| Greeting, no name | "Good evening" with no comma |

## 12. Slices

Each slice is its own branch off the rebrand branch, its own tests, and `./scripts/verify.sh` green
before it lands. AGENTS.md asks for 3 files or fewer; slices that need more are marked and get a
go-ahead first.

1. Tokens, fonts (Young Serif bundled), theme default, Solid default, glass.test updated. (more than 3 files)
2. Brand logos: the bundled SVG folder, the lookup, monogram fallback; MCP presets stop using favicon URLs.
3. Sidebar restyle + starred chats.
4. Header + composer (Tools menu, chips) + mascot perch position and its state label (Agent Pulse).
5. Messages: no avatars, head at the end, hover actions and time, artifact card.
6. Activity Strip (replaces the step card; helpers inside it).
7. Widget kit: `show_widget` tool (sidecar) + seven renderers + `todo_write` as checklist. (more than 3 files)
8. Image cache in the engine for widget cards and favicons.
9. Source chips + pasted-text card + drop overlay.
10. Memory Peek.
11. Home: greeting with name, intents, chips; "call you" setting.
12. Connect your world step.
13. Approval cards in the chat.
14. Context tab for every chat + Artifact Dock + follow-up chips.
15. Coworker Strip + Dreaming card + error card.
16. Settings: Team, Appearance, Memory.
17. Command palette sections and shortcuts.
18. Browser: tabs, agent badge, page summary; voice pill; done toast.
19. Model Switcher with roles (+ role settings on the Models page).
20. Projects: instructions, files. (Rust: restarts his running dev app; schedule it.)

The mascot 3D rework runs separately and only swaps frames in `sheet.webp` / `frames.ts`.

## 13. Testing

- Every slice: vitest for the new logic (widget data validation and fallbacks, starred-id cleanup,
  paste threshold, source-chip matching, project JSON back-compat), `tsc --noEmit`, and the
  contrast gate.
- The widget tool: sidecar test that invalid data returns the text fallback, not an error.
- Before a slice is called done, Darius sees it in the running app (never a simulated shell).

## 14. Answered by Darius (27 Sep)

1. Window background: **Solid by default**, Glass stays as an option.
2. Card images: **through the engine** (private, cached, offline once seen).
3. Home suggestion chips: **all five stay**.

Spec approved: "poti incepe".
