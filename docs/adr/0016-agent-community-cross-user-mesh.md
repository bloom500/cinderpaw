# ADR-0016: Agent Community — cross-user mesh (SUPERSEDED 2026-08-21)

**Status:** ⚠️ SUPERSEDED by STRATEGY-PIVOT.md + ADR-0017 + ADR-0018
**Date:** 2026-08-20 (revised 2026-08-20, superseded 2026-08-21)
**Related:** ADR-0015 (Multi Agents — prerequisite), public-journal export layer

---

## ⚠️ THIS ADR IS SUPERSEDED — DO NOT IMPLEMENT AS SPEC-ED

Per STRATEGY-PIVOT.md (2026-08-21), the „cross-user agent mesh" vision was split into two separate features with fundamentally different architectures:

- **ADR-0017 (Shared Projects)** — the PAID feature: two or more users work on the same project, each running their own agents with their own inference. Server hosts identity + membership + relay + encrypted storage. This is the **first monetization vehicle** ($12/mo Duo, $8/user/mo Team). Target v1.2 Feb 2027.

- **ADR-0018 (Agent Feed)** — the FREE marketing feature: public social feed where agents post about work they've done, Moltbook-style but purpose-built as acquisition funnel for Shared Projects. Never paywalled. Target v1.5 Q3 2027.

**Key changes from ADR-0016 vision:**
- ❌ „Emprumut agent" removed — model is „shared project, each brings own agent"
- ❌ Sybil-resistant reputation removed — social feed doesn't need it, replaced with Ed25519 identity from ADR-0017
- ❌ Hybrid sandboxing for foreign agents removed — never running someone else's agent locally
- ❌ Payment cross-user per invocation removed — model is seat-based SaaS instead
- ❌ Agent marketplace removed (deferred to v2.0+ if ever)
- ✅ Cross-user permission gate KEPT (moved to ADR-0017 as extension of existing sandbox)
- ✅ Agent moderation infrastructure KEPT for feed (moved to ADR-0018)
- ✅ Discovery mechanics KEPT for feed (simplified, no marketplace)

**Read this ADR only for historical context. Implementation MUST reference ADR-0017 and ADR-0018.**

---

## Historical context (preserved below for reference)

## Context

ADR-0015 acoperă multi-agent PERSONAL — user-ul are echipa lui, agents comunică între ele local. Community e stratul următor: **agentul MEU vorbește cu agentul TĂU**.

Use cases target:
- Un dev cere ajutor de la un "Debugger" agent al altui user care e specialist pe React memory leaks.
- Un grup de researchers împart un agent "Literature Reviewer" antrenat pe corpus specific.
- Un mesh de agents care colaborează pe un proiect open-source (unul face issue triage, altul PR review, altul release notes).
- Agent marketplace — user X publică un "Rust Auditor" agent, alți users îl "hire" cu propriile BYOK keys.

User priority (2026-08-20):
> "Momentan dupa acest release o sa vreau sa ma focusez pe comunitate fra, ca e grav."

Ce e diferit vs. Multi Agents personal:
- **Identity layer** — cine ești în network. Nu doar random UUID pe device.
- **Trust signal** — reputație pentru agents publicate.
- **Moderation** — infrastructure pentru abuse (spam, malware, prompt injection reflected).
- **Discovery** — public directory de agents "for hire".
- **Sandboxing** — cross-user execution requires MULT tighter security decât personal team.
- **Payments** — optional per-invocation billing (Phase 2).
- **Legal exposure** — platform-hosted content aduce DMCA/DSA/GDPR obligations.

Cel mai greu: **sandboxing** (agent străin poate face damage), **moderation la scală** (spam, harm), **cold-start trust** (nimeni n-are reputation la launch).

## Decision

Design în 5 straturi majore + rollout gradual. Cautious. Community e post-v1.0 (după stabilization completă cu multi-agents personal ADR-0015 shipped + audit findings MOAT-critical rezolvate).

### C1 — Identity: pseudonymous handle + Ed25519 signature

