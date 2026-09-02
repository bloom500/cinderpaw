# Slice 11 — Guided Connector Setup + Credential Redaction

> The agent can now walk a user through connecting Discord, Slack or
> WhatsApp with real, checked steps — and a token pasted into the chat
> no longer ends up sitting in memory forever.

## Why this shape

The original ask was for the agent to drive a browser itself: navigate
Google, then the Discord Developer Portal, create the app, stop only for
the token copy. That was set aside deliberately (see "Not built" below).
What remained is the part that carries most of the value and none of the
blast radius: **tell the user exactly what to click, and make the paste
safe.**

Making the paste safe turned out to be the more urgent half.

## The hole this closes

`redactPII` already existed (email, IBAN, CNP, card, phone) and ran on
**semantic** memory only. It had **no credential patterns at all**.
Episodic memory ran only `stripPrivate`, which removes what the user
*explicitly* wrapped in `<private>`.

So: a user pastes a Discord bot token into the chat — which the connector
flow tells them to do in plain words — and the token is written verbatim
into episodic memory and kept. The only defence was expecting the user to
type `<private>` around a secret they were just instructed to paste. That
is a guard that is absent at the exact moment it is needed.

## Scope

- [x] `CinderpawAgent/src/memory/privacy.ts` — `redactSecrets()`: 9 anchored credential patterns, **always on, no off switch**; `redactPII` now runs it first
- [x] `CinderpawAgent/src/core/agent-loop.ts` — redaction on both episodic writes (the user's text and the agent's reply)
- [x] `CinderpawAgent/src/tools/builtin/connectors-manage.ts` — `steps[]` + `consoleUrl` per connector; tool description instructs the agent to use them verbatim
- [x] `docs/API.md` — documented `GET /runtime/sessions/:id/transcript` (pre-existing drift from slice 4, see below)
- [x] Tests: +10 redaction, +3 guided setup

## Patterns redacted

PEM private key blocks, Slack (`xox[baprs]-`, `xapp-`), Anthropic
(`sk-ant-`), generic `sk-`, Google (`AIza…`), GitHub (`gh[pousr]_`), AWS
(`AKIA…`), the three-part Discord-bot-token / JWT shape, and `Bearer …`
in prose. Each is anchored on a known prefix or structure.

**Not** a generic high-entropy matcher: that eats base64 payloads, hashes
and git SHAs, and a redactor that mangles ordinary prose is one the user
turns off. Tested both ways — `leaves ordinary text alone` and `does not
eat a plain base64 payload or a UUID`.

**No off switch**, unlike PII (`CINDERPAW_PII_REDACTION=off`). A
credential in durable storage is a different class of problem from a
phone number, and the user who most needs this is the one who never opens
settings.

## Guided setup

`connectors_manage` action `list` now returns `steps[]` and `consoleUrl`
alongside the existing `note`. The steps are the real click path, and the
tool description tells the agent to call `list` first and follow them
verbatim rather than improvise from a recollection of a portal that has
since moved its buttons.

`consoleUrl` also fixes a quiet drift: the URL lived only in
`crates/cinderpaw-core/src/connectors.rs` (for the settings UI), so the
agent had been guessing the address too.

Three tests pin the things that silently break a Discord connection:
Message Content Intent (without it the bot connects and appears to ignore
everything), the token being shown exactly once, and the bot still
needing an invite via the OAuth2 URL Generator. A fourth asserts no step
ever routes a secret to a `.env` file or `connectors.json` — the secret
reaches the keychain through one door, the one that redacts.

## Tests

- `bun test` (sidecar, full): **3649 pass / 0 fail / 14 skip / 1 todo** across 310 files
- `tests/pii-redaction.test.ts`: 19 pass (+10)
- `tests/connectors-manage.test.ts`: 13 pass (+3)
- `node scripts/check-api-docs.mjs`: **OK — 61 routes documented, none missing**

### A pre-existing failure, fixed

The full suite was failing before this slice on `docs/API.md route
coverage`: slice 4 added `GET /runtime/sessions/:id/transcript` to
`api.rs` and never listed it in the doc's `cinderpaw-api-routes` block.
`crates/` has no changes in this slice, so the failure was not ours —
but it is one line, and the test was telling the truth. Fixed.

## Not built, on purpose

**The agent driving a browser to create the Discord app itself.** It
would be the better demo. It is also the pattern the desktop-control
denylist exists to prevent: `desktop_control.rs:154` permanently blocks
shells, UAC/consent surfaces, `lsass`, keychains and password managers,
because driving one turns "type into a field" into arbitrary execution.
A browser is not on that list precisely because a browser is the
legitimate thing you would want to drive — and an agent that can drive a
logged-in Chrome can, with the same primitives, walk through Gmail or a
billing console.

If it is built later, the approval cannot be a global switch. It needs
to be scoped: one domain, one duration, a visible log of every click, and
a hard stop on any navigation off the approved domain. That design comes
before that code.

## Known limitations

- **The visible half of `<private>` is not built.** Nothing yet wraps a
  pasted secret at paste time so the user *sees* it masked in the chat.
  That spans two front-ends (`frontend-react` and the Browser App) and is
  the natural next piece. Redaction currently happens below the UI.
- **The on-disk transcript is not redacted.** `conversations/*.json` is
  written on the Rust side (`src-tauri/src/conversations.rs`) and is the
  conversation the user can read back. Silently rewriting someone's own
  visible messages is a product decision, not a bug fix, so it was not
  done here. **A pasted token still sits in that file.** Memory is
  covered; the transcript is not.
- The steps are a snapshot of three portals. When a portal changes,
  `CATALOG` in `connectors-manage.ts` is the one place to fix — but
  nothing detects the change for us.
- `redactSecrets` cannot catch a credential with no recognisable shape
  (a bare hex string, a short password). Anchoring is what keeps it from
  destroying ordinary text; the trade is deliberate.

## Verdict

**SLICE 11 COMPLETE.** Connector setup is guided with checked steps
instead of one improvised sentence, and the secret the user is told to
paste no longer persists in memory. The transcript remains an open,
named gap.
