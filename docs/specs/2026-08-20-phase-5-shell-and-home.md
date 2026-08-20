# Phase 5 — The floating shell and Home

**Date:** 2026-08-20 · **Status:** draft · **Contract:** `docs/ui/2026-08-19-ux-contract.md`

## Objective

Replace the 746-line rail (now 399) with the persistent chrome the contract
promises — four items and a settings affordance, floating and subordinate to
the page — and make Home the product's first frame: one greeting, one field,
four intents.

Phase 4 emptied the sidebar of the functions it owned alone. This phase removes
the sidebar itself. That is only safe once *every* route it links to is
reachable from somewhere else, and four of them still are not.

## Why this is its own phase

The contract's persistent chrome is four items:

```
FERAL      + New      Models      Search                            ⚙
```

The rail has nine. Five of them lose their only entry point when it goes:

| Rail item | Only way in today | Where it goes |
|---|---|---|
| Skills (drawer) | `openSkillHub()` from the rail | Settings → Capabilities |
| Extensions (`/extensions`) | rail link | Settings → Capabilities |
| Connectors (`/connectors`) | rail link | Settings → Accounts |
| Memory Layers (`/memory-layers`) | rail link | Settings → Advanced |
| New Project | rail button | **+ New** |

Grepped, not assumed: outside `router.tsx` and `Sidebar.tsx`, nothing in
`frontend-react/src` navigates to `/extensions`, `/connectors` or
`/memory-layers`, and nothing else calls the skill-hub opener. Deleting the rail
first would delete four working features and leave their routes alive but
unreachable — the Phase 4 mistake, one phase later.

The vocabulary ban decides the names. `skill`, `extension` and `connector` may
not appear in the primary interface, so the two new Settings tabs are
**Capabilities** (what Feral can do) and **Accounts** (things Feral is connected
to). The banned words stay legal inside those tabs, which are behind
progressive disclosure by definition.

## Non-goals

- **Agent activity and Results** (the "what it is doing" view, `Stop` that
  really stops, the result-as-subject screen). Real work, next phase. A stop
  control that only halts the visible stream is worse than none, and making it
  true reaches into the runtime, not the shell.
- Redesigning Models, Settings, or the chat transcript.
- Voice. It keeps its current entry point.
- Any change to conversation, project, or download storage.
- Onboarding.

## Slices

Each is independently shippable and leaves the app fully usable. **S4 is last,
and is only allowed to land after S1 is on screen.**

### S1 — The evicted tenants get homes

Two new Settings categories and one move:

- **Capabilities** — the Skill Hub content and the Extensions page, one tab,
  two sections. Both answer "what can Feral do"; they are one question to a
  user and two subsystems only to us.
- **Accounts** — the Connectors page, which after Phase 3 is a list of
  `AccountCard`s. This is also where Phase 3's open thread lands: nothing polls
  `connector_pair_poll` on an interval yet, so a device-flow card shows a code
  and never advances. The tab owns that loop.
- **Advanced → Memory** — Memory Layers moves under the existing Settings
  shell; it is the densest, most internal screen in the product.

Routes `/extensions`, `/connectors` and `/memory-layers` keep working and
redirect to their new tab, so a bookmark, a deep link, or anything the agent
itself navigates to does not 404.

*Fresh install:* Capabilities lists the built-ins with nothing installed and
says so in one line. Accounts shows the catalog with every card unpaired, not an
empty list.

### S2 — The floating top navigation

A new `TopNav`, floating and translucent, over the page rather than beside it.
Five affordances, no more: wordmark, **+ New**, **Models**, **Search**, **⚙**.

- **+ New** is a menu: new chat, new project. It absorbs the rail's two
  creation buttons and their shortcuts (⌘N, ⌘P).
- **Search** opens the existing overlay; ⌘K keeps working from anywhere.
- Window controls and `DownloadStatus` already live in their own fixed strip at
  `z-[200]` and are not touched. The nav sits below them and must never overlap
  them at any window width.
- The nav is chrome: it does not scroll with the page, and it does not cover the
  composer at the minimum supported window size.

*Fresh install:* all four items present, none empty-but-broken. Search over
nothing says so in one line; Models opens on browse.

### S3 — Home is the first frame

Today Home is `NewChatEmptyState`: a rotating greeting, three *random*
suggestion pills, and the Phase 4 recent-work cards. The contract asks for
something more fixed:

- Greeting: time-of-day plus name when we have one, and the question under it.
  A fresh install has no name and must read correctly without one.
- **Four intents, not three random suggestions**: Research · Create · Analyze ·
  Automate. Fixed, not shuffled — they are a statement about what the product
  is, and a set that changes every four seconds cannot be that. Each fills the
  composer; none of them sends.
- The rotating greeting goes. Recent-work cards stay exactly as Phase 4 shipped
  them, capped at two.

*Fresh install:* greeting, composer, four intents. No cards. Nothing else.

### S4 — The rail is deleted

`Sidebar.tsx` and its tests are removed, `AppShell` loses the animated
`paddingLeft`, and the `sidebarCollapsed` state leaves the UI store. The page
becomes the full window with the nav floating over it.

## Acceptance criteria

