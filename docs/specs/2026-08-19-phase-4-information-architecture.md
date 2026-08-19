# Phase 4 — Information Architecture Migration

**Date:** 2026-08-19 · **Type:** implementation spec · **Status:** complete — all four slices shipped; the sidebar has no functions left that live only in it

**Audit baseline:** `docs/ui/2026-08-19-brief-audit.md` §B4, §C
**UX contract:** `docs/ui/2026-08-19-ux-contract.md`

## Objective

Give every function the sidebar currently owns a new home, so that removing
the sidebar in Phase 5 removes chrome rather than removing product.

## Why this is its own phase

The brief says "no sidebar". `Sidebar.tsx` is 746 lines and owns far more than
navigation:

| What it owns | Where it goes |
|---|---|
| Conversation list | Search (widened) + Recent on Home |
| Projects tree | Search + a project switcher |
| Rename / Delete / Move-to-project | Context menu on the item, wherever it lives |
| Download progress popover | Top-nav status affordance |
| App version | Settings → About |
| Nine nav items | Four, per the UX contract |

Deleting the component before those exist would delete the only way to reach
each of them. That is the single biggest regression risk in the whole redesign,
which is why the sidebar is dismantled function by function and stays on screen
until the last tenant has moved out.

## Non-goals

- Removing or restyling `Sidebar.tsx`. It keeps working, unchanged in
  behaviour, for the whole of this phase. It is deleted in Phase 5, after its
  last tenant has a home.
- The floating top navigation (Phase 5).
- The new Home layout (Phase 5).
- Any change to conversation, project, or download storage.

## Slices

Each is independently shippable and leaves the app fully usable.

### S1 — Search covers conversations, projects, and messages

Today `SearchOverlay` reads `useConversations` and nothing else, so it can find
a chat and nothing else. The UX contract makes Search one of four permanent
items and promises "one field over conversations, projects, files, and past
task results" — Search is where the sidebar's biggest tenant is going, so it
has to hold more than it does.

- Result kinds: `conversation` (title or message hit) and `project` (name hit).
- Grouped, projects first — a project is a container, so it is the coarser
  answer and belongs above the individual chats.
- Opening a project result navigates to it; opening a conversation opens it.
- Keyboard behaviour (arrows, Enter, Escape) spans the whole flat list,
  unchanged in feel.
- Empty state names both things it searched, so a user who finds nothing knows
  what was looked at.

Files are deliberately not in S1: there is no file index to search, and
building one is not an information-architecture move.

### S2 — Rename / delete / move become item-level actions ✅

Extract the context menus out of `Sidebar.tsx` into a component that takes a
conversation or project and renders the same actions. The sidebar then uses
that component instead of its inline copies, so the behaviour has one
definition before it has two homes.

Shipped as `components/items/ItemActions.tsx`, with two decisions worth
keeping:

- **The dialogs travel with the menu.** The sidebar kept rename and delete
  confirmation at its own root. Extracting only the menu would have left every
  future host — Search, Home, a project page — rebuilding both dialogs, so each
  component owns trigger, menu, and dialogs together. A host renders one
  element and gets the whole behaviour.
- **The containing project is looked up, not passed.** Search and Home have no
  project tree to tell a row where it lives, and "Remove from project" has to
  work there too, or a chat can get stuck in a container only the sidebar could
  open.

Search rows carry the same actions as of this slice, which is what makes S1's
result list a real home rather than a read-only index.

### S3 — Downloads and version leave the rail ✅

Download progress becomes a top-level status affordance; the version string
moves to Settings → About, where the rest of the build information already is.

Shipped as `components/layout/DownloadStatus.tsx`, rendered by `AppShell` in
the window-chrome strip beside the window controls:

- **It only exists while there is something to say.** Idle, it renders nothing.
  A permanent download icon on an app that is not downloading is chrome
  pretending to be information, and there is no download history behind it to
  open. Success and failure both persist until dismissed, so a finished or
  failed download is never lost to a glance away.
- **This also fixes an existing hole**: the sidebar rendered the button only
  when expanded, so collapsing the rail hid a running download entirely.
- **The version needed no new home.** Settings → About already prints it; the
  sidebar footer was a second copy, so it was deleted rather than moved.

### S4 — Recent work on Home ✅

The two Home cards the contract allows, fed by conversations and projects, so
"where was I" does not depend on the rail.

Shipped as `components/shell/RecentWork.tsx`:

- **Exactly one chat and one project, never a list.** Search answers "where is
  that thing I remember"; Home answers "what was I doing". Anything more turns
  Home into the sidebar lying down, which is the failure mode this whole phase
  exists to avoid.
- **A project has no timestamp of its own**, so its recency is the newest
  conversation inside it. An empty project has no activity to report and is
  skipped rather than shown with a blank date.
- **Opening a project card narrows Search to it** (`openSearch(projectId)`),
  the same answer that picking a project result gives.
- **Space above the composer is reserved only when the cards exist**, so a
  fresh install keeps the greeting exactly where it was.

Found and fixed on the way: opening Search already narrowed, with nothing
typed, reported "Nothing in X matches" — an answer to a question the user never
asked. A scope with an empty query now lists what the project contains.

## Acceptance criteria

1. Every function listed in the table above is reachable without the sidebar.
2. The sidebar still works identically throughout; no slice degrades it.
3. Search finds a project by name and a conversation by title or message text.
4. Keyboard navigation in Search still works across mixed result kinds.
5. Existing tests pass; new tests cover the widened search and the extracted
   menus.
