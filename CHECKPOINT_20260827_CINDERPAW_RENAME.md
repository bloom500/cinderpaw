# Checkpoint — 2026-08-27, 02:00

**Written at end of session. Nothing below has been committed. No work in progress.**

Darius's call, verbatim: *"vreau ca totul sa fie clean… vreau sa fie Cinderpaw in TOT
repo, comenzi, cod, dir, fisiere, comenzi CLI, TOT"* — then back to UX.

---

## 1. Read this first: the version confusion is real and has a cause

Darius: *"azi m-am incurcat intre versiuni, una are landing screenul vechi alta
versiune are loading screen nou, worktrees amestecate, such a mess."*

There are **four worktrees on four branches**, all clean, all diverged from `main`:

| Worktree | Branch | Ahead of `main` | Has `299c26b` |
|---|---|---|---|
| `D:/Cinderpaw Agent` (main checkout) | `feat/cowork-s4-approval-gates` | 14 | **NO** |
| `.worktrees/mcp-index` | `fix/mcp-capability-index` | 150 | yes |
| `.worktrees/val23-benchmark` | `integration/mega-release` | 153 | yes |
| `.worktrees/fix-lora-trainer-home` | `fix/setup-lora-trainer-home` | 101 | yes |

`main` itself does **not** have `299c26b`.

**That table is the whole explanation for the screen confusion.** The primary
checkout sits on a branch that is 14 commits off `main`, while three others carry
101–153. Whichever one was last built is what was on screen. Nothing is corrupted;
they are just four different points in history.

**Decision needed at the start of tomorrow, before any code is touched:**
which branch is the trunk for this work? Everything else follows from that answer,
and picking it late is what produced today's mess.

Recommendation: `integration/mega-release` (153 ahead, has everything) becomes the
base; the cowork work rebases onto it. But this is Darius's call, not mine.

---

## 2. The duplicated-work trap — check this before writing a line

Commit **`299c26b`** — *"fix(paths): the sidecar and the host were on two different
profile dirs"* — already implements the sidecar half of the rename **and** the
`agentProfileDirs()` deny wall. It exists on three of the four branches.

This session re-implemented it from scratch on `feat/cowork-s4-approval-gates`
without checking. Cost: a duplicate half-day.

**Run this first, every time:**

```
git merge-base --is-ancestor 299c26b HEAD && echo "already have it" || echo "missing"
```

The memory note `profile-dir-rename-was-half-done` said the fix landed on
`feat/benchmark-mode-isolation`. It was read as history rather than as a branch
check. Read memory notes as *"is this true of MY branch?"*, not *"was this done
once?"*.

---

## 3. Scope of "Cinderpaw in TOT repo"

Measured, not estimated:

- **~400 tracked files** contain `feral` case-insensitively, excluding
  `node_modules`, lockfiles, `CHANGELOG` and `docs/`.
- **2 filenames** still carry it:
  - `docs/adr/0009-feral-evolution-runtime-naming.md`
  - `scripts/lora-trainer/feral_lora_trainer.py`
- Per-surface reference counts taken this session: Desktop Rust 175,
  crates (core/cli) 454, Sidecar TS 733, Frontend TS 234.

Those totals are **before** deduping identifiers that are internal-only.

### The split that must be agreed before mass-editing

Not every `feral` is equal. Three categories, and only Darius can rule on the third:

1. **User-visible** — strings on screen, command names, directory names, env vars,
   binary names. Must all become Cinderpaw. Largely done (see §4).
2. **Internal identifiers** — `feralHome()`, `FERAL_*` schema keys, Rust
   `feral_dir()`, CSS classes `feral-startup-*`. Invisible to users. A blind
   rename here is a very large diff for zero user-facing change, and it will
   conflict with every open branch. **Recommend: do this as its own commit,
   after the branches are unified, never mixed with behaviour changes.**
3. **Deliberate legacy back-compat** — must NOT be renamed:
   - `LEGACY_HOME_DIR_NAME = ".feral"` (sidecar, Rust, Go) — machines that
     predate the migration still live there.
   - `readEnv()` / `crate::env::env_var()` `FERAL_*` fallbacks — a variable set
     in a shell profile a year ago must keep working.
   - `install.rs` probe lists (`feral`, `feral-agent`, `feral-tui`, `~/src/feral`)
     and the `apt remove feral` hints — an upgrade from an old install has to
     find the old install.
   - npm `bin` alias `feral` in `CinderpawAgent/package.json`.
   - `agentProfileDirs()` returning **both** dirs — this is a security control,
     see §5.

---

## 4. Uncommitted work in the primary checkout — 70 files

All on `feat/cowork-s4-approval-gates`, all verified green, **none committed**.

### 4a. Cowork transcript panel — UX audit fixes
P0 1–4, P1 5–9, P2 10–14 from the audit. Highlights:
- Encoding repaired: both files had a BOM + UTF-8 read as CP437, producing 9
  pieces of on-screen mojibake (the close button rendered as `Γ£ò`).
- Composer / Stop / history replay had **no backend at all** — built it:
  `mailbox.thread()` → `cowork_send_message` + `cowork_history` in `dispatch.ts`
  → `feral_cowork_send_message` / `feral_cowork_history` in Rust → TS bridge.
  `coworkStop` reuses `feralStopGeneration("cowork:<id>")`, no new Rust.
- Approval rows now show **what** is being approved (the test assertion for
  `rm -rf dist/` had been weakened; restored).
- Agent names now flow from the roster via a single `emitCoworkEvent` in `boot.ts`.
- Drag position never persisted (`posRef` frozen by an empty dep array); resize
  measured from the viewport instead of the panel; persisted size drifted smaller
  every session.

