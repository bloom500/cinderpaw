# Phase 3 — Connector Accounts

**Date:** 2026-08-19 · **Type:** implementation spec · **Status:** complete (2026-08-20, branch `feat/connector-accounts`)

**UX contract:** `docs/ui/2026-08-19-ux-contract.md`
**Precedents:** `docs/specs/2026-08-19-phase-2-capability-lifecycle.md` (host owns the
trust decision), `crates/feral-core/src/byok.rs` + `byok_file_store.rs` (secret storage)

## Objective

Make adding a connector cost a descriptor and, where the wire protocol is new, a
transport — not an edit to shared code. The target is roughly 120 conversation
surfaces; today the fifth one costs about as much as the fourth, and the
hundredth would cost more.

Authentication is the visible half of that and gets a real lifecycle. It is not
the whole job.

## Why this is a phase and not a feature

Three separate bottlenecks, all load-bearing:

**1. Three named drawers.** `ConnectorManager`
(`CinderpawAgent/src/transports/connectors.ts`) holds `#discord`, `#slack`,
`#whatsapp` as private fields, each with its own key field, start branch, stop
branch, reload diff and health entry. A fifth connector edits that class in
about six places. That is the bottleneck, and it grows.

**2. Two catalogs.** `crates/feral-core/src/connectors.rs` carries the rich
"Decision-D" catalog the headless gateway and CLI read.
`src-tauri/src/connectors.rs` carries the desktop's own catalog and view types.
The code says so itself: *"unrelated to this file's richer Decision-D catalog
above and keep their own shape for the existing UI."* So a new connector is
entered twice, by hand, in two shapes that can drift — and one of them is what
the user sees.

**3. Secrets in the clear.** Connector secrets live in
`~/.feral/connectors.json` as plain JSON. BYOK API keys, on the same machine,
live in the OS keychain with an AES-256-GCM file fallback on Linux
(`byok_file_store.rs`). A Discord bot token — which is access to somebody's
server — is protected worse than an OpenAI key.

**4. `enabled` is not `connected`.** The config says what was asked for. It
already had to be patched once with `connector-health.json` because "on" meant
"enabled in a file" while the bot was dead. A connector whose token expires on
its own — the whole point of OAuth — makes that gap permanent unless status
becomes a real thing.

## Constraints this spec is held to

These are contract-level and not up for interpretation during implementation.

1. **Pairing and transport are independent axes.** A descriptor names both. They
   never collapse into one enum. Two connectors may share a pairing method and
   have nothing else in common.
2. **An account never holds a secret.** It holds `secret_ref`. The value is read
   from the vault at the moment it is used, by the process that uses it.
3. **Secret migration is verified and resumable.** Write, verify, then rewrite
   the config atomically, then verify no secret remains. A process killed
   mid-migration must be able to finish on the next start. The secret is never
   logged, at any level, at any step.
4. **Device flow is a state machine, not a prompt.** Every state the user can be
   parked in is a named state the UI can read. "We are waiting for you" and "it
   timed out" are different states.
5. **`LiveConnector` does not become a universal abstraction.** Four methods,
   and `send` uses the contract the codebase already has.
6. **Adding a connector must not require modifying `ConnectorManager`.** If the
   fifth connector edits that class, the abstraction failed. This is an
   acceptance test, not an aspiration.
7. **One catalog.** `feral-core` owns it. The desktop renders a projection of
   it. There is no second list to keep in sync.

## Architecture

```
        ┌──────────────── feral-core (Rust) ────────────────┐
        │                                                    │
        │   Descriptor  ──►  Account  ──►  secret_ref        │
        │   (what it is)    (where it     (into the vault)   │
        │                    stands)                          │
        │        │              │              │              │
        └────────┼──────────────┼──────────────┼──────────────┘
                 │              │              │
      projection │              │ status       │ read at use
                 ▼              ▼              ▼
            Desktop UI     Desktop UI      Secret Vault
                                          (keychain / file)

        ┌──────────────── sidecar (TypeScript) ─────────────┐
        │   TransportRegistry:  Map<id, LiveConnector>       │
        │   start · stop · health · send(sessionId, text)    │
        └────────────────────────────────────────────────────┘
```