1. Every route the rail linked to is reachable in at most two clicks without it.
2. `grep -rn "Sidebar" frontend-react/src` returns nothing.
3. Persistent chrome is exactly four items and a settings affordance.
4. None of the banned words appears in the nav, on Home, or in a Settings
   category label.
5. A device-flow account card left open advances by itself when the code is
   approved — no reload, no second click.
6. Fresh install: nav, greeting, composer and four intents render with no keys,
   no models, no history, no connectors and no network, and nothing on screen is
   an empty box without an explanation.
7. `scripts/verify.sh` green.

## Tests to add

- `TopNav`: four items render; **+ New** offers both creations; ⌘K opens search.
- Redirects: `/extensions`, `/connectors`, `/memory-layers` each land on their
  new tab.
- Home: four fixed intents, in order, on a store with no name and no history;
  clicking one fills the composer and does not send.
- Accounts tab: a pending device-flow card polls and flips to paired without a
  reload.

---

# Revision — 2026-08-20, after S1–S4 shipped

**Status:** direction correction. S1–S4 stay; the shell changes shape.

## What changed and why

Removing the rail entirely was too aggressive. Being different from
ChatGPT / Copilot / Grok is not the goal; keeping Feral's complexity behind the
agent is. A permanent, *minimal* navigation layer costs little and is what
people already know how to read.

The goal the contract still holds: the user thinks "I tell Feral what I want",
never "I need to understand agents, MCP, skills, connectors, runtimes".

**The sidebar answers one question: where do I want to go.**
**The agent answers the other: what do I want to accomplish.**

## Audit of the deleted rail — 15 tenants

Verified against `6c9f75d^:frontend-react/src/components/layout/Sidebar.tsx`.

| Tenant | Where it is after S1–S4 |
|---|---|
| New Chat (⌘N) | TopNav → + New. Hotkey intact. |
| New Project | TopNav → + New. ⌘P was a label with nothing behind it; removed. |
| Search (⌘K) | TopNav → Search. |
| Models | TopNav → Models. |
| Settings | TopNav → ⚙. |
| Rename / delete / move | On the item, in Search rows and Home cards. |
| Skills drawer | Settings → Capabilities. |
| Extensions | Settings → Capabilities. |
| Connectors | Settings → Accounts. |
| Memory Layers | Settings → Memory. |
| Conversation list | **Degraded** — one card on Home, the rest behind ⌘K. |
| Projects tree | **Degraded** — one card on Home, scoping inside Search. |
| Current-conversation highlight | **Lost.** No persistent surface to highlight on. |
| "Generating now" dot | **Lost.** `streamingIds` is written by the store and read by nothing. |
| Collapse / expand | Removed with the state. |

The three losses are what this revision exists to repair. Everything else stays
where S1–S4 put it.

## The new navigation layer

Seven rows, and they do not grow:

```
FERAL · + New · Search · Chats · Projects · Models · ⚙ Settings
```

It **replaces** the floating top nav rather than joining it — two navigation
chassis on one screen is the clutter this phase exists to remove. The `+ New`
menu and `NewProjectDialog` move across unchanged.

Not in primary navigation, ever: skills, extensions, connectors, MCP, memory,
providers, tools, agent configuration, brain, runtime, BRSI, FMS, evolution,
debugging. They stay in Settings, reachable in two clicks, and are agent-driven
first ("connect my Discord").

**Models stays visible on purpose.** Downloading a local model is a physical act
with disk and time costs, and it is the one advanced area the contract
deliberately exposes.

### Chats and Projects are pages, not trees

The rail carries no nested navigation. `Chats` and `Projects` are routes whose
list lives in the content area, where there is room to read it and where it
costs no width on every frame. That is where the current-conversation highlight
and the generating dot return.

### The library: everything, flat

**Amended the same day the cap shipped.** The rail carries *all* projects and
*all* conversations in one scrolling column, projects first, chats after,
newest first.

The five-item cap was the wrong trade. Browsing your own history should not
require knowing what you are looking for, and a person with two hundred chats
scrolls a column the way they scroll every other app they own. What the cap was
really protecting against was not length but **shape** — a tree. So that is
what the test pins instead: the list stays flat, no project expands into its
chats here. Opening a project goes to the Projects page, where its contents have
room to be read.

No section headings either: "Projects" and "Chats" are already two of the
navigation rows just above, and a 216px column that says each word twice reads
as a form rather than a list.

Home therefore carries **no** continue/project cards. With the whole history one
glance to the left, a card repeating the top of it is the same thing twice, and
the greeting and the field get the screen back.

### Shape

Narrow (~200px), calm, collapsible to icons. Navigation state (`collapsed`)
lives in the UI store and holds nothing about the agent or the runtime.

## Kept from S1–S4, untouched

Home (greeting, composer, four intents, recent cards), the scene gradient,
Search opening on recents, the three Settings categories, the legacy route
redirects, and the connector pairing loop.

## Acceptance criteria (revised)

1. Primary navigation is exactly seven rows, plus a flat library of projects
   and chats that never nests.
2. None of the banned words appears in it.
3. The open conversation is visibly the open one, and a generating one says so.
4. Fresh install: every row is present and none is an empty box without a line
   explaining itself.
5. `Sidebar.tsx` is not restored, and the new component stays well under 300
   lines.
6. `scripts/verify.sh` green.
