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
A working checkout can hold extra git worktrees (full copies of the repo on
other branches), plus `node_modules`, `target` and `vendor`. Walking the disk
can read the same source several times and audit stale branches as if they
were current. Only the tracked files are the product.

## Decisions that are not bugs

**On-device TTS ships only where it can, on purpose.**
`piper` ships in no build: `piper-rs` compiles espeak-ng (GPLv3) into the
binary, and the installers go out under Apache-2.0. `kokoro` rides ONNX
Runtime, whose Linux prebuilt needs glibc 2.38, newer than the distros we
target (Ubuntu 22.04, Debian 12), and which has no prebuilt for Intel Macs. So
Kokoro ships on Windows and Apple Silicon macOS only. See the comments on the
build matrix in `.github/workflows/release.yml` and on `default` in
`src-tauri/Cargo.toml`. Do not recommend adding them to the default feature
set.

**Native features are optional and off by default.**
`whisper`, `moonshine`, `piper`, `kokoro` all pull native toolchains. Off by
default so a broken toolchain cannot block the workspace build; `inference`
(CPU llama.cpp) is the one default. The desktop
build turns on what each platform can carry. `tts::catalog()` reports an
engine as unavailable when its feature is off, so the picker cannot offer an
engine the build does not contain. This is deliberate, not a missing feature.

**`ponytail:` comments are a tracked debt ledger, not stray TODOs.**
About 200 of them across about 150 tracked files (`git grep -c "ponytail:"`).
Each one marks a deliberate simplification with a known ceiling and, where
relevant, the upgrade path. Reporting them as
"incomplete implementation" is noise. Reporting that a specific one has now
hit its stated ceiling in production is useful.

**No telemetry, with two exceptions the person says yes to.**
See `PROMISES.md` promise 4. There is no crash reporting and no phone-home.
There is one install count: version + OS, once, offered with a tick box on the
last screen of setup and recorded in `~/.cinderpaw/.install-counted`. And there
is an opt-in daily usage summary (`CinderpawAgent/src/telemetry/`): off unless
`usage_sharing` is true, per-model counts only, logged to
`~/.cinderpaw/telemetry-sent.jsonl` before each send. A finding that it sends
text, ids or exact times, sends without consent, or sends days from before
consent, is a real one. A finding that says "add observability" or
"there is no error reporting pipeline" is arguing against the product's
central promise. A finding that the install count sends more than those two
values, fires before the notice, or fires twice, is a real one.
A finding that says "this code path silently swallows an error the user needs
to see on screen" is exactly right and we want it.

**Data lives in `~/.cinderpaw`.**
A rename from an older directory name happened. If you find a path that still
points at the old name, that IS a bug and worth reporting.

## Claims to treat carefully

Benchmark numbers appear in specs and design notes under `docs/`. Some are
measured under pinned model routing and some are estimates that are labelled as
estimates in the same document. The raw results behind the tau2 numbers we
publish are in `bench-results/tau2/`, with a script to re-score them.
Unpinned OpenRouter routing has been observed to swing an identical
benchmark by tens of points, so any number without a
pinned endpoint next to it is not evidence of anything. Do not audit the
numbers. Audit the code.

One old number says the opposite of the current result.
`docs/minimax-m3-bugfix-spec.md` quotes a 2026-08-30 tau2 run: 82.0% against a
reference agent's 86.0%. That run was unpinned. The pinned rerun reversed it
(90.0% against 82.0%, in `bench-results/tau2/`). The spec marks the old pair
as retracted. Ignore it.

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
