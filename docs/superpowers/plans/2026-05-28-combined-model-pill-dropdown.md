# Combined Model Pill with Dropdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate model-pill link and controls-pill button in the chat topbar with a single combined pill that opens an inline model-selector dropdown, while integrating the gear/controls toggle into the pill's right half.

**Architecture:** All changes live in two files — `frontend/src/pages/chat.rs` (component logic + HTML) and `frontend/styles.css` (visual). New signals handle dropdown open state and lazily fetched model/BYOK lists. The dropdown renders conditionally via Leptos reactive closures; a transparent overlay beneath it handles click-outside dismissal.

**Tech Stack:** Rust, Leptos 0.6 (reactive signals, `spawn_local`, `view!` macro), Tauri IPC (`tauri_bridge::invoke`), `leptos_router::use_navigate`

---

## File Map

| File | Change |
|------|--------|
| `frontend/src/pages/chat.rs` | Add imports, new signals, replace topbar HTML, add `strip_model_name` helper |
| `frontend/styles.css` | Add pill/dropdown CSS, update topbar padding, remove old pill classes |

---

### Task 1: CSS — topbar positioning + combined pill + dropdown styles

**Files:**
- Modify: `frontend/styles.css:1354-1422` (topbar + controls-pill block)
- Modify: `frontend/styles.css:2188-2225` (model-pill block)

- [ ] **Step 1: Update topbar padding for tighter left position**

Find and replace in `frontend/styles.css`:

```css
/* OLD (line ~1358) */
  padding: 14px 20px;

/* NEW */
  padding: 8px 16px 8px 8px;
```

- [ ] **Step 2: Remove the old `.cx-controls-pill` and `.cx-model-pill` blocks**

Delete the following blocks entirely from `styles.css`:

```css
/* Remove this entire block (~lines 1403-1422) */
.cx-controls-pill {
  display: inline-flex;
  align-items: center;
  gap: 0;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  color: var(--fg);
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.18s ease;
}
.cx-controls-pill:hover {
  background: rgba(255,255,255,0.08);
  border-color: rgba(255,255,255,0.18);
}
.cx-gear { opacity: 0.7; font-size: 13px; }
```

```css
/* Remove this entire block (~lines 2188-2225) */
.cx-model-pill { ... }
.cx-model-pill:hover { ... }
.cx-model-pill-dot { ... }
.cx-model-pill-dot.loaded { ... }
.cx-model-pill-name { ... }
```

- [ ] **Step 3: Add combined pill + dropdown CSS**

Append the following block right after the `.cx-topbar-side` block (after line ~1367):

```css
/* ── COMBINED MODEL PILL ─────────────────────────────────────────────── */
.cx-pill-wrapper {
  position: relative;
}
.cx-pill {
  display: inline-flex;
  align-items: center;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
  height: 30px;
}
.cx-pill-left {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 10px;
  background: transparent;
  border: none;
  color: var(--text, var(--fg));
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  height: 100%;
  transition: background 0.15s;
  white-space: nowrap;
}
.cx-pill-left:hover { background: rgba(255,255,255,0.06); }
.cx-pill-sep {
  width: 1px;
  height: 14px;
  background: rgba(255,255,255,0.14);
  flex-shrink: 0;
}
.cx-pill-right {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 9px;
  background: transparent;
  border: none;
  color: var(--text, var(--fg));
  cursor: pointer;
  height: 100%;
  transition: background 0.15s;
}
.cx-pill-right:hover { background: rgba(255,255,255,0.06); }
.cx-pill-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-hint, rgba(255,255,255,0.3));
}
.cx-pill-dot.loaded {
  background: var(--green, #22c55e);
  box-shadow: 0 0 6px rgba(34,197,94,0.55);
}
.cx-pill-dot.byok {
  background: rgba(99,179,237,0.75);
}
.cx-pill-name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cx-gear { opacity: 0.7; font-size: 13px; }

/* ── MODEL DROPDOWN ──────────────────────────────────────────────────── */
.cx-dd-overlay {
  position: fixed;
  inset: 0;
  z-index: 49;
}
.cx-model-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 240px;
  background: var(--bg-2, #181818);
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  border-radius: 10px;
  padding: 6px 0;
  z-index: 50;
  box-shadow: 0 8px 28px rgba(0,0,0,0.45);
  animation: cx-dd-in 0.12s ease;
}
@keyframes cx-dd-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.cx-dd-section {
  padding: 6px 12px 2px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-hint, rgba(255,255,255,0.32));
  user-select: none;
}
.cx-dd-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 12px;
  background: transparent;
  border: none;
  color: var(--text, var(--fg));
  font-family: var(--font);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}
.cx-dd-item:hover { background: rgba(255,255,255,0.06); }
.cx-dd-item.active .cx-dd-name { color: var(--green, #22c55e); }
.cx-dd-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cx-dd-check {
  color: var(--green, #22c55e);
  font-size: 11px;
  flex-shrink: 0;
}
.cx-dd-configure {
  color: var(--text-hint, rgba(255,255,255,0.32));
  font-size: 11px;
  flex-shrink: 0;
}
.cx-dd-sep {
  height: 1px;
  background: var(--border, rgba(255,255,255,0.08));
  margin: 4px 0;
}
```

