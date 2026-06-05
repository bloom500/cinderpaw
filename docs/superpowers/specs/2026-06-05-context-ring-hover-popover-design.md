# Context Ring Hover Popover

**Date:** 2026-06-05  
**Status:** Approved

## Overview

Replace the native browser `title` tooltip on `ContextRing` with a rich `HoverCard` popover (Radix UI / shadcn) that surfaces full context-window details on hover.

## Component & Location

- **File:** `frontend-react/src/components/chat/ContextRing.tsx`
- The existing SVG ring becomes the `HoverCardTrigger`.
- All detail content lives in `HoverCardContent` (`side="top"`, `align="end"`).
- No changes needed in `ChatInput.tsx`.

## Installation

```bash
cd frontend-react
npx shadcn@latest add hover-card
```

## Card Layout

Width: ~220px, compact padding.

```
┌──────────────────────────────┐
│  Context Window              │  ← small muted header
├──────────────────────────────┤
│  Model      gemma-3-4b-it    │
│  Window     8,192 tokens     │
│  Used       ~1,234 tokens    │
│  Free       ~6,958 tokens    │
│  Messages   12               │
├──────────────────────────────┤
│  🟡 75% · ~18 msgs left      │  ← color-coded status
└──────────────────────────────┘
```

- **Rows (Model → Messages):** 2-column grid, label muted left / value primary right.
- **Separator** between rows section and status line.
- **Native `title` attribute** removed from the wrapper div.

## Data & Calculations

All data already computed in the existing `useMemo` inside `ContextRing`. Additions:

| Field | Source |
|-------|--------|
| Model name | `model` (derived from store) |
| Window | `window` (from `contextWindowFor`) |
| Used | `used` (sum of `estimateTokens` across messages) |
| Free | `window - used` |
| Message count | `messages.length` |
| Avg tokens/msg | `used / messages.length` (fallback: 200) |
| Msgs remaining | `Math.floor((window - used) / avgPerMsg)` |

If remaining < 1 message, show `~N tokens left` instead of msgs.

## Color Coding (status line)

| Range | Color |
|-------|-------|
| < 75% | `text-text-muted` (neutral) |
| 75–90% | amber (`#f59e0b`) |
| ≥ 90% | red (`var(--c-red, #ef4444)`) + label "Approaching limit" |

The status line also echoes the percentage: `75% · ~18 msgs left`.

## Accessibility

- Keep `aria-label` on the wrapper div (already present).
- Remove `title` from the div (replaced by the HoverCard).
- `HoverCard` is keyboard-accessible via Radix defaults.
