# Slice 9 — Onboarding Contract Fixes

> Audit of slices 1–8B, then the repairs. The Browser App's onboarding
> could not be completed on any path: the bridge forwarded the browser's
> `params` verbatim to gateway routes that require a different body, so
> every API-key verification and every model install returned 422. This
> slice makes the flow completable and makes "verified" mean verified.

## What the audit found

| # | Finding | Evidence |
|---|---|---|
| 1 | `verify_api_key` sent `{provider_id, api_key}`; `api.rs:3359 SetupVerifyReq` requires `candidate` (no serde default) → 422 on every key | `bootstrap.rs` forwarded `req.params` verbatim |
| 2 | `install_model` sent `{model_id}`; `api.rs:2441 InstallModelReq` requires `{repo_id, filename}` → 422 | same verbatim forward |
| 3 | `verify_api_key` called `persist_step("provider", true)` on any 2xx — the gateway answers a wrong key with **200 + `ok:false`** | violates the boundary doc's "detected ≠ configured" |
| 4 | "Verify setup" called `finish_setup`, which wrote four `true`s and no model call | the one step whose job is proof proved nothing |
| 5 | `finish_setup` → `write_onboarding_record()` **overwrote** `onboarding.json`, erasing the step flags `compute_state` reads and blanking `userName`/`agentName` | user finishes, refreshes, is back at step 1; a Desktop-set name is lost |
| 6 | `provider_verified`'s Continue button called `retry()`, which had no branch for that state | dead button, no way forward |
| 7 | `installed_not_running` claimed Desktop was not running when the bridge had just answered; only control was a Retry to the same screen | false copy + infinite loop |
| 8 | Model install progress bar never moved; `install_model` discarded the download id, so polling was impossible | decorative |
| 9 | Model step offered local GGUFs to a user who had just configured a cloud provider; fallback `{id:"default"}` hit 422 | step was unpassable |
| 10 | Safari blocks `https://` → `http://127.0.0.1` (mixed content). A Safari user saw "not connected" forever with the reason only in devtools | Chrome/Edge/Firefox exempt loopback; WebKit does not |
| 11 | `handle_connection` did a single `read()`; a POST body in a second TCP segment produced an empty body → intermittent `bad_json` | no read loop, no `Content-Length` |
| 12 | `has_api_key` read `providers.active` from `/runtime/status` — a key that route has never emitted → always `false` | `api.rs:2483` |

Root cause of 1, 2 and 12 is the same: **no test compared a browser payload
with the struct the gateway deserializes.** All 47 existing tests checked pure
functions on one side of that boundary.

## Scope

- [x] `src-tauri/src/commands/bootstrap.rs` — `candidate_for_provider` + `gateway_verify` build the gateway's request from `byok::provider_catalog()`; `persist_step` gated on `outcome.ok`; `finish_setup` runs a real end-to-end verify; `onboarding.json` writes merge and always carry the Desktop's four fields; `Content-Length` read loop; `has_api_key`/`active_model` read in-process; `install_model` + `list_models` removed
- [x] `lib/cinderpaw/bridge.ts` — `verifyProviderKey`, `finishSetup`, typed `VerifyOutcome`; model client removed
- [x] `lib/cinderpaw/onboarding.ts` — 4 steps → 3; `gateway_not_running`; `blocked_by_browser`; `browserBlocksLoopback`; `isStepDone` moved in from the component
- [x] `app/app/discover/OnboardingAssistant.tsx` — model step removed, verification chains automatically, honest copy per state
- [x] `tests/cinderpaw-onboarding.test.ts` — updated + no-dead-end, progress-honesty and mixed-content tests

## Files changed

| File | Stat | Notes |
|---|---|---|
| `src-tauri/src/commands/bootstrap.rs` | +290/-190 | contract layer, truth-preserving persist, merge writes, read loop, 10 new tests |
| `lib/cinderpaw/bridge.ts` | +45/-55 | typed verify/finish; model client deleted |
| `lib/cinderpaw/onboarding.ts` | +60/-45 | 3-step machine, `browserBlocksLoopback`, `isStepDone` |
| `app/app/discover/OnboardingAssistant.tsx` | −140 net | 660 → 520; model states gone |
| `tests/cinderpaw-onboarding.test.ts` | +130/-25 | rules the bugs broke, stated as tests |