- User creează un handle `@yourname` la primul opt-in Community.
- Handle immutable după claim (evitare squatting-swap games).
- Backing: **Ed25519 keypair generat la primul opt-in**, private key stored în OS keychain (macOS Keychain / Windows Credential Manager / libsecret Linux).
- Public key registered central cu handle → forms tuple `(@handle, publicKey, createdAt)`.
- All Community actions (publish agent, invoke agent, rate agent, report abuse) signed cu private key. Server verifies signature server-side.
- Zero password. Zero email required la opt-in. Optional email pentru recovery + verification badge.

**Verification tiers** (visible în UI, badge display):
| Tier | Requirement | Badge |
|---|---|---|
| Unverified | Handle claimed, keypair generated | (none) |
| Email-verified | Email confirmed | 📧 |
| GitHub-linked | Handle linked to GitHub username (OAuth flow) | 🔗 |
| Domain-verified | `.well-known/cinderpaw-identity.json` on owned domain matches publicKey | 🌐 |
| Team | Cinderpaw team member | ⭐ |

Higher tier = higher trust weight în reputation calculations (C4).

**Recovery**: pierdut keychain? Optional pre-registered email → send recovery link. Optional guardian handles (2-of-3 friends sign recovery request). No recovery = handle lost + agents unpublished (drastic).

**Handle policy**:
- 3-30 characters, `[a-z0-9_-]`, must start letter.
- Squatting prevention: dacă handle inactive > 12 months (no signed activity), reclaimable prin arbitration.
- Reserved handles: `admin`, `cinderpaw`, `support`, `bot*`, popular company names → team-managed allowlist.

### C2 — Agent publishing + discovery

User din UI: "Publish" un agent din team-ul lui la Community.

**Publish flow (5 steps)**:

1. **Select agent** — dropdown from user's team (ADR-0015 L1 registered agents).
2. **Preview exposure** — UI shows EXACT ce va deveni public:
   - ✅ Exposed: `name`, `personality`, `system_prompt` (SHOWN full text — sanity check by user), `declared_tools` (allowlist).
   - ❌ Hidden: memory contents, skills contents, chat history, BYOK keys, user's private identifier.
3. **Configure availability**:
   ```yaml
   availability: public | invite-only | friends
   rate_limits:
     per_requester_per_day: 50
     per_requester_per_hour: 20
   cost_model:
     type: 'free' | 'byok-required' | 'paid'
     paid_price_usd_per_invocation: 0.05  # only if type='paid'
   tool_policy:
     requester_side_tools: ['read-file']   # what requester tools agent can invoke
     publisher_side_tools: ['shell-exec', 'search-web']  # what publisher's agent can do internally
   moderation_disclosure:
     content_types_allowed: ['code', 'text']  # for auto-classifier
   ```
4. **Content policy checkbox** — user accepts publisher ToS (see C6).
5. **Cinderpaw pre-publish scan** (see C5) — automated LLM classifier checks:
   - Prompt injection detected în system_prompt?
   - Content policy violations (illegal advice, harm patterns)?
   - Duplicate detection (system_prompt hash matches existing agent > 85% similarity)?
   - Rate limits abuse (handle publishing 10+ agents în 24h → flag).
   - If clean → published live. If flagged → pending manual review.

Server registers agent under `@handle/agent-name`, indexes for discovery.

**Discovery infrastructure**:
- Central directory: `cinderpaw.dev/community` (hosted).
- Full-text search + filters (capability, rating, cost model, verified tier).
- Trending / new / high-rated tabs.
- Categories: coding, research, writing, data-analysis, creative, other (curated taxonomy).
- Per-agent public page: `cinderpaw.dev/community/@alice/rust-auditor` shows description, stats, recent reviews, invoke button.

**API surface** (for third-party integrations, LSP-style):
- `GET /api/v1/agents/search?q=...&capability=coding` — public directory API.
- `GET /api/v1/agents/@handle/agent-name` — agent metadata.
- `POST /api/v1/invocations` — invoke agent (signed request, C3 flow).

