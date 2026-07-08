# TUI Onboarding — OpenClaw-Style Redesign

> Spec + session log. Source of truth for the multi-session TUI wizard
> rewrite. Read this first when resuming work.

## Status (2026-07-06)

| Phase | Scope | Status |
|-------|-------|--------|
| F1 | Branding + Welcome + Security + Setup mode + Config handling | SHIPPED |
| F2 | Searchable provider list + partial resume + health check failure + cred storage + timeouts | SHIPPED |
| F3 | Multi-step health check + Finish screen with commands + model picker | SHIPPED |
| F4 | Real connector integration (Discord/Telegram/Slack pairing) | PLANNED |

## F1 — SHIPPED (2026-07-06)

### Files
- `tui/ui/branding.go` — AppName="FERAL", AppVersion="0.1.0", FeralLogo (ASCII), BearLogo (ASCII bear with version), BearCompact, Taglines (6 messages), RandomTagline()
- `tui/ui/branding_test.go` — 7 tests
- `tui/app/wizard.go` — 4 new WizardSteps (WizWelcome, WizSecurity, WizSetupMode, WizConfigHandling), SetupMode + ConfigHandling enums, `wizardProgressVersion = 2` with "v2:" prefix, `hasExistingConfig()`, `feralHomeDir()`
- `tui/app/update.go` — `startWizard()` routes through F1 pre-flow, key handlers for the 4 new steps, `beginWizardFlow()` helper
- `tui/app/view.go` — 4 new render functions
- `tui/app/wizard_progress_test.go` — 9 tests (roundtrip, v1 rejection, v999 rejection, out-of-range, hasExistingConfig × 3, clear, format pin)

### New flow (after F1)
1. WizWelcome (bear + tagline + Enter)
2. WizSecurity (one-screen disclaimer + y/n)
3. WizSetupMode (QuickStart / Manual / Import)
4. WizConfigHandling (only if hasExistingConfig: Keep / Review / Reset)
5. WizHardware (existing, unchanged)
6. WizModelChoice (existing)
7. WizLocalDownload (existing)
8. WizCloudProvider (existing, but needs F2 search)
9. WizCloudKey (existing, needs F2 cred-storage)
10. WizConnectors (existing, will get real pairing in F4)
11. WizConnectorPrompt (existing)
12. WizTestIt (existing, needs F2 failure handling + F3 enhancement)
13. WizFinish (existing, will be enhanced in F3)

### Backwards compat (F1)
- v1 progress files (no "v2:" prefix) reset to WizWelcome instead of resuming on wrong step
- Existing users with `.wizard-done` see ConfigHandling screen
- BYOK config (byok.json) also trips ConfigHandling

## F2 — SHIPPED (2026-07-06)

### What landed

#### F2.1: Searchable provider list ✅
- New `SearchQuery` field in `WizardState`
- `FilteredProviders(query string) []CloudProvider` — case-insensitive substring on Name and ID
- View shows a search input at top, filtered list below
- Key handler: typing extends query, Backspace deletes, arrows/j/k navigate, Enter confirms, Esc clears query first then backs out
- 7 unit tests in `wizard_f2_test.go` (empty query, by name, by ID, no match, case-insensitive, trim whitespace, uppercase)

#### F2.2: Partial progress persistence ✅
- `hasPartialProgress() (WizardStep, bool)` helper — true when progress file exists but wizard-done marker does not
- New `WizResume` step inserted between `WizConfigHandling` and `WizHardware`
- Renders "Setup in progress" screen with two options: **Resume** (jump to saved step) / **Start over** (clear progress, restart from WizWelcome)
- Esc on this screen = Start over (less destructive default)
- `startWizard()` detects partial state before the F1 pre-flow and routes to WizResume
- 3 unit tests: fresh dir not partial, saved step is partial, wizard-done cancels partial

#### F2.3: Health check failure handling ✅
- New `TestItAttempts` field on `WizardState`
- `WizardTestItResult` handler: on error, auto-retry once (silent). After 1 auto-retry, surface the failure to the user
- New failure view in `renderWizTestIt` shows:
  - "Health check failed" header
  - "what failed:" with the specific check (streaming round-trip)
  - raw error message
  - retry count if > 1
  - explicit actions: **r** retry, **p** change provider, **m** change model, **s** skip (advanced)
- Closes ONB-005/ONB-006 from GPT 5.5 audit (chunk.Error check, 60s timeout) — explicitly called out in the WizardTestItResult handler comment

