# Cinderpaw UI/UX Brief — Repository Audit

**Date:** 2026-08-19 · **Branch:** `ui/cinematic-shell` · **No code written.**

Audit of the current repository against the "Cinderpaw UI/UX Redesign Brief"
(minimalist agent-first surface, no sidebar, agent-driven configuration).

## Verdict

The runtime is well ahead of the interface. Most of what the brief asks for
already exists as machinery and is either **off by default** or **has no UI
path**. Only three capabilities are genuinely absent. The dangerous work is not
building new features — it is that the sidebar owns functionality nothing else
provides, so "no sidebar" deletes product unless it is decomposed first.

## A. Already supports the brief — reuse, do not rebuild

| Brief section | What already exists |
|---|---|
| §3 visual system | Cinematic scene layers + glass material tokens landed this week (`642ef46`, `1b32e1f`) in `globals.css`; theme-correct pre-paint startup in `index.html` + `public/cinderpaw-prepaint.js` |
| §8 progressive disclosure | `ToolCallBubble` / `ToolCallStack` already render running/finished steps and expand output on click. "View details" is a re-layout, not new plumbing |
| §7 agent-driven config | `CinderpawAgent/src/tools/builtin/connectors-manage.ts` — the agent can `list` and `configure` connectors mid-conversation |
| §10/§15 automatic model choice | `CinderpawAgent/src/brain/` is a complete router: `task-classifier.ts`, `capability-registry.ts`, `brain-stack.ts`, modes budget/balanced/quality |
| §16 differentiation | 35 builtin tools incl. `deep-research`, `control-app` (OS accessibility tree), `shell-exec`, `delegate-task`, `tool-forge`, `todo-write`, `remember`/`recall` |
| §5 search | `SearchOverlay` + `useGlobalHotkeys` (⌘K) already wired |
| §11 voice | Call session, speech player, VAD, orb, transcript — already a first-class surface with its own overlay |
| §15 Models | `ModelsPage` with browse/download/progress/installed state is the strongest page in the app today |
| shell swap cost | `createMemoryRouter`, pages lazy-loaded; chrome lives almost entirely in `AppShell.tsx` (104 lines) |

## B. What blocks the brief — ranked by damage

**1. Automatic model selection is built but off, and nothing can turn it on.**
`brain-config.ts` enables Brain Stack only when the user hand-writes
`~/.cinderpaw/brain.json`. No UI, no onboarding step, no default file writes it.
So §10's "remove *No model selected*, Cinderpaw picks automatically" is impossible
today — not for lack of a router, but because the default is off and there is
no path to on. On a fresh machine this is invisible: the user simply meets
"No model selected" forever. Highest-priority SPEC B item.

**2. The agent cannot install a capability.**
`install_skill` and `mcp_install` exist only as Tauri commands the *UI* calls
(`lib/tauri/index.ts:672,692`). The agent's skill tools are `list_skills` and
`read_skill` — read-only. "Install the capability that lets you analyze Excel
files" fails today. Needs a new agent tool crossing the host bridge, with a
permission gate, before §7 is real.

**3. Connector setup is still a developer workflow.**
`connectors_manage` covers Discord and Slack only, and only by the user pasting
a bot token from a developer portal ("Bot → Reset Token", "socket-mode app
token xapp-…"). There is no OAuth. "Connect my Discord" — the brief's headline
example — is currently the weakest real path in the product.

**4. Removing the sidebar removes function, not just chrome.**
`Sidebar.tsx` is 746 lines and owns far more than navigation: the conversation
list, the projects tree, rename/delete/move-to-project menus, the download
progress popover, and the app version. Every one of those needs a new home
*before* the sidebar can go. This is the largest re-layout risk in the brief.

**5. Search is conversations-only.** `SearchOverlay` reads `useConversations`
and nothing else. §5 asks for projects, files, task history, memories.

**6. Projects are chat folders.** The store exposes `addChat` / `removeChat`
and nothing more — no files, tasks, context, or memories. §14's mental model is
currently copy over a thin store.

**7. There is no results/artifact surface.** §13 ("18 pages analyzed · 7 issues
· View report") has nothing behind it. Agent output is message text. This needs
an artifact concept in the agent protocol, not a UI card.

**8. Nine primary nav items; the brief keeps three.** Skills (a drawer),
Extensions, Connectors and Memory Layers are full surfaces. They must become
agent-reachable and discoverable-on-demand, not deleted — the functionality is
real and some of it is the product's differentiation.

**9. The empty state hard-blocks on a model.** `NoModelEmptyState` replaces the
composer entirely. §10 says the user must never feel blocked by model
configuration. Coupled to blocker 1.

## C. Architectural problems that would make the new UX brittle

- `AppShell` animates `paddingLeft` from `SIDEBAR_W`; page containers assume
  that inset. A top nav changes `AppShell` **and** every page's outer container.
- The 746-line `Sidebar` mixes navigation, data fetching, and context menus in
  one file. It must be split before it can be replaced, or the replacement
  inherits the tangle.
- The nav model is already inconsistent: Skills has no route (drawer only),
  `/memory-graph` redirects to `/memory-layers`. A clean top nav has to resolve
  this, not paper over it.
- Execution UI is anchored to the mascot perch beside the composer and capped
  at four bubbles by the store. §12's centered task view is a different anchor
  and a different cap — a re-architecture of `ToolCallStack`'s placement, not a
  restyle.
- `i18n.ts` carries flat EN + RO keys. Every new string must land in both or
  Romanian users silently fall back to English.
- Ten settings tabs today (`General, Appearance, Privacy, Hardware, Byok,
  AgentSettings, ApiServer, About, Dreams, RsiEngineStatus`). The brief's
  Settings is seven infrastructure items; Dreams/RSI panels need a decision —
  hide, or move behind progressive disclosure.

## D. Recommended sequencing

Each step is independently shippable and independently verifiable.

0. *(in flight)* Cinematic scene palette + Grok-style loading screen.
1. **SPEC B slice 1 — Brain Stack on by default.** Ship a default capability
   registry, enable routing without a hand-written file, and delete "No model
   selected" from the composer. Unblocks §10 and the home screen.
2. **SPEC B slice 2 — capability install as an agent tool.** Bridge
   `install_skill` / `mcp_install` to the agent behind one confirmation.
3. **Shell swap.** Decompose `Sidebar` into: a `+ New` menu, a widened Search
   (conversations + projects + files), and a chats surface. Then replace the
   rail with the floating top nav.
4. **Home screen** per §9.
5. **Execution + results surface** per §12/§13 — needs an artifact concept in
   the agent protocol first.
6. **Connector OAuth** per §7.

## E. The §20 test, answered against today's build

| Question | Likely answer today | Verdict |
|---|---|---|
| What is Cinderpaw? | "A chat app with a lot of settings" — 9 nav items, 10 settings tabs | **fail** |
| What can it do? | Not discoverable; tools are invisible until they happen to run | **fail** |
| How would you connect Discord? | Finds the Connectors page, then hits "paste a bot token" | **fail** |
| How would you use a local model? | Models page is clear and complete | **pass** |
| How would you run a complex task? | The agent/chat toggle in the composer is an unlabeled icon | **fail** |

One of five. The gap is discoverability and defaults, not missing capability.
