# Observational memory (notes, a frozen snapshot, search without the tree)

Decided 2026-09-27. Darius asked for memory to work in everyday tasks, both
for continuity ("let's continue with the trip" three days later) and for exact
details (an order number from two months ago), and said not to be shy about
changing the architecture. He declined benchmark runs; the checks are tests
and his first daily-life video.

## What the leaders do, and what we lacked

None of them make the model search in order to feel continuous. ChatGPT
injects ~33 saved facts and summaries of ~15 recent chats; Claude injects a
synthesis rebuilt daily and searches old chats on demand; Mastra's
Observational Memory keeps a dated observation log written by an Observer and
compressed by a Reflector (94.87% on LongMemEval, no vectors); Hermes Agent
freezes two small files into the system prompt at session start; OpenClaw
loads today's and yesterday's notes and consolidates in the background.

We queried memory with the user's words on every turn, so "what did we decide
yesterday?" shares no words with the answer and a Romanian question misses an
English fact; the extractor read 300 characters per message and wrote no
dates; nothing consolidated; and the RAPTOR tree cost model calls on every
rebuild while measuring no better than scoring every turn directly
(LongMemEval n=50, 27 Sep: identical session recall, flat 2-6 points better
on turn recall at k 5-20).

## What it is now

| Part | Where | What it does |
|---|---|---|
| Observer | `memory/extractor.ts` | After a conversation, one call writes facts and dated notes (`priority \| date it is about \| sentence`). Reads whole messages, from where it stopped; runs on the first exchange, every three unread ones, after 5 quiet minutes, before compaction, at shutdown. |
| Store | `memory/observations.ts` | `observations` (notes, weekly digests) and `memory_card` tables. Scoped per speaker like facts. |
| Snapshot | `memory/snapshot.ts`, `WorkingMemory.setSnapshot` | On an owner conversation's first turn, card (or facts) + recent notes by day + digests, appended to the system prompt and frozen for the conversation (cacheable). None for guests, restricted leads, cron/eval sessions or voice. |
| Reflector | `memory/reflector.ts`, idle tick in `boot.ts` | After 10 idle minutes, at most every 4 h, when there is work: rewrites the card (≤ 250 words) and folds notes older than a week into one digest per week. Never deletes a note. |
| Search | `FractalMemory` + `buildFlatTree` | Every past turn scored directly (bge-m3 + FTS5), no clustering, no summaries. The index catches up on the idle tick. `CINDERPAW_FMS_TREE=raptor` brings the old tree back. |
| Forget / visibility | `remember forget_notes`, `memory/forget.ts`, Memory page | Notes can be forgotten by words or deleted on the page; forgetting a fact drops the card until it is rewritten. The page shows the card, the notes and whether writing works, with the reason when it does not. |

## Deliberately not done

- Eviction and cross-session dedup stay unwired: `hit_count` counts
  re-statements, not recalls, so the default policy would delete nearly every
  fact said once. See `CINDERPAW_FMS_EVICTION`.
- The RAPTOR code is still in the tree, unused by default. Deleting it (and the
  benchmark scripts and RSI arms that build trees) is post-release work.
- Notes are not in per-turn search yet; past turns are. Notes in search
  (their own FTS and embeddings) is the next step if exact details prove short.
- Nothing here is measured on a live model yet. The first daily-life video is
  the check; small local models may write vague notes, and the Memory page is
  where that becomes visible.