#### F2.4: Credential storage option ✅
- New `WizCloudKeyMode` step between `WizCloudProvider` and `WizCloudKey`
- Two options: **Enter directly** (stored in `~/.feral/byok.json`) or **Use external secret provider** (env var placeholder)
- If external picked: skip key entry, set `KeyValid = true` with a note about FERAL_BYOK_KEY, advance to WizTestIt
- Renders the chosen name + description

#### F2.5: Timeouts + cancel ✅
- Audited all `http.Client{}` calls in `tui/api/client.go`:
  - `FetchSystemInfo`: 8s (was already)
  - `TestProviderKey`: 12s (was already)
  - `InstallModel`: 10s (was already)
  - `DownloadModel`: 4s (was already)
- Added Esc-cancel during in-flight hardware probe (closes wizard, the probe message is ignored after `a.Wizard.Show` flips)
- Added Esc-cancel during in-flight Test It (same pattern)
- `startWizardTestIt` already had 60s timeout (ONB-006)

### New flow (after F3)

1. (Boot) Check `hasPartialProgress()` → if true, **WizResume** (Resume / Start over)
2. (Boot) Check `hasExistingConfig()` → if true, **WizConfigHandling** (Keep / Review / Reset)
3. **WizWelcome** (bear + tagline + Enter)
4. **WizSecurity** (one-screen disclaimer + y/n)
5. **WizSetupMode** (QuickStart / Manual / Import)
6. **WizHardware** (existing)
7. **WizModelChoice** (existing)
8. **WizLocalDownload** (existing)
9. **WizCloudProvider** (searchable)
10. **WizCloudModel** (model picker — F3)
11. **WizCloudKeyMode** (Enter directly / External — F2)
12. **WizCloudKey** (existing)
13. **WizConnectors** (existing — F4 will replace with real pairing)
14. **WizConnectorPrompt** (existing)
15. **WizTestIt** (F3 multi-step health check with granular checks)
16. **WizFinish** (F3 enhanced checklist + commands)

### Test coverage added (F2)

- 10 new tests in `tui/app/wizard_f2_test.go`:
  - `TestFilteredProvidersEmptyQueryReturnsAll`
  - `TestFilteredProvidersByName`
  - `TestFilteredProvidersByID`
  - `TestFilteredProvidersNoMatch`
  - `TestFilteredProvidersCaseInsensitive`
  - `TestFilteredProvidersTrimsWhitespace`
  - `TestResumeStepLabel` (14 sub-cases)
  - `TestHasPartialProgressNotPartialOnFreshDir`
  - `TestHasPartialProgressTrueOnSavedStep`
  - `TestHasPartialProgressFalseWhenDone`

### Files touched (F2)

- `tui/app/wizard.go` — `WizResume` + `WizCloudKeyMode` steps, `hasPartialProgress()`, `FilteredProviders()`, `KeyStorageMode` field, `SearchQuery` field, `ResumeStep`/`ResumeIdx` fields, `TestItAttempts` field
- `tui/app/update.go` — key handlers for new steps, partial-progress detection in startWizard, Esc-cancel during in-flight probe + TestIt, health-check failure routing (p/m/s actions)
- `tui/app/view.go` — `renderWizResume`, `renderWizCloudKeyMode`, updated `renderWizTestIt` (failure view), updated `renderWizCloudProvider` (search input)
- `tui/app/wizard_f2_test.go` — 10 new tests
- `docs/agents-memory/project_tui_onboarding_openclaw.md` — this spec file

### Open items for F4

- Real connector endpoints — need to add to `crates/feral-core/src/api.rs`
- Token storage — OS keychain (Windows Credential Manager) or encrypted file?
- Discord pairing flow — OAuth redirect or bot token paste?
- Multi-connector state — single config file or per-connector?

## F3 — SHIPPED (2026-07-06)

### Multi-step health check
Replaced the one-shot streaming test with a 4-check pipeline (`startWizardHealthCheck`):
1. **API reachable** — calls `FetchStatus` /runtime/status
2. **Auth valid** — calls `TestProviderKey` (cloud only; local auto-passes)
3. **Model accessible** — calls `ListModels` to verify at least one model
4. **Streaming works** — existing "Hello." round-trip via `StreamChat`

Progress is streamed via `WizardHealthProgress` messages — each check updates
its status (pending → running → passed/failed) live in the UI.

### Finish screen
Enhanced `renderWizFinish` with a checklist showing:
- ✓ Provider/Local model row
- ✓ Model row
- ✓ Connector status (or "No connectors configured")
- ✓ Ready
- Commands: `feral chat`, `feral doctor`, `feral desktop`
- "Press Enter to begin" CTA