### A. Descriptor — a connector becomes data

One entry, in `feral-core`, read by every surface.

```rust
pub struct ConnectorDescriptor {
    pub id: String,                    // "matrix"
    pub name: String,                  // "Matrix"
    pub description: String,
    pub pairing: PairingMethod,        // how credentials are obtained
    pub transport: String,             // which LiveConnector runs it
    pub fields: Vec<FieldDef>,         // what the user provides
    pub validate: Option<String>,      // URL probed to check the credential,
                                       // as `validate_endpoint` does today
    pub docs_url: Option<String>,      // where the user gets what we ask for
}

pub enum PairingMethod {
    /// One or more pasted secrets. Discord, Telegram, Revolt.
    Token,
    /// A user-chosen instance URL plus a credential. Matrix, Mattermost, Zulip.
    InstanceToken,
    /// OAuth 2.0 device authorization grant. Twitch, and every provider that
    /// lets a public client authenticate without holding a secret.
    /// `device_url` starts the flow, `token_url` is polled and later refreshed
    /// against, `client_id` is public and ships in the descriptor.
    OauthDevice { device_url: String, token_url: String, client_id: String, scopes: Vec<String> },
}
```

`pairing` and `transport` stay independent because they vary independently:
Matrix and Mattermost share `InstanceToken` and share no wire protocol; a future
Twitch-adjacent service could share the transport and use a different pairing.

A `FieldDef` gains one thing it does not have today: `secret: bool` already
exists but is `true` for everything we ship. Matrix forces the other case — a
homeserver URL is **required and not secret**, so it belongs in the config file,
not the vault. That distinction is the reason Matrix is a witness.

**The desktop catalog is deleted as a source of truth.** `src-tauri/src/connectors.rs`
keeps its view types — the redacted shape the frontend already receives — but
builds them from the `feral-core` descriptors. Adding a connector touches one
list.

### B. Account — where a connection stands

```rust
pub struct ConnectorAccount {
    pub connector_id: String,
    pub display_name: Option<String>,  // "#general on chat.example.org"
    pub status: AccountStatus,
    pub metadata: BTreeMap<String, String>, // non-secret: instance URL, scopes, user id
    pub auth_state: Option<AuthState>, // only while pairing is in progress
    pub secret_ref: Option<String>,    // vault key. NEVER the value.
    pub expires_at: Option<i64>,
}

pub enum AccountStatus {
    Disconnected,   // nothing paired
    Pairing,        // a flow is in progress; see auth_state
    Connected,
    Expired,        // credential aged out; a refresh may fix it
    Revoked,        // the other side said no; only the user can fix it
    Error,          // something else, with a reason
}
```

`status` is the truth. `enabled` remains what the user asked for, and the two are
displayed separately because they answer different questions: *should this run*
versus *is this running*.

Nothing above ever carries a secret value. `secret_ref` is a vault key; the
sidecar resolves it when it opens a connection, and the desktop never resolves it
at all.

### C. Secret vault — the same road as BYOK

Connector secrets move to the storage BYOK already uses: OS keychain, with the
Linux AES-256-GCM file fallback. No new store, no new threat model.

**Migration, exactly:**

```
for each connector in connectors.json holding a plaintext secret:

  1. detect        legacy secret present
  2. write         vault.set(secret_ref, value)
  3. verify        vault.get(secret_ref) == value        ← fail ⇒ stop, keep config
  4. rewrite       config without the secret, temp file + atomic rename
  5. verify        re-read config; no secret field remains
```

Resumability falls out of the order: a crash after step 2 leaves the secret in
both places, and the next start re-runs the same steps — step 2 overwrites with
an identical value, step 3 passes, step 4 finishes the job. A crash before step 4
never loses the credential, because the config is only rewritten once the vault
copy is proven readable.

Failure at step 3 leaves everything as it was and surfaces one line the user can
act on: the vault is unavailable, the connector still works, and the secret is
still on disk. Silence here would mean the user believes they are protected when
they are not.

**No log line, at any level, ever contains the secret value** — not truncated,
not hashed, not "first four characters". The migration logs connector ids and
outcomes only.

### D. Transport registry — the drawers go away

