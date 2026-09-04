# ADR-0013: AI-Guided Onboarding with Domain-Event Contracts

**Status:** Accepted
**Date:** 2026-07-05

## Context

Cinderpaw's terminal-first setup today is a linear wizard (`tui/app/wizard.go`)
that walks the user through hardware detection, model choice, provider
setup, connectors, and finish. It works, but it forces every user through
the same sequence regardless of preference or prior knowledge.

The product's core value is a local-first autonomous agent that the user
talks to naturally. The onboarding experience should demonstrate that
value immediately: the user should be able to configure Cinderpaw by talking
to Cinderpaw, not just by navigating forms. At the same time, users who prefer
a guided, step-by-step flow must keep that option.

This ADR records the decision to add an **AI-Guided Configuration** branch
to onboarding. It establishes the contracts between the Rust backend, the
TypeScript sidecar, and the Go TUI so that the three layers can evolve
without renegotiating assumptions.

## Decision

Introduce **AI-Guided Onboarding** as a first-class branch of the setup
flow, alongside the existing wizard. The architecture rests on four
contracts:

1. **Three TUI states.** `StateWizard`, `StateOnboardingChat`, and
   `StateNormalChat`. Each has its own header, prompt, suggestion chips,
   and tool policy.

2. **An `OnboardingSession`.** A durable in-memory session that accumulates
temporary choices (providers, connectors, memory mode, permissions) and
only commits them to `brain.json`, `connectors.json`, and
`permissions.json` when the user confirms. This avoids half-written config
and makes undo natural.

3. **A small, dedicated config-tool surface.** Tools live in
   `tools/builtin/config/` and are registered through a thin
   `config-tools.ts` registry. Only these tools are exposed to the agent
   during onboarding; filesystem, shell, browser, and desktop automation
   tools are blocked.

4. **Domain-oriented events.** The sidecar and backend emit typed events
   such as `provider_added`, `connector_connected`,
   `model_download_progress`, and `onboarding_goal_completed`. The TUI
   renders each event directly instead of parsing generic `config_changed`
   payloads.

### Backend contracts

The Rust backend exposes these endpoints (initially as stubs, then
implemented):

- `GET /runtime/hardware` — GPU/RAM/disk detection.
- `POST /runtime/providers/validate` — generic API-key validation.
  Body: `{ provider, apiKey, baseUrl? }`.
- `POST /runtime/models/download` — start a model download.
  Body: `{ id }`.
- `GET /runtime/connectors/:id/qr` — return a QR payload for the
  connector; TUI decides how to render it.

### Sidecar contracts

The sidecar exposes these tools only during onboarding:

- `set_provider` / `remove_provider`
- `validate_provider_key`
- `set_connector` / `remove_connector`
- `request_model_download` / `set_default_model`
- `set_memory_mode`
- `set_permission`
- `check_onboarding_goals`
- `show_onboarding_help`

Every config tool has `requiresConfirmation: true`. The agent loop must
not execute it until the TUI has emitted a `confirmation_granted` event.

The sidecar emits these outbound event kinds:

- `provider_added`, `provider_removed`, `provider_validated`,
  `provider_validation_failed`
- `connector_configured`, `connector_connected`,
  `connector_disconnected`, `connector_connection_failed`
- `memory_mode_changed`
- `permission_changed`
- `model_download_started`, `model_download_progress`,
  `model_download_finished`, `model_download_failed`
- `wizard_step_completed`
- `onboarding_goal_completed`, `onboarding_all_goals_done`
- `onboarding_suggestion`
- `confirmation_required`, `confirmation_granted`, `confirmation_denied`

### TUI contracts

The TUI:

- Shows a "Let Cinderpaw help me" vs "Configure manually" choice after model
  selection in the wizard.
- Enters `StateOnboardingChat` for the conversational path.
- Renders each domain event as a concise status line or card.
- Provides `/wizard`, `/resume`, and `F2` to switch back to the wizard.
- Never sends plain-text "wizard" as a control message.

### Onboarding goals

The session tracks goals explicitly. Example goal set:

- `model` — an inference model is selected.
- `provider` — a local or cloud provider is configured.
- `memory` — memory mode is chosen.
- `connectors` — at least one connector is configured (optional).
- `permissions` — permissions are reviewed.

After each config tool runs, the agent receives the current
`completedGoals` / `pendingGoals` list and can surface it naturally.

## Consequences

**Easier:**

- Onboarding matches the product's primary interface: natural language.
- The wizard and the conversational path share the same backend
  endpoints and sidecar tools.
- Domain events make the TUI simpler: no conditional parsing of generic
  payloads.
- `OnboardingSession` with lazy commit lets users experiment and undo
  before anything is persisted.
- Tool whitelist prevents the agent from hallucinating dangerous actions
  during setup.

**Harder:**

- Three TUI states plus session persistence add complexity to the
  Bubble Tea model.
- Confirmation gating requires the agent loop to pause a tool call and
  wait for a TUI event.
- The backend must implement generic provider validation and download
  progress reporting.
- Keeping event schemas in sync across Rust, TypeScript, and Go requires
  discipline; tests should fail if a new event is added in only one
  language.

**Trade-offs accepted:**

- The first-launch happy path becomes longer in code even if it feels
  shorter to the user.
- We maintain two onboarding entry points forever. The payoff is user
  choice.

## Related

- `docs/agents-memory/project_chat_tui.md` — current TUI state and
  streaming design.
- `tui/app/wizard.go` — existing wizard state machine.
- `CinderpawAgent/src/brain/brain-config.ts` — `brain.json` loader and shape.
- `CinderpawAgent/src/transports/connectors.ts` — connector manager and
  `connectors.json` shape.
- `CinderpawAgent/src/tools/builtin/self.ts` — introspection tools; the new
  config tools complement but do not replace `self_*`.
- `CinderpawAgent/src/core/agent-loop.ts` — profile / tool-allowlist mechanism
  used for onboarding tool restrictions.
- `crates/feral-core/src/api.rs` — backend routes, including the Public
  Runtime API where new endpoints land.
