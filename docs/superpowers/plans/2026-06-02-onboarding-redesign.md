# Onboarding Redesign + OpenClaw Native UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Agents onboarding to a minimalist centered Apple/iOS style, and remove all "experimental" framing from OpenClaw to make it feel native.

**Architecture:** Pure frontend changes — no logic, no Rust, no new files. `OnboardingShell` gets a progress-line header and centered flow layout. Each step gets centered headings. `AgentCard` and `AgentsMain` get copy + label fixes. All existing tests must pass; one AgentCard test needs a label update.

**Tech Stack:** React, TypeScript, Tailwind CSS

---

## File Map

| File | Change |
|------|--------|
| `frontend-react/src/components/agents/onboarding/OnboardingShell.tsx` | Rewrite: progress line, centered layout, no border footer |
| `frontend-react/src/components/agents/onboarding/steps/WelcomeStep.tsx` | Center icon, heading, bullets |
| `frontend-react/src/components/agents/onboarding/steps/PickPresetStep.tsx` | Center header text only |
| `frontend-react/src/components/agents/onboarding/steps/NameAgentStep.tsx` | Center heading, larger input |
| `frontend-react/src/components/agents/onboarding/steps/ReviewStep.tsx` | Center heading, remove "load a model" info box |
| `frontend-react/src/components/agents/onboarding/steps/DoneStep.tsx` | Remove "Next steps" list, simplified layout |
| `frontend-react/src/components/agents/main/AgentsMain.tsx` | Update banner copy |
| `frontend-react/src/components/agents/main/AgentCard.tsx` | Rename "OpenClaw (test)" → "OpenClaw", remove experimental label, hide no-model msg for openclaw agents |
| `frontend-react/src/components/agents/main/__tests__/AgentCard.test.tsx` | Update test selectors to match renamed label |

---

## Task 1: OnboardingShell — progress line + centered layout

**Files:**
- Modify: `frontend-react/src/components/agents/onboarding/OnboardingShell.tsx`

### Context

Current shell: dots at top, scrollable content area, footer with `border-t` and Back/Skip/Continue laid out left-right.

New shell: 2px progress line at top (fills % per step), content vertically+horizontally centered with `max-w-sm`, CTA button full-width below content, Back/Skip as small centered text links. No border anywhere.

`step` prop is 1-based (1=Welcome, 2=PickPreset, 3=Name, 4=Review; Done renders outside the shell). Show step label "Step N of 3" for steps 2–4 (skip Welcome which is step 1). Formula: `step > 1 → label "Step {step-1} of {totalSteps-2}"`.

- [ ] **Step 1.1: Replace the full file content**

```tsx
import { cn } from '@/lib/utils';

interface ShellProps {
  step: number;
  totalSteps: number;
  children: React.ReactNode;
  onBack?: () => void;
  onSkip?: () => void;
  onContinue?: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  continueBusy?: boolean;
}

export function OnboardingShell({
  step, totalSteps, children,
  onBack, onSkip, onContinue,
  continueLabel = 'Continue →',
  continueDisabled = false,
  continueBusy = false,
}: ShellProps) {
  const pct = Math.round((step / totalSteps) * 100);
  const showStepLabel = step > 1 && step < totalSteps;

  return (
    <div className="flex flex-col h-full">
      {/* Progress line */}
      <div className="h-0.5 w-full bg-bg-hover shrink-0">
        <div
          className="h-full bg-brand transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Content — vertically + horizontally centered */}
      <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6 py-6">
        <div className="w-full max-w-sm">
          {showStepLabel && (
            <p className="text-xs font-semibold text-brand uppercase tracking-widest text-center mb-6">
              Step {step - 1} of {totalSteps - 2}
            </p>
          )}
          {children}
        </div>
      </div>

      {/* CTA — no border, part of flow */}
      <div className="px-6 pb-8 flex flex-col items-center gap-3 shrink-0 w-full max-w-sm mx-auto">
        {onContinue && (
          <button
            type="button"
            onClick={onContinue}
            disabled={continueDisabled || continueBusy}
            className="w-full py-2.5 rounded-xl bg-brand text-white text-sm font-semibold hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {continueBusy ? 'Saving…' : continueLabel}
          </button>
        )}
        {(onBack || onSkip) && (
          <div className={cn('flex items-center text-xs text-text-muted', onBack && onSkip ? 'gap-4' : '')}>
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="hover:text-text-secondary transition-colors"
              >
                ← Back
              </button>
            )}
            {onSkip && (
              <button
                type="button"
                onClick={onSkip}
                className="hover:text-text-secondary transition-colors"
              >
                Skip for now
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 1.2: Verify it compiles**

```
cd d:\FeralLocalAI\frontend-react && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 1.3: Commit**