- [ ] **Step 4: Build to verify CSS compiles (no Rust needed yet)**

```bash
cd d:\FeralLocalAI
cargo tauri build --no-bundle 2>&1 | tail -20
```

Expected: build succeeds (CSS is not compiled by Rust, but this checks other unchanged parts still build).

---

### Task 2: Add imports and signals to `ChatPage`

**Files:**
- Modify: `frontend/src/pages/chat.rs:1-12` (imports)
- Modify: `frontend/src/pages/chat.rs:113-170` (component body, signals)

- [ ] **Step 1: Add missing imports**

The current imports at the top of `chat.rs`:
```rust
use leptos::*;
use leptos_router::A;
```

Replace with:
```rust
use leptos::*;
use leptos_router::{A, use_navigate};
```

Also add to the `use crate::pages::...` line:
```rust
// Old:
use crate::pages::types::{InferParams, LoadedModel, Message};

// New:
use crate::pages::types::{InferParams, LoadedModel, Message, ModelInfo};
use crate::pages::models::ByokProviderInfo;
```

- [ ] **Step 2: Add `strip_model_name` helper function**

Add this standalone function right before the `#[component] pub fn ChatPage()` declaration (around line 113):

```rust
fn strip_model_name(name: &str) -> String {
    let n = name.to_lowercase();
    let n = n.trim_end_matches(".gguf");
    let n = if let Some(idx) = n.rfind('.') {
        let suffix = &n[idx + 1..];
        if suffix.starts_with('q') || suffix.starts_with('f') { &n[..idx] } else { n }
    } else { n };
    n.to_string()
}
```

- [ ] **Step 3: Add new signals and navigate inside `ChatPage`**

After the existing signal declarations (after line ~141, after `let (at_bottom, set_at_bottom) = ...`), add:

```rust
// Model selector dropdown
let (model_dd_open, set_model_dd_open) = create_signal(false);
let (local_models, set_local_models) = create_signal::<Vec<ModelInfo>>(vec![]);
let (byok_providers, set_byok_providers) = create_signal::<Vec<ByokProviderInfo>>(vec![]);
let (loading_pill, set_loading_pill) = create_signal(false);
let navigate = use_navigate();
```

- [ ] **Step 4: Update `pill_model_name` closure to use the helper**

Replace the existing `pill_model_name` closure (lines ~306-319):

```rust
// OLD:
let pill_model_name = move || {
    loaded.get()
        .map(|l| {
            let n = l.name.to_lowercase();
            let n = n.trim_end_matches(".gguf");
            let n = if let Some(idx) = n.rfind('.') {
                let suffix = &n[idx + 1..];
                if suffix.starts_with('q') || suffix.starts_with('f') { &n[..idx] } else { n }
            } else { n };
            n.to_string()
        })
        .unwrap_or_else(|| "no model".into())
};

// NEW:
let pill_model_name = move || {
    loaded.get()
        .map(|l| strip_model_name(&l.name))
        .unwrap_or_else(|| "no model".into())
};
```

- [ ] **Step 5: Verify it compiles**

```powershell
cd d:\FeralLocalAI\frontend
cargo check 2>&1 | tail -30
```

Expected: no errors (warnings about unused variables are OK at this stage).

---

### Task 3: Replace topbar HTML with combined pill + dropdown

**Files:**
- Modify: `frontend/src/pages/chat.rs:327-353` (the `<div class="cx-topbar">` block)

