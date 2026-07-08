# F3 — Wizard health check, model picker, finish screen

Shipped 2026-07-06.

## What F3 added

- **WizCloudModel** — explicit model-id input between provider selection and
  key entry. The user accepts the provider's default model or types a custom
  ID (e.g. `gpt-4o-mini`). Searchable list at WizCloudProvider (type-to-filter).
- **4-phase health check** at WizTestIt: API reachable → auth valid → model
  accessible → streaming round-trip. Each phase shows live status (pending /
  running / passed / failed with message). The streaming phase uses a
  deterministic prompt that asks the model to return exactly `FERAL_OK`.
- **F3.1 improvements**: Phases 1-3 run in parallel (not sequential). Timing
  metrics (`HealthCheckLatency`, `StreamLatency`) displayed on the finish
  screen as a "Connection benchmark". The streaming prompt is deterministic:
  `"Return exactly: FERAL_OK"` — the checker validates the response contains
  `FERAL_OK`. Warm finish screen shows bear compact + connection timing.
- **WizFinish** — bear compact + checklist (provider/model/connector/ready) +
  connection benchmark + "Enter to start chatting". Replaces the previous
  bare text screen.
- **wizardProgressVersion** bumped to 3 for the new WizCloudModel step.

## Files touched

- `tui/app/wizard.go` — `WizCloudModel` step, `HealthCheckKind`, `CheckStatus`,
  `HealthCheck`, `FilteredProviders`, timing fields
- `tui/app/update.go` — WizCloudModel handler, WizTestIt 4-phase check,
  WizFinish transition, health check cmd
- `tui/app/view.go` — renderWizCloudModel, renderWizFinish with bear compact
  + benchmark, renderWizTestIt 4-phase status
- `tui/app/overlay_test.go` — tests for all new steps

## Health check flow

```
Phase 1 (parallel): API reachable + auth valid + model accessible
Phase 2 (after phase 1 passes): streaming round-trip with FERAL_OK check
```

On failure: Retry (R), Change provider (P), Change model (M), Skip (S).
Auto-retry once before showing failure screen.
