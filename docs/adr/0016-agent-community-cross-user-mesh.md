# ADR-0016: Agent Community — mesh cross-user cu identity + reputation + moderation

**Status:** Proposed (post-v1.0 milestone)
**Date:** 2026-08-20
**Related:** ADR-0015 (Multi Agents — prerequisite), public-journal export layer

## Context

ADR-0015 acoperă multi-agent PERSONAL — user-ul are echipa lui, agents comunică între ele local. Community e stratul următor: **agentul MEU vorbește cu agentul TĂU**.

Use cases target:
- Un dev cere ajutor de la un "Debugger" agent al altui utilizator care e specialist pe React memory leaks.
- Un grup de researchers împart un agent "Literature Reviewer" antrenat pe corpus specific.
- Un mesh de agents care colaborează pe un proiect open-source (unul face issue triage, altul PR review, altul release notes).
- Agent marketplace — user X publică un "Rust Auditor" agent, alți users îl "hire" cu propriile keys.

User (2026-08-20):
> "Agentul TĂU vorbește cu agentul ALTUI om. Ființe de la oameni diferiți colaborează pe proiecte comune. Aici ai nevoie de conturi, reputație (ca să știi cui îi lași agentul lângă proiectul tău), moderare, și eventual paywall."

Ce e diferit vs. Multi Agents:
- **Identity layer** — cine ești în network. Nu doar random UUID pe device.
- **Trust signal** — reputație pentru agents publicate (rating, uptime, adoption count).
- **Moderation** — infrastructure pentru abuse (spam agents, malicious tool calls, prompt injection reflected).
- **Paywall** — opțional, per-agent-invocation billing.
- **Discovery** — public directory de agents "for hire".
- **Sandboxing** — agentul TĂU rulează tool-uri pe mașina TA. Cum accepți safely un agent străin să opereze aici?

Cel mai greu: **sandboxing** (agent străin poate face damage) și **moderation** (spam, prompt-inject reflected via agent output).

## Decision

Foarte cautious. Community e post-v1.0 (după stabilization completă cu multi-agents personal). 4 straturi, fiecare cu decision separate:

### C1 — Identity: pseudonymous handle + optional verification

- User creează un handle `@yourname` la primul opt-in Community. Stored pe un central lightweight registry (hosted service, sau federation eventuall).
- Handle immutable după claim (evitare squatting swap).
- Optional verification: link la GitHub username → verified badge. Sau prin `.well-known/cinderpaw-identity.json` pe domain owned.
- Zero email required — but bring one dacă vrei recovery.

Storage:
```
cinderpaw registry (central hosted):
├── handles.db
│   └── (@handle, publicKey, createdAt, verifiedGithub, verifiedDomain)
```

Client keeps private key în OS keychain, signs actions cu it. Server never sees private key.

### C2 — Agent publishing + discovery

User din UI poate "Publish" un agent din team-ul lui la Community. Publish flow:

1. User selects agent → "Publish to Community".
2. UI shows what will be exposed: `name`, `personality`, `system_prompt` (SHOWN — sanity check), `tools_declared` (allowlist), NO memory, NO skills content.
3. User sets:
   - **Availability**: 'public' | 'invite-only' | 'friends' (in relation graph).
   - **Rate limits**: max N invocations per requester per day.
   - **Cost model**: 'free' | 'byok-required' (requester uses OWN keys) | 'paid' (requester pays user X, minus platform fee).
   - **Tool policy**: which requester-side tools agent can invoke (default: NONE beyond read-only).

Server registers agent under `@handle/agent-name`, indexes for discovery.

Discovery page: `cinderpaw.ai/community` (hosted) — search by capability, rating, cost.

### C3 — Agent invocation cross-user (SANDBOX)

Cel mai delicat. Requester says "run @alice/rust-auditor on my code". What runs where?

**Design pattern: agent runs ON THE PUBLISHER'S MACHINE**, not requester's.

```
Requester (Bob)                                Publisher (Alice)
┌─────────────────┐                            ┌─────────────────────┐
│ Cinderpaw       │                            │ Cinderpaw           │
│ my-code.rs      │                            │  @alice/rust-auditor│
│                 │                            │  (published, alive) │
│  "invoke        │                            │                     │
│   @alice/       │                            │                     │
│   rust-auditor  │  ── snapshot of code ──▶   │  runs analysis      │
│   on this"      │                            │  in HER sandbox     │
│                 │                            │  cu HER budget      │
│                 │  ◀── verdict + report ──── │  (or requester      │
│                 │                            │   pays for it)      │
└─────────────────┘                            └─────────────────────┘
       │                                              │
       └── coordinator via registry ──────────────────┘
```

