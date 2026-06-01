# Agents Tab Onboarding — Design Spec
**Date:** 2026-06-01  
**Scope:** Phase 3 — Onboarding shell + real CRUD wiring. No run_agent, no OpenClaw routing.

---

## Goal

Replace the `/agents` stub with a guided, one-question-at-a-time onboarding flow that creates the user's first agent using real backend persistence. Beginners land here with no prior context; every screen must be self-explanatory.

---

## What exists (not changing)

| Layer | Status |
|-------|--------|
| `src-tauri/src/agents.rs` | Complete: `AgentConfig`, CRUD, presets, `run_agent` loop |
| `src-tauri/src/lib.rs` | Commands registered: `save_agent`, `get_agents`, `delete_agent`, `get_agent_presets` |
| `frontend-react/src/lib/tauri/index.ts` `raw.*` | `saveAgent`, `getAgents`, `deleteAgent`, `getAgentPresets` wired — not in public facade |

---

## Onboarding flow

Five screens. Each occupies the full content area. One focused question or action per screen.

### Screen 1 — Welcome
**Message:** "Agents are AI helpers that can search the web, read files, run code, and more. Let's set up your first one — it takes about a minute."  
**Buttons:** Skip for now | Let's go →

### Screen 2 — Pick a starting point
**Message:** "What kind of tasks do you want help with?"  
**Content:** Cards loaded from `get_agent_presets`. Each card shows: preset name, short plain-language description, tool badges. Plus a "Start from scratch" option (blank name, no tools pre-selected).  
**Loading state:** Skeleton cards while fetch is in flight. Error state if fetch fails (retry button).  
**Buttons:** ← Back | Skip for now | Continue →  
**Constraint:** Continue is disabled until a selection is made.

### Screen 3 — Name your agent
**Message:** "What do you want to call it?"  
**Content:** Single text input, prefilled with the chosen preset's name (empty for scratch).  
**Buttons:** ← Back | Skip for now | Continue →  
**Constraint:** Continue disabled when input is empty or whitespace-only.

### Screen 4 — Review
**Message:** "Here's what your agent will look like."  
**Content:** Summary card — name, preset type ("Custom" if scratch), tools listed with one-line plain descriptions. Static note: "You'll need a local model loaded before you can run this agent. Load one in the Models tab."  
**Save behaviour:** Clicking "Save & finish" calls `save_agent`. Button shows spinner + "Saving…" while in flight. On success: advance to Done. On failure: show inline error message below the button ("Couldn't save your agent — please try again."), stay on this screen.  
**Buttons:** ← Back | Save & finish →

### Screen 5 — Done
**Message:** "Your agent is ready." Echo the name back. "Open the Models tab to load a model, then come back here to run it."  
**Buttons:** View my agents

---

## Skip / dismiss behaviour

"Skip for now" at any step sets `localStorage.setItem('feral_agents_onboarding', 'dismissed')` and renders `AgentsMain`.  
`AgentsMain` shows an empty state with a "Create your first agent" prompt that re-launches the onboarding (clears the localStorage key and renders `AgentsOnboarding`).

On successful save: `localStorage.setItem('feral_agents_onboarding', 'completed')`.

`AgentsPage` on mount:
- key missing → show `AgentsOnboarding` (first-ever visit)
- key `'dismissed'` → show `AgentsMain` (user skipped; shown empty state with "Create your first agent" button that clears the key and re-renders `AgentsOnboarding`)
- key `'completed'` → show `AgentsMain`

> `localStorage` is used only for this UI flag. Agent data lives in `~/.feral/agents/` via Tauri.

---

## State shape

All state lives inside `AgentsOnboarding`. No Zustand store needed for Phase 3.

```typescript
type OnboardingStep = 'welcome' | 'pick_preset' | 'name_agent' | 'review' | 'done';

// Step history enables Back
const [step, setStep]           = useState<OnboardingStep>('welcome');
const [history, setHistory]     = useState<OnboardingStep[]>([]);

// User choices
const [draft, setDraft]         = useState<{ presetId: string | null; name: string }>
                                           ({ presetId: null, name: '' });

// Async state
const [presets, setPresets]     = useState<AgentConfig[]>([]);
const [presetsLoading, setPresetsLoading] = useState(false);
const [presetsError, setPresetsError]     = useState<string | null>(null);
const [saving, setSaving]       = useState(false);
const [saveError, setSaveError] = useState<string | null>(null);
```

Back: `setStep(history[history.length - 1]); setHistory(h => h.slice(0, -1))`.  
Advance: push current step onto history, set next step.

---

## Component structure

```
frontend-react/src/pages/AgentsPage.tsx
frontend-react/src/components/agents/
  onboarding/
    AgentsOnboarding.tsx     ← state machine, fetches presets, calls save_agent
    OnboardingShell.tsx      ← layout: progress dots, Back/Skip/Continue footer
    PresetCard.tsx           ← selectable card for PickPresetStep
    steps/
      WelcomeStep.tsx
      PickPresetStep.tsx
      NameAgentStep.tsx
      ReviewStep.tsx
      DoneStep.tsx
  main/
    AgentsMain.tsx           ← agent list (calls get_agents), empty state
    AgentCard.tsx            ← name + tool badges + delete button (no run yet)
```

`OnboardingShell` renders `children` (step content) and accepts props:
```typescript
interface ShellProps {
  step: number;        // 1-5 for progress dots
  totalSteps: number;  // 5
  onBack?: () => void; // undefined on step 1 → hides Back
  onSkip?: () => void; // undefined on Done → hides Skip
  onContinue?: () => void;     // undefined → hides Continue
  continueLabel?: string;      // "Continue →" default, "Save & finish →" on review
  continueDisabled?: boolean;
  continueBusy?: boolean;
}
```

---

## Tauri facade additions

In `frontend-react/src/lib/tauri/index.ts`, expose under `tauri.agents`:

```typescript
tauri.agents.getPresets(): Promise<AgentConfig[]>
tauri.agents.save(cfg: AgentConfig): Promise<void>
tauri.agents.getAll(): Promise<AgentConfig[]>
tauri.agents.delete(id: string): Promise<void>
```

Add `AgentConfig` TypeScript interface mirroring the Rust struct:
```typescript
export interface AgentConfig {
  id: string;
  name: string;
  system_prompt: string;
  model_id: string;
  tools: string[];
  params?: Record<string, unknown>;
}
```

---

## Router + sidebar changes

| File | Change |
|------|--------|
| `frontend-react/src/router.tsx` | `/agents` → `<AgentsPage />` |
| `frontend-react/src/components/layout/Sidebar.tsx` | Remove `disabled: true` from Agents item |

---

## What is explicitly deferred

- `run_agent` and agent execution UI
- Live model-loaded check on the review screen (static text note for now)
- Autonomous welcome message
- OpenClaw chat routing
- Agent editing (edit form post-creation)
- Tool selector for "Start from scratch" path (scratch agents save with empty tools for now)

---

## Verification checklist

- [ ] `npx tsc --noEmit` — no type errors
- [ ] `npx vitest run` — all existing tests pass; new tests for OnboardingShell navigation
- [ ] `cargo check` — no Rust issues (no Rust changes expected)
- [ ] Sidebar Agents item is enabled and navigable
- [ ] Preset cards load from real backend
- [ ] Save & finish calls `save_agent` and advances to Done on success
- [ ] Save & finish shows inline error and stays on Review on failure
- [ ] Skip for now dismisses onboarding and shows AgentsMain
- [ ] Back button returns to the previous step correctly
