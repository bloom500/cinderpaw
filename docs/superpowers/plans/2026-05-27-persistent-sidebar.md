# Persistent Sidebar with Focus Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Feral's overlay drawer into a floating persistent sidebar with a Focus Mode toggle (Ctrl+B) that collapses it to give the chat full width.

**Architecture:** `cx-root` becomes a flex row; the sidebar is an inline flex child (240px, floating with `margin: 8px`) that collapses via `translateX(-256px) + margin-left: -248px`. A `cx-right-col` div wraps the topbar and canvas. The model pill sits left-aligned in the topbar and naturally follows the column edge when the sidebar collapses. State persisted to localStorage.

**Tech Stack:** Leptos 0.6 CSR, `web_sys` (localStorage + keydown listener), `wasm_bindgen::closure::Closure`, CSS transitions.

**Spec:** `docs/superpowers/specs/2026-05-27-persistent-sidebar-design.md`

---

### Task 1: CSS — Static sidebar layout classes

**Files:**
- Modify: `frontend/styles.css:1261-1270` (`.cx-root`)
- Modify: `frontend/styles.css:1313` (`.cx-burger`)
- Add: new rules after `.cx-root` and after the `.cx-drawer` block

- [ ] **Step 1: Change `.cx-root` to flex row**

Find this rule at line 1261:
```css
.cx-root {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: #000;
  color: var(--fg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
```
Change `flex-direction: column` → `flex-direction: row`.

- [ ] **Step 2: Add `.cx-right-col` immediately after `.cx-root`**

```css
.cx-right-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
```

- [ ] **Step 3: Add the sidebar block after the `.cx-drawer-right.open` rule (~line 1376)**

```css
/* ── PERSISTENT SIDEBAR ─────────────────────────────────────── */
.cx-sidebar {
  width: 240px;
  flex-shrink: 0;
  background: #191919;
  border-radius: 16px;
  margin: 8px 0 8px 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 4px 24px rgba(0,0,0,0.4);
  transition: transform 200ms ease-in-out, margin-left 200ms ease-in-out;
}
.cx-sidebar.collapsed {
  transform: translateX(-256px);
  margin-left: -248px;
}
```

- [ ] **Step 4: Add Focus Mode button styles after the `.cx-sidebar.collapsed` rule**

```css
.cx-focus-mode-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: calc(100% - 24px);
  margin: 0 12px 4px;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--text-muted);
  font-family: var(--font);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.cx-focus-mode-btn:hover {
  background: rgba(255,255,255,0.05);
  color: var(--fg);
}
.cx-focus-mode-label {
  display: flex;
  align-items: center;
  gap: 7px;
}
.cx-focus-mode-badge {
  font-size: 10px;
  color: #555;
  background: rgba(255,255,255,0.05);
  border-radius: 4px;
  padding: 2px 5px;
  letter-spacing: 0.02em;
}
```

- [ ] **Step 5: Add burger transition + hidden class**

Find `.cx-burger` at line ~1313 and add the transition:
```css
.cx-burger {
  font-size: 22px;
  transition: opacity 200ms ease-in-out;
}
.cx-burger-hidden {
  opacity: 0;
  pointer-events: none;
}
```

- [ ] **Step 6: Verify CSS compiles — run a build check**

