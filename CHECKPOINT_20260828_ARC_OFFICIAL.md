# Checkpoint — 2026-08-28, 01:30. Ready for the official ARC-AGI-3 run.

**Everything below is COMMITTED on `main`. Working tree clean. Nothing is
running. No scorecard is open.** Credit on OpenRouter: **$8.59** of $45.

The next session opens with one decision already made: launch the official run.
The command is in §6. Read §2 before changing anything, and §7 before believing
anything.

---

## 1. The one-paragraph version

Ten commits since `8d14085`, and two of them are the session. The first: every
click the model asked for was being thrown away unsent, so every click game
scored zero and nobody knew. The second: the "imagination" the harness
advertised did nothing at all on this benchmark, measured — and now it works,
at 100% precision on the only prediction that spends nothing. In between, the
run stopped being 25 separate scorecards and became one card in competition
mode, which is what the leaderboard actually requires. Total spent finding all
of that out: **$0.83**, most of it on two aborted runs.

---

## 2. The rules, read rather than assumed — this changed the architecture

From `docs.arcprize.org`, and confirmed against the live API:

- **Competition mode is REQUIRED to appear on the leaderboard, and the API
  turns it ON BY DEFAULT.** Measured: a probe card opened without asking for it
  came back `competition_mode: true`. Every run this project ever made was
  already under those rules.
- **Scoring runs against ALL 25 environments**, played or not. Twenty-five
  separate scorecards are twenty-five results with twenty-four holes each.
- **One card, many games** is supported and is the correct shape.
- In competition mode a **game reset becomes a LEVEL reset**. `--retries` is
  therefore another attempt at the level that killed us, keeping the levels
  already cleared — which is what it should have meant anyway.
- **Rate limit 600 rpm.** 25 parallel processes are nowhere near it.
- **The 15-minute auto-close is not a clock on play.** Measured this session on
  a shared card: played, idled **18 minutes**, played again — accepted, and the
  card reported both plays. This confirms the earlier 220-actions-over-17-minutes
  measurement from the other direction. Do not reintroduce a deadline.

Consequence, implemented: `scripts/arc/arc_card.mjs` opens ONE card and closes
it; every game joins with `--card` and `--cookie`. The cookie must travel with
the id — the card is pinned to one backend — and a game that joined a card
never closes it, or it cuts off the other 24 still playing.

**The card is the result.** Its close payload carries `score`, per-game
`level_scores`, actions, resets, and a breakdown by tag (keyboard 4
environments, click 7, keyboard_click 13, 183 levels total). `report_arc_run.mjs`
prints it beside our own arithmetic; where they disagree, the server wins.

---

## 3. Bugs fixed tonight, in the order they mattered

| # | Bug | How it presented | Commit |
|---|---|---|---|
| 1 | The membership guard compared `"ACTION6:41,4"` against a list that only ever holds bare names | every click game ended at its first click, **zero presses sent**, `stoppedBecause: "invalid_action"` — a silent zero | `2572708` |
| 2 | The frugal veto substitutes from `available_actions`, which holds bare names | `lp85` died nine good clicks in; fixed at the client seam so no future caller can reintroduce it | `7262499` |
| 3 | `\n` in the frame writer became a real newline | the runner would not parse at all — every game would have died at startup | `480bee7` |
| 4 | MCTS imagination inert | see §4 | `f66a77b` |

Bug 1 is the one to remember: it had been there for every run, and it was
invisible because the game just ended early and looked like a bad policy.

---

## 4. Imagination — the measurement, and do not undo it

**What was wrong.** `imagination.ts` searches for a whole-grid transform
(rotate, mirror, recolour) because that is the ARC-AGI-1/2 task. On ten games
and 664 real presses it produced exactly **one** trusted rule, on the one game
where nothing ever happened, and the rule was
`rotate(rotate(g,270),90)` — the identity in two steps. The transition table
already knew that fact, earlier and without 8 seconds of search.

**What replaced it.** `imagination-move.ts` learns the change between two
boards. Measured forward, exactly as the policy uses it — learn from what has
been seen, predict, then look:

```
"this press does nothing"   21 said, 100% right     (was 48%)
"this press moves it"       68 said,  74% right
coverage                    13% of presses; the rest get silence
```

Silence is most of it and that is correct: the click games are not a sprite
sliding. Live on ls20 it holds 2 rules and demotes 14 of 40 presses; a learning
pass costs 0.2s.

**Four things that had to be true first, each hidden by the real data:**

1. The floor passes the same movement test as the sprite, at the opposite
   offset — it fills the hole the sprite left. On the measured game a counter
   made the floor's counts unequal and hid this completely; a four-line test
   board found it.