```
cd d:\FeralLocalAI && git add frontend-react/src/components/agents/onboarding/OnboardingShell.tsx && git commit -m "feat(onboarding): replace dot-progress shell with centered progress-line layout"
```

---

## Task 2: WelcomeStep + PickPresetStep — centered

**Files:**
- Modify: `frontend-react/src/components/agents/onboarding/steps/WelcomeStep.tsx`
- Modify: `frontend-react/src/components/agents/onboarding/steps/PickPresetStep.tsx`

- [ ] **Step 2.1: Replace WelcomeStep.tsx**

```tsx
import { Bot, Search, FileText, Code, Globe } from 'lucide-react';

export function WelcomeStep() {
  return (
    <div className="space-y-8 text-center">
      <div className="flex justify-center">
        <div className="w-14 h-14 rounded-2xl bg-brand/10 flex items-center justify-center">
          <Bot size={28} className="text-brand" />
        </div>
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-text-primary tracking-tight">Meet Agents</h1>
        <p className="text-sm text-text-muted leading-relaxed">
          AI helpers you configure once and run anytime —<br />on your device, privately.
        </p>
      </div>

      <div className="space-y-3 text-left">
        {[
          { icon: Search,   text: 'Search the web and summarise findings' },
          { icon: FileText, text: 'Read and write files on your computer' },
          { icon: Code,     text: 'Write and run code snippets' },
          { icon: Globe,    text: 'Fetch and process data from web pages' },
        ].map(({ icon: Icon, text }) => (
          <div key={text} className="flex items-center gap-3 text-sm text-text-secondary">
            <Icon size={13} className="shrink-0 text-text-muted" />
            <span>{text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2.2: Replace PickPresetStep.tsx**

```tsx
import { AlertCircle, RefreshCw } from 'lucide-react';
import type { AgentConfig } from '@/lib/tauri';
import { PresetCard } from '../PresetCard';

interface Props {
  presets: AgentConfig[];
  loading: boolean;
  error: string | null;
  selected: AgentConfig | null | 'scratch';
  onSelect: (v: AgentConfig | 'scratch') => void;
  onRetry: () => void;
}

