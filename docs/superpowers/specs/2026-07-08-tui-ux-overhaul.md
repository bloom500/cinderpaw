# TUI UX Overhaul — Wizard Cut-Down, Nav Unification, Command Surface

**Date:** 2026-07-08
**Source:** Staff-level UX audit of `tui/` (full read of view.go, update.go, wizard.go, model.go, keymap.go, styles.go, glyphs.go, wizard_frame.go, main.go)
**Implementer:** Opus 4.8
**Scope:** `tui/` only. No gateway/Rust changes required except where explicitly marked OPTIONAL.

## Ground rules for the implementer

- Read the referenced code before changing it. Line numbers are from 2026-07-08; re-locate by symbol name if drifted.
- Existing tests live in `tui/app/*_test.go` and `tui/ui/*_test.go` (snapshot + acceptance). Run `go test ./...` in `tui/` after every phase. Update snapshots deliberately, never blindly.
- Do not rewrite working subsystems (streaming strip, tool pills, per-turn cache, glyph system). This spec is mostly **deletion and rewiring**.
- Every phase is independently committable. Do them in order: P0 → P1 → P2 → P3. P0 is pure bug-fixes and safe; P1 changes the wizard flow shape.

---

## P0 — Correctness fixes (no flow redesign)

### P0.1 Step counter must be path-aware  [CRITICAL C1]
`renderWizard` (view.go ~1467) passes `StepIdx: wizardStepIndex(w.Step)` and `StepTotal: len(wizardStepOrder)` (=14). The path-aware helpers `currentStepIndex(ws)` and `pathTotal(ws)` (wizard.go ~103–121) already exist and are unused.

**Fix:** use `currentStepIndex(w)` / `pathTotal(w)`. When the step is not in the path (conditional steps: `WizResume`, `WizConfigHandling`), pass `StepTotal: 0` so the frame collapses to the static title (already supported by `renderWizardStepLabel`).

**Accept:** QuickStart shows `step 1 of 6` … `step 6 of 6` with no gaps; Manual shows `of 10`; Resume screen shows no counter.

### P0.2 QuickStart cloud branch has no provider  [CRITICAL C2]
`wizardPathQuickStart` (wizard.go ~362) routes `!GpuOK` → `WizCloudKey` directly. `renderWizCloudKey` then renders `"Paste your  API key."` (empty provider) and the key would be saved against provider id `""`.

**Fix (minimal, pre-P1):** insert `WizCloudProvider` before `WizCloudKey` in the QuickStart cloud branch:
```go
path = append(path, WizCloudProvider, WizCloudKey)
```
(The provider picker already sets `w.ModelID` to the provider default on Enter — update.go ~2522 — so no model step is needed on QuickStart.)

**Accept:** on a no-GPU machine, QuickStart shows the provider picker; the key screen names the provider; `saveCloudProvider` never receives an empty provider id. Add a guard in `saveCloudProvider` (update.go ~1815): return an error if `w.Provider == ""` — fail loud, never persist a blank provider.