```ts
export interface LiveConnector {
  start(ctx: ConnectorContext): Promise<void>;
  stop(): Promise<void>;
  health(): ConnectorHealth;
  send(sessionId: string, text: string): Promise<void>;
}
```

`send` is not a new invention. `ChannelSender` in
`CinderpawAgent/src/core/ask-user-channel.ts:28` is already
`(sessionId: string, text: string) => Promise<void>`, session ids are already
prefixed with the connector id, and `ChannelAskRouter` already routes by that
prefix. `LiveConnector.send` adopts that signature so the registry and the ask
router speak the same language, and no message envelope has to be designed.

`ConnectorContext` carries what a transport needs and nothing else: resolved
credentials, non-secret metadata, the agent handle, the log, and the run hooks —
the same things the three existing connectors take today, gathered into one
argument.

`ConnectorManager` keeps its reload/diff/health/persona logic and loses its typed
fields:

```ts
#live = new Map<string, LiveConnector>();
#keys = new Map<string, string>();
```

Transports register themselves into a registry at module load. The existing three
are wrapped, not rewritten: `DiscordConnector`, `SlackConnector` and
`WhatsAppConnector` keep their code and gain the interface.

## Device flow as a state machine

```
        request device code
                ↓
        waiting_for_user ──── user never finishes ───► timed_out
         (code + verify URL           ↓
          are on screen)         user denies ───────► denied
                ↓
            polling
                ↓
           connected
                ↓
        (token nears expiry) ──► refreshing ──┬──► connected
                                              └──► revoked
```

```rust
pub enum AuthState {
    WaitingForUser { user_code: String, verification_uri: String, expires_at: i64 },
    Polling { interval_secs: u64 },
    TimedOut,
    Denied,
}
```

What the user sees never mentions OAuth:

> **Connect Twitch**
> Open **twitch.tv/activate** and enter **ABCD-1234**

and when a refresh fails:

> **Twitch disconnected** — Reconnect

Twitch specifics that the design must respect, verified against Twitch's own
documentation: public clients may use **only** the device code flow — no
loopback authorization code, no client secret. Refresh tokens for public clients
are **single-use** and expire after 30 days of inactivity, so the new refresh
token must be stored on every refresh, and a user returning after a month lands
in `Revoked`, not in a retry loop.

Device flow needs no local HTTP server, so it also works on the headless gateway
(Cubby). Loopback + PKCE is left as a future `PairingMethod` variant, unbuilt:
none of the three witnesses needs it, and an unused flow is an untested one.

## The three witnesses

| Connector | Pairing | Transport | What it forces |
|---|---|---|---|
| **Matrix** | `InstanceToken` | matrix | Configuration that is required but not secret — a homeserver URL belongs in the config, the access token in the vault |
| **Mattermost** | `InstanceToken` | mattermost | Same pairing, different wire protocol — proves the two axes really are independent |
| **Twitch** | `OauthDevice` | twitch | A credential with a life of its own: expiry, single-use refresh, external revocation |

Each is added through the descriptor and a transport module. If any of them needs
a change to `ConnectorManager`, the abstraction is wrong and gets fixed before
the connector is merged.

## Non-goals

- A hosted relay, a Cinderpaw domain, or any server-side component. Decided against:
  it costs monthly infrastructure and puts tokens and messages through our
  machine, which contradicts the product.
- Webhook-based surfaces — Teams, Messenger, WhatsApp Cloud — which need a public
  HTTPS endpoint and therefore the relay above. The descriptor leaves room for
  them; this phase does not build them.
- Loopback + PKCE (see above).
- Rewriting Discord, Slack or WhatsApp. They are wrapped and registered.
- Changing message routing, personas, allowlists, or the public-mode behaviour.

## Acceptance criteria

1. **A connector is added without editing `ConnectorManager`.** Proven by a test
   that registers a fake descriptor and a fake transport from outside the module
   and drives it through start, health, send and stop.
2. **One catalog.** `src-tauri/src/connectors.rs` contains no connector list;
   its view types are built from `feral-core` descriptors. Adding an entry in one
   place changes both the CLI and the desktop.
3. **No secret in `connectors.json` after migration**, and the credential still
   works — verified by re-reading the file and by a successful connection.
