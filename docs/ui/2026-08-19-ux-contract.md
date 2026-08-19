# Feral UX Contract — Phase 0

**Date:** 2026-08-19 · **Status:** draft for review · **No implementation.**

This is the North Star, not a design spec. It fixes *what the product promises*
so every later phase can be checked against something. It is deliberately short.
Layout details, tokens, and component APIs belong to Phase 5+, not here.

## The one sentence

> You tell Feral what you want. Feral works out how.

Every screen below exists to make that sentence true. If a screen makes the user
work out *how*, it violates the contract.

## Two rules that override everything else

**Rule 1 — Never ship a screen without its fresh-install state.**
Every surface in this document defines what it shows on a machine with no keys,
no models, no history, no connectors, and no network. A screen that only reads
correctly once something already exists is not finished.

**Rule 2 — The interface may never be more capable than the runtime.**
If the UI says "Ask Feral anything" and the runtime cannot pick a model, we are
lying to the user. Phases 1–3 exist to make the promise true *before* Phase 5
makes it visible.

## Vocabulary ban

These words must never appear in the primary interface. They may appear behind
progressive disclosure, in Settings → Advanced, and in logs.

`skill` · `extension` · `connector` · `MCP` · `provider` · `token` ·
`BRSI` · `FMS` · `RSI` · `genome` · `ratchet` · `tier` · `sidecar` ·
`agent mode` · `runtime` · `routing` · `inference`

Replacement vocabulary in primary UI: **capability** (what Feral can do),
**account** (a thing Feral is connected to), **model** (kept — it is a real
consumer word, and Models stays a first-class area), **memory** (what Feral
remembers about you).

## Persistent chrome

```
FERAL      + New      Models      Search                            ⚙
```

Floating, translucent, visually subordinate to the page. Four items and a
settings affordance. Nothing else earns permanent residence.

- **+ New** — new chat, new project. Later, Feral may decide which one a request
  should become; the contract does not require that.
- **Models** — first-class, never a Settings subsection. It is the one advanced
  area we deliberately expose, because downloading a local model is a real
  physical act with disk and time costs.
- **Search** — one field over conversations, projects, files, and past task
  results. ⌘K opens it from anywhere.
- **⚙ Settings** — account, appearance, privacy, voice, permissions, model
  defaults, advanced. Infrastructure only.

**Fresh install:** all four are present and none is empty-but-broken. Search over
nothing says so in one line. Models opens on browse, not on an empty installed
list.

## Home

```
                        Good afternoon, Darius.
                       What can I help you with?

              ┌──────────────────────────────────────┐
              │  Ask Feral anything…                 │
              │  📎   ✨   🎙                    ☎  ↑ │
              └──────────────────────────────────────┘

                Research   Create   Analyze   Automate
```

Below that, at most two cards, and only when they have something real to say.
Empty space is permitted. Nothing is added merely to fill it.

**Fresh install:** greeting, composer, and the four intents. No cards. The
product's first frame is one question and one field.

## Composer

The most important element on the screen. Its job is to say *this is where you
tell Feral what you want*.

Controls: attach · capabilities · microphone · voice call · send. Nothing else.

**Forbidden in the composer:** model pickers, "No model selected",
reasoning-mode toggles, an unlabeled chat/agent switch. The user never selects a
model in order to send a message.

**Zero-model state — the contract's hardest case.** The composer stays enabled.
The first message is accepted, and Feral itself answers it:

> I need a brain before I can do that. I can download a small local model
> (2.4 GB, works offline) or use an API key if you have one. Which?

Setup happens *inside the conversation*, driven by Feral. It never becomes a
blocked screen pointing at Settings.

## Agent activity

While Feral works, the default view is what it is doing — not what it is saying.

```
                       Auditing bloommedia.ro

                        ◉ Feral is working

                     ✓ Reading the site
                     ✓ Checking 18 pages
                     ● Looking for SEO problems

                          Stop        View details
```

Requirements: what is done, what is happening now, and a way to stop it. Steps
are written in the user's language, never as tool names. `web_search` reads as
"Searching the web". `read_file` reads as "Reading Audit.pdf".

**Stop must actually stop.** A stop control that only halts the visible stream
is worse than none.

## Results

When a task finishes, the result is the subject — not the transcript.

```
                          Website audit

                       18 pages analyzed

                7 issues · 3 warnings · 12 passed

                          View report →
```

The conversation stays available underneath. It is not the headline.

## Progressive disclosure

One rule, applied everywhere: **hide complexity by default, never remove access
to it.**

`View details` reveals: steps taken, tools used, files read and written,
sources, which model ran and why, memory consulted, timing, cost. Each must be
reachable in at most two clicks from the thing it explains.

This is where the banned vocabulary is allowed. A curious user should be able to
dig down to the real machinery. A normal user should never meet it.

## The other four surfaces

**Projects** — a human container for related work: conversations, files,
context. The user names it; Feral maintains the relationships. The user never
wires a conversation to a project by hand unless they want to.
*Fresh install:* no projects, and the product is fully usable without ever
making one.

**Models** — cloud accounts and local models in one place, with download size,
progress, disk cost, and installed state. This screen is allowed to be denser
than the rest of the product.
*Fresh install:* browse view with recommendations sized to the machine.

**Search** — one field, four kinds of result, keyboard-first.
*Fresh install:* one honest line, not an empty box.

**Voice** — a conversation with Feral, not a dictation feature. Four states:
idle (`☎ Call Feral`), listening, speaking, working. The same Feral identity
carries through all four; working is not a separate screen.
*Fresh install:* the call button is visible, and when pressed with nothing
configured, Feral says what it needs — the same pattern as the zero-model
composer.

## Release gate

The redesign is not done when it looks right. It is done when a stranger, given
20 minutes and no explanation, answers all five:

| # | Question | Passing answer |
|---|---|---|
| 1 | What is Feral? | "An assistant that can actually do things for me." |
| 2 | What can it do? | "I give it a task and it uses whatever it needs." |
| 3 | How would you connect Discord? | "I'd tell Feral to connect it." |
| 4 | How would you give it a complex task? | "I'd just describe what I want." |
| 5 | How would you use a local model? | "Open Models and download one." |

**Today: 1 of 5** — only #5 passes. The gate is not a metaphor: it is run on a
real person who has never seen the product, and the answers are written down.

## What this contract forbids

- Adding UI to demonstrate capability. Capability is demonstrated by behavior.
- A settings screen as the answer to a question the user asked in the composer.
- Any primary surface that requires configuration before it does anything useful.
- Shipping Phase 5 (the new Home) before Phases 1–3 make its promises true.