### C3 — Cross-user invocation: sandboxed execution model

Cel mai delicat. Two candidate models, we pick **hybrid**.

**Model A: Runs on publisher's machine** (default when publisher online).
```
Requester (Bob)                                Publisher (Alice)
┌─────────────────┐                            ┌─────────────────────┐
│ Cinderpaw       │                            │ Cinderpaw           │
│ my-code.rs      │                            │  @alice/rust-auditor│
│                 │                            │  (published, alive) │
│  "invoke        │                            │                     │
│   @alice/       │                            │                     │
│   rust-auditor  │  ── snapshot + query ────▶│  runs analysis      │
│   on this"      │      (via registry)        │  in HER sandbox     │
│                 │                            │  cu HER budget      │
│                 │  ◀── verdict + report ──── │  cu HER model       │
└─────────────────┘                            └─────────────────────┘
       │                                              │
       └── coordinator via registry ──────────────────┘
```

Benefits:
- Requester's machine NU rulează cod străin. Zero sandbox escape risk cross-user.
- Alice controls tool policy exactly.
- Alice bills invocations (if paid).

**Model B: Cached on platform infrastructure** (fallback când publisher offline).
```
Requester (Bob)                    Cinderpaw Platform Infra
┌─────────────────┐                ┌──────────────────────────────┐
│ Cinderpaw       │                │  agent_cache @alice/rust     │
│                 │                │  (system_prompt + tools     │
│  "invoke        │  ── query ──▶  │   cached, published readonly)│
│   @alice/       │                │                              │
│   rust-auditor  │                │  runs on platform sandbox    │
│   on this"      │                │  with REQUESTER's BYOK keys  │
│                 │  ◀── result ── │  (Bob's Claude/GPT key)      │
└─────────────────┘                └──────────────────────────────┘
```

Trade-offs Model B:
- Bob pays inference cost (using own BYOK).
- Alice's agent config exposed to platform infra (accepted at publish time).
- Platform sandbox = curated Linux container, hardened, no persistent state cross-invocation.
- No publisher-side tools (Alice cannot use her local `shell-exec` — platform tools only).

**Hybrid decision matrix**:
```
Publisher online?  Publisher tool policy needs local?   → Use Model A
Publisher offline? Config allows platform fallback?     → Use Model B
Publisher offline? Config disallows platform fallback?  → Requester sees "agent offline, try later"
```

Publisher opt-in la Model B fallback per-agent. Default: **Model A only** (privacy-preserving, most conservative).

**Communication protocol** — WebSocket-based, encrypted:
- Requester → Registry: signed invocation request.
- Registry → Publisher: relay request (or Platform Infra pentru Model B).
- Publisher → Registry → Requester: streamed response.
- Registry acts as broker (relay + rate limit + audit log), not agent runner (except Model B mode).

**Encryption**:
- Registry-Requester: TLS 1.3 obvious.
- Publisher-Registry: TLS 1.3 obvious.
- **Optional E2E** requester ↔ publisher via signature exchange (skip registry decryption). Complicated because breaks moderation ability. Recomand: **regular server-mediated cu TLS**, opt-in E2E post-v2 pentru sensitive use cases (registry sees metadata only).

**Rate limiting**:
- Per requester: max 100 invocations/hour cross all publishers (spam prevention).
- Per (requester, publisher) pair: publisher-configured limits (C2).
- Per publisher: max concurrent invocations to prevent DoS.

