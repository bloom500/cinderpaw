# Context for an external audit

Read this first. It exists so an auditor spends its budget on real defects
instead of re-reporting decisions that were made on purpose.

Nothing here is off limits. If you think one of these decisions is wrong,
say so. Just say it as "this decision is wrong, because", not as "bug found".

## The shape of the repo

| area | path | scale |
|---|---|---|
| Rust core | `crates/cinderpaw-core` | the privacy, storage, TTS, inference and RSI logic |
| Rust CLI | `crates/cinderpaw-cli` | terminal entry point |
| Desktop shell | `src-tauri` | Tauri host, bridges into the core |
| Agent runtime | `CinderpawAgent/src` | TypeScript, the agent loop, memory, tools, egress |
| UI | `frontend-react` | React |

Roughly 500k tokens of Rust and 1.2M of TypeScript excluding tests. It does
not fit in one context. Audit one area at a time.

**Scope the audit with `git ls-files`, not by walking the filesystem.**
The working tree contains `.worktrees/`, which holds full copies of the repo on
other branches, plus `node_modules`, `target` and `vendor`. Walking the disk
reads the same source five times and audits stale branches as if they were
current. Counted one way there are 109 `ponytail:` comments; counted the other
way, 550. Only the tracked files are the product.

## Decisions that are not bugs

**On-device TTS is off on Linux, on purpose.**
`piper` and `kokoro` both ride ONNX Runtime, which has a glibc floor higher
than the distros we target. Enabling them would produce a binary that fails to
start on the machines it was built for. See the comment at
`.github/workflows/release.yml:75` and the feature block in
`crates/cinderpaw-core/Cargo.toml`. Do not recommend adding them to the
default feature set.

**Native features are optional and off by default.**
`inference`, `whisper`, `piper`, `kokoro` all pull native toolchains. Off by
default so a broken toolchain cannot block the workspace build. The desktop
build turns on what each platform can carry. `tts::catalog()` reports an
engine as unavailable when its feature is off, so the picker cannot offer an
engine the build does not contain. This is deliberate, not a missing feature.

**`ponytail:` comments are a tracked debt ledger, not stray TODOs.**
109 of them across 78 files. Each one marks a deliberate simplification with
a known ceiling and, where relevant, the upgrade path. Reporting them as
"incomplete implementation" is noise. Reporting that a specific one has now
hit its stated ceiling in production is useful.

**No telemetry, with one counted exception.**
See `PROMISES.md` promise 4. There is no analytics, no crash reporting and no
phone-home, and exactly one install count: version + OS, once, offered with a
tick box on the last screen of setup and recorded in
`~/.cinderpaw/.install-counted`. A finding that says "add observability" or
"there is no error reporting pipeline" is arguing against the product's
central promise. A finding that the install count sends more than those two
values, fires before the notice, or fires twice, is a real one.
A finding that says "this code path silently swallows an error the user needs
to see on screen" is exactly right and we want it.

**Data lives in `~/.cinderpaw`.**
A rename from an older directory name happened. If you find a path that still
points at the old name, that IS a bug and worth reporting.

## Claims to treat carefully

Benchmark numbers appear in the `CHECKPOINT_*.md` files. Some are measured
under pinned model routing and some are estimates that are labelled as
estimates in the same document. Unpinned OpenRouter routing has been observed
to swing an identical benchmark by tens of points, so any number without a
pinned endpoint next to it is not evidence of anything. Do not audit the
numbers. Audit the code.

One number in the repo is stale and says the opposite of the current result.
`CHECKPOINT_20260830_TAU2_RESULT_AND_ROADMAP.md` reports 82.0% against a
reference agent's 86.0% under a heading that calls it the number that stands,
and `docs/minimax-m3-bugfix-spec.md` repeats it. That run was unpinned. The
pinned rerun reversed it. Ignore both.

`PROMISES.md` states user-facing guarantees as fact. It has been wrong before:
a guarantee was stated there while the code did not hold it. Checking each
promise in that file against the code is one of the highest value things you
can do here.

## What we actually want found

In rough order of value:

1. A promise in `PROMISES.md` that the code does not keep.
2. Anything that behaves correctly only on a machine that is already set up.
   No keys, no downloaded models, no config, no `~/.cinderpaw`, a different
   OS, a different locale. First run is the case that matters.
3. A failure whose only explanation lands in a log file or stderr, where the
   user sees silence and has no way to learn why.
4. A default that is only correct after the user opens settings.
5. Correctness bugs in the agent loop, memory, and egress paths.
6. Case sensitivity assumptions. A previous hardening pass found four separate
   reported bugs that were all one defect around case-insensitive filesystems.

## How to report

For each finding: the file and line, what breaks, and the concrete input or
state that triggers it. A finding without a failure path is a guess, and we
have enough guesses.
