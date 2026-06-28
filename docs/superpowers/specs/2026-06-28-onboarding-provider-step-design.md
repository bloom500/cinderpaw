# Onboarding "Choose your brain" step — design

**Date:** 2026-06-28
**Status:** Approved, ready for implementation plan
**Branch:** feat/reactive-pixel-tree

## Problem

The first-run onboarding wizard (`frontend-react/src/components/onboarding/OnboardingWizard.tsx`)
has no panel where the user picks a provider. Its 4 steps are
Welcome → Personalize → Showcase → Done. The wizard deliberately deferred
model/provider choice to "the agent's job", but that leaves a real gap: a
first-time user — especially the non-technical primary audience — finishes
onboarding with **no brain wired up**. They land on a chat that needs a model
or a cloud key, with no guided path to get one. The `Done` step only shows an
advisory hardware *hint* ("look for a 7–8B Q4_K_M model in Models → Browse");
it never actually downloads anything or guides a cloud-key setup.

Meanwhile the app already supports:

- **Local models** — downloaded GGUFs via `useDownload.start(repoId, filename)`
  (`stores/download.ts`), auto-loaded on completion.
- **Cloud BYOK** — 12 providers in `components/settings/ByokTab.tsx`, each
  saved/tested via `useSettings.saveByokProvider` / `testByokProvider`.

The missing piece is a guided fork in onboarding that connects a first-time
user to one of these two worlds.

## Goal

Add a "Choose your brain" step to the onboarding wizard that lets the user:

1. **Run locally** — one-click download of a hardware-appropriate model,
   inline, with progress, ending with a loaded model on disk.
2. **Use a cloud key** — pick from a short curated list of providers, follow a
   step-by-step tutorial, paste an API key, test, and save — all inline.

The step is **skippable / non-blocking**: a user can `Skip` or `Continue`
without choosing, keeping current defaults and configuring later from Settings.
This matches the existing skippable philosophy and is essential for
non-technical error recovery.

## Flow change

Insert one new step between Personalize and Showcase. `totalSteps` 4 → 5:

```
Welcome(0) → Personalize(1) → ProviderStep(2) → Showcase(3) → Done(4)
```

- `stores/onboarding.ts`: bump `totalSteps` 4 → 5 in `DEFAULTS`.
- `OnboardingWizard.tsx`: add `{step === 2 && <ProviderStep />}` and shift
  Showcase to `step === 3`, Done to `step === 4`.
- `Done` step (`DoneStep`): remove the hardware-recommendation block — it is
  now redundant with the local branch of ProviderStep. Keep the celebration,
  the names recap, and the `DiskEncryptionNotice`.

`ProviderStep` does **not** gate `Continue`. The wizard's existing
`StepNavigation` already only gates step 1 (Personalize requires a name);
ProviderStep adds no gate.

## ProviderStep — component design

Lives in `OnboardingWizard.tsx` (same file as the other steps, following the
existing in-file step pattern). A two-card fork at the top; selecting a card
expands its inline flow below.

### Card A — "Run locally"

- Title + subtitle ("Private, free, runs on your machine"). Shows a
  "Recommended" badge when `recommendModel(sysInfo)` returns a tier ≥ 3–4B
  (i.e. the device can comfortably run a useful model).
- On select: render `recommendModel(sysInfo).rationale`, then a single
  primary button **"Download {model name} (~{size})"**.
- The button resolves the recommendation's `sizeClass` to a concrete model via
  a new `TIER_MODELS` map, then calls `useDownload.start(repoId, filename)`.
- While `useDownload.active` is set, show an inline progress bar driven by
  `active.progress`. On `done`, show "✓ Model ready" — the existing
  `feral://download-complete` listener in `download.ts` auto-loads the model,
  so no extra wiring is needed here.
- Secondary link **"Browse other models"** → deep-links to the Models page
  (close/skip the wizard and navigate). Reuses the existing Models flow intact.

### Card B — "Use a cloud key"