- [ ] **Step 1: Replace the entire topbar block**

Find the existing topbar block in `chat.rs`:
```rust
// ── TOP BAR ──────────────────────────────────────────────
<div class="cx-topbar" data-tauri-drag-region="true">
    <div class="cx-topbar-side">
        <button
            class=move || if layout.sidebar_collapsed.get() { ... } else { ... }
            on:click=move |_| layout.collapse(false)
            title="Expand sidebar"
        >"≡"</button>
        <A href="/models" class="cx-model-pill" attr:title="Switch model">
            <span class=move || { ... }></span>
            <span class="cx-model-pill-name">
                {move || pill_model_name()}
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

Replace with:
```rust
// ── TOP BAR ──────────────────────────────────────────────
<div class="cx-topbar" data-tauri-drag-region="true">
    <div class="cx-topbar-side">
        <button
            class=move || if layout.sidebar_collapsed.get() {
                "cx-icon-btn cx-burger"
            } else {
                "cx-icon-btn cx-burger cx-burger-hidden"
            }
            on:click=move |_| layout.collapse(false)
            title="Expand sidebar"
        >"≡"</button>

        // ── COMBINED MODEL PILL ──
        <div class="cx-pill-wrapper">
            <div class="cx-pill">
                // Left half: model name → opens dropdown
                <button class="cx-pill-left"
                    on:click=move |_| {
                        let was_open = model_dd_open.get_untracked();
                        set_model_dd_open.set(!was_open);
                        if !was_open {
                            spawn_local(async move {
                                if let Ok(list) = tauri_bridge::invoke::<Vec<ModelInfo>>(
                                    "get_models", json!({})
                                ).await {
                                    set_local_models.set(list);
                                }
                                if let Ok(provs) = tauri_bridge::invoke::<Vec<ByokProviderInfo>>(
                                    "get_byok_settings", json!({})
                                ).await {
                                    set_byok_providers.set(provs);
                                }
                            });
                        }
                    }
                >
                    <span class=move || {
                        if loaded.get().is_some() { "cx-pill-dot loaded" } else { "cx-pill-dot" }
                    }></span>
                    <span class="cx-pill-name">
                        {move || if loading_pill.get() { "Loading…".to_string() } else { pill_model_name() }}
                    </span>
                </button>
                // Separator
                <div class="cx-pill-sep"></div>
                // Right half: controls toggle
                <button class="cx-pill-right"
                    on:click=move |_| set_controls_open.update(|v| *v = !*v)
                    title="Controls"
                >
                    <span class="cx-gear">"⚙"</span>
                </button>
            </div>

            // Click-outside overlay (renders only when dropdown open)
            {move || model_dd_open.get().then(|| view! {
                <div class="cx-dd-overlay"
                    on:click=move |_| set_model_dd_open.set(false)
                ></div>
            })}

            // Dropdown panel (renders only when dropdown open)
            {move || {
                if !model_dd_open.get() { return None; }

                let models = local_models.get();
                let loaded_path = loaded.get().map(|l| l.path.clone()).unwrap_or_default();
                let providers: Vec<ByokProviderInfo> = byok_providers.get()
                    .into_iter()
                    .filter(|p| p.enabled || p.has_api_key)
                    .collect();
                let has_byok = !providers.is_empty();

                let model_rows: Vec<_> = models.into_iter().map(|m| {
                    let is_active = m.path == loaded_path;
                    let path = m.path.clone();
                    let display = strip_model_name(&m.name);
                    view! {
                        <button
                            class=if is_active { "cx-dd-item active" } else { "cx-dd-item" }
                            on:click=move |_| {
                                set_model_dd_open.set(false);
                                if !is_active {
                                    set_loading_pill.set(true);
                                    let p = path.clone();
                                    spawn_local(async move {
                                        if let Ok(l) = tauri_bridge::invoke::<LoadedModel>(
                                            "start_model_load", json!({ "path": p })
                                        ).await {
                                            set_loaded.set(Some(l));
                                        }
                                        set_loading_pill.set(false);
                                    });
                                }
                            }
                        >
                            <span class=if is_active { "cx-pill-dot loaded" } else { "cx-pill-dot" }></span>
                            <span class="cx-dd-name">{display}</span>
                            {is_active.then(|| view! { <span class="cx-dd-check">"✓"</span> })}
                        </button>
                    }
                }).collect();

                let byok_rows: Vec<_> = providers.into_iter().map(|p| {
                    let nav = navigate.clone();
                    let name = p.name.clone();
                    view! {
                        <button class="cx-dd-item cx-dd-item-byok"
                            on:click=move |_| {
                                set_model_dd_open.set(false);
                                nav("/models", Default::default());
                            }
                        >
                            <span class="cx-pill-dot byok"></span>
                            <span class="cx-dd-name">{name}</span>
                            <span class="cx-dd-configure">"→"</span>
                        </button>
                    }
                }).collect();

                Some(view! {
                    <div class="cx-model-dropdown">
                        <div class="cx-dd-section">"LOCAL MODELS"</div>
                        {model_rows}
                        {has_byok.then(|| view! {
                            <div class="cx-dd-sep"></div>
                            <div class="cx-dd-section">"CLOUD PROVIDERS"</div>
                            {byok_rows}
                        })}
                    </div>
                })
            }}
        </div>
    </div>
    // (controls pill removed — gear is now inside cx-pill-right above)
