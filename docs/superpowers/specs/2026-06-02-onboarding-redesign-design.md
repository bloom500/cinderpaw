# Onboarding Redesign + OpenClaw Native UI Design

**Date:** 2026-06-02  
**Status:** Approved

## Goal

Redesign the Agents onboarding to be minimalist and centered (Apple/iOS style), and clean up the OpenClaw UI framing so agents feel native — not experimental.

## Design

### OnboardingShell

**Replace** dots + footer-with-border with:
- Thin progress line at top (2px, full-width, fills left-to-right per step)
- All content centered: `max-w-sm mx-auto text-center`
- No border-top footer — CTA button is part of the content flow
- Back/Skip as discrete text links below the CTA

Layout per step:
```
[████████░░░░░░░░]   ← progress line, full-width, 2px, bg-brand filled

      Step 2 of 4    ← text-xs brand color, centered
 Large heading here  ← text-2xl font-bold, centered
   subtitle text     ← text-sm muted, centered

   [ content area ]

   [ Continue →  ]   ← full-width rounded button, bg-brand
     ← Back  ·  Skip ← text-xs muted, centered row
```

### Steps

**WelcomeStep:**
- `✦` icon (or Bot), centered, brand color
- Title: "Meet Agents"
- Subtitle: one sentence
- 3 capability bullets (icon + text), centered
- CTA: "Get started"

**PickPresetStep:**
- Label: "Step 1 of 4"
- Title: "What will your agent do?"
- Subtitle: "Pick a template or start from scratch"
- Preset cards: full-width, left-aligned icon + name + description, border on selected
- No loading skeleton changes needed

**NameAgentStep:**
- Label: "Step 2 of 4"
- Title: "Give it a name"
- Subtitle: "You can always rename it later"
- Single input, centered, auto-focused, Enter = submit

**ReviewStep:**
- Label: "Step 3 of 4"
- Title: "Looks good?"
- Summary card: name, template, tools — minimal rows
- CTA: "Create agent →"

**DoneStep:**
- No step label (it's the end)
- Animated green checkmark (✓ in circle)
- Title: `"[agent name]" is ready`
- If `loadedModelName`: one line "Connected to [model]"
- OpenClaw badge if warmup succeeded: `● OpenClaw ready`
- CTA: "Go to agents"
- No "Next steps" list (too verbose)

### OpenClaw Native Fixes

| File | Change |
|------|--------|
| `AgentsMain.tsx` | Replace banner text: remove "experimental and not used for normal execution" → "These agents run through OpenClaw by default." |
| `AgentCard.tsx` `RuntimeSelector` | `"OpenClaw (test)"` → `"OpenClaw"` |
| `AgentCard.tsx` `RuntimeSelector` | Remove `"OpenClaw-backed routing is experimental"` label |
| `AgentCard.tsx` | Hide `"No model assigned..."` message when `agent.preferred_runtime === 'openclaw'` |

## Files Changed

| File | Change |
|------|--------|
| `frontend-react/src/components/agents/onboarding/OnboardingShell.tsx` | Full rewrite |
| `frontend-react/src/components/agents/onboarding/steps/WelcomeStep.tsx` | Centered layout |
| `frontend-react/src/components/agents/onboarding/steps/PickPresetStep.tsx` | Centered layout |
| `frontend-react/src/components/agents/onboarding/steps/NameAgentStep.tsx` | Centered layout |
| `frontend-react/src/components/agents/onboarding/steps/ReviewStep.tsx` | Centered layout |
| `frontend-react/src/components/agents/onboarding/steps/DoneStep.tsx` | Simplified, no "Next steps" |
| `frontend-react/src/components/agents/main/AgentsMain.tsx` | Update banner |
| `frontend-react/src/components/agents/main/AgentCard.tsx` | RuntimeSelector labels + hide no-model msg |

## Out of Scope

- Animation/transitions between steps (future)
- Changes to onboarding logic or Rust backend
- PresetCard component (style unchanged)
