# Cinderpaw Roadmap

**Last updated:** 2026-08-22
**Status:** Updated per STRATEGY-PIVOT.md. Shared Projects is technical research only; monetization is out of scope for the current phase.

> **⚠️ Scope update 2026-08-22:** Cinderpaw focuses on the local-first single-user product. Shared Projects and Agent Feed are research directions. This roadmap does not define pricing, payments, or commercial tiers.


Single-page timeline that ties together: bug backlog (~319 findings audit) + rebrand (Feral → Cinderpaw) + Brain Stack v2 + Multi Agents + Community launch.

## Guiding principles

1. **Safety first**: never ship a Community feature that depends on unresolved MOAT-critical bugs (§142/§150/§151/§211/§232).
2. **User migration painless**: any breaking change ships with tested migrator; users never lose data.
3. **Fazat non-monolithic**: 10× small releases beat 1× big release. Rollback path per feature.
4. **Trust building**: transparency on what changes, what doesn't, why. Public changelog + explicit release notes.
5. **Community requires foundation**: nu lansăm public mesh înainte de multi-agents personal stable + audit-clean.

## Release timeline

```
Q3 2026 (curent) ──────────────────────────────────────────────
  v0.1   [SHIPPED] Feral base
  v0.2   REBRAND cosmetic (Faza A din RENAME-PLAN)
         + Bug fixes runda 1 (34 findings) — Opus 5 în paralel
         + Brain Stack U1 (semantic classifier) + R1 (breaker) + R5 (traces)
         Target: fin Sep 2026

Q4 2026 ──────────────────────────────────────────────────────
  v0.3   Bug fixes rundele 2-3 (55 findings)
         + Brain Stack U2 (runtime stats) + R2 (cold start manifest) + R6 (budget breaker)
         + Frontend audit HIGH fixes (§F27, §F1, §F14, §F21, §F11)
         Target: mid Oct 2026

  v0.4   REBRAND intern (Faza B: Cargo/npm/events rename)
         + Bug fixes rundele 4-5 (50 findings) — MOAT focus (BRSI + FMS)
         + Brain Stack U3 (mid-stream fallback) + R8 (cache-aware chain) + R4 (stickiness)
         + Multi Agents L1 (first-class agents, "Your Team" sidebar)
         + Frontend audit MEDIUM fixes
         Target: fin Nov 2026

Q1 2027 ──────────────────────────────────────────────────────
  v0.5   Bug fixes runda 6 (31 findings)
         + Brain Stack U4 (cost UI) + R3 (model pinning) + R7 (canary rollout)
         + Multi Agents L2 (concurrent active agents, model pool)
         + Mascot polish (§F61-§F66 audit fixes)
         Target: mid Jan 2027

  v0.6   Bug fixes runda 7 (23 findings MOAT-critical Rust)
         + Multi Agents L3 (agent-to-agent delegation) + R1 permission inheritance
         + Brain Stack R9 (RSI integration — routing metrics feed evolution)
         + Rebrand Faza C (bundle ID + ~/.feral migrator) — MAJOR VERSION PATH
         Target: fin Feb 2027

  v0.7   Bug fixes rundele 8-9 (51 findings TS + Tauri)
         + Multi Agents polish + isolation tests (R6)
         + Handoff mid-conversation (R3)
         + Skills team-sharing (R5)
         + Frontend audit final cleanup
         Target: mid Mar 2027

v1.0 GA ──────────────────────────────────────────────────────
  v1.0   RELEASE MILESTONE
         All rundele audit clean (0 CRITICAL open)
         Brain Stack v2 stable
         Multi Agents stable
         Rebrand Faza D complete (Feral → Cinderpaw public)
         Domain live: cinderpaw.dev
         npm/crates published
         Marketing launch: HN post, blog, social
         Target: fin Mar 2027 / early Apr

Q2 2027 ──────────────────────────────────────────────────────
  v1.1   COMMUNITY ALPHA
         + ADR-0016 C1 identity (Ed25519 handles)
         + C2 publish invite-only
         + C3 Model A only (publisher-side execution)
         + C4 basic metrics + rating
         + Team-seeded curated agents (C8)
         100 hand-selected alpha users
         Target: mid May 2027

  v1.2   COMMUNITY BETA
         + C4 reputation full (trust scoring, sybil resistance)
         + C5 moderation infrastructure (LLM classifier + report flow)
         + C6 legal framework (ToS, Privacy Policy, DMCA agent designated)
         + Public discovery UI on cinderpaw.dev/community
         5000 public beta users
         Target: fin Jun 2027

Q3 2027 ──────────────────────────────────────────────────────
  v1.3   COMMUNITY GA
         + C3 Model B fallback (platform-hosted invocation when publisher offline)
         + C5 full moderation team scaling
         + Discovery API v1 for third-party
         + Transparency reports quarterly
         Open public registration
         Target: mid Aug 2027

  v1.4   COMMUNITY POLISH
         + Advanced discovery (recommendations, categories, search improvements)
         + Publisher analytics dashboard
         + Bulk publish tools for power users
         + Community-nominated moderators
         Target: fin Sep 2027

Q4 2027+ ─────────────────────────────────────────────────────
  v2.0   COMMUNITY MATURE
         + Moderation and discovery hardening
         + Public transparency and export work
         + Federation exploration if the central model proves useful
         Target: date TBD

  v2.5+  Further multi-user experiments
         Only if research validates the model.
         Post-2027 timeframe.
```

