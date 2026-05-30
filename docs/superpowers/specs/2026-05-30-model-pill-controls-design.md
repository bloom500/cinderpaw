# Design: Model Pill + Controls in ChatHeader

**Date:** 2026-05-30  
**Status:** Approved

---

## 1. Goal

Replace the visually detached `ChatHeader` top bar with a seamlessly integrated header that contains a large `ModelPill` button on the left. The pill surfaces the active model name (or "No Model Selected"), a model picker popover, and a controls popover for inference parameters (Temperature, Top-P, Max Tokens).

---

## 2. Visual Layout

```
┌────────────────────────────────────────────────────────────────┐
│ [⚡ Jan-v3_5-4B-Q8_0  ⌄ │ ⚙]          New chat               │
└────────────────────────────────────────────────────────────────┘
```

- `ChatHeader`: transparent background, **no border-bottom** (or 1px at ~5% opacity), h-12
- `ModelPill`: `rounded-full`, `bg-zinc-800/60 border border-white/10`, h-8, left-aligned near sidebar
  - **Left section** (clickable): model icon + name/status + `ChevronDown` → opens `ModelPickerPopover`
  - **Divider**: `w-px h-4 bg-white/10`
  - **Right section** (gear icon): `⚙` → opens `ControlsPopover`
- Conversation title: centered/right in header, `text-sm text-text-muted/40`, truncated
- `ModelSelector` button at bottom-right of `ChatInput` is **removed**

---

## 3. Components

### 3.1 `ModelPill` (new — `components/chat/ModelPill.tsx`)

Renders the pill. Manages open state for both popovers independently.

Label logic (same as current `ModelSelector`):
- Loading: `"Loading XX%"`
- Cloud model: `"modelId · providerName"`
- Local model: `loaded.name`
- None: `"No model selected"`

### 3.2 `ModelPickerPopover` (new — `components/chat/ModelPickerPopover.tsx`)

Extracts the dropdown content from the existing `ModelSelector` component into a `Popover` (shadcn/ui). Opens anchored to the left section of the pill. Same data-fetching logic as the current `ModelSelector` (`tauri.models.list()` + `tauri.raw.getByokSettings()`).

### 3.3 `ControlsPopover` (new — `components/chat/ControlsPopover.tsx`)

Opens anchored to the gear icon. Contains three controls:

| Parameter | Control | Range | Default |
|-----------|---------|-------|---------|
| Temperature | Slider + number input | 0.0 – 2.0 | 0.8 |
| Top-P | Slider + number input | 0.01 – 1.0 | 0.95 |
| Max Tokens | Slider + number input | 128 – 8192 | 2048 |

Writes to `useModel` store via `setInferParams`.

### 3.4 `ChatHeader` (modified — `components/chat/ChatHeader.tsx`)

- Remove `border-b border-border-subtle`
- Left: `<ModelPill />`
- Right: conversation title (demoted to `text-sm text-text-muted/50`)

### 3.5 `ChatInput` (modified — `components/chat/ChatInput.tsx`)

- Remove `<ModelSelector />` from the bottom-right toolbar

---

## 4. State Management

### `stores/model.ts` additions

```ts
interface InferParamsUI {
  temperature: number;   // 0.8 default
  top_p: number;         // 0.95 default
  max_tokens: number;    // 2048 default
}

// Added to ModelStore:
inferParams: InferParamsUI;
setInferParams: (patch: Partial<InferParamsUI>) => void;
```

`repeat_penalty` stays at its hardcoded default (1.1) — not exposed in UI.

### `lib/inferParams.ts` modification

`currentInferParams()` reads `temperature`, `top_p`, `max_tokens` from `useModel.getState().inferParams` instead of hardcoded values.

---

## 5. Backend

No Rust changes required. `InferParams` in `inference.rs` already has `temperature`, `top_p`, and `max_tokens` fields that are actively used in the llama.cpp sampler chain (`LlamaSampler::top_p`, `LlamaSampler::temp`) and as the `max_new` token budget. The frontend simply needs to pass non-hardcoded values.

---

## 6. Files Touched

| File | Change |
|------|--------|
| `frontend-react/src/components/chat/ChatHeader.tsx` | Redesign: remove border, add ModelPill, demote title |
| `frontend-react/src/components/chat/ModelPill.tsx` | **New**: pill wrapper, delegates to two popovers |
| `frontend-react/src/components/chat/ModelPickerPopover.tsx` | **New**: extracted + promoted from ModelSelector |
| `frontend-react/src/components/chat/ControlsPopover.tsx` | **New**: Temperature / Top-P / Max Tokens sliders |
| `frontend-react/src/components/chat/ModelSelector.tsx` | Delete (superseded) |
| `frontend-react/src/components/chat/ChatInput.tsx` | Remove ModelSelector import + usage |
| `frontend-react/src/stores/model.ts` | Add `inferParams` state + `setInferParams` |
| `frontend-react/src/lib/inferParams.ts` | Read params from store instead of hardcoding |

---

## 7. Out of Scope

- `repeat_penalty` UI (stays hardcoded at 1.1)
- Per-conversation inference param persistence (params are global session state)
- Any Rust / Tauri changes
