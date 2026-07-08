# OpenClaw onboarding UX — investigation notes

**Status:** Investigation only. **No OpenClaw code has been copied into Feral** —
this file is an analytical comparison for our own design decisions. Quoted strings
are short UX copy snippets (under fair use + file:line attribution) used to anchor
specific design choices, not code to port.

**Source of truth:** OpenClaw was cloned shallow into
`C:\Users\Darius\AppData\Local\Temp\opencode\openclaw\` for read-only inspection
on 2026-07-07. The relevant files referenced below live under that path; they
are not part of this repo.

> Companion: `docs/audits/2026-07-06-architecture-audit-persistent-memory-and-onboarding.md`
> (Feral DoD pointer), `docs/agents-memory/project_tui_onboarding_sprint3.md`,
> `…_wizard_f3.md`, `…_connectors_f4.md`, `…_chat_tui.md` (what Feral ships today).

---

## TL;DR

OpenClaw split their first-run UX into **two distinct entry points** —
a conversational agentic wizard ("Crestodian", the default) and a
classic step wizard (`--classic`). Feral has only the classic pattern
today (`tui/app/wizard.go` + the React `OnboardingWizard`).
Their classic wizard doesn't have UX ideas we don't already pin; their
**conversational** pattern is the one that's interesting and where the
upside lives, and it's orthogonal to (not a replacement for) the classic
wizard. Of the dozen or so concrete patterns I read, four map cleanly to
open Feral work without copying anyone's code.

## What they built (the surface I'm looking at)

`openclaw onboard` is the documented entry point
(`README.md`, repo's docs.openclaw.ai/start/wizard page). It branches in
`src/commands/onboard.ts:155-160`:

- `--non-interactive --accept-risk` → `runNonInteractiveSetup`
- `--classic` (or any explicit non-default flag) → `runInteractiveSetup`
- **default** (no flags) → `runConversationalOnboarding` (the LLM-driven
  Crestodian)

Both interactive paths presume TTY
(`onboard-interactive.ts:50, 107`), fail fast otherwise, and call
`restoreTerminalState` in a `finally` so a cancel cannot leave stdin paused
(`onboard-interactive.ts:31-37`). A cancelled wizard exits `1`, not `0`
(`onboard-interactive.ts:27`). Small detail but worth copying.

## The classic wizard (their fallback)

Orchestrator: `src/wizard/setup.ts`, ~570 lines, decoupled into ~30
supporting files (`setup.model-auth.ts`, `setup.gateway-config.ts`,
`setup-migration-import.ts`, `setup.finalize.ts`, `setup.*` plugin steps,
the i18n dictionary, the Clack-prompter adapter).

**Order of operations:**

1. intro → risk acknowledgement gate
2. config-snapshot review (`readSetupConfigFileSnapshot`) — if config
   exists & invalid, `prompter.note` the issues and exit 1
3. plugin-compat snapshot — surfaces any existing plugin notices at
   the top before any input is taken
4. flow choice (QuickStart / Advanced / Import / keep-existing-model
   when one is already configured)
5. setup-mode local vs remote
6. workspace dir
7. model + auth (`runSetupModelAuthStep`)
8. gateway config (port, bind, auth token/password, Tailscale exposure,
   direct-channels hint)
9. **persist config here** — `setup.ts:474-476` writes before channels so
   a channel-pairing crash doesn't lose provider setup
10. channels (`setupChannels` — `onboard-channels.ts:7`)
11. search provider
12. skills
13. plugin install (skipped in quickstart flow)
14. plugin config (skipped in quickstart flow)
15. hooks + finalize (`setup.finalize.ts:857-871`) — at the very end
    the wizard launches the TUI in-place instead of printing "now run
    `openclaw tui`"

**Pattern-relevant choices to compare against Feral:**

| OpenClaw choice | Feral today | Gap for Feral? |
|---|---|---|
| `--skip-{channels,search,skills,bootstrap,hooks}` for automation | TUI wizard has timeouts + Esc-cancel during probes (Sprint 2 audit) but no skip toggles | small — only matters if we want a headless wizard install path; out of current scope |
| **Persist config after gateway-auth, before channels** | No equivalent — TUI wizard persists via `wizardProgressVersion` at the end, but in-flight wizard progress IS already on disk per step | already fine; not a gap |
| `disableBackNavigation()` after migration import | TUI always allows Esc back; could break an import | out of scope (no OpenClaw-style import flow) |
| Risk acknowledgement `y/n` gate BEFORE any credential write | TUI `WizSecurity` step (F1) | matches; nothing to borrow |
| "Direct channels" hint pinned in quickstart view | TUI doesn't render channel hint at gateway step | small — could add to finish-checklist |
| Finalize step LAUNCHES the TUI (instead of a "type X" outro) | TUI wizard already launches `feral chat` on the Done step in F2 | matches |
| Tailscale bind options + tailnet exposure in wizard | No remote-exposure step | out of scope (Feral has no equivalent) |

The classic-wizard ideas that translate 1:1 are mostly things we already
do. Where it's sharper than Feral:

- **`buildPluginCompatibilitySnapshotNotices` shown BEFORE any input** —
  Feral's provider-side `byok` already surfaces compatibility per provider,
  but plugin-level notices (e.g. a deprecated/incompatible BYOK key) never
  surface in the wizard. We don't have plugins, so the equivalent in
  Feral would be "if `byok.json` carries an unknown provider id, surface
  it before the user gets into the model picker." Cheap, single check in
  `tui/app/wizard.go` if we want it.
- **`applyWizardMetadata` markers** (`setup.ts:552` writes
  `wizardMetadata` into the saved config) — Feral doesn't write any
  "this config was authored by which command" marker. Useful for the
  audit-driven question "did this come from a wizard run or a manual
  edit?" — purely diagnostics, very low cost.

## The conversational wizard (their default — `src/crestodian/`)

Crestodian is the interesting one. It reuses the **same LLM that the user
just configured** to run setup itself: there's a single LLM playing both
"assistant I'm setting up" and "operator I'm configuring you." The
onboarding greeting is intentionally a single message carrying the whole
plan; a bare `yes` applies it.

Their welcome message (verbatim, `onboarding-welcome.ts:87-99`,
~13 lines, fair-use UX quote):

```
## Hi, I'm Crestodian — let's hatch your agent.

