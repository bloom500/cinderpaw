# ADR-0017: Shared Projects — technical research

**Status:** Deferred commercial scope; technical research only
**Date:** 2026-08-22
**Related:** STRATEGY-PIVOT.md (canonical), ADR-0015 (Multi Agents personal), supersedes half of ADR-0016
**Prerequisites:** v1.0 rebrand shipped, v1.1 personal teams shipped

## Context

Per STRATEGY-PIVOT.md, Shared Projects are a research direction: two or more users may collaborate on the same project, each running their own agents with their own inference (local GGUF or cloud BYOK). The Cinderpaw server, if tested, hosts only identity, membership, event relay, and encrypted blob storage — never inference, never plaintext.

This ADR specifies technical questions and a narrow research prototype. It does not define a launch date, commercial model, tiers, pricing, or payment flow.

## Scope

### In scope for the research prototype

1. **Ed25519 identity** generated locally on first shared-project use
2. **Invite via link** with explicit acceptance and revocation
3. **Conversation sync** append-only log
4. **Project membership sync** (add/remove members, permissions)
5. **File sync** last-write-wins with visibility banner
6. **Presence** heartbeat
7. **Model divergence UX** — each action tagged with `model_id`, visible per message
8. **Offline task queue** — encrypted task waits for recipient device online

### Later research, only after the prototype is understood

9. **Cross-user permission gate** — extend `FeralAgent/src/sandbox/*` to gate by `agent_owner + resource_owner`
10. **Approval flow** for destructive cross-user operations
11. **Audit trail export** for project members
12. **CRDT sync** for files (Yjs) if real testing requires it
13. **Always-on delegate device** as a separate technical experiment

### OUT of scope

- ❌ Pricing, subscriptions, billing, checkout, or payment processing
- ❌ Commercial tiers, entitlements, or discount promises
- ❌ Enterprise self-hosted offering
- ❌ Agent marketplace
- ❌ Sybil-resistant public reputation

## Technical architecture

### Server components (Rust, hosted on Cinderpaw infrastructure)

```
┌─────────────────────────────────────────────────────────┐
│  Cinderpaw Relay (Rust, per-region)                     │
│  ├── Identity registry (Ed25519 pubkey → user_id)       │
│  ├── Project membership graph (SQLite / Postgres)       │
│  ├── WebSocket event relay (encrypted payloads)         │
│  ├── Blob storage proxy (S3-compatible, E2E-encrypted)  │
│  └── Presence tracker (Redis TTL 30s)                   │
└─────────────────────────────────────────────────────────┘
```

### Client sync layer (extends FeralAgent)

```
┌─────────────────────────────────────────────────────────┐
│  FeralAgent/src/sync/                                   │
│  ├── identity.ts         — Ed25519 keygen + storage     │
│  ├── project-sync.ts     — Conversation + membership    │
│  ├── file-sync.ts        — File LWW with visibility     │
│  ├── invite.ts           — Pairing token generate/verify│
│  ├── relay-client.ts     — WebSocket to relay           │
│  ├── crypto.ts           — E2E encrypt/decrypt          │
│  └── task-queue.ts       — Offline task encryption      │
└─────────────────────────────────────────────────────────┘
```

### Data flow example — user A messages agent in shared project

```
User A (RO)                    Cinderpaw Relay              User B (UK, offline)
    │                                │                               │
    │ 1. Message + agent action      │                               │
    │───encrypt(project_key)───────▶│                               │
    │                                │ 2. Store encrypted in relay   │
    │                                │    queue for user B           │
    │                                │                               │
    │ 3. Local agent A executes      │                               │
    │    (qwen-32b on device)        │                               │
    │                                │                               │
    │ 4. Response + tool calls       │                               │
    │───encrypt(project_key)───────▶│───queue for user B───────────▶│ (still offline)
    │                                │                               │
    │                                │                               │
    │                                │◀──user B device wakes─────────│
    │                                │───deliver queued events───────▶│
    │                                │                               │ 5. User B sees:
    │                                │                               │    - agent A action
    │                                │                               │    - tagged model: qwen-32b
    │                                │                               │    - handoff dialog
```

### Cross-user permission gate

Current `FeralAgent/src/sandbox/` sandbox decides based on agent permissions declared in tool manifest. New requirement: decide based on **agent_owner + resource_owner** pair.

Pseudo-policy:

```
allow(agent, tool, target):
  if agent.owner == target.owner:
    return current_policy(agent, tool)  # local sandbox rules
  else:
    return cross_user_policy(
      agent_owner=agent.owner,
      target_owner=target.owner,
      tool=tool,
      target=target,
      project_permissions=project.permissions_for(agent.owner)
    )

cross_user_policy:
  read: allowed by default if project member
  write: requires explicit project permission + audit log entry
  delete: requires approval from resource_owner OR project admin
  execute: requires explicit permission per tool per user
```