### P0.3 One back-navigation system  [CRITICAL C3]
Two systems coexist: global Esc/Backspace → `prevPathStep()` (update.go ~2192–2204), plus per-step `case tea.KeyEscape:` blocks with raw `w.Step--` enum decrements (WizModelChoice ~2487, WizCloudProvider ~2568, WizCloudModel ~2598, WizCloudKey ~2675, WizConnectors ~2735) and hardcoded jumps (WizSetupMode → WizSecurity, WizCloudKeyMode → WizCloudModel). Consequences: Esc while typing a provider search query goes back a step instead of clearing (the step's clear-query branch is unreachable); `w.Step--` can land on the wrong branch's screen.

**Fix:**
1. Delete every per-step `KeyEscape` case in `wizardHandleKey`.
2. Extend the single global handler:
   - If the current step is `WizCloudProvider` and `w.SearchQuery != ""`: Esc clears the query (and only that). This must run BEFORE the back-nav branch.
   - Else Esc/Backspace → `prevPathStep()`. Backspace-as-back only when the step has no active text buffer (provider search empty, and step not in {WizCloudModel, WizCloudKey, WizConnectorPrompt} — those consume Backspace for editing).
   - On `WizWelcome`: Esc exits the wizard (current behavior, keep).
   - While an async op is in flight (hardware probe, key validation, download, health check): first Esc cancels/ignores the op result and stays on the step showing a "cancelled — Enter to retry" line; it does NOT exit the wizard. (Today Esc during probe/TestIt exits the whole wizard — update.go ~2182, ~2836. Change both.)
3. Never assign `w.Step--` or `w.Step++` anywhere. All movement is `nextPathStep` / `prevPathStep` / explicit jump to a step **verified to be in `w.Path`**.

**Accept:** grep `w.Step--` and `w.Step++` in tui/ returns zero hits. Esc on provider search with a query clears the query; with empty query goes to previous path step. Esc mid-health-check does not exit the wizard.

### P0.4 Resume must be path-aware  [CRITICAL C5]
`startWizard` (update.go ~1701) and the WizResume handler (~2314) resume with `w.Step = saved + 1` — an **enum** increment that can produce a step not in the user's path (e.g. QuickStart saved=WizHardware → WizModelChoice, not in path → Enter dead-ends).

**Fix:** persist enough to rebuild the path, then resume by path index:
- Extend the progress file payload to `v4:<step>:<mode>:<choice>` where `<choice>` is `int(w.Choice)` (local/cloud), bump `wizardProgressVersion` to 4 (old files reset cleanly — mechanism already exists).
- On resume: `path := defineWizardPath(mode, hardware)` — then if choice==cloud and the path was pruned at ModelChoice previously, apply the same pruning as the WizModelChoice Enter handler (factor that pruning into a helper `pruneAtModelChoice(path, choice)` used by both).
- Find `i := indexOf(path, saved)`; if found, resume at `path[i+1]` (clamp to last). If NOT found, resume at the branch point (`WizHardware`) — never guess.

**Accept:** unit test: for every (mode, choice, saved-step) combination, the resumed step is in the reconstructed path. Add it to `wizard_progress_test.go`.

### P0.5 Adaptive colors  [CRITICAL C6]
styles.go ~14–22 hardcodes a dark-only palette. On light terminals `Text #E4DDD2` is illegible.

**Fix:** convert the palette vars to `lipgloss.AdaptiveColor`:
```go
Accent    = lipgloss.AdaptiveColor{Light: "#C2632A", Dark: "#EC8C4C"}
AccentHi  = lipgloss.AdaptiveColor{Light: "#A85520", Dark: "#F2A466"}
AccentDim = lipgloss.AdaptiveColor{Light: "#D9A87E", Dark: "#89532F"}
Text      = lipgloss.AdaptiveColor{Light: "#2B2620", Dark: "#E4DDD2"}
Meta      = lipgloss.AdaptiveColor{Light: "#8A8378", Dark: "#7A746B"}
Ok        = lipgloss.AdaptiveColor{Light: "#4F7A38", Dark: "#8FB77A"}
Warn      = lipgloss.AdaptiveColor{Light: "#9A741F", Dark: "#D6A95A"}
Fail      = lipgloss.AdaptiveColor{Light: "#B23A28", Dark: "#D16B5A"}
```
Also fix `KbdStyle`'s hardcoded `#1b1b1f` background (AdaptiveColor: light `#E8E2D8`). The glamour theme JSON (`feralStyleJSON`) stays dark-tuned for now — OPTIONAL: generate a light variant and pick via `lipgloss.HasDarkBackground()`.

Note: the palette var type changes from `lipgloss.Color` to `lipgloss.AdaptiveColor` — both satisfy `lipgloss.TerminalColor`, so every `.Foreground(X)` call site compiles unchanged. Verify `go build ./...`.

**Accept:** `go test ./...` green (snapshot tests may need regen — the escape codes change; regenerate once, review diff is colors-only).

### P0.6 Wizard breaks under 60 cols  [C9]
`RenderWizardFrame` (wizard_frame.go ~63) clamps width UP to 60 while the app minimum is 40 — lines wrap into soup at 40–59 cols.

**Fix:** when `width < 60`, skip the border entirely: render `header \n body \n footer` flat with no `Border()`, no horizontal padding beyond 1. Never emit a line wider than `width`.

**Accept:** snapshot test at width 45 shows no wrapped border fragments.

### P0.7 Command output goes to the transcript, not flash  [C7]
`/status`, `/usage`, `/whoami`, `/context`, `/tasks`, `/sessions`, `/model status` all use `setFlash` (one-line, transient; `/status` even embeds `\n` which a one-line footer cannot render).

**Fix:** route all of these through `appendTranscriptLines` (already exists, used by `/doctor`). Multi-field output = one dim line per field, same visual style as `/doctor` rows. Flash remains ONLY for ≤5-word acknowledgments ("cleared", "session reset", "aborted", "reasoning toggled", "unknown command…").

**Accept:** `/status` output is scrollable in the transcript and survives longer than 3 seconds.

### P0.8 Single command registry feeding help + completion + dispatch  [C8]
The help overlay (view.go ~536) hand-lists 7 of ~25 commands; keymap.go claims help renders from `KeyMap` but `renderHelpOverlay` never calls `HelpEntries()`.

**Fix:** create `tui/app/commands.go`:
```go
type Command struct {
    Name    string   // "status"
    Aliases []string // {"?"} for help, etc.
    Desc    string   // one line
    Args    string   // "" or "<id>" — for completion Insert
    Hidden  bool     // true = works but not listed (genome, meta until real)
    Run     func(a *App, args []string) tea.Cmd
}
var Registry = []Command{ … }
```
- `handleSlash` becomes a lookup over Registry (keep the switch bodies, move them into `Run` closures or methods).
- `recomputeCompletion` builds its list from Registry (non-Hidden).
- `renderHelpOverlay` renders: all non-Hidden commands from Registry + key bindings from `Keys.HelpEntries()`. Delete the hand-written lists.
- Mark `/genome`, `/meta` as `Hidden: true`. Remove the `/model list` completion row (keep it working as alias).
- Fix stale copy while here: help "Esc — close overlay / interrupt" (not "exit TUI"); welcome shortcuts "^C ×2 exit".

**Accept:** every command in Registry appears in `/help`; a test asserts `len(helpOverlayCommands) == len(nonHiddenRegistry)` so drift is impossible.

### P0.9 Honest receipts
- `/compact` (update.go ~808) fabricates "compacted: N turns → summary (X freed)" while doing nothing. Replace with: `a.setFlash("compaction not available yet")`. Delete the fake RuntimeEvent.
- Health-check "s skip" sets `TestItSucceeded = true` (update.go ~2873). Add `TestItSkipped bool` to WizardState; skip sets Skipped, not Succeeded. `renderWizFinish` renders `⚠ health check skipped — run /doctor after setup` (WarnStyle) instead of the ✓ rows when Skipped.

### P0.10 Small copy/glyph fixes (one commit)
- view.go ~335: `"reconnecting. (attempt %d)"` → `"reconnecting… (attempt %d)"`.
- view.go ~1718: `"1 2 3  choose"` on a 2-option screen → `"1 2  choose"` (or derive from len).
- view.go ~1673: `"gpu none detected — cpu mode"` → `"no GPU detected — using CPU (slower, still private)"`.
- wizard_frame.go ~129: `"  -  "` separator → `" · "`.
- view.go ~726 (history overlay): byte-slice `preview[:35]` can split a rune — use the existing `truncate()`.
- view.go ~980: "(N more chars)" count is chars-minus-joined-lines, wrong — compute `len(tc.Preview) - len(strings.Join(lines,"\n"))` correctly or just say `"… truncated · /tools"`.
- Health-check failure options (view.go ~2115): only render `"p change provider"` / `"m change model"` when the corresponding step is in `w.Path` (local path must not offer provider change — pressing it today jumps out of the path). Gate the key handler the same way.
- Overlay close-hints: standardize to `"esc close"` grammar across help/history/tools/models.

---

## P1 — Wizard flow cut-down (14 declared / 6–10 walked → 4 screens)

Design target: QuickStart = 3 interactive screens + Ready; Manual = same screens with more options exposed. Every screen either takes a decision or shows progress.

### New flow

**Screen 1 — Welcome + Mode** (replaces WizWelcome + WizSecurity + WizSetupMode + WizConfigHandling)
- Bear logo + tagline + preflight notes (keep existing `PreflightNotes` rendering).
- One select list:
  - `Quick start` — "recommended · ~2 min"
  - `Custom setup` — "pick provider, model, storage"
  - `Use existing config` — shown ONLY when `hasExistingConfig()`; description embeds what was found (provider id + model from byok.json when parseable — reuse the preflight sweep in wizard_preflight.go which already reads it). Selecting it = today's ConfigKeep (exit wizard, use config). A second line under it: `r reset — wipe ~/.feral and start fresh` requiring an explicit `y/N` confirm before deleting.
- Security note is two dim lines of body copy on this screen, NOT a step:
  "Feral can run tools and connect to services you enable. You approve each connector. Nothing leaves this machine unless you add a cloud key."
- Enum cleanup: `WizSecurity`, `WizSetupMode`, `WizConfigHandling` are removed from paths. Keep the enum values (progress-file compat is handled by the v4 version bump) but delete their renderers and key handlers. `SecurityAccepted` field: delete.

**Screen 2 — Engine** (replaces WizHardware + WizModelChoice)
- Hardware probe fires on entry (existing `startWizardHardwareProbe`); while in flight the header row shows the spinner; on result it becomes one line: `✓ RTX 4070 · 12 GB vram · 32 GB ram · 210 GB free` (or the no-GPU copy). Probe failure keeps the existing Retry CTA inline.
- Below it the Local/Cloud list, pre-highlighted from probe (GPU → Local, else Cloud):
  - `Local — Qwen3.5 9B · 5.5 GB download · private, runs on your GPU` ← model name + size ARE the consent (fixes C4). Pull from `w.ModelID`/`w.ModelSize` (already set in startWizard).
  - `Cloud — bring your API key · faster, prompts leave this machine`
- No standalone "Press Enter" hardware screen. Enter here selects the branch AND (local) starts the download.
- QuickStart vs Custom difference on this screen: none structurally. Custom mode later gets the model-id edit on screen 3.

**Screen 3a — Local: download + verify** (replaces WizLocalDownload + WizTestIt)
- Keep the existing progress bar + real elapsed. Add the first line: `↓ Qwen3.5 9B · %.1f/%.1f GB · %d MB/s` (bytes are already in DownloadModelMsg polling).
- On download complete, auto-run the 4 health checks on the SAME screen (reuse `startWizardHealthCheck` + the existing 4-row check renderer). No separate TestIt step, no Enter between download and checks.
- Failure handling: keep r retry; add `m change model` only in Custom mode; `s continue anyway` sets Skipped (P0.9).

**Screen 3b — Cloud: provider + model + key, one form** (replaces WizCloudProvider + WizCloudModel + WizCloudKeyMode + WizCloudKey + WizTestIt)
- Top: the existing searchable provider list (keep filter behavior + catalog fetch fallback).
- On provider Enter, the list collapses to one line (`provider: OpenAI · press p to change`) and focus moves to the key field.
- Key field: `bubbles/textinput` with `EchoMode: EchoPassword` (see P1.2). Under it a dim line: `model: gpt-4o` — in Custom mode `m` edits it inline (textinput); in QuickStart it's display-only.
- Enter on a non-empty key runs validation (existing `startWizardProviderTest`) with a spinner ON THE FIELD row, then auto-runs the 4 health checks below on the same screen.
- Delete `WizCloudKeyMode` entirely (option 2 was a "coming soon" placeholder not even in the manual path). Add the hint line under the key field: `tip: or set FERAL_BYOK_KEY in your environment`.

**Screen 4 — Ready** (replaces WizFinish)
- One consolidated receipt: provider/model line, latency/streaming line (render the benchmark block ONCE here — delete the duplicate from the TestIt success view, which no longer exists), `⚠ health check skipped` when Skipped.
- DELETE the `feral chat / feral doctor / feral desktop` command list (user is already inside the TUI — wrong context). Replace with:
  - `try: "summarize the files in this folder"` — and on Enter, pre-fill the chat input with that suggestion (do not auto-send).
  - `/help commands · /setup re-run setup`
- Keep "Have fun. Press Enter to begin."

### P1.1 Path/enum mechanics
- `wizardStepOrder` becomes: `{WizWelcome, WizHardware, WizLocalDownload, WizCloudProvider, WizCloudKey, WizFinish}` (WizHardware is now "Engine", WizCloudProvider+Key merged rendering but may stay two enum steps internally if the one-form is easier as a sub-state machine — implementer's choice; the step COUNTER must show it as one step either way, via `StepTotal` derived from visible screens, not enum entries).
- QuickStart path = `{Welcome, Engine, Download|CloudForm, Finish}` → counter "of 4".
- Custom path = same 4 screens; Custom only unlocks inline edits (model id) and extra failure options. This kills the QuickStart/Manual path divergence as a structural concept — `SetupMode` degrades to a bool `customMode` on WizardState. Keep `SetupMode` type for progress-file compat but stop branching paths on it.
- Connectors: `WizConnectors`/`WizConnectorPrompt` are already absent from both paths. Delete their renderers, key-handler cases, and `connectorCardNames`. Keep `connectorDefs` + `api.SaveConnectorConfig` — they back the `/connectors` slash command. Post-onboarding discovery: after the first successful chat reply ever (first `StreamDoneMsg` with no error following wizard completion), push one RuntimeEvent: `◦ tip: connect Discord or Telegram with /connectors`.

### P1.2 Real text inputs
Replace the four hand-rolled `string += runes` buffers (APIKey, ModelID, SearchQuery, ConnectorTokenInput) with `bubbles/textinput` models on WizardState:
- key input: `EchoPassword`, show last-4-after-validation like today's mask.
- provider search: plain, placeholder "type to filter".
- model id: plain.
This gives cursor movement, word-delete, paste handling for free. `bubbles` is already a direct dependency.

**Accept for P1:** manual walkthrough scripted in `acceptance_test.go`: QuickStart-GPU = exactly 4 Enter-or-less interactions from launch to chat (welcome-select, engine-select, [download+checks auto], ready-Enter). QuickStart-no-GPU = 4 interactions + provider pick + key paste. Counter shows "of 4" everywhere. `go vet` finds no unused renderers.

---

## P2 — Interaction consistency (chat surface)

### P2.1 Interaction grammar
One grammar everywhere in the wizard and overlays:
- Lists: ↑↓/j/k + Enter, number accelerators where ≤4 options. No bare y/n screens (the only y/n left is the destructive-reset confirm and tool approvals, which are true confirms).
- Text: textinput sub-models (P1.2).

### P2.2 Keybinding fixes
- **Ctrl+H collision:** Ctrl+H is ASCII backspace in many terminals. Remove the Ctrl+H binding for the history overlay. The overlay itself ("this session's user messages", read-only, actionless) is low-value — DELETE it (`ShowHistory`, `renderHistoryOverlay`, handler) and keep `/sessions` (transcript output per P0.7). Update keymap + help.
- **F1 fallback:** keep F1, add `?` as help alias only when the input is empty (check `a.Input.Value() == ""` before treating `?` as help; otherwise it types).
- Naming: `/history` alias for `/sessions` stays but the word "history" no longer refers to two features.

### P2.3 Type-ahead during streaming
`renderInput` (view.go ~402) swaps the textarea for a placeholder while streaming. Keep the input focused and editable during streaming; on Enter while streaming, queue the text (`pendingSubmit string` on App) and auto-submit it when `StreamDoneMsg` lands cleanly. Esc still interrupts the stream (does not clear the composed text). The streaming status strip already carries the cancel hint, so remove the placeholder's "(esc to cancel)".

### P2.4 Overlay position indicators
Tool viewer + model picker: add `3/27` position in the header line when rows > visible cap. Tool viewer expanded preview: PgUp/PgDn pages the preview (track a preview offset in ToolViewerState).

---

## P3 — OPTIONAL / follow-up (do not start without confirmation)

- Command palette (Ctrl+K): fuzzy over Registry + models + sessions. Registry from P0.8 is the prerequisite; this is the payoff.
- Welcome-screen sessions selectable (↑↓+Enter opens a past session via gateway).
- Light glamour theme variant.
- Mouse click targets on completion rows / overlay rows.
- Gateway: `/runtime/compact` endpoint to make `/compact` real.

---

## Verification (whole spec)

1. `cd tui && go build ./... && go test ./...` — green.
2. `feral chat --wizard` on a machine with GPU: 4-screen QuickStart, counter "of 4", download shows name+size, checks auto-run, Ready pre-fills suggestion.
3. `FERAL_BYOK_PROVIDER` unset, no GPU (or force via env if a knob exists — check `startWizardHardwareProbe`): cloud form names the provider before asking for the key; empty-provider save is impossible.
4. Kill the TUI (Ctrl+C) mid-wizard at each screen; relaunch: resume lands on a step in the path every time.
5. `NO_COLOR=1` and `FERAL_ASCII=1` runs: wizard usable, no Unicode border in ASCII mode is OPTIONAL (existing deviation, leave unless trivial).
6. 45-col terminal: wizard renders flat, nothing wraps.
7. Light-background terminal: text readable everywhere.
8. `/status`, `/usage`, `/sessions` output lands in the transcript; `/help` lists every non-hidden command.
