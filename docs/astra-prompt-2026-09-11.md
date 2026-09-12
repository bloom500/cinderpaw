# Astra brief — Cinderpaw, 2026-09-11 (find AND fix)

You are auditing and repairing the Cinderpaw repository. Effort: medium.
This is a **find-and-fix** run, not a report-only run. Three zones, in the
order given. Do not widen the scope on your own.

Repo: `D:\Cinderpaw Agent`. Current branch `art/mascot-body-d` at `66c5581`;
`main` is at `8ad7ed5`. Work from `main` unless a zone says otherwise.

---

## 0. Read these before anything else

`audit-out/ledger.md` and `audit-out/state.md` exist from the September 6 run.
`ledger.md` has a section "FIXED on branch" listing seventeen findings already
repaired on `fix/release-blockers-2026-09-06`.

**Do not re-report anything in that ledger.** If you believe a ledger finding
marked fixed is in fact still open, that is itself a finding — say so with the
commit id that claimed it and the code that contradicts it.

Do NOT read `audit-out/00-coverage.md`. It is 1800+ lines of per-file table and
will eat your budget for nothing.

## 1. How to record work — this part is not optional

Write every confirmed finding to disk **the moment you confirm it**, before
moving on. Append to `audit-out/ledger.md`; overwrite `audit-out/state.md` with
where you are.

A finding kept in the conversation gets compressed when the window fills and
comes out as a vague sentence with no file and no trigger. That is exactly how
two earlier audits on this repo lost their evidence. The limit here has never
been "the repo does not fit" — it is accumulation.

Every finding needs, at minimum:

- `file:line`
- what the code does, and what it was supposed to do
- **the trigger**: the concrete input, state or sequence that makes it happen
- whether it is reachable by an ordinary user on a fresh install, or only in an
  unusual state
- the fix, if you applied one, and the test that fails without it

Fixes go on a branch named `fix/astra-2026-09-11-<zone>`. One commit per
finding. Never commit to `main`. `audit-out/` is gitignored and must stay that
way — **this repository is public and most findings are still open.**

---

## ZONE A — Voice call. Highest priority.

Voice is the product surface that keeps regressing across sessions. The reason
is now known and it is not subtle, so start from what follows rather than from
a blank page.

### Files

- `crates/cinderpaw-core/src/livekit_agent.mjs` (975 lines) — the worker
- `crates/cinderpaw-core/src/livekit.rs` (1594 lines)
- `crates/cinderpaw-core/src/live/{mod,session,bridge,briefing}.rs`
- `crates/cinderpaw-core/src/{stt,transcription}.rs`
- the `ask_cinder` route in `crates/cinderpaw-core/src/api.rs`

### What was already diagnosed on 2026-09-06 — do not rediscover this

Four defects were found and fixed by reading source (ours, the LiveKit SDK, and
`@livekit/agents-plugin-google`), because the call left no trace anywhere at the
time. Observability has since been added.

**Verified again on 2026-09-11 against `HEAD`, `main` and
`voice/hardening-and-ui-2026-09-06`: only two of the four are actually in the
tree.** Counts from `livekit_agent.mjs`:

| fix | marker | grep count | in the tree? |
|---|---|---|---|
| mic muted during a tool call | `NON_BLOCKING` | 1 | **NO — the comment only** |
| filler could not speak | `LocalTTS` | 6 | yes |
| filler must stand down on Gemini | `SPEAKS_FOR_ITSELF` | 0 | **NO** |
| the two disagreeing timeouts | `VOICE_TOOL_DEADLINE` (in `api.rs`) | — | yes |
| turn detection cuts the user off | `END_SENSITIVITY` / `voice-tuning.json` | 0 / 0 | **NO** |

The `NON_BLOCKING` miss is the worst, because its **documentation survived while
its code did not**. The comment at `livekit_agent.mjs:443` states as fact:

> `ask_cinder` is declared NON_BLOCKING and the session stays free to talk