</div>
```

- [ ] **Step 2: Verify it compiles**

```powershell
cd d:\FeralLocalAI\frontend
cargo check 2>&1 | tail -40
```

Expected: no errors. Common issues to fix:
- If `ByokProviderInfo` isn't `pub`: open `frontend/src/pages/models.rs` line 14, change `pub struct ByokProviderInfo` → it should already be `pub`. If not, add `pub`.
- If `navigate` can't be moved into multiple closures: wrap it in `std::rc::Rc::new(navigate)` and clone the `Rc` inside each closure.

- [ ] **Step 3: Build and run the app**

```powershell
cd d:\FeralLocalAI
cargo tauri dev 2>&1
```

Expected: app starts without Rust panic. Open the chat page, verify the combined pill appears top-left.

---

### Task 4: Verify behavior end-to-end and commit

- [ ] **Step 1: Test pill rendering**

With the app running:
1. Open chat page — pill should show status dot + model name + `⚙` all in one pill
2. Pill should be positioned closer to left edge (near sidebar)
3. `⚙` click should open the controls panel as before

- [ ] **Step 2: Test dropdown opens and lists models**

1. Click the model name half of the pill
2. Dropdown should animate in below the pill
3. "LOCAL MODELS" section should list all `.gguf` files from the models directory
4. Currently loaded model should have green dot and `✓` checkmark
5. Click outside the dropdown → it closes

- [ ] **Step 3: Test BYOK section**

1. Open dropdown — if no BYOK providers configured, "CLOUD PROVIDERS" section should NOT appear
2. Configure a BYOK provider in Settings → open dropdown → provider should appear
3. Click a BYOK provider → navigates to `/models` and dropdown closes

- [ ] **Step 4: Test model switching from dropdown**

1. Open dropdown, click a different local model
2. Dropdown closes, pill shows "Loading…"
3. After load completes, pill name updates to the new model
4. Green dot + `✓` moves to the newly loaded model on next dropdown open

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/pages/chat.rs frontend/styles.css docs/superpowers/
git commit -m "feat: combined model pill with inline dropdown, integrates controls gear"
```

---

## Self-Review Notes

- **Spec §Positioning**: Covered in Task 1 Step 1 (topbar padding change).
- **Spec §Combined Pill**: Covered in Task 3 (left half + sep + right half).
- **Spec §Dropdown — Local Models**: Task 3 model_rows loop with `start_model_load` on click.
- **Spec §Dropdown — BYOK**: Task 3 byok_rows with navigate to `/models`.
- **Spec §Open/Close**: Overlay div + toggle on left-half click both in Task 3.
- **Spec §State Signals**: Task 2 Step 3.
- **Type consistency**: `ModelInfo` used with `.path`, `.name` (matches `types.rs`). `ByokProviderInfo` used with `.enabled`, `.has_api_key`, `.name` (matches `models.rs:14-21`). `LoadedModel` used with `.path` (matches `types.rs:15-19`). `strip_model_name(&str) -> String` defined Task 2 Step 2, used Task 3. `set_model_dd_open`, `set_local_models`, `set_byok_providers`, `set_loading_pill` defined Task 2 Step 3, used Task 3. Consistent throughout.
