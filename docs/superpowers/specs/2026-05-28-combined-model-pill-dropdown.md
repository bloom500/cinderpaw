# Combined Model Pill with Dropdown — Design Spec

## Overview

Replace the separate model pill (`<A href="/models">`) and controls pill (⚙ button) in the chat topbar with a single combined pill that opens an inline dropdown for model selection.

## Visual Design

```
[ • Jan-v3_5-4B-Q8_0  |  ⚙ ]
        ↓ click left half
┌─────────────────────────────┐
│  LOCAL MODELS               │
│  • Jan-v3_5-4B-Q8_0  ✓     │
│  • Mistral-7B-Q4_K_M        │
│                             │
│  CLOUD PROVIDERS            │
│  Anthropic                  │
│  Groq                       │
└─────────────────────────────┘
```

## Positioning

Move the pill to top-left, close to the sidebar edge:
- Reduce `.cx-topbar` left padding to 8px
- Remove `.cx-topbar-side` gap or reduce to 6px
- Pill stays in `.cx-topbar-side` (no layout restructure needed)

## Combined Pill Structure

Single `<div class="cx-pill">` with:
- **Left half** (`.cx-pill-left`): status dot + model name — `on:click` toggles dropdown
- **Divider** (`.cx-pill-sep`): 1px vertical separator
- **Right half** (`.cx-pill-right`): ⚙ icon — `on:click` toggles controls panel

Hover states are per-half (not whole pill) via CSS `:hover` on each half.

## Dropdown

Positioned absolute below the pill, left-aligned. Z-index above content.

### Sections
1. **LOCAL MODELS** — from `get_models()` Tauri command
   - Each row: colored dot (green if currently loaded) + display name
   - Click: invoke `start_model_load` with the model path; close dropdown
   - Currently loaded model shows a checkmark
2. **CLOUD PROVIDERS** — from `get_byok_settings()` Tauri command
   - Only show providers where `enabled == true` OR `has_api_key == true`
   - Each row: provider name + "Configure →" label
   - Click: navigate to `/models` (BYOK tab); close dropdown

### Open/Close
- Opens on left-half click
- Closes on: second click on left half, click outside (transparent overlay), Escape key, or item selection

## State Signals (added to `ChatPage`)

```rust
let (model_dd_open, set_model_dd_open) = create_signal(false);
let (local_models, set_local_models) = create_signal::<Vec<ModelInfo>>(vec![]);
let (byok_providers, set_byok_providers) = create_signal::<Vec<ByokProviderInfo>>(vec![]);
let (loading_pill, set_loading_pill) = create_signal(false);
```

Models and BYOK list are fetched when the dropdown opens (lazy fetch, cached per open).

## Imports Needed in `chat.rs`

- `use crate::pages::types::ModelInfo`
- `use crate::pages::models::ByokProviderInfo` (move struct to `types.rs` or use `pub use`)
- `use leptos_router::use_navigate`

## CSS

New classes in `styles.css`:
- `.cx-pill` — outer container (inline-flex, pill border-radius, border)
- `.cx-pill-left`, `.cx-pill-right` — halves with independent hover backgrounds
- `.cx-pill-sep` — 1px vertical divider (height ~14px, centered)
- `.cx-model-dropdown` — absolute panel (top: calc(100% + 6px), left: 0, min-width: 240px, bg + border + shadow)
- `.cx-dd-section` — small caps section label
- `.cx-dd-item` — row with dot + name, hover highlight
- `.cx-dd-item.active` — currently loaded model (green dot + checkmark)

Existing `.cx-model-pill`, `.cx-controls-pill` classes removed.

## Out of Scope

- BYOK inference integration (chat send still uses local model only)
- Model load progress indicator inside pill (uses existing loading state; pill shows "Loading…" text)
- Keyboard navigation within dropdown