The actual declaration at line 562 is
`llm.tool({ description, parameters, execute })` with no behaviour flag of any
kind. `grep -E "Blocking|behavior|scheduling"` over the whole file returns
nothing. Anyone reading that file is told the microphone problem is solved.

The three defects whose fixes are missing, restated so you can re-derive them:

1. **The plugin mutes the microphone during a tool call.**
   `@livekit/agents-plugin-google` drops every frame in `pushAudio` while a tool
   is pending, unless the tool is declared `NON_BLOCKING`
   (`shouldBlockRealtimeInputForPendingTools`). One recorded call spent 65s in
   `ask_cinder` with every spoken word discarded while the screen still said
   "Listening". The same flag also blocks the model from speaking.

2. **The filler can produce a second voice on Gemini.** `session.say()` throws
   without a TTS; the session now carries `tts: new LocalTTS(null)`, which fixed
   the OpenAI path. On Gemini the realtime model speaks for itself, so the
   filler must stand down entirely or the user hears two voices. That guard was
   never committed. A two-voices bug has already shipped once on this repo from
   a different cause (a re-entrant `begin()`), so treat a second voice as a
   known-recurring class, not a surprise.

3. **Turn detection is the vendor default on Gemini.** `livekit_agent.mjs`
   carries only `turnDetection: { type: 'server_vad' }`, and only on the OpenAI
   path. `END_SENSITIVITY_HIGH` was measured closing a turn mid-question at 46
   characters and answering nothing. The intended fix was LOW sensitivity with
   700ms silence, overridable per call from `~/.cinderpaw/voice-tuning.json`
   without a rebuild.

**Measured after the four fixes were applied locally:** 13 turns, reply 1.2 to
3.4s from the last word, no drift. Latency is measured from the LAST partial;
measuring from the first made every long question look like a slow system. Keep
that convention.

### Still open, never fixed, and yours to solve

- **The reconnect loop.** First evidence is `detected connection state mismatch`
  from LiveKit's `Room.ts`. Never root-caused.
- **No cancel path for a running tool.** Once `ask_cinder` starts, nothing stops
  it. The user cannot interrupt, and neither can the model.
- **`ask_cinder` takes 60 to 100 seconds on a search.** The 45s Rust deadline
  and the 60s worker wait are a bandage over this, not a fix.
- **The OpenAI realtime path has never been run.** Not once. Assume it is broken
  until proven otherwise and say which of your findings apply to it.

### Explicitly wanted, does not exist

- **Backchannels** — short acknowledgements ("aha", "mm") while the user is
  still speaking.
- **Knowing whether the user is talking to it or to another person in the room.**
  This is device-directed speech detection, which is a model, not a setting. If
  your answer is "train or source a model", say so plainly rather than
  approximating it with endpointing thresholds; the endpointing knobs are the
  cheap first step and are already understood.

### The question to answer for Zone A

Why does voice keep regressing across sessions? Three fixes went missing between
being written and being in the tree. Find out whether that is branch hygiene, a
rebase that dropped them, or something about how this repo is worked on — and
say which, with evidence. That answer is worth more than any single defect.

---

## ZONE B — Claims in comments and docs that the code does not implement.

Repo-wide scan. This is the meta-defect behind Zone A and it has now appeared
five times in confirmed form. It is cheap for you to hunt with grep and it is
the thing nobody else will find, because reading a comment is how everyone else
concludes the work is done.

**Confirmed seed instances — use them to calibrate the pattern, do not just
re-report them:**

1. `livekit_agent.mjs:443` — asserts `ask_cinder` is `NON_BLOCKING`. It is not.
2. `crates/cinderpaw-core/src/connectors.rs:156` — documents
   `POST /runtime/connectors/:id/validate` as the token validator.
   `grep '.route("/runtime/connectors'` in `api.rs` returns exactly two routes,
   `/reload` and `/catalog`. The route does not exist.