2. The sprite's colours appear elsewhere on the board. It is found by exact
   shape and by nearness to where it was last seen — **never by size**.
3. What stops it is LEARNED. That board lets it cross colour 5 freely, and
   assuming "not floor means wall" called two thirds of the working presses
   dead.
4. A colour is a wall only after being watched stopping it **twice, counted
   once per press** — one failure indicts every colour in front of the sprite.

**The contract that must never be relaxed:** "I cannot tell" returns `null`,
never the unchanged board. To a caller comparing grids those look identical,
and one of them demotes a press that would have worked. A prediction only ever
DEMOTES; it never vetoes.

---

## 5. What is actually in the run

IN, and each one verified as reachable from the runner's imports: model policy
(temperature 0, upstream pinned), perception (scene graph in the prompt),
transition table, no-op and revisit detection, inert-action inference
(`INERT_AFTER = 3`), frugal veto, move imagination, ACTION6 click inference,
memory across levels and retries, spend accounting, run manifest, `result.json`,
`frames.jsonl`.

OUT, and never in: BRSI, FMS, cowork, RLM subagents, SOUL.md, episodic memory,
skills, tools, the agent loop. That is run C, and it is a build, not a flag.

The A arm (`--no-imagination --no-perception`) is the bare baseline and is
still worth running once the official card is done — same games, so the delta
is attributable.

---

## 6. Launching the official run

```
bash "D:/Cinderpaw Agent/runs-arc/launch-official.sh" official-$(date +%Y%m%d-%H%M)
```

One card in competition mode, 25 games, `--retries 3`, **no action cap**,
`--max-spend 0.15` per game, GLM 5.3 Flash pinned to Z.AI at effort medium,
`source_url` pointing at the exact commit. The launcher closes the card in a
`trap` on every exit path — a card left open shows no results at all.

Watch it, in PowerShell, which is the shell this machine opens:

```
pwsh -File "D:\Cinderpaw Agent\runs-arc\watch.ps1"                       # all 25
pwsh -File "D:\Cinderpaw Agent\runs-arc\watch-game.ps1" -Game ls20-9607627b   # the board, live
```

Afterwards:

```
bun CinderpawAgent/scripts/arc/report_arc_run.mjs runs-arc/<stamp>
```

Expected cost: measured **$0.00063 per action** with perception (nearly double
the earlier estimate — completion tokens are ~1,143 per call on a real board,
not ~110). $0.15 buys roughly 240 actions a game. Worst case 25 × $0.15 =
$3.75 against $8.59 available.

**Before launching, put a monitor on it** rather than watching: one event per
game finished or crashed, plus a credit check, and an alarm under $1.20. The
run takes hours.

---

## 7. Traps — every one of these has already cost time tonight

- **Backslashes die in these Python heredocs.** `"\n"` written inside a
  `python - <<'PY'` block reached the file as a real newline and shipped a
  syntax error to `main`. Build it as `chr(92) + "n"`, or use the Edit tool.
- **The reportability gate refuses a COMPETITION card on a dirty tree, and only
  a competition card.** A practice card opens with a warning. That split is
  deliberate: a gate that makes the safe path the annoying path is a gate
  somebody switches off for the run that mattered.
- **`seed: null` still marks every run NOT REPORTABLE.** No seed was faked to
  silence it. There is no seeded randomness in the ARC decision path at all —
  the nondeterminism is the model and the live server, and temperature is 0.
  Decide what the manifest should say; do not invent a seed that controls
  nothing.
- **Do not reintroduce MCTS "just in case".** §4 is the measurement. If it goes
  back in, it must come with a game where it beats silence.
- **Do not add an action cap.** A press cap decides the score instead of
  measuring it. Money is the constraint.
- **A game that joined a shared card must never close it.**

---

## 8. Open, in the order worth doing

1. **Run the official card** (§6), then the A arm on the same games.
2. **Coverage of the move learner is 13%** — the click games get silence. A
   click model ("ACTION6 at x,y does what to the thing under x,y") is the next
   real gain, and `frames.jsonl` from `--dry-run` makes measuring it free.
3. **The dry-run policy explores badly**: 1–2 distinct actions per game, which
   is a narrow training set for the learner probes. A round-robin exploration
   policy would make the free measurements broader.
4. **Rule memory across GAMES** is still not implemented (across levels and
   retries it is). AVO names it as their lever.
5. **Run C** — supervisor, FMS, one cowork teammate. Still a build. Do it with
   the official numbers in hand so escalation aims at measured weakness.

Aborted runs from tonight are on disk with an `_ABORTED` marker naming the bug
that killed them. They are evidence, not clutter — if anyone asks why the run
was restarted twice, the answer is in the directory rather than in memory.
