# project_tui_openclaw_parity.md

> Parity document: what was adapted from OpenClaw patterns and what was
> synthesized for Feral. Phase 1 / Phase 2 wizard work 2026-07-07.

## Reference: OpenClaw classic wizard flow

OpenClaw's classic wizard (launched via `--classic`) lives in
`frontend/src/pages/onboarding/setup.ts`. Its terminal gate sequence is:

1. `wiz-compact.tsx` → `WizardFrame` (branded frame box)
2. `RiskAckStep` → `WizRiskAck`
3. `PluginCompatPreflight` (reads local state, surfaces stale plugins)
4. `FlowChoice` (recommended / classic / LLM-driven)
5. `LocalOrRemote`
6. `WorkspacePath`
7. `ModelAuth`
8. `PersistConfig` → writes to `~/.openclaw/config.json`
9. `ChannelSetup`
10. `SearchConfig` / `SkillsConfig` / `PluginList`
11. `Finalize` → writes `done` flag

The critical UX contract: **all config is persisted BEFORE the test step
(`TestRun`) and BEFORE the finalize screen.** No write races.

## Feral classic wizard flow (TUI, post Phase 1+2)

Feral's wizard (`tui/app/wizard.go`) follows the same contract:

1. `WizWelcome` → bear logo + tagline + preflight notices
2. `WizSecurity` → one-screen security disclaimer
3. `WizSetupMode` → QuickStart / Manual / Import
4. `WizResume` → if existing state detected, offer resume
5. `WizHardware` → GPU probe + display
6. `WizModelChoice` → local vs cloud path fork
7. `WizLocalDownload` → download progress
8. `WizCloudProvider` → provider picker (searchable)
9. `WizCloudModel` → model picker
10. `WizCloudKeyMode` → enter directly vs external
11. `WizCloudKey` → masked key input + live validation
12. `WizConnectors` → Discord/Slack/Telegram/WhatsApp
13. `WizConnectorPrompt` → field-by-field token input (masked) or QR toggle
14. `WizTestIt` → real "Hello." round-trip, gates finish
15. `WizFinish` → final screen with timing metrics

## What was adapted (structural parity, not copied code)

| OpenClaw pattern | Feral adaptation | Notes |
|---|---|---|
| `WizardFrame` box (rounded border, branded header strip, step indicator, bear compact footer) | `RenderWizardFrame()` in `tui/ui/wizard_frame.go` | Same visual contract: branded top strip with product mark + step count, accent-dim border, bear compact footer. Implemented as a standalone `RenderWizardFrame(header, body, width)` function — not a frame state machine. |
| Pre-input plugin-compat snapshot (`PluginCompatPreflight`) | `preflightNotices()` in `tui/app/wizard_preflight.go` | Surfaces malformed `byok.json`, unknown provider IDs, and stale progress files at wizard start. Same purpose: surface anomalies BEFORE the user takes any action. |
| `RiskAckStep` (one-screen security warning) | `WizSecurity` screen | One screen, no multi-page warning, bear icon present. |
| `FlowChoice` (recommended / manual) | `WizSetupMode` (QuickStart / Manual / Import) | Same fork concept. |
| `ChannelSetup` (Discord/Slack/WhatsApp) | `WizConnectors` + `WizConnectorPrompt` | Same flow: pick channels → enter tokens. |
| Config-write BEFORE test step | `saveCloudProvider()` + `SaveConnectorConfig()` both happen BEFORE `WizTestIt` | Pinned via `TestWizardOrder` in `wizard_order_test.go`. |
| `ModelAuth` → key validation before persist | `WizCloudKey` → `ProvidersTestMsg` → `saveCloudProvider()` | Key validated via `/providers/test` before any disk write. |
| `Finalize` writes `done` flag | `WizFinish` renders metrics, `WizardDoneMsg` handler writes done | Same timing: flag written only after all screens complete. |

## What was synthesized (Feral-specific)

| Feature | Location | Why it's not in OpenClaw |
|---|---|---|
| Preflight notes for `byok.json` malformed / unknown provider / stale progress | `wizard_preflight.go` | OpenClaw has `PluginCompatPreflight` for stale plugins but not for malformed config or version drift. Feral extends the pattern to catch three additional failure modes. |
| Bear compact footer | `RenderWizardFrame()` | Feral's brand identity; OpenClaw uses a different mascot. |
| `WizardFrame` as a function (not a state machine) | `tui/ui/wizard_frame.go` | OpenClaw's frame is a React component with internal state. Feral's is a stateless Go function: `func RenderWizardFrame(header, body, width) string`. |
| `RenderStepIndicator` (horizontal `───/3/───` bar) | `tui/ui/wizard_frame.go` | OpenClaw shows "Step X/Y" text. Feral renders a visual bar for better terminal readability. |
| ASCII-glyph fallback via `GlyphSet` auto-detect | `tui/ui/glyphs.go` | OpenClaw renders Unicode natively in the terminal. Feral must support Windows Console (no true-color) → automatic fallback to ASCII. |

## Config-write ordering (pinned)

The wizard's write-before-test contract is enforced via a test:

```
tui/app/wizard_order_test.go
TestWizardOrder        → verifies saveCloudProvider() executes
                        before WizTestIt in the step handler
TestWizardConnectorOrder → verifies SaveConnectorConfig() executes
                          before WizTestIt in the step handler
```

The actual sequence (verified by code review):

1. `WizCloudKey` → `startWizardProviderTest()` → async HTTP
2. `ProvidersTestMsg` handler → `saveCloudProvider()` → disk write
3. → `WizConnectors` → `WizConnectorPrompt` → `SaveConnectorConfig()` → disk write
4. → `WizTestIt` → health check → real round-trip

**Zero config is written before the user has committed to a provider and
passed validation.** This matches OpenClaw's contract exactly.

## What we deliberately did NOT include

- **LLM-driven onboarding (Crestodian path):** OpenClaw's default is a
  conversational onboarding agent. Feral keeps the deterministic wizard.
  Reason: LLM onboarding adds latency, non-determinism, and failure
  modes that are inappropriate for a first-run experience on a local
  machine.

- **Code duplication:** All wizard frame / preflight / indicator code
  is written from scratch for Go/Bubble Tea. No OpenClaw TypeScript
  was ported or mechanically translated.

- **React OnboardingWizard (`src/components/OnboardingWizard.tsx`):**
  This file is the desktop React path and was not touched. All work
  was TUI-only (`tui/`).

## Verification commands

```bash
# Go test (wizard + preflight + order pin)
cd tui && go test ./... -count=1

# TypeScript typecheck (FeralAgent, must remain clean)
cd FeralAgent && bunx tsc --noEmit

# Sidecar tests (existing, must remain green)
cd FeralAgent && bun test
```