## Dependency graph (why the order matters)

```
Bug audit fixes ─────────────────────┐
  (259 backend + 60 frontend)         │
                                      ▼
Rebrand Faza A (cosmetic) ─── Frontend audit fixes
                │                     │
                ▼                     ▼
Rebrand Faza B (packages internal)   Brain Stack U1-U4
                │                     │
                └──┬──────────────────┘
                   ▼
Rebrand Faza C (bundle ID + migration)
                │
                ▼
Multi Agents L1 (first-class)
                │
                ▼
Multi Agents L2 (concurrent)
                │
                ▼
Multi Agents L3 (delegation) ─── Brain Stack R9 (RSI integration)
                │                     │
                └──┬──────────────────┘
                   ▼
Rebrand Faza D (public) ─── v1.0 GA
                                      │
                                      ▼
                          v1.1 Personal Agent Teams (Nov 2026)
                                      │
                                      ▼
                          Shared Projects research prototype
                                    (date TBD)
                                      │
                                      ▼
                          Shared Projects iteration after validation
                                      │
                                      ▼
                          Agent Feed research (opt-in, privacy-first)
                                      │
                                      ▼
                          Later multi-user experiments
                                                     (date TBD)
```

**Critical path** (longest chain that dictates product confidence):
`v1.0 launch → v1.1 personal Agent Teams → Shared Projects research prototype → feedback-driven iteration`

No date is promised for a production multi-user launch. The next milestone is a technically safe, privacy-reviewed prototype with real feedback.

## Parallelization opportunities

Diferite streams pot rula concurrent cu diferite people:

**Stream A — Bugs (Opus 5 primary):**
- Rundele 1-10 audit fixes secvential.
- Frontend audit fixes.
- Regression tests pentru MOAT invariants (§256 audit).

**Stream B — Rebrand + Brand:**
- Faza A cosmetic (1 dev + design, 1-2 zile).
- Faza B intern (1 dev, 1 săptămână).
- Faza C migrator + testing (2-3 săptămâni cross-platform).
- Faza D coordination (1 zi + ongoing marketing).

**Stream C — Brain Stack:**
- U1-U5 + R1-R9 (per ADR-0014 revised).
- 1 dev focused, 4-6 luni total.

**Stream D — Multi Agents:**
- L1-L3 + R1-R7 (per ADR-0015 revised).
- 1 dev focused, 4-6 luni total.
- DEPENDENCE: needs Rebrand Faza C done pentru ~/.cinderpaw/agents/ paths.

**Stream E — Community (post-v1.0):**
- C1-C6 primary (per ADR-0016 revised).
- 1-2 devs + design + community manager.
- DEPENDENCE: v1.0 must ship first cu audit clean.

**Stream F — Documentation + Marketing:**
- Public docs on cinderpaw.dev website (rebrand cinderpaw.dev/docs).
- Blog posts per release.
- Video walkthroughs.
- Ongoing throughout all phases.

## Non-goals în roadmap (things intentionally deferred)

