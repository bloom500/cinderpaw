# PROMISES.md

**Public commitments about what Cinderpaw will always be, and what will never be paywalled.**

This document is a public trust anchor. It's version-controlled so every change is visible in `git blame`. If we ever break a promise here, the git history will show exactly when and why.

**Last updated:** 2026-08-22
**Applies to:** Cinderpaw v1.0 onwards

> **Current scope:** Cinderpaw currently has no monetized tier, payment flow, subscription, or commercial pricing. Those decisions are intentionally deferred and are not part of the current product or landing-page spec.

---

## The Solo Experience Guarantee

**Everything shipped in the current solo experience remains available without an account or payment gate.**

This means:
- Chat with local models (GGUF via llama.cpp)
- Chat with cloud models via your own API keys — you pay the provider directly
- Agent runtime with memory, tools, and MCP servers
- Multi-step deep research
- Skills and extensions
- Personal multi-agent teams when shipped
- Named agent presets and approval flows when shipped
- Mascot, splash screen, and UI polish
- CLI mode and headless server support
- No account required for solo features
- No telemetry on any tier

**We will not add a paywall to features already shipped in the solo experience.** Future product decisions will be documented separately before implementation.

---

## Shared Projects status

Shared Projects are currently a research direction, not a commercial launch. The team is testing the product shape, privacy model, encrypted relay, permissions, and export paths. No price, tier, payment flow, or launch commitment is defined in this document.

Any future commercial decision must be documented publicly before it appears in product copy or code.

---

## What we will never do

We commit publicly to never:

- ❌ Add telemetry or analytics to Cinderpaw (any tier)
- ❌ Require account signup for solo tier features
- ❌ Show ads inside the app
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
- ✅ Provide data export for user-owned project data
- ✅ Honor deletion requests for any data Cinderpaw stores
- ✅ Publish transparency reports on active users and incidents when the product has a server component
- ✅ Ship security updates within 7 days of any confirmed vulnerability
- ✅ Give clear notice for breaking changes affecting user data or workflows
- ✅ Keep self-hosting a documented option for future relay work

---

## License evolution

Cinderpaw is currently BSL 1.1 (source-available). Each version converts to Apache 2.0 four years after its release. That is the current documented license path.

No revenue milestone or commercial trigger is part of the current promise.

---

## How to hold us accountable

If Cinderpaw ever breaks a promise in this document:

1. **Open an issue** at github.com/bloom500/cinderpaw with label `promises-violation`
2. **Point to the git diff** showing when the promise changed
3. **Publicly demand explanation** — we commit to responding within 7 days publicly

There is no separate trust department here. It's just Darius (Bloom Media) building this in public. If we break promises, the repository should make that visible and the project should answer for it.

---

## Changelog

- **2026-08-22** — Current scope clarified: no monetization or commercial tier is defined.
- **2026-08-21** — Initial version. Anchors STRATEGY-PIVOT.md.
