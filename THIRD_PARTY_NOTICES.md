# Third-Party Notices

Third-party source **copied into this repository**. Package-manager
dependencies are not listed here — those ship with their own licenses and are
resolved at install time; this file covers code that lives in our tree and
would otherwise look like ours.

---

## OpenClaw — tool-call repair scanner

- **Files:** `CinderpawAgent/src/vendor/tool-call-repair/grammar.ts`,
  `CinderpawAgent/src/vendor/tool-call-repair/payload.ts`
- **Source:** https://github.com/openclaw/openclaw
  (`packages/tool-call-repair/src/`)
- **License:** MIT — full text in
  `CinderpawAgent/src/vendor/tool-call-repair/LICENSE`
- **Copyright:** Copyright (c) 2026 OpenClaw Foundation
- **Modifications:** one import specifier changed from `./grammar.js` to
  `./grammar.ts` to match our module resolver. Otherwise verbatim.

Used to recover tool calls emitted in formats other than the one we ask models
for. See `CinderpawAgent/src/vendor/tool-call-repair/README.md` for what it covers,
what it does not, and why the rest of that package was left behind.
