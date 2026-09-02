# Slice 10 — Make Your Agent

> The Browser App now ends with the user's own agent, not with a green
> checkmark. They name it, answer three questions that shape how it
> talks, and then have a real conversation with it — running on their
> machine, on their key — before they ever open the Desktop app.

## The idea

`~/.cinderpaw/onboarding.json` already carried `userName` and
`agentName`, and `CinderpawAgent/src/core/user-loader.ts:94` already
turned them into a `## Personalization` block appended to the system
prompt below SOUL.md. Naming the agent was never cosmetic — it changes
how the agent speaks. The Browser App was writing both fields as `""`,
so it shipped every user an agent with no name.

This slice uses that primitive instead of inventing one, adds a third
field beside it, and makes the last screen a conversation.

**Why the last step is a conversation.** The end-to-end verification was
already a real model call whose reply we threw away behind a spinner.
The same proof, shown to the user, is the agent introducing itself by
the name they just gave it. Same evidence, and the user leaves having
talked to their agent rather than having watched a checkbox tick.

## Scope

- [x] `src-tauri/src/commands/bootstrap.rs` — `save_identity` action (validate → merge → restart sidecar), `POST /bootstrap/chat` SSE proxy, `agent_ready` capability, `validated_origin` extracted and made RFC-9110 case-insensitive
- [x] `src-tauri/src/commands/settings.rs` — `restart_sidecar` is `pub(crate)`
- [x] `CinderpawAgent/src/core/user-loader.ts` — reads `agentCharacter`, renders it as preferences with an explicit SOUL.md precedence line
- [x] `lib/cinderpaw/bridge.ts` — `saveIdentity`, `streamBridgeChat`, `AgentCharacter`, `agent_ready`
- [x] `lib/cinderpaw/onboarding.ts` — `naming` / `character` / `waking` / `meeting` states, `CHARACTER_QUESTIONS`, `cleanAnswer`
- [x] `app/app/discover/AgentMaker.tsx` — NEW: the four screens
- [x] `app/app/discover/OnboardingAssistant.tsx` — wiring, sidecar-readiness poll, streamed conversation
- [x] Tests on all three sides

## Files changed

| File | Stat | Notes |
|---|---|---|
| `src-tauri/src/commands/bootstrap.rs` | +330 | identity + chat stream + 9 tests |
| `src-tauri/src/commands/settings.rs` | +4/-1 | visibility + why the restart exists |
| `CinderpawAgent/src/core/user-loader.ts` | +105 | `agentCharacter`, bounded on read |
| `CinderpawAgent/tests/user-loader.test.ts` | +125 | character load + prompt rendering |
| `lib/cinderpaw/bridge.ts` | +125 | `saveIdentity`, `streamBridgeChat` |
| `lib/cinderpaw/onboarding.ts` | +95 | states + guided questions |
| `app/app/discover/AgentMaker.tsx` | +300 | NEW |
| `app/app/discover/OnboardingAssistant.tsx` | +190 | wiring |
| `tests/cinderpaw-onboarding.test.ts` | +75 | questions, `cleanAnswer`, agent steps |

## Files explicitly NOT changed

- `crates/cinderpaw-core/**` — **ZERO changes**. The chat proxy calls the existing `POST /runtime/chat`; no new route, no gateway edit.
- `~/.cinderpaw/SOUL.md` — **never written**. See "Security" below.
- `frontend-react/**`, `tui/**` — untouched. The Desktop reads the same record; the new field is additive and optional.
- `app/app/chat/**`, `app/api/cinderpaw/**` — untouched.
- `useCallSession.ts`, `vad.ts`, Rust audio pipeline, `mcp.json` — pinned OOS.

## Tests

- `cargo check -p cinderpaw --no-default-features`: **PASS** (6 pre-existing `cinderpaw-core` dead_code warnings, 0 new)
- `cargo test -p cinderpaw --lib --no-default-features`: **164 passed / 0 failed / 1 ignored** (was 155; +9)
- `bun test` (sidecar, 3 touched files): **50 pass / 0 fail** (+11 character tests)
- `bun test` (landing page): **215 pass / 0 fail** (was 205)
- `bunx tsc --noEmit`: **PASS**
- `bunx next build`: **PASS** — `/app/discover` 8.38 kB

