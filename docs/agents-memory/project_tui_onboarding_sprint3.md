# Sprint 3 — TUI Onboarding (WizTestIt / Recovery / What's Next / Welcome Back)

**Shipped:** 2026-07-06  
**Scope:** Terminal (Go/Bubble Tea `tui/`), not the desktop React frontend  
**Spec doc:** User-provided terminal onboarding spec (conversation-first wizard)

---

## What was implemented

### 1. Test-it (`WizTestIt` wizard step)

- **File:** `tui/app/wizard.go` — Added `WizTestIt = 6` (shifted `WizFinish` to 7)
- **Fields on `WizardState`:**
  - `TestItSucceeded bool` — gates Enter-to-finish
  - `TestItError string` — surface-level error message
  - `TestItResponse string` — full assistant reply text
  - `TestItRunning bool` — in-flight indicator
- **Flow:**
  1. User finishes `WizConnectorPrompt` (Y/n/Enter) → step advances to `WizTestIt`, `startWizardTestIt()` fires
  2. A goroutine runs `api.StreamChat("Hello.")` and collects all chunks
  3. On completion, sends `WizardTestItResult` with full response text
  4. Handler sets `TestItSucceeded` + persists `wizardProgress`
  5. User presses Enter to advance to `WizFinish`; on failure, 'r' or Enter retries

### 2. What's Next suggestions

- **File:** `tui/app/update.go:finishWizard()`
- Replaced generic "Welcome to Feral" text with:
  ```
  ✓ Setup complete.

  You're ready.

  Try asking:
    • Summarize this repository.
    • Remember that I prefer Rust.
    • Explain this codebase.
  ```

### 3. Recovery auto-retry

- **File:** `tui/app/update.go:StatusPollResult` handler
- On `StatusPollResult` where `!Online`:
  - Enter `StateRecovery` (increment `RecoverAttempts`)
  - First attempt: flash "Backend disconnected. Attempting restart…"
  - Every 5s status poll auto-retries
- On reconnection:
  - Flash "✓ Reconnected"
  - Reset `StateReady`, `RecoverAttempts = 0`
- **Header enhancement:** `renderHeader()` shows "reconnecting. (attempt N)" during recovery (was "no sidecar")

### 4. Welcome back (last-task row)

- Already implemented in Sprint 1.8 (`renderWelcomeResume()` shows "welcome back · <title> · <workspace> · <relative>")
- No changes needed for Sprint 3

### 5. Backend liveness

- Already in header: `● online / ○ no sidecar`
- Enhanced: shows "○ reconnecting. (attempt N)" during recovery
- Status polling every 5s continues through recovery

---

## Key design decisions

- **Test-it uses the same `api.StreamChat` as normal chat** — no fake/simulated "Hello." response; real round-trip through the gateway
- **`WizardTestItResult` is a separate message type** (not `StreamDoneMsg`) to avoid conflicting with the normal streaming path
- **`startWizardTestIt` returns `tea.Cmd`** for the normal path (from Update), but in `startWizard()` (resume case) it runs via `go func() { a.Prog.Send(cmd()) }()` since `startWizard` doesn't return a cmd
- **Wizard resume works** — `saveWizardProgress(WizTestIt)` saves after success, and on next launch the test auto-restarts

---

## Files changed

| File | Changes |
|------|---------|
| `tui/app/wizard.go` | `WizTestIt` step constant, `TestIt*` fields, reset/cleanup updates |
| `tui/app/update.go` | `WizardTestItResult` msg type, `startWizardTestIt()` cmd, handler in Update, `WizTestIt` key handling, recovery logic in `StatusPollResult`, updated `finishWizard()` text, resume auto-start |
| `tui/app/view.go` | `renderWizTestIt()` step renderer, `renderHeader` recovery state handling |
| `tui/app/overlay_test.go` | Updated `TestWizardConnectorPrompt` to expect `WizTestIt`, updated welcome text assertion |