### 4b. Rename work (overlaps `299c26b` — see §2)
- Sidecar home → `~/.cinderpaw` with legacy fallback (`brand.ts`, `config.ts`,
  `soul-loader`, `user-loader`).
- `agentProfileDirs()` ported from `299c26b`; deny wall now covers **both** dirs.
  Verified: `[ "C:\Users\Darius\.cinderpaw", "C:\Users\Darius\.feral" ]`.
- **Not in `299c26b`, genuinely new:**
  - Migration guard `bail!`ed when both homes existed unmarked → the app refused
    to start, permanently, on the second launch after the rename. Now
    `LeftoverLegacyHome`: use the new home, touch nothing, tell the person once
    (receipt at `~/.cinderpaw/.legacy-home-notice`), on a background thread so it
    never blocks startup.
  - Go TUI was untouched by `299c26b`: read `~/.feral/api-token`, so it minted a
    token the gateway no longer read; `--wizard` only worked on Windows (marker
    path built by backslash concatenation). New `tui/api/home.go` resolver.
    Module renamed `feral-tui` → `cinderpaw-tui`; binary built as
    `cinderpaw-tui.exe` (the CLI already probes that name first).
  - 21 Rust call sites read `std::env::var("FERAL_*")` directly, bypassing
    `crate::env::env_var` — so `CINDERPAW_API_KEY` and friends did nothing.
    All routed through the helper. Added `env_var_uncached` for
    `FERAL_AGENT_WORKSPACE` and `FERAL_ENABLE_CODE_EXEC` (security boundaries
    read per call; a cached answer would lag its own setting).
  - Host now hands the sidecar the **modern** env names, so the app stops
    emitting a deprecation warning about itself on every boot.
  - Visible strings: TUI wordmark `◉ FERAL` → `◉ CINDERPAW`; all `feral:`
    message prefixes → `cinderpaw:`; suggested commands (`feral setup`,
    `feral chat`, `feral providers`, `feral gateway start`) → `cinderpaw …`;
    `"feral-agent is not running"` → `cinderpaw-agent` (21 sites).

### 4c. Provider fix
`egress/inference-providers.ts` read only `delta.reasoning_content`. **OpenRouter
normalises the field to `delta.reasoning`**, so any reasoning model behind
OpenRouter had its chain-of-thought silently dropped. Both spellings now read, on
the streaming and non-streaming paths, plus a once-per-stream log line naming
which field the provider actually used.

### Verification on the current tree
3218 sidecar · 325 core Rust · 27 CLI Rust · 470 frontend (54 files) · 4/4 Go
packages · `tsc` clean both TS projects · `cargo check` clean.

---

## 5. Do not undo these

- **`agentProfileDirs()` must return BOTH `~/.cinderpaw` and `~/.feral`.** The
  migration never deletes the source, so the old directory keeps a full copy of
  `byok.json`, `connectors.json` and conversations forever. Guarding only the
  current one leaves the other readable by the agent's own fs tools — and which
  one that is flipped silently the day the host migrated. Fixing `feralHome()`
  alone merely swaps which directory is exposed.
- **The migration guard must never be fatal again.** An app that refuses to open
  is not the safer app; it is the same lost archive with an extra step.

---

## 6. Open, unresolved

**Streaming truncation at tool call — NOT solved.** Reported symptom: the agent's
narration is cut mid-word right before a tool call. Measured fragment lengths
91 / 115 / 124 / 276 / 146 chars, so it is not a fixed `slice(0, N)`.

Ruled out with evidence, not by reading:
- `createStreamHoldback` (sidecar) — driven character-by-character with the real
  Romanian prose × 5 tool-call formats, `resolve(false)`: **zero loss** in all five.
- `trimDanglingToolCallTag` — only strips trailing empty `<tool_call>` tags.
- `reasoningTail` seam-heal — has `flushReasoningTail()` at end of stream.
- Transport — `chunk` and `tool_start` share one ordered channel, no batching.
- `stripStreamingToolCalls` (frontend) — none of its three alternations match
  plain prose.

Found but not fixed, because the fix would be wrong: `useCinderpaw.ts:412`
discards the authoritative `done` content whenever the accumulated stream is
non-empty, so any streaming loss becomes permanent — including in what is saved
to Recent. Preferring `finalContent` would be worse: it holds only the last
segment, so it would erase the prose from before every tool call.

**Three questions that discriminate — ask Darius when he next hits it:**
1. Does `[cinderpaw] reasoning stream: provider uses '…'` appear, and with which value?
2. On a truncation, does reopening the chat from Recent bring the missing text back?
3. Does it happen on a model **without** reasoning?

The OpenRouter `delta.reasoning` fix in §4c is real but does **not** on its own
explain a mid-word cut. It is not being claimed as the cause.

---

## 7. Suggested order for tomorrow

1. **Pick the trunk branch.** Nothing else starts until this is decided (§1).
2. **Unify the worktrees onto it.** Four branches, 14–153 commits ahead, is the
   root of the screen confusion.
3. **Commit the 70 files** — probably split: cowork UX, rename, provider fix.
   Resolve the `299c26b` overlap in `config.ts` (recommendation: drop this
   session's sidecar half, cherry-pick `299c26b`, keep everything else).
4. **Then** the full-repo rename, as its own commit, with the §3 category split
   agreed first.
5. **Then** back to UX. The cowork panel audit is delivered; item 15 (keyboard
   repositioning of the panel) was deliberately skipped and is still open.

Nothing in §4 is committed. Nothing is half-applied. The tree is green as it
stands.
