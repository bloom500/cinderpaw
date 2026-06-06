# Feral Mascot (8-bit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an animated 8-bit mascot that perches on the top edge of the chat typing bar and reacts to interaction state (idle / typing / thinking / calling / done).

**Architecture:** Three isolated units under `frontend-react/src/components/chat/mascot/`: pure frame data (`frames.ts`), a pure state-derivation hook (`useMascotState.ts`), and a `<canvas>` renderer (`FeralMascot.tsx`). `ChatInput.tsx` owns the hook (it has `isUserTyping`) and mounts the renderer perched on its rounded container. All pixel art is hand-authored data — no external assets.

**Tech Stack:** React + TypeScript, Vitest + @testing-library/react (jsdom), HTML5 Canvas (nearest-neighbor).

**Reference (spec):** `docs/superpowers/specs/2026-06-06-feral-mascot-8bit-design.md`

---

## File Structure

- Create: `frontend-react/src/components/chat/mascot/frames.ts` — palette, types, `BASE` idle frame, `withRows` helper, `FRAMES` per state.
- Create: `frontend-react/src/components/chat/mascot/__tests__/frames.test.ts` — frame invariants.
- Create: `frontend-react/src/components/chat/mascot/useMascotState.ts` — pure hook.
- Create: `frontend-react/src/components/chat/mascot/__tests__/useMascotState.test.ts` — mapping + transient `done`.
- Create: `frontend-react/src/components/chat/mascot/FeralMascot.tsx` — canvas renderer + bob + reduced-motion.
- Modify: `frontend-react/src/components/chat/ChatInput.tsx` — add `relative` to the container, compute mascot state, mount `<FeralMascot>`.

Each frame is a tuple of exactly 16 strings, each exactly 16 chars. Palette chars: `.`=transparent, `k`=fur, `o`=orange, `w`=white, `r`=red.

---

## Task 1: Frame data (`frames.ts`)

**Files:**
- Create: `frontend-react/src/components/chat/mascot/frames.ts`
- Test: `frontend-react/src/components/chat/mascot/__tests__/frames.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend-react/src/components/chat/mascot/__tests__/frames.test.ts
import { describe, it, expect } from 'vitest';
import { FRAMES, FRAME_W, FRAME_H, PALETTE, type MascotState } from '../frames';

const STATES: MascotState[] = ['idle', 'typing', 'thinking', 'calling', 'done'];

describe('mascot frames', () => {
  it('defines at least one frame for every state', () => {
    for (const s of STATES) {
      expect(FRAMES[s].length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every frame is FRAME_H rows of FRAME_W chars', () => {
    for (const s of STATES) {
      for (const frame of FRAMES[s]) {
        expect(frame).toHaveLength(FRAME_H);
        for (const row of frame) {
          expect(row).toHaveLength(FRAME_W);
        }
      }
    }
  });

  it('every pixel char is a known palette key', () => {
    const keys = new Set(Object.keys(PALETTE));
    for (const s of STATES) {
      for (const frame of FRAMES[s]) {
        for (const row of frame) {
          for (const ch of row) {
            expect(keys.has(ch)).toBe(true);
          }
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend-react && npx vitest run src/components/chat/mascot/__tests__/frames.test.ts`
Expected: FAIL — cannot resolve `../frames`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend-react/src/components/chat/mascot/frames.ts

export type MascotState = 'idle' | 'typing' | 'thinking' | 'calling' | 'done';

export const FRAME_W = 16;
export const FRAME_H = 16;

/**
 * Mascot palette. Orange is a vivid toy-orange (matches the reference figure),
 * intentionally brighter than the muted brand `--brand` (#C4843A) so it reads at
 * 16px. Swap MASCOT_ORANGE to '#C4843A' if strict brand alignment is preferred.
 * `null` = transparent (pixel skipped when drawing).
 */
const MASCOT_ORANGE = '#F57A1F';
export const PALETTE: Record<string, string | null> = {
  '.': null,
  k: '#1c1c1e', // fur (near-black)
  o: MASCOT_ORANGE,
  w: '#ffffff', // eye highlights, fangs
  r: '#c0392b', // mouth interior
};

export type Frame = string[]; // FRAME_H strings, each FRAME_W chars