3. `crates/cinderpaw-core/src/connectors.rs:174` and `:269` — document
   `POST /runtime/connectors/whatsapp/pair/start` for QR pairing, and the
   catalog entry ships that path as `qr_setup_endpoint`. The route does not
   exist, so **WhatsApp cannot be paired from any UI** and the catalog hands
   clients a 404.
4. `tui/app/wizard.go:194` — a version-history comment reads
   "v3: F3 added WizCloudModel (between WizCloudProvider and WizCloudKeyMode)".
   The step had no renderer and no key handler and was not in any wizard path;
   it was unreachable. (Being fixed separately on 2026-09-11 — verify the fix,
   do not redo it.)
5. `PROMISES.md` — the September 6 pass found five of ten promises not kept,
   with the document stating the broken guarantees as fact. See
   `audit-out/pass-1-promises.md`.

**What to produce:** every place where a comment, a doc, a README, a struct
doc-comment or a user-facing string asserts a behaviour, guarantee, flag,
endpoint or default that the code does not implement. Rank by whether a user or
another developer would act on the false statement.

For each: fix the code if the claim is the correct intent, or delete the claim
if it is not. Never leave both. A comment describing intent that was never built
must say so explicitly or be removed.

---

## ZONE C — The egress / connector / MCP boundary. Audit before we grow it.

This zone has not been audited and it is about to triple in size: we intend to
bring in roughly twenty chat-platform integrations (Discord, Slack, Telegram,
WhatsApp, Signal, iMessage, Matrix, Teams, IRC and more) from the MIT-licensed
OpenClaw project, each as a self-contained plugin loaded through a host
contract. Auditing the boundary after importing twenty platforms is the wrong
order.

Cover:

- `CinderpawAgent/src/egress/` — the proxy, the inference router, tool
  permissions.
- `crates/cinderpaw-core/src/connectors.rs`, `connector_secrets.rs`,
  `connector_accounts.rs`, and the `/runtime/connectors*` routes in `api.rs`.
- Wherever MCP servers are registered and their tools reach the agent loop.

Known-open from the September 6 pass, still in the ledger — confirm current
state before spending time:

- Redirects keep credentials across scheme and port changes, so HTTPS can
  downgrade to HTTP with the key attached, and the audit log records only the
  original URL. `egress/egress-proxy.ts:451`,
  `egress/inference-providers.ts:1453`.
- Session eviction drops a public participant's restrictions, so owner tools
  become reachable. `core/agent-loop.ts:2587`.

Questions to answer:

1. What is the actual trust boundary for a connector? A connector carries a bot
   token and receives messages from strangers on the internet. Trace what an
   inbound message can reach, and whether per-connector allowlists hold on a
   **fresh install with an empty allowlist** — an empty allowlist that means
   "allow everything" has shipped on this repo before.
2. Where do connector secrets actually live, and what reads them? `byok.json`,
   `connectors.json`, the OS keychain and a file fallback all exist.
3. If a third-party plugin package is loaded as a channel, what does it get
   access to that it should not? Name the minimum contract that would make
   importing twenty of them safe.

---

## Out of scope — do not spend budget here

- Telemetry or analytics suggestions. Data collection is a decided product
  direction with its own timeline.
- `ponytail:` comments. Those are deliberate, marked simplifications with a
  recorded upgrade path, not defects.
- Style, formatting, naming, or test-coverage-for-its-own-sake findings.
- The mascot and pixel-art work under `scripts/mascot/` and
  `frontend-react/src/components/chat/mascot/`.
- Benchmark harnesses under `scripts/tau2/` and `vendor/`.

## Ranking rule

Rank by **whether a stranger on a machine that was never set up hits it**, not
by how interesting the code is. A defect that needs an unusual state ranks below
one that fires on first run. Say plainly when a finding only reproduces in a
configured environment.

## Finally

If a zone turns out to be clean, say so and stop. Do not manufacture findings to
fill a section. And if you disagree with the priority order above after seeing
the code, say that too, with your reason, before you act on it.