### Model picker (WizCloudModel — was F2.5 deferred)
New `WizCloudModel` wizard step inserted between `WizCloudProvider` and
`WizCloudKeyMode`. Shows the provider name, default model, and an editable
model ID input. User can accept the default (Enter) or type a custom model ID.

### Version bump
- `wizardProgressVersion` bumped from 2 to 3 (v3 prefix for progress files)
- Old v2 progress files reset cleanly to `WizWelcome`

### New types
- `HealthCheckKind` (iota: `HealthCheckAPI`, `HealthCheckAuth`, `HealthCheckModel`, `HealthCheckStream`) with `.String()` method
- `CheckStatus` (iota: `CheckPending`, `CheckRunning`, `CheckPassed`, `CheckFailed`)
- `HealthCheck` struct (Kind, Status, Message)
- `WizardHealthProgress` message type for live UI updates
- `anyCheckRunning()` helper
- `[4]HealthCheck` field on `WizardState`

### Files touched
- `tui/app/wizard.go` — version 3, WizCloudModel step, types, HealthChecks field, footer hint
- `tui/app/update.go` — WizardHealthProgress msg + handler, startWizardHealthCheck, all callers migrated, WizCloudModel key handler, flow routing
- `tui/app/view.go` — renderWizCloudModel, updated renderWizTestIt (multi-step), updated renderWizFinish (checklist + commands), resumeStepLabel entry
- `tui/app/wizard_f2_test.go` — 4 new tests (HealthCheckKind strings, anyCheckRunning, reset initializes checks, WizCloudModel + WizCloudKeyMode in resumeStepLabel)

## F4 — PLANNED

### Real connector integration
- Requires backend endpoints in `crates/feral-core/src/api.rs`:
  - `GET /runtime/connectors/list` — list available connectors
  - `POST /runtime/connectors/discord/start` — start Discord pairing
  - `POST /runtime/connectors/discord/validate` — validate bot token
  - `POST /runtime/connectors/discord/save` — persist token
- TUI consumes these endpoints, no mock logic
- Searchable connector list (reuses F2 search component)

## Audit findings still relevant

From GPT 5.5 audit (2026-07-06):

| ID | Status | Notes |
|----|--------|-------|
| ONB-001 | DONE (F1.5 — before F1) | `~` path fix |
| ONB-002 | DONE (F1.5) | Default model for local path |
| ONB-003 | DONE (F1.5) | Provider picker |
| ONB-004 | DONE (F1.5) | BYOK save + activate |
| ONB-005 | DONE (F1.5) | Test It chunk.Error check |
| ONB-006 | DONE (F1.5) | Test It 60s timeout |
| ONB-007 | DONE (F1.5) | Download poll terminal error |
| ONB-008 | DONE (F1.5) | Remove Hybrid option |
| ONB-009 | DONE (F1.5) | Recovery honest message |
| ONB-010 | DONE (F1.5) | Hardware probe error display |
| ONB-011 | DONE (F1.5) | Connector skip/nav |
| ONB-012 | DONE (F1.5) | nil Prog guard |
| ONB-014 | DONE (F1.5) | Real download progress |
| ONB-013 | DEFERRED | Reduced motion — nice-to-have, not blocking |

F2 explicitly closes ONB-005/ONB-006 with the health-check failure handling.

## Migration notes

- v1 progress files reset to WizWelcome (already done in F1)
- v2 progress files use "v2:" prefix (already done in F1)
- Users with partial progress (v2 progress, no wizard-done) will see WizResume screen starting F2

## Test coverage (current)

- 133 tests across feral-tui, feral-tui/api, feral-tui/app, feral-tui/ui
- F1 added 16 tests (7 branding + 9 progress)
- F2 added 10 tests (search, partial progress, resume label)
- F3 added 4 tests (HealthCheckKind strings, anyCheckRunning, reset initializes checks, WizCloudModel/WizCloudKeyMode resumeStepLabel)

## Commands

```bash
# Build + test
cd D:\FeralLocalAI\tui
go build ./...
go test ./...

# Rebuild binary
go build -o feral-tui.exe .
Copy-Item .\feral-tui.exe "C:\Users\Darius\AppData\Roaming\npm\node_modules\feral-agent\vendor\feral-tui.exe" -Force
```

## Open questions for F4

1. Real connector endpoints — need to add to `crates/feral-core/src/api.rs`
2. Token storage — OS keychain (Windows Credential Manager) or encrypted file?
3. Discord pairing flow — OAuth redirect or bot token paste?
4. Multi-connector state — single config file or per-connector?