/** Idle, eyes-open, mouth smiling. The canonical silhouette all states derive from. */
const BASE: Frame = [
  '...o........o...', // 0  horn tips
  '..oo..kkkk..oo..', // 1  horns + fur crown
  '..ookkkkkkkkoo..', // 2  horns base + fur
  '.kkkkkkkkkkkkkk.', // 3  fur head
  '.kkooooooooookk.', // 4  face top
  '.kkookkookkookk.', // 5  eyes (solid)
  '.kkookwoowkookk.', // 6  eyes + white highlights
  '.kkooowrrwoookk.', // 7  mouth (fangs + red)
  'kkkooooooooookkk', // 8  chin
  'kkkkkooooookkkkk', // 9  body + belly top
  'kkkkooooooookkkk', // 10 belly
  'kkkkkooooookkkkk', // 11 belly
  'kkkkkkooookkkkkk', // 12 belly bottom
  '.kkkkkkkkkkkkkk.', // 13 lower body
  '....kkk..kkk....', // 14 legs
  '....kk....kk....', // 15 feet
];

/** Return a copy of `base` with specific row indices replaced. */
function withRows(base: Frame, overrides: Record<number, string>): Frame {
  return base.map((row, i) => overrides[i] ?? row);
}

// Idle blink: eyes become a flat line, highlights gone.
const IDLE_BLINK = withRows(BASE, {
  5: '.kkooooooooookk.',
  6: '.kkookkookkookk.',
});

// Typing: looks down at the cursor — highlights drop to the lower eye row.
const TYPING = withRows(BASE, {
  5: '.kkookwoowkookk.',
  6: '.kkookkookkookk.',
});

// Thinking: glances up — highlights rise to the upper eye row.
const THINK_UP = withRows(BASE, {
  5: '.kkookwoowkookk.',
  6: '.kkookkookkookk.',
});
const THINK_FWD = BASE;

// Calling: scans left/right (eye highlights shift outward, then inward).
const CALL_OUT = withRows(BASE, { 6: '.kkoowkookwookk.' });
const CALL_IN = BASE;

// Done: happy closed eyes + a wider open smile.
const DONE = withRows(BASE, {
  5: '.kkooooooooookk.',
  6: '.kkookkookkookk.',
  7: '.kkoowrrrrwookk.',
});

