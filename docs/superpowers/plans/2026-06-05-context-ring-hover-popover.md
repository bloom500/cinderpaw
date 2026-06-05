# Context Ring Hover Popover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native `title` tooltip on `ContextRing` with a rich `HoverCard` popover showing model name, window size, used/free tokens, message count, and estimated remaining messages.

**Architecture:** Install shadcn `hover-card` component, extract a pure `estimateRemaining` helper into `contextWindow.ts` (tested in isolation), then rewrite `ContextRing.tsx` to wrap the SVG in a `HoverCardTrigger` and render a compact detail card in `HoverCardContent`.

**Tech Stack:** React, shadcn/ui (Radix `HoverCard`), Vitest, Tailwind CSS

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `frontend-react/src/components/ui/hover-card.tsx` | shadcn primitive (auto-generated) |
| Modify | `frontend-react/src/lib/contextWindow.ts` | Add `estimateRemaining` helper |
| Create | `frontend-react/src/lib/__tests__/contextWindow.test.ts` | Unit tests for `estimateRemaining` + existing exports |
| Modify | `frontend-react/src/components/chat/ContextRing.tsx` | Wrap SVG in HoverCard, render detail rows |

---

## Task 1: Install hover-card shadcn component

**Files:**
- Create: `frontend-react/src/components/ui/hover-card.tsx`

- [ ] **Step 1: Install the shadcn hover-card primitive**

```bash
cd frontend-react
npx shadcn@latest add hover-card
```

Expected output: `✔ Done.` — creates `src/components/ui/hover-card.tsx`.

- [ ] **Step 2: Verify the file exists and exports the three named exports**

```bash
grep -n "export" src/components/ui/hover-card.tsx
```

Expected output should include `HoverCard`, `HoverCardTrigger`, `HoverCardContent`.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/hover-card.tsx
git commit -m "feat(ui): add shadcn hover-card primitive"
```

---

## Task 2: Add `estimateRemaining` to contextWindow.ts (TDD)

**Files:**
- Create: `frontend-react/src/lib/__tests__/contextWindow.test.ts`
- Modify: `frontend-react/src/lib/contextWindow.ts`

- [ ] **Step 1: Write failing tests**

Create `frontend-react/src/lib/__tests__/contextWindow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  contextWindowFor,
  estimateTokens,
  estimateRemaining,
  LOCAL_DEFAULT_CONTEXT,
  CLOUD_DEFAULT_CONTEXT,
} from '../contextWindow';

describe('contextWindowFor', () => {
  it('returns 1_000_000 for minimax', () => {
    expect(contextWindowFor('minimax-text-01', false)).toBe(1_000_000);
  });
  it('returns 200_000 for claude', () => {
    expect(contextWindowFor('claude-3-opus', false)).toBe(200_000);
  });
  it('returns LOCAL_DEFAULT_CONTEXT for unknown local model', () => {
    expect(contextWindowFor('unknown-gguf', true)).toBe(LOCAL_DEFAULT_CONTEXT);
  });
  it('returns CLOUD_DEFAULT_CONTEXT for unknown cloud model', () => {
    expect(contextWindowFor(undefined, false)).toBe(CLOUD_DEFAULT_CONTEXT);
  });
});

