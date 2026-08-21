# ADR-0017: Shared Projects — first paid tier of Cinderpaw

**Status:** Proposed (target v1.2, February 2027)
**Date:** 2026-08-21
**Related:** STRATEGY-PIVOT.md (canonical), ADR-0015 (Multi Agents personal), supersedes half of ADR-0016
**Prerequisites:** v1.0 rebrand shipped, v1.1 personal teams shipped

## Context

Per STRATEGY-PIVOT.md, Cinderpaw introduces its first paid tier around **shared projects**: two or more users collaborate on the same project, each running their own agents with their own inference (local GGUF or cloud BYOK). The Cinderpaw server hosts identity, membership, event relay, and encrypted blob storage — never inference, never plaintext.

Thesis (Opus, verbatim from 2026-08-21):

> Vinzi coordonare, nu tokeni. Marja ta stă la 95%+ pentru totdeauna, indiferent cât de mult muncește un user. Un concurent care găzduiește inferență nu poate egala prin preț.

This ADR specifies the technical scope for v1.2 Shared Projects Beta.

## Scope

### In scope for v1.2 Beta

1. **Ed25519 identity** generated locally on first shared-project use
2. **Duo tier** ($12/lună flat) — up to 2 users, 1 shared project, 5 GB storage, single-payer billing
3. **Invite via link** (no account required for peer)
4. **Conversation sync** append-only log
5. **Project membership sync** (add/remove members, permissions)
6. **File sync** last-write-wins with visibility banner
7. **Presence** heartbeat
8. **Model divergence UX** — each action tagged with `model_id`, visible per message
9. **Offline task queue** — encrypted task waits for recipient device online

### In scope for v1.2 GA (May 2027, on top of Beta)

10. **Team tier** ($8/user/lună) — unlimited users/projects, SSO (Google/GitHub), audit log, 50 GB storage
11. **Cross-user permission gate** — extend `FeralAgent/src/sandbox/*` to gate by `agent_owner + resource_owner`
12. **Approval flow** for destructive cross-user operations
13. **Audit log export** for Team tier compliance

### In scope for v1.3 (post-GA)

14. **Business tier** ($16/user/lună) — SSO SAML, GDPR data residency (EU relay), priority support
15. **CRDT sync** for files (Yjs) if Beta feedback demands
16. **Always-on delegate device** as Business feature

### OUT of scope (deferred)

- ❌ Enterprise self-hosted relay (v2.0+)
- ❌ Agent marketplace (v2.0+, if ever)
- ❌ Payment processing cross-user (removed from vision entirely — was ADR-0016)
- ❌ Sybil-resistant public reputation (removed — social feed is v1.5 different design)

## Technical architecture

### Server components (Rust, hosted on Cinderpaw infrastructure)

```
┌─────────────────────────────────────────────────────────┐
│  Cinderpaw Relay (Rust, per-region)                     │
│  ├── Identity registry (Ed25519 pubkey → user_id)       │
│  ├── Project membership graph (SQLite / Postgres)       │
│  ├── WebSocket event relay (encrypted payloads)         │
│  ├── Blob storage proxy (S3-compatible, E2E-encrypted)  │
│  ├── Presence tracker (Redis TTL 30s)                   │
│  └── Billing gate (Stripe webhook integration)          │
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
2. Sidebar: „Upgrade to shared project" → opens Duo tier billing dialog
3. Stripe checkout: $12/lună, single payer
4. Post-payment: existing local project migrates to shared (data stays local + syncs to relay)
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

## Pricing implementation

Handled by Stripe:
- Duo: $12/lună subscription, one payer (project owner)
- Team: $8/user/lună metered subscription, one admin billing
- Free tier stays free — no Stripe touched for solo users

Free tier promise enforced in code:
- Any solo-tier local feature MUST NOT check server-side entitlement
- Solo tier local features have no `require_paid()` gate anywhere
- Server-side entitlement only checks for shared-project actions

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

## Legal & compliance

### GDPR obligations at Team+ tier

- Right to access: user can export all data (Team+ features audit log export)
- Right to erasure: user can delete account; membership records anonymized, encrypted blobs deleted
- Data residency: Business tier offers EU-only relay option
- DPA (Data Processing Agreement): template provided for Team+ customers requiring one

### Solo tier explicitly OUT of GDPR scope

Because solo tier has no account, no server-side data, no data leaves the device. GDPR concerns don't apply — nothing to comply with.

### Terms of Service updates

New TOS section required for paid tiers, drafted separately in `docs/legal/`.

## Migration path

### From v1.1 (personal teams local) to v1.2 Beta

- No breaking changes for solo users — they see nothing different
- Existing projects gain „Upgrade to shared" option in menu
- Upgrading a local project migrates: creates Ed25519 identity, uploads encrypted snapshot to relay, marks as shared

### From v1.2 Beta to GA

- Duo Beta users continue on Duo tier
- Team tier becomes available; Duo can upgrade to Team preserving all data
- Beta users get 3 months free of GA pricing as thank-you

## Rollout plan

### Alpha (internal, dec 2026 — jan 2027)

- Solo dev + 2-3 friends test full flow
- Instrumentation, bug reports, iteration

### Closed Beta (feb 2027)

- Waitlist users invited in cohorts of 50
- Support handled personally by Darius
- Weekly feedback surveys
- Public transparency updates in Discord

### Open Beta (mar-apr 2027)

- Public signup enabled
- Duo tier billing goes live
- Documentation published

### GA (may 2027)

- Team tier launches
- Pricing formalized
- Business tier waitlist opens

## Open questions

1. **Payment processor:** Stripe vs Paddle for RO merchant of record?
2. **Relay hosting:** self-managed VPS (cheap) vs managed (Fly.io / Railway) for reliability?
3. **Encrypted storage backend:** S3 direct vs Cloudflare R2 (no egress fees) vs Backblaze B2?
4. **Cross-user permission UI:** where does user configure „B's agent can/cannot"? Settings per project seems right but needs mockup.
5. **Handoff dialog specifics:** what's the minimum viable version for v1.2 Beta? Full „diff-and-approve" or lighter „just notify"?

## References

- STRATEGY-PIVOT.md — canonical thesis and pricing
- ADR-0015 — personal team primitives that shared projects build on
- ADR-0018 — Agent Feed (separate free feature, marketing funnel)
- LAUNCH-PLAYBOOK-CINDERPAW.md — v1.0 launch marți 26 aug
- Opus conversation transcript 2026-08-21 (in user messages)
