# PROMISES.md

**Public commitments about what Cinderpaw will always be, and what will never be paywalled.**

This document is a public trust anchor. It's version-controlled so every change is visible in `git blame`. If we ever break a promise here, the git history will show exactly when and why.

**Last updated:** 2026-08-21
**Applies to:** Cinderpaw v1.0 onwards

---

## The Solo Tier Guarantee

**Every feature available in Cinderpaw v1.0 solo will remain free forever.**

This means:
- Chat with local models (GGUF via llama.cpp) — free forever
- Chat with cloud models via your own API keys (BYOK) — free forever, you pay the provider directly
- Agent runtime with memory, tools, MCP servers — free forever
- Multi-step deep research — free forever
- Skills and extensions — free forever
- Personal multi-agent teams (v1.1) — free forever
- Named agent presets, approval flows (v1.1) — free forever
- Mascot, splash screen, UI polish — free forever
- CLI mode, headless server support — free forever
- No account required — ever, for any solo tier feature
- No telemetry — ever, on any tier
- No usage limits, no daily quotas, no throttling on solo tier

**We will never retroactively move a solo-tier feature behind a paywall.** New features that require server infrastructure (shared projects, sync, cross-user coordination) may be paid — but those are NEW capabilities, not existing ones taken away.

---

## What might be paid (and why it's OK)

New capabilities that fundamentally require server infrastructure will have paid tiers:

### v1.2 — Shared Projects (target Feb 2027)

**Paid because it needs a server we host and pay for.**

- Duo tier ($12/month flat, 2 users): shared project workspace
- Team tier ($8/user/month): unlimited users and projects, SSO, audit log
- Business tier ($16/user/month): SSO SAML, GDPR data residency, priority support
- Enterprise tier (contact us): self-hosted relay, air-gapped deployment

**Why paid is fair:**
- These features literally cannot exist without infrastructure we run
- Your agents still run on your machines (no inference cost for us)
- Your inference costs stay yours (BYOK or local)
- We charge for coordination, not for AI usage
- Solo tier stays free with everything it has today

### v1.5 — Agent Feed (target Q3 2027)

**Free forever. Never paywalled.**

- Public social feed where opted-in agents post about work
- Discovery, threading, profiles, sharing
- Optional Verified badge for organizations (part of Business tier)

**Why free:** the feed is a public discovery mechanism, not a revenue product. Paywalling it would defeat its purpose.

---

## What we will never do

We commit publicly to never:

- ❌ Add telemetry or analytics to Cinderpaw (any tier)
- ❌ Require account signup for solo tier features
- ❌ Show ads inside the app
- ❌ Show upsell prompts inside the app (paid features have opt-in discovery, not push notifications)
- ❌ Retract solo tier features to move them behind a paywall
- ❌ Sell user data (there's none to sell — see „no telemetry")
- ❌ Read user chat content on any server (E2E encryption on shared projects)
- ❌ Train models on user conversations
- ❌ Deprecate the local single-user mode

---

## What we commit to do

We commit publicly to always:

- ✅ Keep source code open and readable (BSL 1.1 for now, Apache 2.0 in future — see „License evolution" below)
- ✅ Publish this promises document, version controlled
- ✅ Provide data export for all paid tier users at any time
- ✅ Honor account deletion requests (paid tiers) within 30 days
- ✅ Publish quarterly transparency reports on: revenue (aggregate), active users (aggregate), any incidents
- ✅ Ship security updates within 7 days of any confirmed vulnerability
- ✅ Give 90 days notice for any breaking change affecting paid customers
- ✅ Allow self-hosting for anyone who wants to run their own relay (v2.0 target)

---

## License evolution

Cinderpaw is currently BSL 1.1 (source-available). The path to fully open source:

**Automatic conversion:** each version converts to Apache 2.0 four years after its release. That's the BSL 1.1 clause and it's ironclad.

**Faster conversion:** if Cinderpaw hits **$5,000/month in recurring revenue** (sponsorships + commercial licenses + shared projects subscriptions), the current release converts to Apache 2.0 immediately, and every release after stays fully open source.

**Track progress:** [GitHub Sponsors →](https://github.com/sponsors/bloom500)

This is a public commitment. If we hit the threshold and don't convert, this git commit history will show we broke a promise.

---

## How to hold us accountable

If Cinderpaw ever breaks a promise in this document:

1. **Open an issue** at github.com/bloom500/cinderpaw with label `promises-violation`
2. **Point to the git diff** showing when the promise changed
3. **Publicly demand explanation** — we commit to responding within 7 days publicly

We don't have investors demanding growth at any cost. We don't have a board with fiduciary duty to shareholders. It's just Darius (Bloom Media) building this. If we break promises, it's because we chose to — and that's a reputation cost we don't want to pay.

---

## Changelog

- **2026-08-21** — Initial version. Anchors STRATEGY-PIVOT.md.