describe('estimateTokens', () => {
  it('returns ceil(length / 4)', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('estimateRemaining', () => {
  it('calculates freeTokens as window - used', () => {
    const r = estimateRemaining(8192, 1000, 5);
    expect(r.freeTokens).toBe(7192);
  });

  it('calculates msgsRemaining using avg tokens per message', () => {
    // avg = 1000 / 5 = 200 tokens/msg, free = 7192, msgs = floor(7192/200) = 35
    const r = estimateRemaining(8192, 1000, 5);
    expect(r.msgsRemaining).toBe(35);
    expect(r.showAsTokens).toBe(false);
  });

  it('uses fallback of 200 tokens/msg when messageCount is 0', () => {
    // free = 8192, avg = 200 (fallback), msgs = floor(8192/200) = 40
    const r = estimateRemaining(8192, 0, 0);
    expect(r.msgsRemaining).toBe(40);
    expect(r.showAsTokens).toBe(false);
  });

  it('sets showAsTokens when less than 1 message remains', () => {
    // avg = 500/1 = 500, free = 8192 - 8100 = 92, msgs = floor(92/500) = 0
    const r = estimateRemaining(8192, 8100, 1);
    expect(r.msgsRemaining).toBe(0);
    expect(r.showAsTokens).toBe(true);
    expect(r.freeTokens).toBe(92);
  });

  it('clamps freeTokens to 0 when over limit', () => {
    const r = estimateRemaining(1000, 1500, 10);
    expect(r.freeTokens).toBe(0);
    expect(r.msgsRemaining).toBe(0);
    expect(r.showAsTokens).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend-react
npx vitest run src/lib/__tests__/contextWindow.test.ts
```

Expected: FAIL — `estimateRemaining is not a function` (or similar import error).

- [ ] **Step 3: Add `estimateRemaining` to contextWindow.ts**

Open `frontend-react/src/lib/contextWindow.ts` and append after the existing `estimateTokens` function:

```ts
export interface RemainingEstimate {
  freeTokens: number;
  msgsRemaining: number;
  showAsTokens: boolean;
}

/** Fallback avg tokens per message when there are no messages yet. */
const FALLBACK_AVG_TOKENS_PER_MSG = 200;

export function estimateRemaining(
  windowTokens: number,
  usedTokens: number,
  messageCount: number,
): RemainingEstimate {
  const freeTokens = Math.max(0, windowTokens - usedTokens);
  const avgPerMsg = messageCount > 0 ? usedTokens / messageCount : FALLBACK_AVG_TOKENS_PER_MSG;
  const msgsRemaining = Math.floor(freeTokens / avgPerMsg);
  return { freeTokens, msgsRemaining, showAsTokens: msgsRemaining < 1 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/__tests__/contextWindow.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/contextWindow.ts src/lib/__tests__/contextWindow.test.ts
git commit -m "feat(lib): add estimateRemaining helper to contextWindow"
```

---

## Task 3: Rewrite ContextRing with HoverCard

**Files:**
- Modify: `frontend-react/src/components/chat/ContextRing.tsx`

- [ ] **Step 1: Replace the file contents**

Replace `frontend-react/src/components/chat/ContextRing.tsx` with:

```tsx
import { useMemo } from 'react';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { useModel } from '@/stores/model';
import { useFeralStore } from '@/stores/feral';
import { contextWindowFor, estimateTokens, estimateRemaining } from '@/lib/contextWindow';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Separator } from '@/components/ui/separator';

const R = 8;
const C = 2 * Math.PI * R;

export function ContextRing() {
  const messages    = useChat((s) => s.messages);
  const isAgentMode = useUI((s) => s.inputMode) === 'agent';
  const loaded      = useModel((s) => s.loaded);
  const cloudModel  = useModel((s) => s.cloudModel);
  const feralConfig = useFeralStore((s) => s.modelConfig);

  const { used, window, pct, modelName, remaining } = useMemo(() => {
    const used = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

    let model: string | undefined;
    let isLocal: boolean;
    if (isAgentMode) {
      model = feralConfig?.model;
      isLocal = feralConfig?.provider === 'openai_compatible' || feralConfig?.provider === 'ollama';
    } else if (cloudModel) {
      model = cloudModel.modelId;
      isLocal = false;
    } else {
      model = loaded?.name;
      isLocal = true;
    }

    const window = contextWindowFor(model, isLocal);
    const pct = Math.min(1, used / window);
    const remaining = estimateRemaining(window, used, messages.length);
    return { used, window, pct, modelName: model ?? 'Unknown', remaining };
  }, [messages, isAgentMode, feralConfig, cloudModel, loaded]);

  if (messages.length === 0) return null;

  const ringColor =
    pct >= 0.9 ? 'var(--c-red, #ef4444)'
    : pct >= 0.75 ? '#f59e0b'
    : 'var(--color-text-muted, #888)';

  const statusColor =
    pct >= 0.9 ? 'text-red-400'
    : pct >= 0.75 ? 'text-amber-400'
    : 'text-text-muted';

  const pctLabel = pct < 0.01 ? '<1' : Math.round(pct * 100).toString();

  const remainingLabel = remaining.showAsTokens
    ? `~${remaining.freeTokens.toLocaleString()} tokens left`
    : `~${remaining.msgsRemaining} msgs left`;

  const statusLabel = pct >= 0.9
    ? `Approaching limit · ${remainingLabel}`
    : `${pctLabel}% · ${remainingLabel}`;

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <div
          className="flex items-center shrink-0 text-text-muted cursor-default"
          aria-label={`Context: ~${used.toLocaleString()} / ${window.toLocaleString()} tokens (${pctLabel}%)`}
        >
          <svg width="18" height="18" viewBox="0 0 20 20" className="shrink-0">
            <circle cx="10" cy="10" r={R} fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
            <circle
              cx="10" cy="10" r={R}
              fill="none"
              stroke={ringColor}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - pct)}
              transform="rotate(-90 10 10)"
              style={{ transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease' }}
            />
          </svg>
        </div>
      </HoverCardTrigger>

      <HoverCardContent side="top" align="end" className="w-52 p-3 text-xs">
        <p className="text-text-muted font-medium mb-2">Context Window</p>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <span className="text-text-muted">Model</span>
          <span className="text-text-primary truncate text-right">{modelName}</span>

          <span className="text-text-muted">Window</span>
          <span className="text-text-primary text-right">{window.toLocaleString()} tokens</span>

          <span className="text-text-muted">Used</span>
          <span className="text-text-primary text-right">~{used.toLocaleString()} tokens</span>

          <span className="text-text-muted">Free</span>
          <span className="text-text-primary text-right">~{remaining.freeTokens.toLocaleString()} tokens</span>

          <span className="text-text-muted">Messages</span>
          <span className="text-text-primary text-right">{messages.length}</span>
        </div>

        <Separator className="my-2" />

        <p className={statusColor}>{statusLabel}</p>
      </HoverCardContent>
    </HoverCard>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend-react
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run the full test suite**

```bash
npx vitest run
```

Expected: all existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/ContextRing.tsx
git commit -m "feat(ui): context ring hover popover with token and message details"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** model name ✓, window size ✓, used tokens ✓, free tokens ✓, message count ✓, remaining msgs estimate ✓, color coding ✓, side="top" align="end" ✓, HoverCard approach ✓, native `title` removed ✓
- [x] **No placeholders:** all code is complete
- [x] **Type consistency:** `estimateRemaining` returns `RemainingEstimate` — used correctly in ContextRing as `remaining.freeTokens`, `remaining.msgsRemaining`, `remaining.showAsTokens`
- [x] **Import paths:** `@/components/ui/hover-card` and `@/components/ui/separator` — `separator.tsx` already exists in the project
