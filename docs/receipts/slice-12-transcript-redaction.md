# Slice 12 — Transcript Redaction + Redactor Parity

> Closes the gap slice 11 named and left open: a credential pasted into
> the chat was kept out of memory but still written in plaintext to the
> saved conversation on disk.

## The gap

Slice 11 added `redactSecrets` in the sidecar, covering episodic and
semantic memory. Its own receipt said, in as many words:

> **The on-disk transcript is not redacted.** `conversations/*.json` is
> written on the Rust side and is the conversation the user can read
> back. **A pasted token still sits in that file.**

That file sits next to the keychain we went to the trouble of using. This
slice closes it.

## Scope

- [x] `crates/cinderpaw-core/src/secret_redact.rs` — NEW: `redact_secrets`, the Rust half. 9 unit tests.
- [x] `crates/cinderpaw-core/src/lib.rs` — module registered
- [x] `src-tauri/src/conversations.rs` — `redact_messages` applied in `save_to_dir`, covering `content` and `thinking`
- [x] `CinderpawAgent/tests/fixtures/secret-redaction-cases.json` — NEW: the shared parity fixture
- [x] `crates/cinderpaw-core/tests/secret_redaction_parity.rs` — NEW: Rust side reads the fixture
- [x] `CinderpawAgent/tests/pii-redaction.test.ts` — TypeScript side reads the same fixture

## Two decisions worth stating

**Redaction is on the saved copy, not the live one.** The conversation on
screen is untouched, so a user still sees exactly what they typed in the
session they typed it in. Silently rewriting somebody's own visible
message as they look at it is a different and worse behaviour than
declining to keep it forever.

**Hand-written scanner, no `regex` dependency.** Every rule is the same
three checks — known prefix, allowed character set, minimum length —
which is what a credential format is. `regex` is not a direct dependency
of any crate in this workspace and this did not justify making it one.
One pass over whitespace-separated words, with two special cases (a PEM
block spans lines; a `Bearer` value is identified by the word before it).

## The parity problem, and the fixture

There are now **two** redactors, in two languages, in two processes:
TypeScript keeps credentials out of memory, Rust keeps them out of the
transcript. Two hand-maintained lists drift by default, and a format one
catches and the other misses is still a leaked secret — it just leaks
into the other store.

So both are tested against the **same fixture file**
(`CinderpawAgent/tests/fixtures/secret-redaction-cases.json`): 9 secret
formats that must be caught, 7 innocent strings that must survive
byte-identical. Add a format there and whichever side has not learned it
yet fails.

The innocent list is the half that keeps this honest — git SHAs, base64
payloads, UUIDs, dotted file paths, version numbers. A redactor that
mangles ordinary text is one that gets turned off, and then it protects
nothing at all.

## Tests

- `cargo test -p cinderpaw-core --lib`: **365 passed / 0 failed / 2 ignored** (+9)
- `cargo test -p cinderpaw-core --tests`: all integration suites pass, including the new `secret_redaction_parity` (3 passed)
- `cargo test -p cinderpaw --lib --no-default-features`: **164 passed / 0 failed / 1 ignored**
- `cargo check`: clean, 0 new warnings
- `bun test` (sidecar, full): **3651 pass / 0 fail / 14 skip / 1 todo** across 310 files (+2 parity tests)

### One unexplained failure

An earlier full sidecar run reported `1 fail`, and the failing test name
did not appear in the captured output. **Three consecutive full runs
afterwards were clean.** It is not in any file this slice touched and it
could not be reproduced or named. Recorded here rather than rounded down
to "all green" — there is a flaky test somewhere in the 310 files and it
has not been found.

## Known limitations

- **Existing conversations on disk are not rewritten.** Redaction runs on
  save, so a token pasted before this slice is still in the file it
  landed in. A migration pass would need to rewrite user data, which is
  not something to do silently.
- **The paste is still not masked in the UI.** The user sees the raw
  token in their own chat window during the session. Making it appear as
  a masked chip spans `frontend-react` and the Browser App and is not
  built.
- `redact_secrets` cannot catch a credential with no recognisable shape —
  a bare hex string, a short password. Anchoring is exactly what keeps it
  from destroying ordinary text; the trade is deliberate and permanent.
- Two implementations still have to be maintained together. The fixture
  makes drift fail a test; it does not make drift impossible.

## Verdict

**SLICE 12 COMPLETE.** A credential pasted during connector setup no
longer reaches disk in either store, and the two redactors are pinned to
each other by a shared fixture. The named remaining gap is the UI mask.