4. **A killed migration completes on the next start**, with the credential intact
   in every intermediate state. Tested by injecting a failure at each step.
5. **No log line contains a secret value.** Tested by running the migration with
   a captured logger and asserting the sentinel value appears nowhere.
6. **`status` reflects reality.** An invalid token yields `Error`, an aged-out
   Twitch token yields `Expired` and then `Connected` after refresh, and a
   revoked one yields `Revoked` — none of them yields "on".
7. **The device flow is visible.** The user code and verification URL reach the
   UI as data, and a timeout is distinguishable from a denial.
8. **Matrix, Mattermost and Twitch each connect and answer a message.**
9. Existing connectors behave identically: Discord, Slack and WhatsApp keep their
   current pairing, personas, allowlists and health reporting.
10. `./scripts/verify.sh` is green.

## Test plan

- **Rust (`feral-core`)**: descriptor catalog shape; account state transitions;
  migration under injected failure at each of the five steps; log-sentinel test;
  vault-unavailable path leaves config untouched and reports.
- **Rust (`src-tauri`)**: the desktop view is a projection — a descriptor added to
  `feral-core` appears in the desktop catalog with no second edit; secrets never
  cross the boundary.
- **TypeScript (sidecar)**: registry start/stop/health/send with a fake transport;
  the no-edit acceptance test from criterion 1; reload diffing still restarts only
  what changed; ask-router prefix registration unchanged.
- **Device flow**: fake clock and fake token endpoint — `waiting_for_user` →
  `polling` → `connected`; timeout; denial; refresh success storing the *new*
  refresh token; refresh failure yielding `Revoked`.
- **Frontend**: the connector card renders each status, and the device-code
  instruction renders as a code and a link.

## Risks

- **Matrix and Mattermost transports are new code against real protocols.** Each
  is small (both are HTTP + WebSocket), but neither has been written here before.
  If either turns out to be large, it ships as its own commit after the engine —
  the engine's value does not depend on it.
- **The two-catalog merge touches a surface the desktop already renders.** The
  view types stay identical on purpose so the frontend does not change in the same
  commit as the catalog.
- **Twitch's 30-day single-use refresh** means a long-idle machine will show
  `Revoked`. That is correct behaviour, not a bug, and the copy has to say so
  plainly rather than looking like a failure.

---

## What turned out differently (closed 2026-08-20)

Five things the design did not foresee. Each is in the code with a test.

**The migration switched the product off.** Task 3 deletes every connector
secret from `connectors.json` — the point of it — but the sidecar, the process
that actually holds the connections, only ever read that file. The first start
after migrating would have brought EVERY connector up blank on a machine where
nothing was wrong the day before. Closed by `resolved_connector_configs()`:
the rows now travel with their secrets over the same `connectors_reload` poke.
Found while writing Task 13, not by any of the tests written for Task 3.

**Matrix ids contain colons.** `matrix:<room>:<user>` split on `:` gives five
pieces and a room that does not exist. Both halves are percent-encoded.

**A homeserver that ignores the sync timeout makes a hot loop.** The spec is
that `/sync` is held open; not every server honours it, and the difference
between "polling" and "pinning a core" is a 250 ms floor.

**Twitch's IRC refuses a NICK that does not match the token.** Rather than ask
someone to retype a username Cinderpaw already knows, `pair_poll` asks Helix once
at grant time and stores it — which also gives the card "as <name>" for anyone
with two accounts.

**Refresh cannot live in the transport.** The plan had Task 13 call `refresh()`
before connecting. The vault and the client id are in Rust and the transport is
Bun, so the transport reports "needs renewing" and the host renews before
handing credentials over (`refresh_expired_accounts`).

### Left open, deliberately

- `boot.rs` still discards the `MigrationReport` (`let _ = …`). If the vault is
  unavailable, secrets stay in plaintext and the only sign is a log line. The
  account card is per-account and has nowhere to say it; this needs a surface
  of its own.
- Nothing drives `connector_pair_poll` on an interval yet — the commands and
  the card exist and are tested, the Connectors page that ties them together
  does not.
- Renewal happens on a reload, not on a timer. A machine left running for a
  day renews at the next config change or restart, not the moment a token
  expires.
