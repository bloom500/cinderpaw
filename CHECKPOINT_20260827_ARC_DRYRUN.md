# Checkpoint — 2026-08-27, 20:20. ARC-AGI-3 dry run, paused for quota.

**All work below is COMMITTED on `main`.** Working tree clean apart from this
file. The run is stopped; nothing is in flight.

Resume condition: Claude quota resets ~22:20. The plan is to run all 25 games
in parallel then.

---

## 1. The one-paragraph version

The ARC harness existed but had never once completed a game. Seven separate
bugs stood between it and a scored run, and every one was found by a free or
sub-dollar probe rather than by a paid run. They are all fixed, tested and
committed. Total spent on OpenRouter today: **~$0.05** of $4.43.

---

## 2. What was wrong, in the order it was found

| # | Bug | How it presented | Commit |
|---|---|---|---|
| 1 | Cowork panel followed you into every chat | see §6 | `ee18e79` |
| 2 | Agent DB: app opened an empty file beside a full one | agent knew nothing, no teammates | `ea195fa` |
| 3 | Session affinity started at RESET, not at scorecard open | `game <id> not found` for an id from `/api/games` | `fd60364` |
| 4 | Doubled `/v1` in the OpenRouter base URL | 404 page of HTML | `f60d724` |
| 5 | OpenRouter routed one model to five upstreams | 158x latency spread, empty answers | `f60d724` |
| 6 | Perception inert on every real grid | silently no scene in prompt | `452c528` |
| 7 | 15-minute "deadline" that does not exist | would cut every game at ~50 presses | `f5c1579` |
| 8 | No retry: one 500 killed a whole game | 10 of 25 games died in the first minute | `f85b880` |
| 9 | Bare `ACTION6` sent without coordinates | `500 — the server is overloaded` | `114e249` |

Bug 9 is the instructive one: the server's own error message sent us chasing
load that was never there. **Every failure in both parallel runs was ACTION6
and nothing else.**

---

## 3. Measured facts — do not re-derive these

**The 15-minute scorecard limit is NOT a cap on play.** Measured: one card, 220
actions over 17 minutes, every one `200`, and `close` reported `actions: 220`,
`level_actions: [220,0,0,0,0,0,0]`. The auto-close finalises an *abandoned*
card so its results appear. Do not reintroduce a deadline.

**OpenRouter routes per request.** One prompt, one body, five upstreams:

```
Z.AI       3.8s      95 out tokens   answer present
Together   4.4s     885              answer present
GMICloud  16.5s     522              answer present
Novita   191.3s  16,000              answer EMPTY
Io Net   602.0s   9,426              answer EMPTY   (with effort: low!)
GMICloud 737.0s  65,536              answer EMPTY
```

Pinned to Z.AI at `effort: medium`: 3.4s / 5.4s / 10.3s / 15.0s / 22.2s, answer
present every time. **Never run unpinned.**

**Latency on a REAL grid is far worse than on a synthetic one.** Pilot on ls20,
Z.AI, medium: **~57s per action**. Synthetic probes said 5-15s. Budget from the
real number.

**Scoring** (docs, verified): `level = (human_baseline/ai)^2` capped at 1.15x;
`game` = weighted average of levels by 1-indexed level number; an unfinished
game is capped by levels never reached (4 of 5 ⇒ 66.7% max); `total` = mean of
game scores.

**Human baselines, from the API.** 25 games, 183 levels, **17,135** actions to
finish everything. Median per game **638**. ls20 = 776 over 7 levels.

**NVIDIA AVO** (their blog): 100.00 using **6,624 actions** total — *fewer* than
the human baseline, which is how they hit the 1.15x cap everywhere. Claude
Opus 5 alone scores 30%. Their stated lever is persistent memory across
attempts; they explicitly rejected a programmatic world model (which is what
our `imagination.ts` is).

**Perception cost, measured.** ls20 opening frame: 1,487 non-background cells,
parses in **6ms**, 17 objects, 272 relations, renders to 9,054 chars — more than
twice the 4,159 the grid itself costs. Pathological case (scattered grid): 819
objects, 346,205 relations, **32ms**. CPU was never the risk; the prompt is.

---

## 4. Run configuration that is now correct

```
bun CinderpawAgent/scripts/arc/run_arc_agi3.mjs \
    --game <id> --model z-ai/glm-5.3-flash --provider Z.AI \
    --reasoning-effort medium --budget 200 --max-spend 0.12
```

- `.env` (gitignored) holds `ARC_API_KEY`, `OPENROUTER_API_KEY`,
  `CINDERPAW_CLOUD_IDLE_TIMEOUT_MS=900000`. That last one MUST be in the
  environment: `config.ts` snapshots env at import and `run-manifest.ts` imports
  it statically, so setting it inside the runner is always too late.
- Run from the REPO ROOT so bun loads `.env`.
- `--budget` is HARD locally. The server can still count slightly more: a
  retried ambiguous 500 may double one press, and RESETs are counted separately.
- `--max-spend` is per PROCESS (= per game). 25 x 0.12 = $3.00 max exposure.

**Parallelism: 25 at once is fine.** The failures were never load — they were
ACTION6. Games share nothing (own scorecard, own guid, own policy). Stagger by
~6s anyway, it costs nothing.

---

## 5. Systems in the run

IN: MCTS rehearsal (`imagination.ts`, wired `65702e0`), DSL
(`rlm/dsl/primitives`), perception (`scene-graph`, in the prompt `514874f`),
frugal policy + transition table, persistent memory across levels and retries,
budget accounting, run manifest.

OUT, and not by a flag — the code path never imports them: BRSI (`src/rsi`),
FMS (`src/memory`), cowork, RLM subagents, SOUL.md, episodic/semantic memory,
skills, tools, the agent loop. `grep` for them under `src/arc/` returns nothing.

Note: `src/rlm/dsl/primitives.ts` IS used — that is the DSL library, not the RLM
engine. Easy to misread.

---

## 6. Non-ARC work committed today

- `ee18e79` cowork panel: per-thread transcript, chat-head bubble with the
  unread count top-right, tail colour, z-order, resize floor (the clamp put the
  floor inside the min, so a short window collapsed the panel and took its own
  resize grip with it), unread counting a thread switch as new mail.
- `fee9fa1` mascot: the last tool bubble never left the screen — the linger
  timer only ran on `tool_done`, so any turn that ended without one left it
  there forever.
- `ea195fa` agent DB: see §2. `~/.cinderpaw/agent/feral.db` was the real one and
  the host opened an empty `cinderpaw.db` beside it.
- Three stale worktrees removed; all three were 0 commits ahead of `main`.
  `.worktrees/val23-benchmark` is still on disk as an orphan (18 GB) — git no
  longer knows it, deleting it is safe.

---

## 7. Open, and what to do next

1. **Run 25 in parallel** with the config in §4 after the quota reset.
2. **`--no-imagination` / `--no-perception`** exist so the delta of each is
   MEASURED on a matched pair, not asserted. Do this before publishing any
   number.
3. **`cinderpaw-self` skill does not exist anywhere.** `AGENTS.md:63` tells the
   agent to load it; the installed skills are `feral-self` / `feral-connectors`
   (pre-rename names, user data, not in the repo), and neither manifest ships a
   `*-self` skill at all. On a fresh install that instruction points at nothing.
4. **Rule memory across GAMES** is not implemented (across levels/retries it is).
   AVO's lever. Cheap, and worth trying if the run shows repeated rediscovery.
5. `--budget 200` finishes maybe 1-3 of 7-9 levels. That is fine for a dry run;
   for a scored run the budget should come from the game's own baseline.
