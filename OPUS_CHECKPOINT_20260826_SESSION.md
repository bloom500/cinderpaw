# Session checkpoint — 2026-08-26

Everything is on **`feat/benchmark-mode-isolation`**, in
`.worktrees/val23-benchmark`. **23 commits are UNPUSHED** (origin is at
`f7f20b8`). Working tree clean. That branch now contains the ox-alpha stack,
cowork, and all of today's work — it is the tip, not a side branch.

## Waves

- **Val 4 (merge) — DONE.** ox-alpha + cowork combined and green. The gate's
  only red was never the merge: `cargo check` fails in any fresh worktree
  because `src-tauri/binaries/cinderpaw-agent-<triple>.exe` is a gitignored
  build artifact. Both verify scripts now build the sidecar first.
- **Val 2.3 + 2.4 — DONE.** `CINDERPAW_BENCHMARK_RUN_ID` turns on both isolations:
  the network narrows to `CINDERPAW_BENCHMARK_ALLOW_HOSTS` at BOTH exits (egress
  proxy AND inference router — model traffic uses the global fetch and never
  touches the proxy), and `cinderpawHome()` returns `<home>/runs/<runId>`.
- **Val 3 — NOT STARTED**, by decision: no official ARC run until the systems
  are stable.

## The profile-dir split (the largest find)

Rust migrated `~/.feral` → `~/.cinderpaw` on 2026-08-21. The sidecar and the
Go TUI never learned. Consequences, all fixed:

- Two live profiles diverging for five days (connectors saved in one, invisible
  in the other, no error anywhere).
- **The fs deny wall guarded the wrong directory**, so `~/.cinderpaw/byok.json`
  and `connectors.json` were readable by the agent's own tools.
  `agentProfileDirs()` now returns BOTH; fixing only `cinderpawHome()` would have
  flipped which one was exposed.
- The TUI's `cinderpawHome()` did `MkdirAll`, so merely running it RECREATED the
  legacy dir — after the cleanup that made the Rust host refuse to boot.
- **Both test suites wrote into the live profile.** `bun test` overwrote a real
  connector allowlist; `go test` recreated `~/.cinderpaw`. Both isolated now, both
  setting the WEAKER variable (`CINDERPAW_HOME`/`HOME`) so per-test overrides win.
- Three TS tests hardcoded `.cinderpaw` themselves, which is why none of it was
  caught.

`~/.feral` is gone from this machine. Backup: `~/cinderpaw-home-backup-20260826`
(includes the 2026-08-26 RSI journal half that could NOT be merged — each daily
journal file is its own hash chain starting at GENESIS).

## Cowork — module complete

`cowork.ts` and its boot registration **had never been committed** — every
branch carried the engine without the lever. Now committed, plus:

- Approval gate follows delegation (`subagent:cowork:<id>:<sa>` used to walk
  around a denied call). Hop cap moved onto the THREAD so `cowork_send` cannot
  reset it.
- `cowork_create_teammate` — a roster could previously only be made by a seed
  script or by hand-editing SQLite. Registered ALWAYS, and it registers
  `cowork_team`/`cowork_send` itself on the first teammate, which removes the
  "requires a restart" caveat boot.ts admitted to.
- **Per-teammate tool scoping**, reusing the connector-profile seam. This is
  also the speed answer: unscoped, every teammate advertised the whole registry.
- Panel rewritten as a group chat using the app's own `MessageItem` language,
  with a typing row that names who is working and for how long, real roster
  names, markdown, direct messaging, per-teammate stop, and per-thread replay
  from the mailbox.
- Speed: Atlas ~4 min / Bolt 10–15 min. Bolt's was a bug — the roster drained
  SERIALLY, so Bolt waited out Atlas's whole turn. Now `Promise.allSettled`.
  Atlas's four minutes are prompt size, addressed by tool scoping.

## invoke() camelCase — three approval gates never worked

Tauri converts camelCase JS keys to snake_case Rust params, so passing
snake_case fails. `cinderpaw_code_patch_resolve`, `cinderpaw_lora_review_resolve` and
`cinderpaw_cowork_approval_resolve` all shipped broken. The gates themselves held
(nothing was wrongly approved) — what did not work was the human saying YES.
A guard now scans for snake_case invoke keys.