- **Mobile apps** — Cinderpaw is desktop-first. iOS/Android post-v2.0 dacă demand justified.
- **Enterprise features** (SSO, audit compliance, organization administration) — deferred until multi-user research is validated.
- **Training own base models** — Cinderpaw = agent layer, not model provider. Depend on BYOK + local GGUFs.
- **Voice-first UX** — voice already integrated (Whisper + Fish TTS), but not primary interaction mode.
- **Multi-machine sync personal** — user's own devices sync own agents. Nice-to-have, complex (E2E encryption needed). Post-v2.0.
- **Browser extension** — potential but not roadmap-committed.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Opus 5 slower than expected on bug fixes | Medium | Delays v1.0 | Parallel streams, reduce scope per release |
| Rebrand breaks user data during Faza C migration | Medium | Users lose conversations | Extensive cross-platform testing + rollback docs + soft-delete never hard-delete legacy |
| Brain Stack R9 (RSI integration) exposes new MOAT issues | Medium | Delays v0.6 | Feature flag, staged rollout, ability to disable if regressions detected |
| Multi Agents resource usage abused by malicious agent | Low | Local resource exhaustion | Per-agent budget caps, sandbox bounds, user-facing controls |
| Community launch attracts bad actors immediately | High | Reputational + legal | Pre-launch: robust moderation ready, invite-only alpha, team-seeded content |
| Legal takedown request (DMCA, hate speech, etc.) | High (any platform hits this) | Reputational | Standard takedown flow, transparency reports, designated agent |
| Cinderpaw registry central point of failure | Medium | Community offline temporarily | Multi-region hosting, health monitoring, transparent status page |
| SEO can't overcome Warriors fandom for "cinderpaw" | High | Brand discovery | Own the .ai domain, invest în content marketing, brand as "Cinderpaw AI" clearly |
| Publisher liability incidents (agent gives bad advice, user acts) | Medium | Legal exposure | Clear ToS disclaimers, force-visible în UI ("output from AI, not professional advice") |
| Cost of moderation scaling too fast | Medium | Operational load | Automated pre-filters, community moderators, rate limits |

## Success metrics per phase

**v0.2-0.7 (rebrand + bug fixes)**:
- Bug backlog: 0 CRITICAL open at v1.0.
- User churn during migration: < 5% (measured via telemetry opt-in).
- Test coverage: 80%+ on RSI critical paths post-audit fixes.

**v1.0 GA**:
- Downloads first month: 5000 (Feral was un-tracked baseline).
- Daily active users month 1: 500.
- HN launch: front page top 10.
- Zero P0 incidents in first month.

**v1.1-1.3 (Community launch)**:
- Alpha: 100 users, 50 published agents, 10k invocations.
- Beta: 5000 users, 500 published agents, 500k invocations.
- GA: 20000 users, 2000 published agents, 5M invocations.
- Trust score median: 65+.
- Moderation actions: < 1% of published agents suspended.

**Later phases:**
- Define new success metrics only after the product direction is validated.
- Do not use payment volume, paid adoption, or platform revenue as current roadmap criteria.

## Community attraction strategy (headline preview — detailed în next document)

The roadmap gets Cinderpaw to Community GA. What makes users ACTUALLY come? Three pillars, high-level:

1. **Content-first launch** — 3-6 luni pre-launch content strategy (blog posts, videos, teardowns of "how we built this") builds audience before we need one. Simon Willison model: write publicly, be useful, community follows.

2. **Founding member benefits** — first 500 users at Community launch get "founding" badge, permanent visibility boost, direct communication channel cu team. Status incentive.

3. **Ecosystem partnerships** — approach 5-10 AI content creators (Karpathy tier), 2-3 relevant open-source projects (LangChain, Ollama), 1-2 dev tool makers (Cursor, Continue). Offer integration, cross-promotion. Distribution shortcut.

Detailed community-attraction plan în follow-up document (as user requested).

## Immediate next steps

1. **User approve** ADR-0014, ADR-0015, ADR-0016 (revised versions).
2. **Kick off Faza A rebrand** (safe, 1-2 zile, parallel cu Opus 5 bug fixes).
3. **Opus 5 continue** on bug backlog rundele 1-10.
4. **Design mockups** pentru Brain Stack UI (cost tab, routing traces), Multi Agents UI (Your Team sidebar).
5. **Legal consultation** early: draft ToS + Privacy Policy for Community. Retain în q4 2026.
6. **Content strategy document** (community attraction) — next writeup requested by user.

## Living document

This roadmap updates monthly. Track în git; each change = new commit cu rationale. Rebase timeline dacă blockers emerge.
