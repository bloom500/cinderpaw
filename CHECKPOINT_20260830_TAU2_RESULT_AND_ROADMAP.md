# Checkpoint — tau2 result, the session-bricking bug, and the road after 2 Sep

Written 2026-08-30 to hand this to a session that starts on **2 September**, when
the weekly quota resets. **Verify before trusting.** Two checkpoints in this repo
have already claimed things that verification contradicted, so every claim below
carries the command that re-checks it, and anything that is a judgement says so.

Branch `fix/arc-run-survives-errors` · last commit `86ebd3d`

---

## 0. The number that stands

**Cinderpaw 82.0% (41/50) against the reference `llm_agent` 86.0% (43/50)**,
airline domain, `z-ai/glm-5.3-flash` on both arms, user simulator
`gemini-2.5-flash`, `--max-steps 200`, concurrency 1. Both arms on this harness
on 2026-08-30, roughly two hours apart.

```bash
python scripts/tau2/compare_arms.py \
  vendor/tau2-bench/data/simulations/20260830_120916_airline_cinderpaw_* \
  vendor/tau2-bench/data/simulations/20260830_151946_airline_llm_agent_*
```

Shape, not just score:

| | Cinderpaw | llm_agent |
|---|---|---|
| reward | 0.820 | 0.860 |
| db_match | 42/50 | 44/50 |
| read actions | 88/91 (96.7%) | 89/91 (97.8%) |
| write actions | 36/49 (73.5%) | 39/49 (79.6%) |
| MAX_STEPS | 0 | 0 |
| termination | 50/50 USER_STOP | 50/50 USER_STOP |

**This run is clean and it is the one to publish.** Zero `run in flight`
rejections, zero MAX_STEPS, every task terminated normally. It was NOT affected
by the bug in section 2 — verified:

```bash
grep -ho 'already has a run in flight' bench-results/tau2-events/*.jsonl | wc -l   # 0
```

### Where the four points went — read this before "fixing" anything

Every Cinderpaw failure has `COMMUNICATE = 1.0`. We lose **only** on `db_match`.

- Cinderpaw-only failures: 8, 15, 18, 32, 33, 40
- llm_agent-only failures: 11, 17, 29, 35
- both arms fail: 7, 39, 44

Cause by task, read out of the trajectories rather than guessed:

| Task | What actually happened |
|---|---|
| 8, 40 | **Passenger ordering.** Ground truth puts the account holder first; we put the companion first. Every other field identical. |
| 18 | Five reservations updated with the right flights but the wrong `payment_id` — one credit card everywhere, where the baseline used each reservation's original method. The domain policy DOES reach the sidecar intact (0 compaction events measured). |
| 15, 44 | Searched, presented options, never acted. Zero writes. |
| 32, 33 | Malformed argument shapes, partly caused by the two bugs fixed in section 1. |
| 7, 39 | Fail identically in BOTH arms. Not a Cinderpaw defect. |

**Judgement, stated as judgement:** tasks 8, 18 and 40 are reasoning misses, not
harness defects. Tuning behaviour to fix passenger order or payment-method choice
would be fitting to these 50 known tasks and would make the number unpublishable.
Do not do it. If it is done anyway, say so next to the number.

---

## 1. Shipped 2026-08-30 — `86ebd3d`, two real product bugs

Both found by reading trajectories rather than the score. Both affect ordinary
installs, not just benchmarks. 3,627 bun pass, 0 fail, `tsc --noEmit` clean.

**`selectTools` withheld every tool it had never heard of.**
`tool-intent.ts` states its own first rule as FAIL OPEN — remove a tool only with
a positive reason. The filter did the opposite: `core.filter(n => wanted.has(n))`
dropped every name absent from the hand-written intent maps, and those maps list
only Cinderpaw's built-ins. So an MCP server's tools, a forged tool, or a host's
domain tools were all read as "not needed".

With `CINDERPAW_HOST_TOOLS` set the core set IS the host's tools, none of them
named in those maps, and the selection is pinned for the whole session on the
first message. Airline task 8 shows the cost: five rejected `book_reservation`
calls guessing `trip_type`, `travel_type`, `payload_version`,
`payment_method_id`, and a boolean `insurance` — every one of them answered by a
schema the model was never shown. 89 `load_tool` calls across 50 tasks say how
routine this was.

**A call the model serialised twice.** The whole call ends up in the name slot
with empty arguments. Reporting that as `unknown_tool` is true and useless, so the
model retried the identical shape with different whitespace four times and never
escaped. The unwrap lives in `registry.call` — the one door every caller comes
through — and fires only when the outer name misses and the inner one hits, so a
genuinely missing tool still reports as missing.

---

## 2. THE BUG TO FIX FIRST — a session that bricks itself forever

`boot.ts:2032`:

```
[cinderpaw] desktop: <sessionId> already has a run in flight — not starting a second
```

`runStore.begin()` returns null, the turn returns null, and the user gets
**"I wasn't able to answer that. Please try again."** — with nothing on screen
saying why. Every later turn in that session hits the same guard. The session is
dead and cannot recover.

In one observed trajectory the customer repeated the same request **eight times**
and got the same dead sentence each time. This is the CLAUDE.md failure shape
"the message only I can read": the reason is in stderr, on nobody's screen.