export function PickPresetStep({ presets, loading, error, selected, onSelect, onRetry }: Props) {
  return (
    <div className="space-y-6">
      <div className="text-center space-y-1">
        <h2 className="text-2xl font-bold text-text-primary tracking-tight">
          What will your agent do?
        </h2>
        <p className="text-sm text-text-muted">Pick a template or start from scratch.</p>
      </div>

      {loading && (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 rounded-lg bg-bg-hover animate-pulse" />
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 flex items-start gap-3">
          <AlertCircle size={14} className="text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p className="text-sm text-red-400">Couldn't load templates.</p>
            <button
              type="button"
              onClick={onRetry}
              className="text-xs text-text-muted hover:text-text-secondary inline-flex items-center gap-1"
            >
              <RefreshCw size={11} /> Try again
            </button>
          </div>
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-2">
          {presets.map((p) => (
            <PresetCard
              key={p.id ?? p.name}
              preset={p}
              selected={selected !== 'scratch' && selected?.name === p.name}
              onSelect={() => onSelect(p)}
            />
          ))}
          <PresetCard
            preset="scratch"
            selected={selected === 'scratch'}
            onSelect={() => onSelect('scratch')}
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2.3: Verify it compiles**

```
cd d:\FeralLocalAI\frontend-react && npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 2.4: Commit**

```
cd d:\FeralLocalAI && git add frontend-react/src/components/agents/onboarding/steps/WelcomeStep.tsx frontend-react/src/components/agents/onboarding/steps/PickPresetStep.tsx && git commit -m "feat(onboarding): center Welcome and PickPreset steps"
```

---

## Task 3: NameAgentStep + ReviewStep — centered

**Files:**
- Modify: `frontend-react/src/components/agents/onboarding/steps/NameAgentStep.tsx`
- Modify: `frontend-react/src/components/agents/onboarding/steps/ReviewStep.tsx`

- [ ] **Step 3.1: Replace NameAgentStep.tsx**

```tsx
import { useRef, useEffect } from 'react';

interface Props {
  name: string;
  onChange: (name: string) => void;
  onSubmit: () => void;
}

export function NameAgentStep({ name, onChange, onSubmit }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="space-y-6 text-center">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-text-primary tracking-tight">
          Give it a name
        </h2>
        <p className="text-sm text-text-muted">You can always rename it later.</p>
      </div>

      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSubmit(); }}
        placeholder="e.g. My Research Assistant"
        className="w-full rounded-xl border border-bg-hover bg-bg-primary px-4 py-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-brand placeholder:text-text-muted text-center"
      />
    </div>
  );
}
```

- [ ] **Step 3.2: Replace ReviewStep.tsx**

```tsx
import { AlertCircle } from 'lucide-react';
import type { AgentConfig } from '@/lib/tauri';
import { TOOL_LABELS } from '../../agentUtils';

interface Props {
  name: string;
  preset: AgentConfig | 'scratch' | null;
  saveError: string | null;
}

export function ReviewStep({ name, preset, saveError }: Props) {
  const isScratch = !preset || preset === 'scratch';
  const tools: string[] = isScratch ? [] : (preset as AgentConfig).tools;
  const templateLabel = isScratch ? 'Custom' : (preset as AgentConfig).name;

  return (
    <div className="space-y-6 text-center">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-text-primary tracking-tight">Looks good?</h2>
        <p className="text-sm text-text-muted">Review before saving.</p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-surface p-4 space-y-3 text-left">
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-muted">Name</span>
          <span className="text-sm font-medium text-text-primary">{name}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-muted">Template</span>
          <span className="text-sm text-text-primary">{templateLabel}</span>
        </div>
        {tools.length > 0 && (
          <div className="flex items-start justify-between gap-4">
            <span className="text-xs text-text-muted shrink-0">Tools</span>
            <div className="space-y-0.5 text-right">
              {tools.map((t) => (
                <div key={t} className="text-xs text-text-secondary">
                  {TOOL_LABELS[t]?.label ?? t}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {saveError && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
          <AlertCircle size={13} className="text-red-400 shrink-0 mt-0.5" />
          <p className="text-sm text-red-400">Couldn't save your agent — please try again.</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3.3: Verify it compiles**

```
cd d:\FeralLocalAI\frontend-react && npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 3.4: Commit**

```
cd d:\FeralLocalAI && git add frontend-react/src/components/agents/onboarding/steps/NameAgentStep.tsx frontend-react/src/components/agents/onboarding/steps/ReviewStep.tsx && git commit -m "feat(onboarding): center NameAgent and Review steps; remove load-a-model hint"
```

---

## Task 4: DoneStep — simplified

**Files:**
- Modify: `frontend-react/src/components/agents/onboarding/steps/DoneStep.tsx`

### Context

Current DoneStep has a "Next steps" ordered list with "Go to Models…" and "Come back to Agents…". This was replaced earlier with a conditional `loadedModelName` block. Now simplify further: no list at all. Just the badge + a single sentence. The warmup logic and `loadedModelName` prop stay unchanged.

- [ ] **Step 4.1: Write the failing test**

Add to `frontend-react/src/components/agents/onboarding/steps/__tests__/DoneStep.test.tsx` at the end of the `describe` block:

```tsx
  it('never renders a numbered list of next steps', async () => {
    mockWarmup.mockResolvedValue({
      kind: 'error',
      response_text: null,
      error_message: null,
      endpoint_tried: null,
    } satisfies OpenClawTestMessageResult);

    render(<DoneStep agentName="My Agent" agentId="agent-abc" onViewAgents={vi.fn()} />);
    await Promise.resolve();
    expect(document.querySelector('ol')).toBeNull();
    expect(document.querySelector('li')).toBeNull();
  });
```

- [ ] **Step 4.2: Run to confirm it fails (or passes — check current state)**

```
cd d:\FeralLocalAI\frontend-react && npx vitest run src/components/agents/onboarding/steps/__tests__/DoneStep.test.tsx 2>&1 | tail -10
```

If it fails: good, proceed. If it passes already: the list was already removed, still proceed.

- [ ] **Step 4.3: Replace DoneStep.tsx**

```tsx
import { useEffect, useState } from 'react';
import { CheckCircle, Loader2 } from 'lucide-react';
import { tauri, type OpenClawTestMessageResult } from '@/lib/tauri';

type WarmupState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; result: OpenClawTestMessageResult };

interface Props {
  agentName: string;
  agentId?: string;
  loadedModelName?: string;
  onViewAgents: () => void;
}

export function DoneStep({ agentName, agentId, loadedModelName, onViewAgents }: Props) {
  const [warmup, setWarmup] = useState<WarmupState>({ phase: 'idle' });

  useEffect(() => {
    if (!agentId) return;
    const id = agentId;
    let cancelled = false;

    async function run() {
      setWarmup({ phase: 'running' });
      const result = await tauri.openclaw.warmupAgent(id);
      if (!cancelled) setWarmup({ phase: 'done', result });
    }

    void run();
    return () => { cancelled = true; };
  }, [agentId]);

  const badge = (() => {
    if (warmup.phase === 'running') {
      return (
        <div className="flex items-center justify-center gap-1.5 text-xs text-text-muted">
          <Loader2 size={12} className="animate-spin" />
          Connecting to OpenClaw…
        </div>
      );
    }
    if (warmup.phase === 'done') {
      const ok = warmup.result.kind === 'ok';
      return ok ? (
        <div className="flex items-center justify-center gap-1.5 text-xs text-green-400">
          <CheckCircle size={12} />
          OpenClaw ready
        </div>
      ) : (
        <div className="text-xs text-amber-400 text-center">
          OpenClaw not connected —{' '}
          <span className="text-text-muted">check Settings → OpenClaw.</span>
        </div>
      );
    }
    return null;
  })();

  return (
    <div className="space-y-8 text-center">
      <div className="flex justify-center">
        <div className="w-14 h-14 rounded-full bg-green-400/10 flex items-center justify-center">
          <CheckCircle size={28} className="text-green-400" />
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-text-primary tracking-tight">
          "{agentName}" is ready
        </h2>
        {loadedModelName ? (
          <p className="text-sm text-text-muted">
            Connected to <span className="text-text-secondary font-medium">{loadedModelName}</span>.
          </p>
        ) : (
          <p className="text-sm text-text-muted">
            Load a model in the Models tab to start running it.
          </p>
        )}
      </div>

      {badge}

      <button
        type="button"
        onClick={onViewAgents}
        className="w-full py-2.5 rounded-xl bg-brand text-white text-sm font-semibold hover:bg-brand/90 transition-colors"
      >
        Go to agents
      </button>
    </div>
  );
}
```

- [ ] **Step 4.4: Run DoneStep tests**

```
cd d:\FeralLocalAI\frontend-react && npx vitest run src/components/agents/onboarding/steps/__tests__/DoneStep.test.tsx 2>&1 | tail -10
```

Expected: all pass (including the new `no numbered list` test).

- [ ] **Step 4.5: Commit**

```
cd d:\FeralLocalAI && git add frontend-react/src/components/agents/onboarding/steps/DoneStep.tsx frontend-react/src/components/agents/onboarding/steps/__tests__/DoneStep.test.tsx && git commit -m "feat(onboarding): simplify DoneStep — centered checkmark, no next-steps list"
```

---

## Task 5: AgentsMain + AgentCard — OpenClaw native + fix tests

**Files:**
- Modify: `frontend-react/src/components/agents/main/AgentsMain.tsx`
- Modify: `frontend-react/src/components/agents/main/AgentCard.tsx`
- Modify: `frontend-react/src/components/agents/main/__tests__/AgentCard.test.tsx`

### Context

Three changes in `AgentCard.tsx`:
1. `RuntimeSelector` label: `"OpenClaw (test)"` → `"OpenClaw"`
2. Remove the `"OpenClaw-backed routing is experimental"` amber text in `RuntimeSelector`
3. Hide `"No model assigned — load a model in the Models tab to run this agent."` when `agent.preferred_runtime === 'openclaw'`

`AgentsMain.tsx`: replace the info banner text.

`AgentCard.test.tsx`: the `openOpenClawPanel` helper and one test use `name: /openclaw \(test\)/i` — update to `/openclaw/i` (without the `(test)` part). Also update the banner text assertion if present.

- [ ] **Step 5.1: Update `AgentsMain.tsx` banner**

Find this block in `AgentsMain.tsx`:
```tsx
        <p className="text-xs text-text-muted">
          These agents run on your <span className="text-text-secondary font-medium">local Feral model</span>{' '}
          by default. Open a card below and switch the runtime to{' '}
          <span className="text-text-secondary font-medium">OpenClaw (test)</span>{' '}
          to send one prompt through the local OpenClaw gateway.{' '}
          OpenClaw-backed routing is <span className="text-amber-400/90">experimental</span>{' '}
          and not used for normal execution.
        </p>
```

Replace with:
```tsx
        <p className="text-xs text-text-muted">
          These agents run through{' '}
          <span className="text-text-secondary font-medium">OpenClaw</span>{' '}
          on your local model. Open a card below to run an agent or test it directly.
        </p>
```

- [ ] **Step 5.2: Update `AgentCard.tsx` — three changes**

**Change 1:** In `RuntimeSelector`, find:
```tsx
        <RuntimeButton
          active={value === 'openclaw'}
          disabled={disabled}
          onClick={() => onChange('openclaw')}
          icon={<FlaskConical size={11} />}
          label="OpenClaw (test)"
        />
      </div>
      <span className="text-[10px] text-amber-400/80">
        OpenClaw-backed routing is experimental
      </span>
```

Replace with:
```tsx
        <RuntimeButton
          active={value === 'openclaw'}
          disabled={disabled}
          onClick={() => onChange('openclaw')}
          icon={<FlaskConical size={11} />}
          label="OpenClaw"
        />
      </div>
```

**Change 2:** In `AgentCard`, find:
```tsx
          {!agent.model_id && (
            <p className="text-[11px] text-text-muted">
              No model assigned — load a model in the Models tab to run this agent.
            </p>
          )}
```

Replace with:
```tsx
          {!agent.model_id && agent.preferred_runtime !== 'openclaw' && (
            <p className="text-[11px] text-text-muted">
              No model assigned — load a model in the Models tab to run this agent.
            </p>
          )}
```

- [ ] **Step 5.3: Update `AgentCard.test.tsx` — fix broken selector**

Find all occurrences of `/openclaw \(test\)/i` in the test file and replace with `/^openclaw$/i`:

The `openOpenClawPanel` helper:
```tsx
  async function openOpenClawPanel() {
    await userEvent.click(screen.getByRole('button', { name: /test panel for/i }));
    await userEvent.click(screen.getByRole('button', { name: /^openclaw$/i }));
  }
```

Also find the test that directly checks for the button label:
```tsx
    expect(screen.getByRole('button', { name: /^openclaw$/i })).toBeInTheDocument();
```

And update the "switching to OpenClaw" test assertion:
```tsx
    expect(screen.queryByText(/openclaw-backed routing is experimental/i)).not.toBeInTheDocument();
```
→ Remove or replace this assertion (the text no longer exists). If the test asserts this text IS present, remove the assertion entirely. If it asserts it's NOT present, it stays correct.

- [ ] **Step 5.4: Run AgentCard tests**

```
cd d:\FeralLocalAI\frontend-react && npx vitest run src/components/agents/main/__tests__/AgentCard.test.tsx 2>&1 | tail -15
```

Expected: all pass.

- [ ] **Step 5.5: Verify TypeScript**

```
cd d:\FeralLocalAI\frontend-react && npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 5.6: Commit**

```
cd d:\FeralLocalAI && git add frontend-react/src/components/agents/main/AgentsMain.tsx frontend-react/src/components/agents/main/AgentCard.tsx frontend-react/src/components/agents/main/__tests__/AgentCard.test.tsx && git commit -m "feat(agents): openclaw native UI — remove experimental framing, fix labels, hide no-model msg"
```

---

## Task 6: Full verification pass

- [ ] **Step 6.1: Run all frontend tests**

```
cd d:\FeralLocalAI\frontend-react && npx vitest run 2>&1 | tail -8
```

Expected: all 14 test files pass, 0 failures.

- [ ] **Step 6.2: TypeScript check**

```
cd d:\FeralLocalAI\frontend-react && npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 6.3: Rust tests (unchanged — just confirm nothing broke)**

```
cd d:\FeralLocalAI\src-tauri && cargo test 2>&1 | grep "test result" | head -5
```

Expected: all pass.

- [ ] **Step 6.4: Final commit if any fixups needed**

Only commit if steps above revealed issues requiring fixes.