Configurable per project by owner. Default template for Duo: read-all, write-approve, delete-approve.

## User flows

### Flow 1 — Create shared project

1. User A in Cinderpaw solo (existing local)
2. Sidebar: „Explore shared project" → opens a research disclosure dialog
3. User explicitly opts into the prototype and reviews what data would be synchronized
4. Existing local project remains local until the user confirms the test
5. Invite link generated

### Flow 2 — Accept invite (peer, no account)

1. User B clicks link `https://cinderpaw.dev/join/xB9k3Lm7pQr2`
2. If Cinderpaw installed: deep link opens app to Accept Invite dialog
3. If not: browser shows „Someone invited you to work on X. Get Cinderpaw." → download → post-install auto-prompt for pending invite
4. Accept → Ed25519 pairing → project appears in sidebar with shared indicator

### Flow 3 — Peer works while you sleep

1. User A (RO) says goodnight, closes laptop
2. User B (UK) opens shared project, tells own agent to refactor file X
3. Agent B (Claude) does work → syncs changes to relay → queued for A
4. User A wakes, opens Cinderpaw → sees:
   - Notification badge on shared project
   - Diff view: „Andrei's agent (Claude Sonnet 4.6) modified X while you were away"
   - Handoff summary: „Andrei asked: refactor auth logic. Claude changed 3 files, added 2 tests."
   - Approve / discuss / continue options

### Flow 4 — Model divergence dialog

1. User A's qwen agent wrote `auth.ts` yesterday
2. User B asks Claude agent to review
3. Claude reviews, suggests changes with different style preferences
4. User A sees notification: „Andrei's Claude reviewed your qwen's work. 4 suggestions differ from qwen's original style — see comparison."
5. Options: accept all, review one-by-one, revert

## Current implementation boundary

There is no billing or entitlement layer in the current prototype. Solo flows must not call a server-side account or payment service.

Technical guardrails:
- Any solo local feature MUST NOT check a server-side entitlement
- No checkout, subscription, coupon, or payment provider integration
- Shared-project research must be opt-in and visibly experimental
- Export and deletion paths are tested before real project data is invited

## Security model

### Threats addressed

1. **Server compromise:** relay database leaked → attacker has metadata (who's in what project, when active) but zero plaintext content
2. **Agent poisoning cross-user:** user B's agent tries to read/write user A's private files → blocked by cross-user permission gate + audit log alert
3. **Man-in-the-middle:** all client-relay traffic TLS 1.3, all payloads E2E encrypted with project key derived from pairing
4. **Malicious invite link:** links are single-use, expire 7 days, cannot be replayed. Accepting requires user click (no drive-by).
5. **Prompt injection via shared conversation:** if user B pastes malicious content, user A's agent MAY encounter it. Mitigation: same as single-user (agent behavior policies, tool call review), no cross-user specific mitigation possible.

### Threats explicitly NOT addressed

- ❌ **Nation-state adversary with access to both endpoints' devices** — E2E crypto doesn't help if endpoint compromised
- ❌ **Malicious project member behavior** — trust is human problem; audit log is only mitigation
- ❌ **BYOK cloud provider reading data** — outside Cinderpaw's control; user's API key with user's cloud provider

## Privacy & compliance for research

If a server component is tested with real users, document data flows, retention, deletion, and EU privacy obligations before the invitation. End-to-end encryption does not remove the need to explain metadata and operational processing.

Solo local mode remains the default: no account, no relay, no server-side project data.

Any future terms for a hosted collaboration service are a separate decision and are not part of this ADR.

## Migration path

### From v1.1 personal teams to Shared Projects research

- No breaking changes for solo users — they see nothing different
- Existing projects remain local by default
- An explicit research action creates a test copy or opt-in shared view
- No automatic upload of local memory, API keys, or unrelated files

### Research rollout

- Internal test with Darius and 2–3 friends
- Small invitation cohorts only after the prototype is stable enough to observe
- Weekly feedback and public technical notes
- No public production launch commitment yet

## Open questions

1. **Relay hosting:** self-managed VPS vs managed provider for reliability
2. **Encrypted storage backend:** S3-compatible storage vs direct peer exchange
3. **Cross-user permission UI:** where does a project owner configure „B's agent can/cannot"?
4. **Handoff dialog:** what is the minimum viable context for a safe takeover?
5. **Offline behavior:** queue semantics, expiry, retry, and deletion
6. **Export and recovery:** what must be locally recoverable if the relay disappears?

## References

- STRATEGY-PIVOT.md — canonical current direction and research boundary
- ADR-0015 — personal team primitives that shared projects build on
- ADR-0018 — Agent Feed (separate research direction)
- LAUNCH-PLAYBOOK-CINDERPAW.md — v1.0 launch marți 26 aug
- Opus conversation transcript 2026-08-21 (in user messages)