## Files explicitly NOT changed

- `crates/cinderpaw-core/**` — **ZERO changes** (gateway untouched; every fix is on our side of its contract)
- `src-tauri/src/deep_link.rs`, `lib.rs` deep-link wiring — slice 8B, untouched
- `app/app/chat/**`, `app/app/wizard/**`, `app/api/cinderpaw/**` — untouched
- `tui/**`, `CinderpawAgent/**`, `frontend-react/**` — untouched
- `~/.cinderpaw` schema — **extended by merge only**; the Desktop's `OnboardingRecord` fields are now always present, which is strictly more compatible than before
- `useCallSession.ts`, `vad.ts`, Rust audio pipeline, `mcp.json` — pinned OOS

## Tests

- `cargo check -p cinderpaw --no-default-features`: **PASS** (6 pre-existing `cinderpaw-core` dead_code warnings, 0 new)
- `cargo test -p cinderpaw --lib --no-default-features`: **155 passed / 0 failed / 1 ignored** (was 147; +10 new, −2 tautological)
- `bun test` (landing page): **205 pass / 0 fail** (was 195)
- `bunx tsc --noEmit`: **PASS**
- `bunx next build`: **PASS** — `/app/discover` 5.39 kB

New tests that would have caught the shipped bugs:
`verify_body_matches_what_the_gateway_deserializes`, `a_failed_verification_is_not_a_success`,
`every_write_keeps_the_desktop_fields`, `completing_onboarding_preserves_the_users_name`,
`a_body_split_across_segments_is_read_whole`, `every state moves`, `browserBlocksLoopback`.

## Security

- bearer token server-side only: **PASS** — unchanged; the browser still sends only `{provider_id, api_key}` and the bridge adds the bearer
- API key handling: **PASS** — held in React state, sent once, cleared in `finally` regardless of outcome; now reaches the OS keychain via the gateway's `persist` (previously it reached nothing)
- `persist: true` is set **by the bridge**, not the browser — and the gateway honours it only on a successful round-trip, so a browser cannot ask for an unproven key to be saved
- no new action, port, route or dependency; the action enum **shrank** from 7 to 5

## Architectural invariants

- [x] BFF remains the only browser → gateway boundary for non-bridge traffic
- [x] gateway loopback-only, `127.0.0.1:11435`; bridge loopback-only, `127.0.0.1:11437`, dies with Tauri
- [x] no new backend / daemon / port / process
- [x] `crates/cinderpaw-core` untouched
- [x] TUI state machine untouched
- [x] wizard contract restored: a step is configured only after a real verify succeeded end to end

## Known limitations

- **Safari / iOS cannot use the Browser App.** The block is in WebKit, not in our code. The page now says so and points at the Desktop. Not fixable here; if it must work on Safari, that is Mode B (a hosted or paired gateway), which the boundary doc defers.
- **`finish_setup` runs a second real model call** after the key check. It is 32 tokens and it is the only thing that proves the *saved* route works, which is a different claim from "the key I just pasted works".
- Browser-side local-model onboarding is gone, not fixed. The Desktop wizard does it properly. Bringing it back needs a bridge action that returns the download id and a progress poll.
- E2E deep-link (slice 8B) remains unverified on all three OSes — unchanged by this slice.
- The download link is still a GitHub releases page.

## Deviations

- **Deleted rather than repaired:** `install_model`, `list_models`, and the browser's whole model step. Both actions spoke a body the gateway rejects, the step could not be completed, and the model the Browser App configures is now the provider's catalog default — proven by the same call that proves the key, changeable afterwards in the Desktop. Agreed before implementation.
- **`canRetry` semantics widened** to "the user can ask us to look again", which is true for every state that does not advance itself. It is the predicate that encodes "no dead ends".
- NONE other.

## Verdict

**SLICE 9 COMPLETE.** Onboarding is completable, every "verified" is a real
model round-trip, `onboarding.json` is safe to share with the Desktop, and the
browser↔gateway boundary now has tests on it. Safari remains architecturally
excluded and now says so on screen.