export const FRAMES: Record<MascotState, Frame[]> = {
  idle: [BASE, BASE, BASE, IDLE_BLINK], // blink ~1 in 4 frames
  typing: [TYPING],
  thinking: [THINK_UP, THINK_FWD],
  calling: [CALL_OUT, CALL_IN],
  done: [DONE, DONE],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend-react && npx vitest run src/components/chat/mascot/__tests__/frames.test.ts`
Expected: PASS (3 tests). If a row length assertion fails, the offending row is not exactly 16 chars — fix that row literal.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/components/chat/mascot/frames.ts frontend-react/src/components/chat/mascot/__tests__/frames.test.ts
git commit -m "feat(mascot): add 8-bit frame data + invariants test"
```

---

## Task 2: State derivation hook (`useMascotState.ts`)

Maps app state to a mascot state. `done` is transient: held ~1200ms after `streamStatus` becomes `'done'`, then falls back to `'idle'`.

**Files:**
- Create: `frontend-react/src/components/chat/mascot/useMascotState.ts`
- Test: `frontend-react/src/components/chat/mascot/__tests__/useMascotState.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend-react/src/components/chat/mascot/__tests__/useMascotState.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMascotState, DONE_HOLD_MS } from '../useMascotState';
import type { StreamStatus } from '@/stores/chat';
import type { AgentPhase } from '@/stores/chat';

function run(args: { streamStatus: StreamStatus; agentPhase: AgentPhase; isUserTyping: boolean }) {
  return renderHook((p: typeof args) => useMascotState(p), { initialProps: args });
}

describe('useMascotState', () => {
  it('idle when nothing is happening', () => {
    const { result } = run({ streamStatus: 'idle', agentPhase: null, isUserTyping: false });
    expect(result.current).toBe('idle');
  });

  it('typing when user has text and not streaming', () => {
    const { result } = run({ streamStatus: 'idle', agentPhase: null, isUserTyping: true });
    expect(result.current).toBe('typing');
  });

  it('thinking while streaming with no/thinking/processing phase', () => {
    for (const phase of [null, 'thinking', 'processing'] as AgentPhase[]) {
      const { result } = run({ streamStatus: 'streaming', agentPhase: phase, isUserTyping: false });
      expect(result.current).toBe('thinking');
    }
  });

  it('calling while streaming with calling phase', () => {
    const { result } = run({ streamStatus: 'streaming', agentPhase: 'calling', isUserTyping: false });
    expect(result.current).toBe('calling');
  });

  it('typing is ignored while streaming', () => {
    const { result } = run({ streamStatus: 'streaming', agentPhase: null, isUserTyping: true });
    expect(result.current).toBe('thinking');
  });

  describe('transient done', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('shows done then reverts to idle after DONE_HOLD_MS', () => {
      const { result, rerender } = run({ streamStatus: 'streaming', agentPhase: null, isUserTyping: false });
      rerender({ streamStatus: 'done', agentPhase: null, isUserTyping: false });
      expect(result.current).toBe('done');
      vi.advanceTimersByTime(DONE_HOLD_MS + 50);
      expect(result.current).toBe('idle');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend-react && npx vitest run src/components/chat/mascot/__tests__/useMascotState.test.ts`
Expected: FAIL — cannot resolve `../useMascotState`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend-react/src/components/chat/mascot/useMascotState.ts
import { useEffect, useRef, useState } from 'react';
import type { StreamStatus, AgentPhase } from '@/stores/chat';
import type { MascotState } from './frames';

export const DONE_HOLD_MS = 1200;

export interface MascotInputs {
  streamStatus: StreamStatus;
  agentPhase: AgentPhase;
  isUserTyping: boolean;
}

/** Pure-ish mapping from app state to mascot state, with a transient `done`. */
export function useMascotState({ streamStatus, agentPhase, isUserTyping }: MascotInputs): MascotState {
  const [doneActive, setDoneActive] = useState(false);
  const prevStatus = useRef<StreamStatus>(streamStatus);

  useEffect(() => {
    // Fire `done` only on the transition INTO 'done'.
    if (streamStatus === 'done' && prevStatus.current !== 'done') {
      setDoneActive(true);
      const id = setTimeout(() => setDoneActive(false), DONE_HOLD_MS);
      prevStatus.current = streamStatus;
      return () => clearTimeout(id);
    }
    // Any non-done status cancels a held `done`.
    if (streamStatus !== 'done') setDoneActive(false);
    prevStatus.current = streamStatus;
  }, [streamStatus]);

  if (doneActive) return 'done';
  if (streamStatus === 'streaming') {
    return agentPhase === 'calling' ? 'calling' : 'thinking';
  }
  if (isUserTyping) return 'typing';
  return 'idle';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend-react && npx vitest run src/components/chat/mascot/__tests__/useMascotState.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/components/chat/mascot/useMascotState.ts frontend-react/src/components/chat/mascot/__tests__/useMascotState.test.ts
git commit -m "feat(mascot): add state-derivation hook with transient done"
```

---

## Task 3: Canvas renderer (`FeralMascot.tsx`)

Draws the active state's frames nearest-neighbor, advancing every ~150ms, with a subtle vertical bob. Respects `prefers-reduced-motion` (single static frame, no bob, no interval).

**Files:**
- Create: `frontend-react/src/components/chat/mascot/FeralMascot.tsx`

- [ ] **Step 1: Write the implementation**

```tsx
// frontend-react/src/components/chat/mascot/FeralMascot.tsx
import { useEffect, useRef, useState } from 'react';
import { FRAMES, PALETTE, FRAME_W, FRAME_H, type MascotState } from './frames';

const FRAME_MS = 160;
const CANVAS_H = FRAME_H + 2; // headroom so the 1px bob never clips
const DISPLAY = 34;           // CSS px (logical 16 → ~2.1x, image-rendering: pixelated)

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Vertical bob offset (px) for a given state + tick. Up is negative. */
function bobOffset(state: MascotState, tick: number): number {
  if (state === 'done') return tick % 2 === 0 ? -1 : 0; // quick hop
  // idle/typing/thinking/calling: gentle 0↔1 sway every ~2 frames
  return tick % 4 < 2 ? 0 : 1;
}

export function FeralMascot({ state }: { state: MascotState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    const frames = FRAMES[state];

    const draw = (frameIdx: number, tick: number) => {
      ctx.clearRect(0, 0, FRAME_W, CANVAS_H);
      const frame = frames[frameIdx % frames.length];
      const y0 = 1 + (reduced ? 0 : bobOffset(state, tick));
      for (let r = 0; r < frame.length; r++) {
        const row = frame[r];
        for (let c = 0; c < row.length; c++) {
          const color = PALETTE[row[c]];
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(c, y0 + r, 1, 1);
        }
      }
    };

    draw(0, 0);
    if (reduced) return; // static

    let tick = 0;
    const id = window.setInterval(() => {
      tick += 1;
      draw(tick, tick);
    }, FRAME_MS);
    return () => window.clearInterval(id);
  }, [state, reduced]);

  return (
    <canvas
      ref={ref}
      width={FRAME_W}
      height={CANVAS_H}
      aria-hidden="true"
      style={{
        width: DISPLAY,
        height: Math.round((DISPLAY * CANVAS_H) / FRAME_W),
        imageRendering: 'pixelated',
      }}
    />
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend-react && npx tsc --noEmit`
Expected: PASS (exit 0).

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/components/chat/mascot/FeralMascot.tsx
git commit -m "feat(mascot): add canvas renderer with bob + reduced-motion"
```

---

## Task 4: Mount on the typing bar (`ChatInput.tsx`)

Perch the mascot on the top edge of the rounded input container and feed it the derived state.

**Files:**
- Modify: `frontend-react/src/components/chat/ChatInput.tsx`

- [ ] **Step 1: Add imports**

After the existing `ContextRing` import (line 18) add:

```tsx
import { FeralMascot } from './mascot/FeralMascot';
import { useMascotState } from './mascot/useMascotState';
```

- [ ] **Step 2: Derive mascot state in the component body**

In `ChatInput`, just after `const isStreaming = status === 'streaming';` (line 89), add:

```tsx
  const agentPhase = useChat((s) => s.agentPhase);
  const mascotState = useMascotState({
    streamStatus: status,
    agentPhase,
    isUserTyping: text.trim().length > 0,
  });
```

- [ ] **Step 3: Make the container a positioning context and mount the mascot**

Replace the container opening tag (line 124):

```tsx
        <div className="rounded-3xl border border-border-default bg-bg-surface focus-within:border-brand transition-colors">
```

with:

```tsx
        <div className="relative rounded-3xl border border-border-default bg-bg-surface focus-within:border-brand transition-colors">
          <div className="pointer-events-none absolute -top-7 left-5 z-10">
            <FeralMascot state={mascotState} />
          </div>
```

(The mascot sits ~7px above the top edge, near the left, perched on the rim. `pointer-events-none` keeps clicks flowing to the input. `z-10` keeps it above the textarea.)

- [ ] **Step 4: Typecheck**

Run: `cd frontend-react && npx tsc --noEmit`
Expected: PASS (exit 0).

- [ ] **Step 5: Run the full mascot test suite**

Run: `cd frontend-react && npx vitest run src/components/chat/mascot`
Expected: PASS (all tests from Tasks 1–2).

- [ ] **Step 6: Commit**

```bash
git add frontend-react/src/components/chat/ChatInput.tsx
git commit -m "feat(mascot): perch mascot on the typing bar"
```

---

## Task 5: Visual verification

**Files:** none (manual).

- [ ] **Step 1: Launch the app**

Run: `cd frontend-react && npm run dev` (or run the full Tauri app via the project's run path) and open the chat view.

- [ ] **Step 2: Verify each state by observation**
  - Empty input, no generation → **idle**: gentle bob, occasional blink.
  - Type text (don't send) → **typing**.
  - Send a chat message → **thinking** during streaming.
  - In Agent mode, trigger a tool call → **calling** during the tool phase.
  - On completion → brief **done** hop, then back to **idle**.
  - OS "reduce motion" on → static frame, no bob.

- [ ] **Step 3: Tune pixels if needed**

If the silhouette reads poorly at 34px, adjust the row literals in `frames.ts` (keeping each row exactly 16 chars so `frames.test.ts` stays green) and/or `MASCOT_ORANGE`. Re-run `npx vitest run src/components/chat/mascot/__tests__/frames.test.ts` after edits.

- [ ] **Step 4: Commit any tuning**

```bash
git add frontend-react/src/components/chat/mascot/frames.ts
git commit -m "polish(mascot): tune pixel frames after visual review"
```

---

## Notes for the executor

- Keep every frame row exactly 16 characters — the invariant test enforces it; a miscount is the most likely failure.
- Do not add global CSS keyframes — the bob lives entirely in the canvas draw loop, by design (self-contained, reduced-motion-aware).
- `AgentPhase` is `null` in chat mode; the hook already routes that to `thinking` while streaming, so the mascot animates in both chat and agent modes.
- Version bump to v0.1.5 is intentionally NOT part of this plan (other fixes land first).