### The sequence, from `bench-results/ev-armC/*ed0dcd3.jsonl`

1. several turns of `I wasn't able to answer that` /
   `Not finished. After 1 turn I couldn't produce a usable answer`
2. a confirmation standoff — the agent insists on an explicit go-ahead
3. `Understood — proceeding with the downgrades now, one reservation at a time.`
4. `safety-point: ...\workspace snapshotted at c023b62f (shadow)`
5. **`already has a run in flight`** on the next turn, and every turn after

Working hypothesis, NOT verified: the turn returns its text while the run row
stays open (unattended continuation), so the next orchestrator message is refused.
**Verify this before designing a fix** — that is the tau2 lesson in section 4.

### It is NOT the code committed on 2026-08-30

Three arms, same three tasks (8, 18, 33), same day:

| arm | tree | `run in flight` | MAX_STEPS |
|---|---|---|---|
| A | HEAD (`86ebd3d`, both fixes on) | 20 | 1 |
| B | `tool-intent.ts` reverted | 29 | 2 |
| C | **both fixes reverted — tree == `25c9e88`, the state that scored 82%** | 22 | 1 |

All three scored 0/3. Reverting changes nothing, so `86ebd3d` is exonerated and
stays. The other agent's commits that day (`25c9e88`, `38d6c2a`) touch only Rust
and React — no sidecar file — so they are excluded too. Machine load was 17% with
no competing build.

```bash
for d in tau2-events tau2-events-canary ev-armA ev-armB ev-armC; do
  echo "$d: $(grep -ho 'already has a run in flight' bench-results/$d/*.jsonl 2>/dev/null | wc -l)"
done
# tau2-events 0 (the clean 50) - canary 43 - A 20 - B 29 - C 22
```

**Unexplained and worth chasing first:** the clean run used no `--task-ids`; all
four broken runs did, on hard tasks. The same tasks 8, 18 and 33 ran clean inside
the full 50 that morning. Either the subset path differs, or something drifted
between 12:08 and 17:20 that day. This is the open question.

### Junk to ignore or delete

An aborted full run left an incomplete directory —
`vendor/tau2-bench/data/simulations/20260830_190113_airline_cinderpaw_*` and
`bench-results/ev-full2/` (1 file). **Not a result.** Delete or ignore; do not let
it be read as a run.

---

## 3. The road, in the order Darius set it

1. **One more full tau2 airline run** — the FINAL number to post. Cinderpaw arm
   only, ~3h, ~$1.13. Do NOT re-run the baseline: the reference agent has not been
   touched, and its 86% was measured on this harness the same day. Prerequisite:
   section 2 fixed, or at minimum understood well enough to know the run is not
   measuring it.
2. **Terminal Bench** — first because the bridge is cheap: shell, files and the
   notebook already exist and are exercised daily; the environment is a container,
   not a simulated company.
3. **TheAgentCompany** — the one that matters. See section 4.
4. Optional: **GAIA**, **tau2 retail** (114 tasks, 112 with expected actions,
   `reward_basis` is `DB` + `NL_ASSERTION` rather than airline's `COMMUNICATE` +
   `DB`, and there is no published OpenRouter number for our model, so it needs
   our own baseline arm).
5. **Pre-release**: UI/UX and backend, desktop app + CLI + cross-platform.

---

## 4. Before TheAgentCompany — the question that decides everything

**Find out what the scorer reads, before designing any bridge.** tau2 cost a whole
design iteration on exactly this: it grades a *fresh environment replayed from the
recorded trajectory*, not the live environment the agent worked in, so a tool call
that never entered the transcript did not happen. The first bridge wrote correctly
to the live DB and would have capped at 7/50 while looking wired up and merely weak.

If TAC grades **environment state at checkpoints**, the problem inverts: no
tool-call routing is needed, and Darius's framing — "the benchmark is a connector
into my runtime, not extra engineering" — is essentially right. Verify it in TAC's
evaluator source. Nothing else should be planned until that is known.

### What tau2 did NOT measure, and must be said next to any TAC plan

Airline ran with a fresh `CINDERPAW_HOME` per task, so: **no MCP extensions, no
skills, no soul, no cross-task memory, no settings**, brain disabled, built-ins
behind the drawer, and the notebook unable to call domain tools — the largest
measured token lever, unavailable. The honest phrasing for that number is
**"Cinderpaw's agent loop"**, not "Cinderpaw".

TAC is where the full stack can actually engage. Two cautions before turning
everything on:

- **MCTS was measured inert on ARC-3** and is marked "do not put it back without
  evidence". Turning it on unmeasured repeats a mistake already made once.
- **Cross-task memory does not engage** — `semantic` stays at 0 rows and `recall`
  is never called. TAC is precisely where one would want to claim memory helps.
  Publishing a TAC number with memory inert would misdescribe what was measured.

**Instrument which subsystems actually fire.** A number from "everything on" that
cannot be attributed teaches nothing: a win has no cause and a loss has no fix.

---

## 5. What the benchmark has already paid for

Fifteen commits, most of them product bugs the benchmark surfaced before it
produced any score: host tools, tool tiering (16,488 to 10,830 tokens of prefix),
a notebook that could not host-call, a drawer that reported "no such tool" for a
tool it already had, a customer being told to "try a larger model", and the two in
section 1. That is the argument for doing the next three — not the leaderboard row.
