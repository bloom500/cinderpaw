# F4 — Real chat-platform connectors from the wizard

Shipped 2026-07-06.

## What F4 does

The `WizConnectors` / `WizConnectorPrompt` wizard steps were cosmetic in F3
(just set `ConnectorSelected`, no persistence). F4 makes them functional:

1. **Field-by-field token input**: Token-based connectors (Discord, Slack,
   Telegram) show their required fields with masked input, one at a time.
   Slack has two fields (app-level + bot token); Discord and Telegram have
   one. Each field shows the label from the Rust catalog (e.g. "Discord bot
   token", "App-level token (xapp-…)").

2. **QR/bare connectors**: WhatsApp has no secret fields — the wizard shows
   a Y/n prompt to enable it (the sidecar handles QR linking on first connect).

3. **Persistence**: `api.SaveConnectorConfig()` writes to
   `~/.feral/connectors.json` in the exact `ConnectorConfigFile` format the
   Rust backend expects. Merges with existing entries (doesn't clobber other
   connectors).

4. **Sidecar reload**: After saving, fires `POST /runtime/connectors/reload`
   (fire-and-forget goroutine) so the sidecar picks up the change immediately.

## State fields (WizardState)

- `ConnectorFieldIdx int` — which field we're filling (0-based index into def.Fields)
- `ConnectorTokenInput string` — current masked text buffer
- `ConnectorTokenValues map[string]string` — completed field key → value
- (`Connecting bool` was removed — no longer needed)

## Connector definitions (Go side)

Maintained in `connectorDefs` map in `tui/app/wizard.go`, mirrors the Rust
`catalog_def()` in `src-tauri/src/connectors.rs`. Keep in sync when adding
connectors or changing fields.

## Files touched

- `tui/app/wizard.go` — `ConnectorFieldDef`, `ConnectorDef`, `connectorDefs`,
  `connectorCardNames`, reset/state fields
- `tui/api/client.go` — `SaveConnectorConfig()`, types `ConnectorFileConfig`,
  `ConnectorFileEntry`
- `tui/app/update.go` — WizConnectorPrompt handler (field input + Y/n branches)
- `tui/app/view.go` — renderWizConnectorPrompt (field labels + masked input or Y/n)
- `tui/app/overlay_test.go` — TestWizardConnectorPrompt (field input),
  TestWizardConnectorPromptBare (WhatsApp Y/n)

## Tests

```
go test ./app/...    # 4 packages pass, including new connector tests
go build ./...       # clean compile
```