## Security

The three character answers and the two names are appended to **every
system prompt this user's agent ever builds**. That makes them a trust
boundary, not form fields, and they are treated as one:

- **Bounded and stripped at the writer** (`sanitize_field`, `bootstrap.rs`): control characters removed, 120 chars for an answer, 60 for a name. A newline would let an answer forge its own line directly under the agent's rules.
- **Bounded and stripped again at the reader** (`readCharacterField`, `user-loader.ts`): the record is a file on disk and a user can hand-edit it. Anything that lands in a prompt is checked where it is read, not only where it was written.
- **Three keys, nothing else.** `role`, `system_prompt` and any other invented key never reach the record.
- **Capped by characters, not bytes** — slicing a multi-byte character in half would panic on a name like "Ștefan". Tested.
- **SOUL.md is never written.** It is a full override of the agent's identity, honesty rules included. A personalization feature that silently replaced it would be a way to talk a user's agent out of its own guardrails. The answers go in the personalization block, below SOUL, and the rendered block ends with an explicit line saying SOUL.md wins on conflict — because "never tell me when you are unsure" is an answer a user can genuinely give. Tested (`says which one wins when a preference fights SOUL.md`).
- **The chat proxy is still not a generic proxy.** Fixed URL, fixed method; the only value from the browser is the message text. The **session id is ours** (`ONBOARDING_SESSION_ID`), never the browser's — on the gateway a session id is a path segment and a file name.
- **Bearer unchanged**: added inside the bridge, never in the browser.
- **`validated_origin` is now RFC-9110 case-insensitive** and stops at the blank line, so a request body cannot forge a header the validator trusts. Both tested.

## Architectural invariants

- [x] `crates/cinderpaw-core` untouched; gateway and bridge stay loopback-only
- [x] no new port, daemon, process or dependency (`reqwest` already had `stream`; `futures` was already a dep)
- [x] bridge action enum: 5 → 6 (`save_identity`), plus one streaming endpoint
- [x] `onboarding.json` extended additively; the Desktop's four required fields are still always present
- [x] no browser-side key or token persistence

## Known limitations

- **The sidecar restart is real downtime.** Naming the agent restarts it so it reads the new name — the "Waking…" screen polls `agent_ready` for up to 30s. If it does not return, the user is told the setup is saved and pointed at the Desktop, rather than being left on a spinner.
- **Onboarding chat renders assistant text only.** Tool and ask frames are parsed and skipped, not half-rendered — a tool call belongs in the Desktop. The frames are read by the same `lib/cinderpaw/chat.ts` parser the chat surface uses, so nothing forks.
- **One agent, not many.** Multiple agents with separate personas would need a new schema and would touch the Desktop; deliberately out of scope.
- **No tools or connectors in the browser.** Also out of scope — the bridge would have to write connector secrets.
- Safari/iOS still cannot use the Browser App (WebKit mixed content), unchanged from slice 9 and stated on screen.
- E2E deep-link (slice 8B) still unverified on all three OSes.
- The character answers apply from the next sidecar boot; changing them later is a Desktop job.

## Deviations

- **Added `agent_ready` to `BridgeStatus.capabilities`.** Without it the first message of the first conversation fires into a process that is still booting. It reads `runtime.cinderpaw_agent_tx` — holding the sidecar's stdin sender IS "the agent is up", so there is no separate flag to fall out of step with reality.
- **`stream_chat` owns the socket** instead of returning a `String` like every other handler. A live SSE stream cannot be a return value, and the user is watching it arrive a word at a time.
- NONE other.

## Verdict

**SLICE 10 COMPLETE.** A stranger with nothing installed can now go from
cinderpaw.dev to a named agent, shaped by their own answers, running on
their own key, that has already answered them — without opening a
terminal. The Desktop takes over from there.