## ARC

`OPUS_CHECKPOINT_20260826_ARC_STACK.md` has the map. Seven tested modules, 135
tests, and nothing composing them. The shape problem: MCTS maps `{input,
output}` pairs (ARC-AGI-1/2 transduction) while ARC-AGI-3 is interactive.

Darius settled the design: the two approaches are **complementary**. Built:

- `src/arc/environment.ts` — the seam a real client will implement.
- `src/arc/play-level.ts` — observe → decide → act, with hard action
  accounting. A level scores `(human/ai)^2`, so double the actions is a
  QUARTER of the score. Thinking is free; a keypress is not.
- `src/arc/imagination.ts` — an ACTION IS AN EXAMPLE PAIR (grid before, grid
  after), so the existing search applies unmodified and the agent can rehearse
  a move for free. Confidence is measured against every pair, never taken from
  the search's verdict.

Human baseline is unpublished but bounded: AVO scored 100.00 RHAE with 6,624
actions, so the human total is ~6,600+, NOT the 4,000 we had guessed.

## Tokens

`OPUS_CHECKPOINT_20260826_TOKENS.md` has the measurements. ~70% of everything
sent is the fixed prefix; the conversation is under 6%. **Prompt caching works
at 41.9%** — that had been an open unknown twice.

- `token_usage` tool added (the accounting existed with no caller anywhere),
  then immediately drawered: it was costing ~260 tokens per completion, caught
  by the monitor within minutes.
- **Notebook ON by default, owner-only.** Verified by running it: two tool
  calls in one cell is ONE completion. Enabling it cost +1,481/completion
  (mostly 1,246–1,490 of "doctrine"), so it must cut 12.2% of completions to
  break even. Preliminary verdict UNFAVOURABLE: 41,473 tokens of doctrine
  against 60 tokens of use — but the session was mostly conversation, not tool
  work, so it is not a verdict yet.
- Enabling it exposed an older hole: a connector persona with no `personaTools`
  compiles to `allowed = null`, and both gates read `profile?.allowed && …`, so
  a null allow-list skipped the check entirely. `OWNER_ONLY_TOOLS` now tests
  the PRESENCE of a profile.
- `src/tools/tool-intent.ts` — the MoE-shaped router. **Written and tested, NOT
  WIRED.**

## Open, in the order I would take them

1. **Wire `tool-intent`** — but FIRST verify where the cached prefix is built.
   If the prefix is rebuilt per turn anyway, selecting per session buys
   nothing; if selection changes it per turn, we lose the measured 41.9%.
2. **Notebook verdict** — needs a session of real tool work. If it stays
   unused, shorten the doctrine (most of it enumerates all 88 tool
   identifiers, duplicating `buildCapabilityIndex`) or drop it.
3. **MCP pruning** — 41 extension tools ≈ 2,300 tokens per completion. No code.
4. **ARC policy** — the only thing that moves the score. Needs the client too.
5. **TTT wiring** — the trainer is live in `dispatch.ts`; only the trigger
   decisions are missing.
6. **Approval-gate classes** — still 2 of 39 tools, though per-agent tool
   scoping now covers much of the risk.
7. **Cowork on CLI/Discord** — unverified. The tools register everywhere, but
   `cowork_event` rides the Tauri transport and approvals have nowhere to
   appear.
8. **Scroll bounce** — `will-change` removed from `.word-fade` (a compositor
   layer per word). A CANDIDATE, not a confirmed diagnosis.

## Method notes worth keeping

- Individual tool calls are NOT in `~/.cinderpaw/logs/cinderpaw.log`. Grepping
  it for `tool_start` returns zero whether or not tools ran — it cost one wrong
  conclusion here. `costReport(db, {since})` is the instrument.
- Verify before fixing. Two "bugs" this session were already fixed, and the
  Brain-Stack cache concern was wrong (`CINDERPAW_BRAIN` defaults to false).
- Do NOT write files containing backslashes through Python heredocs. It
  silently mangled a regex escape twice today, in a test whose whole job was
  proving a regex escape.