No menus here: tell me what you want and I'll do the configuring.
I looked around this machine:

- AI: Claude Code (claude-sonnet-4-…) — I'll reuse it; switching later
  is one sentence.
- Workspace: ~/.openclaw/workspace
- Gateway: runs locally, private to this machine (token auth).

Say **yes** and I'll set all of that up now.

Heads up: your agent gets real access to this machine —
https://docs.openclaw.ai/security
Afterwards: `connect discord`, `connect slack`, `connect telegram`,
`connect whatsapp` (or `channels` for the full list), then
`talk to agent` to meet your agent.
```

**Three observations Feral can borrow without copying code:**

1. **Pre-detect, then propose.** The LLM inspects credentials already
   on the machine (Claude Code login, `OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`) and pre-resolves the "what's my provider"
   choice the user would otherwise have to make. Feral's provider
   wizard (CloudBranch) does this for the catalog layer but still
   re-asks the user to pick a provider; with the same intuition we
   could prefer credentials Feral already detects in the user's env
   as the default provider candidate (`ProviderCatalogEntry` is
   already the right shape for "found provider X, here are its
   auth_style + default_model"). This is a much smaller change than
   it sounds — it's a default ordering, not new UX.

2. **Outgoing connectors as verbs, not config rows.** "connect discord"
   reads as a single intent; the gateway sorts out the OAuth dance.
   Feral's Connectors tab uses tab cards + "Y/n" connectors in the
   wizard; that's fine, but the inline-suggestion style ("Afterwards:
   try `connect discord`") is more inviting. We can spell this without
   rewriting anything — `project_tui_connectors_f4.md`'s footer hint
   area on the Done step could expose the same `·  connect discord ·
   connect slack · …` line. Visual sugar, near-zero risk.

3. **"Switching later is one sentence."** Calm, low-anxiety copy. The
   Feral UX has a "you can change names anytime in Settings" line on
   the Done step (`OnboardingWizard.tsx:732`), which is fine. What
   we're missing is the **provider-side** equivalent — "switching
   models later is one click in Settings → Cloud Keys." A one-liner
   in the cloud branch (`OnboardingWizard.tsx:570+`) covers the
   cognitive leak. This is a copy change, not architecture.

## Channel setup UX (their connector wiring)

`flows/channel-setup.ts` (~820 lines) + the `setup-wizard-types` adapter
interface. The adapter pattern is the interesting thing: each channel
plugin implements a `ChannelSetupWizardAdapter` with `pairConfig`,
`afterConfigWritten`, `dmPolicy`, etc. The runner walks the visible
plugin list, asks the unified selector prompt, then defers to the
adapter.

**What Feral has vs. what OpenClaw does:**

- Feral has `crates/feral-core/src/connectors.rs` canonical catalog with
  `pairing_method: PairingMethod` enum + the new `qr_setup_endpoint`
  field added by Phase 1 (snapshot DoD). The catalog is shape-only; the
  runtime pairing-side calls live in `src-tauri/src/connectors.rs`
  (persistence) and `FeralAgent/src/transports/tauri.ts` (IPC). That's
  roughly the adapter pattern but expressed as two parallel catalogs
  with manual sync (the M-R1 work just pinned their divergence via
  golden snapshot tests).
- The big delta: OpenClaw makes `dmPolicy` a first-class wizard
  prompt. `wizard.channels.dmPolicy` choices include `pairing` (the
  default — unknown senders get a code) vs `open` (allow public DMs).
  Approving pairing codes is a one-shot command
  (`openclaw pairing approve <channel> <code>`). This is a strong,
  opinionated safety surface for a product that connects to **23+
  messaging channels**. Feral's `dmPolicy` analogue (channel access
  control) is in the codebase but isn't surfaced in the wizard — it's
  set implicitly. **Worth surfacing in the wizard before Phase 2 ships
  the Connectors tab.** A two-question prompt ("do you want this
  channel open to anyone, or only people you approve?") per pairing
  is the obvious move.

## Things OpenClaw does that we should NOT copy

| Pattern | Why not |
|---|---|
| The Crestodian conversational default | Feral's terminal onboarding explicitly went minimalist-by-design (4 steps + audit). Replacing our classic wizard with an LLM-driven "yes" prompt makes the wizard into a black box, kills test coverage of decisions, and contradicts the AGENTS.md stance that the substrate is observable. The pattern is *interesting*; shipping it as default is not. If we ever experiment, gate it behind `feral onboard --agentic` (OpenClaw has `--classic`; we'd flip to `--agentic` like-for-like) so the deterministic path stays the surface and the agentic is opt-in. |
| `--skip-{everything}` automation toggles | A bypass for the safety prompts and the channel config is a feature in an automation-grade product. Feral doesn't have that user; adding it before the Connectors tab lands would create a footgun. |
| Launching the TUI in-place at the end | We already do this on the `Done` step ("Open chat" button exits the wizard and re-execs `feral-tui.exe`). Not a gap. |
| Plugin install wizard | Feral has no plugins. Copying this pattern without a plugin substrate would be cargo-culting. |

## Concrete Feral-shaped work this implies (none started; for triage)

In rough priority order, scoped to the "terminal onboarding flawless +
TUI agent chat UX" lane the user is operating in:

| # | Slice | Estimate | Risk |
|---|---|---|---|
| 1 | **Pre-detect credentials in `ProviderStep`**: when `process.env.OPENAI_API_KEY` (etc.) is set on first launch, surface a "I noticed you already have `<provider>` set up — want to start there?" card at the top of CloudBranch. Pre-selects it in the grid. Manual override stays. | very small, Zustand store change + 1 new card | low — fallback to existing flow |
| 2 | **Surface `dmPolicy` per channel** (Phase 2 Connectors territory): add `pairing` vs `open` 2-question prompt to `WizConnectors` / the future Connectors tab. OpenClaw's `wizard.channels.dmPolicy` keys are a good shape; we can use the same vocabulary without copying the strings. | medium, mostly wizard + adapter | medium — security UX is review-by-many-eyes territory; do NOT copy their exact wording, ours should follow Feral's `provider-style` copy |
| 3 | **"Switching models is one click" line** in `OnboardingWizard.tsx:570+` (CloudBranch) copy. Same line in `LocalBranch` post-download card. | trivial, copy edit | none |
| 4 | **Verbs-as-hints line** on the Done step (`OnboardingWizard.tsx:711+`): `· connect discord · connect slack · connect whatsapp` rendered as muted footer hints. The wizard can't actually pair any of these yet (Connectors tab is Phase 2), but the suggestion sits well. | trivial, JSX-only | none |
| 5 | **`applyWizardMetadata` markers** for Feral: write `{ ran_wizard_at, completed_at, channels_considered, … }` into `wizard-progress` so audit questions like "did this config come from a run?" are answerable. | small, TUI persistence change | low |
| 6 | **Plugin-compat preflight** in TUI: if `~/.feral/byok.json` carries an unknown provider id at wizard start, surface a notice before any prompt fires. | small | low |

Slice 1 + 3 + 4 + 5 + 6 are pure local changes with no architectural
implications. Slice 2 is the actual Phase 2 Connectors work and should
land together with it; the `dmPolicy` vocabulary can match OpenClaw's
words (`pairing` / `open`) without it being a copy — they're the
English words and our table is internal-only.

## What I did NOT investigate (out of lane)

- Web UI Control UI / Dashboard (`apps/`, `ui/`, `pnpm ui:dev`) —
  desktop UI is out of the "terminal + TUI" lane we own.
- Tailscale bind / remote gateway / Funnel / Serve — Feral has no remote
  gateway surface.
- Embedded plugin SDK / `extensions/` — Feral has no plugin substrate.
- macOS / iOS / Android companion-app pairing runbooks — pure desktop-
  adjacent UX, out of lane.
- The `health` command post-wizard hooks / `doctor` as the never-written
  but-recommended follow-up — Feral's `feral doctor` analog exists
  already, already mentioned on the F2 finish screen.
- `clawhub.ai` skills registry — could be relevant to Feral's skills
  surface but is outside terminal onboarding.
- Pricing / sponsorship copy. Irrelevant to UX.

## Open question I owe a follow-up

Crestodian's welcome message assumes the user is comfortable with a
default-and-overwrite model ("say yes"). That's a deliberate bet against
the Feral wizard's "confirm every step" stance. If we ever ship an
agentic-mode wizard in Feral, the **single** question worth getting right
is how a "yes" gets undone — Feral's recovery model
(`startWizard`:Resume vs Start over) would need an equivalent for
"unapply wizard decisions that just happened." Untouched here — flagging
because the answer is non-obvious, and any Feral agentic mode would
inherit the same risk.

---

*End of notes. Update when we ship slice 1, slice 2, or a Phase 2 Connectors
tab — those are the entries the next agent should read before touching
provider / connector onboarding.*
