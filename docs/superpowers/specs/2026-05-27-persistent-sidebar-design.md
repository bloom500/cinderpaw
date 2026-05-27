# Persistent Sidebar with Focus Mode — Design Spec

**Date:** 2026-05-27
**Status:** Approved

---

## Goal

Convert Feral's existing overlay drawer into a persistent, always-visible sidebar that matches Jan's aesthetic. Add a Focus Mode toggle (Ctrl+B) that collapses the sidebar and gives the chat full width.

---

## Layout Restructure

**Current:** `cx-root` is `flex-direction: column` — topbar spans full width, canvas below.

**New:** `cx-root` becomes `flex-direction: row` — sidebar is the first column, a right column (flex:1) contains the topbar + canvas stacked vertically.

```
cx-root  (flex row)
├── cx-sidebar           (240px, floats, collapses left)
└── cx-right-col         (flex:1, flex-direction: column)
    ├── cx-topbar        (model pill left, controls pill right)
    └── cx-canvas        (flex:1, existing chat area)
```

The existing overlay/drawer mechanism and `cx-overlay` backdrop are removed. The right-side controls drawer remains unchanged (still `position: fixed`).

---

## Sidebar

- **Width:** 240px
- **Background:** `#191919`
- **Border-radius:** `16px` (all corners — sidebar floats, touching no edges)
- **Margin:** `8px` on all sides to create the floating card gap
- **Box-shadow:** `0 4px 24px rgba(0,0,0,0.4)`
- **Contents (top to bottom):**
  1. "feral" brand label
  2. "+ New Chat" button
  3. Nav links: Models, Assistants, Settings
  4. "Chats" section header + conversation history list
  5. Spacer (`flex: 1`)
  6. Focus Mode toggle button (footer)
  7. "v0.1.0" version label

### Focus Mode Button

Full-width ghost button pinned to sidebar footer:

```
[ ⊡  Focus Mode          Ctrl+B ]
```

- `border: 1px solid rgba(255,255,255,0.07)`
- `border-radius: 8px`
- Left: icon + "Focus Mode" label
- Right: small `Ctrl+B` badge (`background: rgba(255,255,255,0.05)`)
- Click collapses sidebar (same as pressing Ctrl+B)

---

## Collapse Animation

**Trigger:** Focus Mode button click OR Ctrl+B keyboard shortcut.

**Sidebar (200ms ease-in-out, simultaneous):**
- `transform: translateX(-256px)` — slides fully off screen (`240px width + 8px left-margin + 8px extra`)
- `margin-left: -248px` — reclaims the layout space (`8px natural margin - 248px = net 0 contribution`) so the right column expands to full width

**Right column:** Expands naturally via flexbox as the sidebar's space is freed. No explicit animation needed on the column itself — CSS handles it.

**Burger icon in topbar:**
- Hidden (`opacity: 0`, `pointer-events: none`) when sidebar is expanded
- Fades in (`opacity: 1`) as sidebar collapses — same 200ms transition
- Clicking the burger expands the sidebar (reverses the animation)

**Model pill:** Left-aligned in the topbar (no centering). It rides the left edge of the right column, so it naturally slides leftward as the right column expands during collapse.

---

## State Persistence

- Collapsed/expanded state stored in `localStorage` key `feral_sidebar_collapsed`
- Read on component mount; apply initial state without animation (add a `no-transition` class during mount, remove after first paint)

---

## Keyboard Shortcut

- `Ctrl+B` registered at the app level in `main.rs` via a `keydown` event listener (same pattern as the existing streaming event listeners using `Closure::<dyn FnMut()>::new(...).forget()`)
- Toggles the `sidebar_collapsed: RwSignal<bool>` in `ChatContext` (or local signal in `ChatPage`)
- Also persists state to localStorage on each toggle

---

## Topbar Changes

The `cx-topbar` moves inside `cx-right-col`. Layout changes:

- **Left:** burger icon (hidden when sidebar expanded, visible when collapsed)
- **Left:** model pill (left-aligned, not centered) — immediately after burger
- **Right:** controls pill (unchanged)
- Remove the `cx-topbar-side` / `cx-topbar-center` split; use `justify-content: space-between` with a left flex group and the right pill

---

## Files to Change

| File | Change |
|------|--------|
| `frontend/src/pages/chat.rs` | Layout restructure; new sidebar signal; Ctrl+B listener; localStorage read/write; burger visibility |
| `frontend/styles.css` | New `.cx-sidebar` rules; update `.cx-root` to `flex-direction: row`; add `.cx-right-col`; update `.cx-topbar`; collapse transition rules |
| `frontend/src/context.rs` | No changes — `sidebar_collapsed` stays local to `ChatPage` (only the chat screen has the sidebar) |

---

## Out of Scope

- Right-side controls drawer (unchanged)
- Nav item content (Models, Assistants, Settings links — unchanged)
- Chat history data / session loading logic (unchanged)
- Rust backend / Tauri commands (unchanged)
- Mobile/responsive breakpoints (not in scope)