```powershell
cd d:/FeralLocalAI && cargo build -p frontend 2>&1 | tail -5
```
Expected: `Finished` with no errors. (CSS errors won't appear here — they surface in the browser, but Rust compilation should pass.)

- [ ] **Step 7: Commit**

```powershell
git add frontend/styles.css
git commit -m "feat: add cx-sidebar, cx-right-col, focus-mode-btn CSS"
```

---

### Task 2: Rust — Layout restructure

**Files:**
- Modify: `frontend/src/pages/chat.rs`

The full layout restructure: remove the overlay left drawer, add the persistent sidebar as an inline flex child, wrap topbar + canvas in `cx-right-col`, left-align the model pill.

- [ ] **Step 1: Add localStorage helper functions**

Open `frontend/src/pages/chat.rs`. Find the `fn title_from_messages` function near line 99. **Add these two functions directly above `pub fn ChatPage()`** (after `fn title_from_messages` ends):

```rust
fn read_sidebar_collapsed() -> bool {
    web_sys::window()
        .and_then(|w| w.local_storage().ok().flatten())
        .and_then(|ls| ls.get_item("feral_sidebar_collapsed").ok().flatten())
        .map(|v| v == "true")
        .unwrap_or(false)
}

fn write_sidebar_collapsed(val: bool) {
    if let Some(ls) = web_sys::window()
        .and_then(|w| w.local_storage().ok().flatten())
    {
        let _ = ls.set_item(
            "feral_sidebar_collapsed",
            if val { "true" } else { "false" },
        );
    }
}
```

- [ ] **Step 2: Remove `history_open` / `set_history_open` signal**

Find and delete line 125:
```rust
    let (history_open, set_history_open) = create_signal(false);
```

- [ ] **Step 3: Add `sidebar_collapsed` signal after the `system_prompt` signal (line ~123)**

```rust
    let (sidebar_collapsed, set_sidebar_collapsed) = create_signal(read_sidebar_collapsed());
```

- [ ] **Step 4: Rewrite the `view!` layout — root, sidebar, right-col**

Find the `view! {` block which starts near line 352. Replace everything from `<div class="cx-root">` through the end of `</aside>` for the left drawer (currently ends around line 434) — that is, replace the root open tag, the HwNotification, the topbar, the left overlay, and the left drawer — with the following. Keep everything from `// ── CONTROLS DRAWER` onward untouched.

```rust
        view! {
        <div class="cx-root">

            // ── HW RECOMMENDATION TOAST ─────────────────────────────
            <HwNotification/>

            // ── PERSISTENT SIDEBAR ───────────────────────────────────
            <aside class=move || if sidebar_collapsed.get() { "cx-sidebar collapsed" } else { "cx-sidebar" }>
                <div class="cx-sidebar-brand">"feral"</div>
                <button class="cx-new-chat-full" on:click=move |e| {
                    new_chat(e);
                }>
                    <span>"+"</span><span>"New Chat"</span>
                </button>
                <div class="cx-drawer-nav">
                    <A href="/models" class="cx-nav-link">"◧ Models"</A>
                    <A href="/agents" class="cx-nav-link">"⚙ Assistants"</A>
                    <A href="/settings" class="cx-nav-link">"⚒ Settings"</A>
                </div>
                <div class="cx-drawer-section">
                    <div class="cx-thread-group">
                        <div class="cx-thread-group-label">"Recent"</div>
                        <div class="cx-hist-list">
                            {move || {
                                let convs = chat.history.get();
                                let active = chat.active_session_id.get();
                                if convs.is_empty() {
                                    view! { <div class="cx-hist-empty">"No conversations yet"</div> }.into_view()
                                } else {
                                    convs.into_iter().rev().map(|s| {
                                        let is_active = active.as_ref() == Some(&s.id);
                                        let title = s.title.clone();
                                        let id = s.id.clone();
                                        view! {
                                            <div class=if is_active { "cx-hist-item active" } else { "cx-hist-item" }
                                                on:click=move |_| {
                                                    load_conv(id.clone());
                                                }>
                                                <span class="cx-hist-dot">"◆"</span>
                                                <span class="cx-hist-name">{title}</span>
                                            </div>
                                        }.into_view()
                                    }).collect_view()
                                }
                            }}
                        </div>
                    </div>
                </div>
                <button class="cx-focus-mode-btn"
                    on:click=move |_| {
                        let new_val = !sidebar_collapsed.get_untracked();
                        set_sidebar_collapsed.set(new_val);
                        write_sidebar_collapsed(new_val);
                    }
                >
                    <span class="cx-focus-mode-label"><span>"⊡"</span>" Focus Mode"</span>
                    <span class="cx-focus-mode-badge">"Ctrl+B"</span>
                </button>
                <div class="cx-sidebar-footer">"v0.1.0"</div>
            </aside>

            // ── RIGHT COLUMN (topbar + canvas) ────────────────────────
            <div class="cx-right-col">

            // ── TOP BAR ──────────────────────────────────────────────
            <div class="cx-topbar">
                <div class="cx-topbar-side">
                    <button
                        class=move || if sidebar_collapsed.get() {
                            "cx-icon-btn cx-burger"
                        } else {
                            "cx-icon-btn cx-burger cx-burger-hidden"
                        }
                        on:click=move |_| {
                            set_sidebar_collapsed.set(false);
                            write_sidebar_collapsed(false);
                        }
                        title="Expand sidebar"
                    >"≡"</button>
                    <A href="/models" class="cx-model-pill" attr:title="Switch model">
                        <span class=move || {
                            if loaded.get().is_some() { "cx-model-pill-dot loaded" } else { "cx-model-pill-dot" }
                        }></span>
                        <span class="cx-model-pill-name">
                            {move || {
                                match loaded.get() {
                                    Some(l) => l.name,
                                    None => "No model loaded".into(),
                                }
                            }}
                        </span>
                    </A>
                </div>
                <button class="cx-controls-pill"
                    on:click=move |_| set_controls_open.update(|v| *v = !*v)
                    title="Controls">
                    <span class="cx-gear">"⚙"</span>
                </button>
            </div>
```

- [ ] **Step 5: Close `cx-right-col` after the canvas**

Find the end of the `<main class="cx-canvas">` element — it's the last closing tag before the controls drawer. After it, add `</div>` to close `cx-right-col`:

```rust
            </main>

            </div> // cx-right-col
```

Make sure the controls drawer (`// ── CONTROLS DRAWER`) and its overlay remain outside `cx-right-col` (at the `cx-root` level) — they use `position: fixed` so location in the DOM doesn't affect visuals, but keeping them at root is cleaner.

- [ ] **Step 6: Build and check for compile errors**

```powershell
cd d:/FeralLocalAI && cargo build -p frontend 2>&1 | grep -E "error|warning.*unused" | head -20
```
Expected: zero `error` lines. Warnings about unused `set_history_open` would already be gone since we removed it. Fix any compile errors before proceeding.

- [ ] **Step 7: Commit**

```powershell
git add frontend/src/pages/chat.rs
git commit -m "feat: convert left drawer to persistent sidebar, add focus mode button"
```

---

### Task 3: Rust — Ctrl+B keyboard shortcut

**Files:**
- Modify: `frontend/src/pages/chat.rs`

- [ ] **Step 1: Add keydown effect after the `sidebar_collapsed` signal**

In `ChatPage`, after the line:
```rust
    let (sidebar_collapsed, set_sidebar_collapsed) = create_signal(read_sidebar_collapsed());
```

Add:
```rust
    // Register Ctrl+B globally to toggle sidebar. No reactive deps → runs once on mount.
    create_effect(move |_| {
        let closure = Closure::<dyn FnMut(_)>::new(move |e: web_sys::KeyboardEvent| {
            if e.ctrl_key() && e.key() == "b" {
                e.prevent_default();
                let new_val = !sidebar_collapsed.get_untracked();
                set_sidebar_collapsed.set(new_val);
                write_sidebar_collapsed(new_val);
            }
        });
        web_sys::window()
            .expect("window")
            .add_event_listener_with_callback("keydown", closure.as_ref().unchecked_ref())
            .expect("keydown listener");
        closure.forget();
    });
```

`Closure::<dyn FnMut(_)>` (not `FnMut()`) is required for event listeners that receive an event argument. `KeyboardEvent` is already imported via `use web_sys::{..., KeyboardEvent}` at the top of the file.

- [ ] **Step 2: Build**

```powershell
cd d:/FeralLocalAI && cargo build -p frontend 2>&1 | grep "error" | head -10
```
Expected: no errors.

- [ ] **Step 3: Launch the app and verify**

```powershell
cd d:/FeralLocalAI && cargo tauri dev 2>&1 &
```

Manual checks:
1. Sidebar is visible on load at 240px wide, floating with rounded corners and gap from all edges
2. Model pill is left-aligned next to the sidebar, not centered
3. Click "Focus Mode" button → sidebar slides left, canvas expands, burger (≡) fades in at top-left
4. Click ≡ burger → sidebar slides back in, burger fades out
5. Press Ctrl+B → toggles sidebar
6. Close and reopen the app → sidebar state is restored from localStorage

- [ ] **Step 4: Commit**

```powershell
git add frontend/src/pages/chat.rs
git commit -m "feat: add Ctrl+B keyboard shortcut to toggle sidebar"
```

---

### Task 4: Push to remote

- [ ] **Step 1: Push**

```powershell
git push bloom500 main
```