- Title + subtitle ("Instant, stronger models, needs an account — some have a
  free tier").
- On select: render a row of 4 curated provider tiles (`CURATED_PROVIDERS`).
- Pick a provider → inline mini-form:
  - A short numbered tutorial (3 steps) + a button **"Open {provider} console"**
    that opens the provider's key page (`tauri` shell open / external link).
  - API key field (password input with show/hide), reusing the `keyPrefix`
    detection hint already present in `ByokTab` (e.g. "✓ MiniMax key detected").
  - **Test** and **Save** buttons calling `useSettings.testByokProvider` and
    `saveByokProvider` — the same store actions `ByokTab` uses. Save enables the
    provider so it becomes the active cloud model.
- Footer link **"More providers → Settings → Cloud Keys"**.

## New data (kept minimal)

### `TIER_MODELS`

A map from `recommendModel` size class to a concrete downloadable GGUF. **This
is the calibration knob** — pinned, real, curated, and must be maintained when
the recommended models change.

```ts
// ponytail: pinned curated models per hardware tier. Calibration knob —
// re-verify these repos/files exist on HF before each release; swap when a
// better small model ships.
const TIER_MODELS: Record<string, { repoId: string; filename: string; label: string }> = {
  '1–2B':   { repoId: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF', filename: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf', label: 'Qwen2.5 1.5B' },
  '3–4B':   { repoId: 'bartowski/Qwen2.5-3B-Instruct-GGUF',   filename: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',   label: 'Qwen2.5 3B' },
  '7–8B':   { repoId: 'bartowski/Qwen2.5-7B-Instruct-GGUF',   filename: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',   label: 'Qwen2.5 7B' },
  '13–14B': { repoId: 'bartowski/Qwen2.5-14B-Instruct-GGUF',  filename: 'Qwen2.5-14B-Instruct-Q4_K_M.gguf',  label: 'Qwen2.5 14B' },
};
```

> **Pre-ship verification (required):** the four repo IDs and filenames above
> are best-guess and MUST be confirmed against Hugging Face (exact repo owner,
> casing, and GGUF filename) before this ships. If a repo/file does not resolve,
> the one-click download silently fails. Verify against the same source the
> Models page uses to download.

### `CURATED_PROVIDERS`

A small array in the step file. Each entry: provider `id` (matching a
`PROVIDER_DEFS` id in `ByokTab`), display name, console URL, 3 tutorial steps,
and the `keyPrefix` (reused from `PROVIDER_DEFS`).

Curated set: **OpenAI, Anthropic, Google Gemini, OpenRouter** (Gemini and
OpenRouter offer free tiers — relevant for zero-budget users). All other
providers remain available in Settings → Cloud Keys.

## Error handling

- **Local download failure:** `useDownload` sets `error`; show it inline with a
  retry button. Non-fatal — the user can still `Continue` or switch to cloud.
- **Cloud test/save failure:** surface the error string inline (same pattern as
  `ByokTab`). Non-fatal.
- **No `sysInfo` yet:** if `recommendModel` returns `null`, the local card shows
  a generic "Download a starter model" using the `3–4B` tier as a safe default,
  or simply links to Models. Never blocks.
- The step never throws into the wizard; all failures are local to the card.

## Testing

One test file alongside the existing onboarding tests
(`stores/__tests__/onboarding.test.ts` covers the store; component tests follow
the `ByokTab.test.tsx` pattern):

- ProviderStep renders both fork cards.
- Selecting "Run locally" with a mocked `sysInfo` resolves a concrete
  `repoId`/`filename` from the recommended tier and calls `useDownload.start`
  with those exact values.
- Selecting a curated provider and clicking Save calls
  `useSettings.saveByokProvider` with the chosen provider id.

No new test framework — reuse the existing Vitest + Testing Library setup.

## Explicitly out of scope (YAGNI)

- Hand-written tutorials for all 12 providers — only the 4 curated ones get the
  inline tutorial; the rest stay in Settings → Cloud Keys.
- A full local model picker in the wizard — only the single recommended-tier
  model is offered; "Browse other models" deep-links to the existing Models
  page for anything else.
- Multi-model / multi-provider configuration in onboarding — one brain is
  enough to finish first-run; the rest is configured later in Settings.