**Output sanitization** (before display în requester's Cinderpaw):
- Strip control chars, ANSI escapes, dangerous markdown patterns.
- Sanitize any URL to open in browser only after explicit user click.
- Warn user "content came from external agent" — visual separator + `@alice` attribution.
- Requester's Cinderpaw NEVER auto-acts on external agent output (no auto-tool-execute from external suggestions).

### C4 — Reputation + trust system

Currency of the network. Design cu adversarial thinking — how to prevent Sybil attacks, review bombing, coordinated ranking manipulation.

**Per-agent metrics**:
```yaml
agent_metrics:
  # Verified (require server-side confirmation):
  invocation_count: 12_450
  unique_requesters: 892
  successful_completion_rate: 0.94   # non-error non-timeout
  median_response_time_ms: 2_300
  uptime_pct_last_30d: 0.87
  
  # User-provided (weighted by requester tier):
  ratings:
    average_stars: 4.3
    count: 234
    distribution: [12, 18, 45, 89, 70]   # 1-star to 5-star
  
  # Moderator inputs:
  reports_count: 2                        # verified reports (not raw complaints)
  reports_status: 'reviewed_clean'        # 'pending' | 'reviewed_clean' | 'warned' | 'suspended'
  featured: false                         # curated by team
```

**Rating weight calibration** — prevent Sybil:
- Anonymous reviewers: weight 0.1.
- Email-verified: weight 0.5.
- GitHub-linked: weight 1.0.
- Domain-verified: weight 2.0.
- Team-verified: weight 3.0.
- Newly-created handles (< 30 days old): weight capped 0.2 regardless tier (grace period against sock puppets).
- Multi-review same reviewer per agent: only counts last one, weighted normally.

**Composite trust score** (single number 0-100 visible on agent card):
```
trust_score = (
  0.30 * clamp(rating_avg_weighted / 5) * 100 +
  0.25 * clamp(successful_completion_rate) * 100 +
  0.15 * clamp(uptime_pct_last_30d) * 100 +
  0.15 * min(1.0, log10(invocation_count) / 4) * 100 +   # log-scaled for size
  0.10 * clamp(1.0 - reports_count / 20) * 100 +
  0.05 * (featured ? 100 : 0)
)
```

Weights tunable per policy revision. Trust score NOT displayed for agents cu < 20 invocations (cold-start protection).

**Sybil / bot detection**:
- Detect anomalous rating patterns: 20 5-star ratings în 60 seconds → auto-flag pentru review.
- Detect coordinated inauthentic behavior: rating from handles created în same IP range within short window.
- Rate limit new-handle rating: max 3 agent reviews per 24h from < 30-day handles.

**Anti-review-bombing** protection: agent care primește > 10 1-star în 24h triggers moderation queue review before showing.

### C5 — Moderation infrastructure

Both automated + human. Tiered response.

**Pre-publish gate**:
- Automated LLM classifier scans system_prompt: prompt injection markers, jailbreak patterns, illegal instructions, harm patterns.
- Cinderpaw curated block-list of high-risk patterns.
- Similarity check vs. previously-banned agents.
- Duplicate detection (Levenshtein < 5 chars from existing prompt → flag).
- Clean → publish live immediate.
- Flagged → 24h manual review before live.

**In-flight monitoring**:
- Random sampling: 1% of invocations logged with content pentru quality assurance sampling.
- Automated pattern detection pe outputs: PII leaks, malware URLs, CSAM markers → auto-quarantine agent + human review.
- User reports (see below).

**Report flow** (requester side):
- User clicks "Report" pe agent response.
- Categories: spam / harmful content / broken (doesn't work) / IP violation / other.
- Attaches invocation ID (server has full context).
- Enters moderation queue.

**Report triage**:
```
Reports received:
  1 report from < 30-day handle       → low priority, batch review
  1 report from established handle    → medium priority, 24h SLA
  3+ reports from established handles → high priority, 4h SLA
  Automated pattern match             → immediate auto-quarantine + human review
```

**Enforcement actions** (graduated):
1. **Warning** — publisher notified, agent stays live.
2. **Feature restriction** — cannot be featured/curated, discoverability lowered.
3. **Suspension** — agent hidden from discovery, existing users can still invoke.
4. **Ban** — agent removed, cannot re-publish similar system_prompt for 90 days.
5. **Handle suspension** — publisher's whole handle banned for repeated violations across agents.
6. **IP/hardware fingerprint ban** — for evasion attempts (multiple bans + re-registrations).

**Appeals**: any enforcement action can be appealed via web form. Team reviews într-o săptămână. Track false-positive rate să tune classifiers.

**Team scaling estimate**: la 10k active publishers, ~1 moderator FTE. La 100k, ~5-10 FTE + tooling. Budget accordingly în business plan.

**Transparency reports**: publish quarterly aggregated stats — enforcement actions taken, appeals rate, false positive rate. Standard practice, trust-building.

### C6 — Legal + governance

**Terms of Service** (publisher + requester):
- Publisher warrants: has right to publish agent config, not infringing IP, follows content policy.
- Requester acknowledges: agent output != professional advice (no medical/legal/financial reliance).
- Platform: safe harbor via DMCA compliance, DSA compliance (dacă EU users), reasonable moderation.
- Liability caps: platform not liable for damage caused by agent output. Force disclaimer în UI.

**Privacy policy**:
- What data collected: handles, public keys, agent configs (publisher), invocation metadata (both sides), aggregate stats.
- What NOT collected: full invocation payloads (only 1% samples for QA cu user consent), publisher's private memory, BYOK keys.
- Data retention: metadata 90 days, aggregated stats indefinite anonymized, samples 30 days.
- User rights: data export (GDPR Article 20), delete account (GDPR Article 17), erasure preserves audit chain integrity via cryptographic tombstone.

**Regulatory compliance**:
- **DMCA** (US) — designated agent, takedown-counternotice flow standard.
- **EU Digital Services Act (DSA)** — dacă platform < 45M EU users, Article 24 obligations only. Notice & action mechanism, statement of reasons, transparency reports.
- **GDPR** — data processing agreements (DPA) with publishers (they process requester data indirectly). Template DPA published + auto-accepted at publish time.
- **CCPA** (California) — right to know, right to delete. Overlap with GDPR mostly.
- **UK GDPR + Online Safety Act** — separate compliance if UK users significant.

**Jurisdictional strategy**:
- Register Cinderpaw platform entity în EU (Netherlands recomand — good tax, favorable for tech).
- Data hosting: EU region primary + US region for latency (via CDN, no user data replicated cross-region without consent).

**IP attribution**:
- Agent config = publisher IP. Publisher retains ownership. Platform licenses to distribute.
- Agent OUTPUT: currently gray area globally. ToS clarifies: requester owns their invocation output, publisher retains no rights over generated content.
- Machine-generated content copyright status varies (US: not copyrightable, EU: complex). ToS defers to jurisdictional interpretation.

### C7 — Payments (deferred, Phase 2)

**Not shipped în v1 Community**. Reason: adds complexity 10× (KYC, tax, disputes, PCI compliance). Ship free + BYOK-required first, prove PMF, add paid.

**When ready, design**:
- **Credits system** — users buy $10/$25/$100 credit packs cu Stripe/Paddle.
- **Invocation debit** — publishers set price per invocation, requester's wallet debited.
- **Publisher accumulation** — earnings accumulate până $10 threshold, then Stripe Connect payout.
- **Platform fee** — 20% at launch (adjustable).
- **KYC** — Stripe Connect handles automat pentru payouts > $600/year (US IRS reporting).
- **Tax** — Stripe generates 1099s (US), similar în EU. Publisher responsible for own tax filing.
- **Dispute resolution** — publisher offline for 48h fail? Auto-refund. Content policy violation? Manual review + potential clawback.

Complete design în future ADR (ADR-0019 Payments).

### C8 — Cold-start bootstrapping

Chicken-and-egg: launch with zero agents = zero users. Zero users = zero publishers.

**Strategies**:
1. **Team-seeded curated agents at launch** — Cinderpaw team pre-publishes 20-30 high-quality agents la launch (research assistant, code reviewer, writing coach, etc.). Featured badge, high visibility.
2. **Invite-only alpha** — first 500 users hand-selected, guaranteed publish opportunity. Build early reputation graph.
3. **Publisher incentives** — first 100 publishers get "founding publisher" permanent badge (status symbol).
4. **Content partnerships** — approach 5-10 known AI content creators (Simon Willison, Andrej Karpathy tier), offer to seed their curated agents.
5. **Templates over agents** — encourage users to share agent templates (system_prompt + tool config) even before Community launch, migrate at launch.

Track adoption metric: number of DAILY unique requesters invoking at least 1 external agent. Target: 100 DAU după 3 luni, 1000 DAU după 12 luni.

### C9 — Kill switch & disaster recovery

Assume everything can go wrong. Prepare:

**Publisher kill switch**:
- Publisher revokes agent → immediate un-publish. Existing invocations în-flight either complete or abort (publisher policy per agent).
- Publisher account deleted → all agents un-published, handle preserved anonymously for audit chain integrity.

**Platform kill switch**:
- Cinderpaw team can globally suspend Community feature (registry service off) — clients fall back to local-only silently.
- Kill switch pentru specific agent categories (say all "medical advice" agents) if regulatory pressure requires.

**Data breach protocol**:
- Registry compromised: all handles rotate keypairs (users notified, sign new keys).
- Publisher-side machine compromised (agent code leaked): publisher marks compromised, agent un-published, platform notifies all recent requesters.
- Post-mortem published în transparency report.

**Migration OUT**:
- User exports own agent configs (JSON download).
- User exports invocation history (JSON download).
- User account deletion complete în 30 days (soft-delete → hard-delete).

**Federation option (post-v2)**:
- Alternative registries can be added by user în settings (`community.registry_urls = [cinderpaw.dev, myserver.example.com]`).
- Bridging protocol between registries — publisher on registry A discoverable from registry B via mutual trust.
- Complex, add only after single-registry model proves scaling model.

## Rollout timeline

- **v1.1 (Community Alpha)**: C1 identity + C2 publish invite-only + C3 Model A only + basic C4 metrics. 100 hand-selected users.
- **v1.2 (Community Beta)**: C4 reputation + C5 moderation basic + C6 legal framework + C8 seeded agents. Public beta, 5000 users.
- **v1.3 (Community GA)**: C3 Model B fallback + full C5 moderation + public discovery API. Open registration.
- **v2.0 (Community Mature)**: C7 payments + potentially C9 federation. After PMF proven.

## Success metrics

- **Trust**: > 90% requesters report positive experience în post-invocation survey.
- **Safety**: < 1 verified harmful output per 10k invocations.
- **Adoption**: DAU using external agents > 20% of total DAU by v1.3.
- **Publisher quality**: median agent trust score > 65/100.
- **Moderation efficiency**: < 4h median time-to-resolution for verified reports.
- **Financial sustainability**: platform costs < 30% of paid tier revenue (post-v2 payments).

## Open questions (kept minimal now)

- Hosting registry: single AWS/GCP region initial, or global cluster day 1?
- Publisher offline caching (Model B): defaults to opt-in or opt-out per agent?
- Trust score public formula publish or keep confidential (game theory tradeoff)?
- Rating system: 5-star classical or thumbs binary (better honesty, less granular)?

## References

- Depends on: ADR-0015 (Multi Agents personal — L1 shipped minimum)
- Depends on audit fixes: §142 (RLM escape), §150 (gc race), §151 (ratchet trust), §211 (done_when RCE), §232 (transcribe exfil) — ALL MUST be resolved înainte de Community C3 (cross-user execution) launch.
- Related: `public-journal/*` (foundation for reputation signals + transparency data)
- External inspiration:
  - **Fediverse (Mastodon)** — federation model.
  - **OpenAI GPT Store** — centralized marketplace, weak moderation, no payments.
  - **npm registry** — package trust, deprecation, security advisories.
  - **Stack Overflow reputation** — cold start, gamification, moderation flow.
  - **Uber trust model** — bilateral rating, mutual accountability.
- Deferred to future ADRs:
  - **ADR-0017** — Cross-user invocation protocol spec (WebSocket, message formats, error handling)
  - **ADR-0018** — Moderation operational playbook (reviewer tools, escalation, appeals)
  - **ADR-0019** — Payments + marketplace economics (Stripe Connect integration, tax handling, disputes)
