# Board artifacts: the agent sends blocks, the app draws the boards

Status: approved by Darius, 1 Oct 2026 ("A, ideea e sa fie cat mai procedural designul, sa nu
existe 2 carduri la fel"). He asked not to be handed this to read; it is here for the next session.

## Why

The five reference boards (`Desktop\Cinderpaw Moodboard\Components\`: Diagram, GTM Strategy,
Performance Charts, Trip Planning, Marketing Strategy) are a component set: icon node cards with
dashed links, KPI tiles, line and bar charts, share lists, numbered columns with illustrations,
timelines, photo strips, pillars with checks, a content calendar with a photo per day, chip rows.
A Markdown document cannot express them, and HTML written by a model will not land on them every
time, least of all on a cheap model. The chat widgets (spec 2026-09-27 section 7.1) already follow
the rule that fixes this: the agent sends data, the app draws it.

## What

A new artifact kind, `board`: JSON the agent writes with `artifact_create`, validated by the
sidecar, drawn by React in the chat card (summary) and in the Artifacts panel (deep dive, full).

```
{ title, subtitle?, icon?, status?: "draft" | "in progress" | "ready", blocks: Block[] (1-12) }
```

| Block | Data | Board |
|---|---|---|
| `text` | `{ text }` | Marketing lead line |
| `kpis` | `{ items: 2-4 { label, value, delta?, trend?: up/down/flat } }` | Performance |
| `line` | `{ title?, subtitle?, x: string[], series: 1-3 { name, values } }` | Performance |
| `bars` | `{ title?, subtitle?, items: 2-8 { label, value } }` | Performance |
| `breakdown` | `{ title?, subtitle?, items: 2-8 { label, value } }` as shares | Performance |
| `flow` | `{ nodes: 2-8 { id, title, lines?, icon? }, edges: { from, to, dashed? } }` | Diagram |
| `columns` | `{ items: 2-4 { title, text?, points?, icon?, image? } }`, numbered | GTM |
| `pillars` | `{ items: 2-3 { title, text?, icon?, checks } }` | Marketing |
| `timeline` | `{ title?, items: 2-10 { label, title, text? } }` | Trip, GTM |
| `photos` | `{ items: 2-4 { image, title, subtitle? } }` | Trip |
| `calendar` | `{ title?, range?, days: 1-7 { day, date?, title, image?, tag? } }` | Marketing |
| `chips` | `{ items: 2-6 { label, icon? } }`, drawn as the card's footer row | all |

Icons are names from a fixed list (lucide), as for widgets. Images are https only; the agent gets
them from `find_images`. Unknown or invalid blocks are dropped and named in the tool result, so
the agent can fix them with `artifact_edit`; a board left with no valid block is refused.

## Procedural, so no two cards are alike

A seed from the artifact id and title picks, deterministically: the accent tint order, the icon
tile shape, the header ornament (hills, dots, rays, none), the number style of columns, the curve
of charts (smooth or straight) and the angle of the card's warm wash. The agent's choice and order
of blocks does the rest; adjacent half-width blocks (bars, breakdown, timeline, text) pair up side
by side. The same board always looks the same; two boards never look identical.

## Where

- Sidecar: `artifacts/board.ts` (validate, `boardToMarkdown` for PDF/Word export), kind `board`
  in `artifacts/store.ts`, `artifact_create` description and validation, export routes a board
  through Markdown.
- App: `lib/board.ts` (re-parse untrusted JSON, seed), `components/board/` (BoardView and the
  blocks), `ArtifactCard` draws a board's own header (its icon, subtitle, status), the panel's
  `Preview` draws the full board.

Not now: the map (spec 7.1: maps need third-party tiles), the 7D/30D/90D switch (needs data the
board does not have), editing a board by hand in the panel (the agent edits it).

## Slices

1. Sidecar kind, validation, export, tests.
2. App parsing and the seed, tests.
3. Header, `kpis`, `line`, `bars`, `breakdown`, `flow`: compared with Diagram and Performance.
4. `columns`, `timeline`, `photos`, `pillars`, `calendar`, `chips`: compared with GTM, Trip,
   Marketing.

After 3 and 4: screenshots beside the boards and a list of what still differs, per board.