Beneficii:
- Requester's machine NU rulează cod străin. Alice's agent inspectează code, dar tool calls happen în Alice's sandbox.
- Alice controlează ce tools agent-ul ei folosește. Nu Bob.
- Alice bills invocations (dacă cost model = 'paid').

Constraint: agent output visible la Bob poate include prompt injection reflected. Deci:
- **Output sanitization** înainte de show la Bob (strip control chars, sanitize markdown).
- Bob's Cinderpaw doesn't act on Alice's agent output automat — user must confirm each suggestion.

**Alternative**: agent code (system prompt + tool policy) e transmis la Bob, rulează local pe Bob's machine. Simpler infra, dar security nightmare — cod străin loose în Bob's sandbox. Reject.

### C4 — Moderation + reputation

**Reputation:**
- Per-agent rating (1-5 stars) după fiecare invocation, requester poate rate.
- Uptime tracking — dacă publisher offline, agent inaccessible → penalty score.
- Response time metric public.
- Adoption count (how many unique requesters used it).

**Moderation:**
- Reports flow — Bob click "report" pe output de la @alice/agent → central review queue.
- Automated pre-filters: registrar signs agents cu prompt injection detected în system_prompt refuses to list.
- Publisher can be shadow-banned per handle dacă >3 verified abuse reports.
- **Content policy**: no CSAM, no hate speech, no active malware distribution. Standard.

**Governance:**
- Community moderators (initial: Cinderpaw team + trusted contributors).
- Eventually: federation model — separate community registries pentru different trust groups (analogous cu Mastodon instances).

### C5 — Paywall (optional, defer to Phase 2)

For agents marked 'paid':
- User B invokes @alice/rust-auditor at $0.10/invocation.
- Cinderpaw Community platform intermediates: B's card charged, minus X% platform fee, remainder paid to A.
- Requires: KYC pentru payouts, tax handling, dispute resolution.

**Strong recommendation**: defer paywall to Community v2. Free (BYOK) și 'byok-required' modes shipping first, prove product-market fit, then add paid.

## Consequences

**Positive:**
- Cinderpaw devine platform, not just app. Network effects.
- User can leverage specialized agents fără să-i antreneze singur.
- Marketplace effect — cei mai buni agents surface.
- Federation eventual = decentralized alternative la OpenAI GPT Store.

**Negative:**
- Sandboxing model (agent runs on publisher's machine) requires publisher să lase Cinderpaw pornit 24/7 sau accepta invocation queue.
- Central registry = single point of failure. Federation adds complexity.
- Moderation load scales cu adoption. Nevoie de tooling + dedicated humans.
- Legal exposure — platform hosted, must handle DMCA, GDPR, etc.
- Payments infrastructure (paywall) e mai simple to say than build.

**Prerequisites:**
- ADR-0015 layer 2 shipped and stable (multi-agent personal working).
- ADR-0014 Brain Stack mature (cost accounting foundation).
- Bug backlog cleared la nivel de audit findings §142/§150/§151/§232 (MOAT breakers) — nu poți lansa mesh public dacă sandbox escape encă posibil.
- Explicit user opt-in flow, cu clear consent pentru what data leaves device.

**Rollout suggestion:**
- v1.5: C1 (identity) + C2 (publishing to invite-only friends). Beta cu 100 users.
- v1.6: C3 (cross-user invocation, sandboxed). Extended beta.
- v2.0: C4 (public discovery + reputation). GA.
- v2.5+: C5 (paywall).

## Open questions

- **Hosting Central Registry** — self-host (Cinderpaw team owns costs) vs. federate day 1 (harder infrastructure)?
- **Encryption în transit** — agent invocation e sensitive (contains user code/data). TLS obvious. E2E encryption între requester și publisher direct? Complicated (registry can't moderate what it can't see).
- **Attribution** — dacă agent A produce content, cine "owns" IP? Publisher agent? Requester who invoked? Both? Nevoie de clear ToS.
- **Kill switch** — user care publica un agent care devine abused, poate "unpublish"? Yes obviously, dar existing invocations în flight — dropped sau completed?

## References

- Depends on: ADR-0015 (Multi Agents personal)
- Related: `public-journal/*` (existing export layer — foundation for reputation signals)
- External inspiration: OpenAI GPT Store (centralized), Mastodon (federation), Hugging Face Spaces (compute hosting)
