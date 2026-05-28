# Streaming Animation Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Feral's chat streaming to match Jan's smooth real-time token display — per-token re-renders eliminated, smart auto-scroll, and proper cursor behavior.

**Architecture:** Introduce `streaming_content: RwSignal<String>` on `ChatContext`. Token events update only `streaming_content`; `chat.messages` changes just twice per conversation (placeholder added at send, final text set at done). The streaming message component reads solely `streaming_content` for live display (plain text, no markdown), eliminating the O(n) `markdown_to_html()` call and full list re-renders per token. Auto-scroll is conditioned on at-bottom tracking via a passive scroll listener.

**Tech Stack:** Leptos 0.6 CSR, WASM, web_sys, wasm_bindgen Closure, Tauri v2 events, pulldown-cmark

---

## File Map

| File | Change |
|------|--------|
| `frontend/src/context.rs` | Add `streaming_content: RwSignal<String>` to `ChatContext` |
| `frontend/src/main.rs` | Token handler → update `streaming_content`; done handler → batch-update messages + reset + unbusy |
| `frontend/src/pages/chat.rs` | Streaming display reads `streaming_content`; auto-scroll conditioned on at-bottom; speed tracking uses `streaming_content` |
| `frontend/styles.css` | Add `↓ New content` pill styles |

---

## Task 1: Add `streaming_content` to ChatContext

**Files:**
- Modify: `frontend/src/context.rs`

- [ ] **Step 1: Add field to struct**

Open `frontend/src/context.rs`. In the `ChatContext` struct, add after the `busy` field:

```rust
/// Accumulated text from the live token stream. Reset to "" on stream completion.
/// The streaming display component reads this directly — not chat.messages — to
/// avoid re-rendering the completed message list on every token.
pub streaming_content: RwSignal<String>,
```

- [ ] **Step 2: Initialize the new field in `new()`**

In the `ChatContext::new()` impl, add after `busy: create_rw_signal(false),`:

```rust
streaming_content: create_rw_signal(String::new()),
```

- [ ] **Step 3: Build to confirm it compiles**

```powershell
cd d:\FeralLocalAI\frontend
cargo check 2>&1 | Select-String -Pattern "error\[" | head -20
```

Expected: errors about unused field or no errors. If errors about "streaming_content" not being used yet, that is fine — proceed.

- [ ] **Step 4: Commit**

```powershell
git add frontend/src/context.rs
git commit -m "feat: add streaming_content signal to ChatContext for per-token decoupling"
```

---

## Task 2: Decouple token stream from `chat.messages` in main.rs

**Files:**
- Modify: `frontend/src/main.rs:72-97` (feral://token handler)
- Modify: `frontend/src/main.rs:99-129` (feral://stream-done handler)

**Context:** Currently the `feral://token` handler appends each token into `chat.messages` (the last assistant message). This causes the outer render closure in chat.rs to re-run on every token. After this change, `chat.messages` is only updated twice per conversation: once when the user sends (placeholder added in chat.rs), and once when the stream ends (final text set here).

- [ ] **Step 1: Replace the feral://token handler body**

Find this block in `frontend/src/main.rs` (around line 72–97):

```rust
tauri_bridge::listen("feral://token", move |evt: JsValue| {
    if let Ok(obj) = serde_wasm_bindgen::from_value::<serde_json::Value>(evt) {
        if let Some(payload) = obj.get("payload") {
            let tok_session = payload.get("session_id").and_then(|s| s.as_str()).unwrap_or("").to_string();
            if let Some(tok) = payload.get("text").and_then(|t| t.as_str()) {
                let tok = tok.to_string();
                let active = chat.active_session_id.get();
                if active.as_deref() == Some(&tok_session) {
                    chat.messages.update(|m| {
                        if let Some(last) = m.last_mut() {
                            if last.role == "assistant" { last.content.push_str(&tok); }
                        }
                    });
                } else {
                    chat.sessions.update(|s| {
                        if let Some(msgs) = s.get_mut(&tok_session) {
                            if let Some(last) = msgs.last_mut() {
                                if last.role == "assistant" { last.content.push_str(&tok); }
                            }
                        }
                    });
                }
            }
        }
    }
});
```

Replace with:

```rust
tauri_bridge::listen("feral://token", move |evt: JsValue| {
    if let Ok(obj) = serde_wasm_bindgen::from_value::<serde_json::Value>(evt) {
        if let Some(payload) = obj.get("payload") {
            let tok_session = payload.get("session_id").and_then(|s| s.as_str()).unwrap_or("").to_string();
            if let Some(tok) = payload.get("text").and_then(|t| t.as_str()) {
                let tok = tok.to_string();
                let active = chat.active_session_id.get();
                if active.as_deref() == Some(&tok_session) {
                    // Append to streaming_content only — does NOT re-render the completed list.
                    // chat.messages is updated once at stream end with the full text.
                    chat.streaming_content.update(|s| s.push_str(&tok));
                } else {
                    // Background session: accumulate directly into sessions map (no live display)
                    chat.sessions.update(|s| {
                        if let Some(msgs) = s.get_mut(&tok_session) {
                            if let Some(last) = msgs.last_mut() {
                                if last.role == "assistant" { last.content.push_str(&tok); }
                            }
                        }
                    });
                }
            }
        }
    }
});
```

- [ ] **Step 2: Replace the feral://stream-done handler body**

Find this block (around line 99–129):

```rust
tauri_bridge::listen("feral://stream-done", move |evt: JsValue| {
    let done_session = serde_wasm_bindgen::from_value::<serde_json::Value>(evt).ok()
        .and_then(|obj| obj.get("payload")?.get("session_id")?.as_str().map(str::to_string))
        .unwrap_or_default();

    if chat.active_session_id.get().as_deref() == Some(&done_session) {
        chat.busy.set(false);
        let msgs = chat.messages.get();
        if !msgs.is_empty() {
            let title = session_title(&msgs);
            chat.sessions.update(|s| { s.insert(done_session.clone(), msgs); });
            chat.history.update(|h| {
                if let Some(entry) = h.iter_mut().find(|s| s.id == done_session) {
                    entry.title = title;
                } else {
                    h.push(ChatSessionSummary { id: done_session, title });
                }
            });
        }
    } else if !done_session.is_empty() {
        let title = chat.sessions.get()
            .get(&done_session)
            .map(|m| session_title(m))
            .unwrap_or_else(|| "Conversation".into());
        chat.history.update(|h| {
            if let Some(entry) = h.iter_mut().find(|s| s.id == done_session) {
                entry.title = title;
            }
        });
    }
});
```

Replace with:

```rust
tauri_bridge::listen("feral://stream-done", move |evt: JsValue| {
    let done_session = serde_wasm_bindgen::from_value::<serde_json::Value>(evt).ok()
        .and_then(|obj| obj.get("payload")?.get("session_id")?.as_str().map(str::to_string))
        .unwrap_or_default();

    if chat.active_session_id.get().as_deref() == Some(&done_session) {
        let final_content = chat.streaming_content.get();

        // Atomic batch: set final content into messages, clear streaming buffer,
        // and mark not-busy all in one reactive flush to avoid intermediate states.
        batch(|| {
            chat.messages.update(|m| {
                if let Some(last) = m.last_mut() {
                    if last.role == "assistant" {
                        last.content = final_content.clone();
                    }
                }
            });
            chat.streaming_content.set(String::new());
            chat.busy.set(false);
        });

        let msgs = chat.messages.get();
        if !msgs.is_empty() {
            let title = session_title(&msgs);
            chat.sessions.update(|s| { s.insert(done_session.clone(), msgs); });
            chat.history.update(|h| {
                if let Some(entry) = h.iter_mut().find(|s| s.id == done_session) {
                    entry.title = title;
                } else {
                    h.push(ChatSessionSummary { id: done_session, title });
                }
            });
        }
    } else if !done_session.is_empty() {
        // Stream completed for a background session — update title only
        let title = chat.sessions.get()
            .get(&done_session)
            .map(|m| session_title(m))
            .unwrap_or_else(|| "Conversation".into());
        chat.history.update(|h| {
            if let Some(entry) = h.iter_mut().find(|s| s.id == done_session) {
                entry.title = title;
            }
        });
    }
});
```

Note: `batch` is available because `use leptos::*` is already at the top of main.rs. It prevents reactive effects from firing until all three updates inside are applied.

- [ ] **Step 3: Build to confirm it compiles**

```powershell
cd d:\FeralLocalAI\frontend
cargo check 2>&1 | Select-String -Pattern "error\[" | head -20
```

Expected: zero errors. Any errors about `batch` not in scope means add `use leptos::batch;` near the top of main.rs.

- [ ] **Step 4: Commit**

```powershell
git add frontend/src/main.rs
git commit -m "feat: decouple streaming tokens from chat.messages — use streaming_content for live display"
```

---

## Task 3: Rewrite Streaming Display Component in chat.rs

**Files:**
- Modify: `frontend/src/pages/chat.rs`

**Context:** The streaming section in chat.rs currently has a reactive closure that reads `chat.messages.get()` on every token, rebuilding the entire message list and calling `markdown_to_html()` per token. After this change, the outer list closure subscribes only to `chat.messages` (stable during streaming) and `busy`, while the inner streaming closure subscribes only to `chat.streaming_content`. Markdown is NOT applied during streaming (plain text only); it applies when the message moves to the completed list at stream end.

- [ ] **Step 1: Add `wasm_bindgen::closure::Closure` import**

At the top of `frontend/src/pages/chat.rs`, add to the existing `use wasm_bindgen::JsCast;` line:

```rust
use wasm_bindgen::JsCast;
use wasm_bindgen::closure::Closure;
```

- [ ] **Step 2: Replace the split-and-render outer closure**

Find the large reactive closure starting around line 573 that begins:

```rust
{move || {
    // Snapshot messages once. Split into:
    ...
    let msgs = chat.messages.get();
    let is_busy = busy.get();
    let visible: Vec<_> = msgs.into_iter()
        .filter(|m| m.role != "system")
        .collect();

    let (completed, streaming_msg) =
        if is_busy
            && visible.last().map(|m| m.role == "assistant").unwrap_or(false)
        {
            let last = visible.last().cloned();
            (&visible[..visible.len() - 1], last)
        } else {
            (&visible[..], None)
        };
```

Replace the split line (changing `streaming_msg` to `show_streaming: bool`):

```rust
    let (completed, show_streaming) =
        if is_busy
            && visible.last().map(|m| m.role == "assistant").unwrap_or(false)
        {
            (&visible[..visible.len() - 1], true)
        } else {
            (&visible[..], false)
        };
```

- [ ] **Step 3: Replace the streaming message section**

Find the streaming message block near the bottom of the outer closure (lines ~714–766):

```rust
                                        // ── Live streaming message
                                        {streaming_msg.map(|_| view! {
                                            <div class="msg-row msg-ai">
                                                <div class="bubble-ai">
                                                    {move || {
                                                        let msgs = chat.messages.get();
                                                        let content = msgs.iter()
                                                            .filter(|m| m.role != "system")
                                                            .last()
                                                            .map(|m| m.content.clone())
                                                            .unwrap_or_default();
                                                        let is_empty = content.is_empty();
                                                        let parsed = parse_think(&content);
                                                        let still_thinking = parsed.still_thinking;
                                                        let current = parsed.current_think.clone();
                                                        if is_empty {
                                                            return view! {
                                                                <div class="cx-stream-dots"><span></span><span></span><span></span></div>
                                                            }.into_view();
                                                        }
                                                        view! {
                                                            // Completed think blocks (collapsed)
                                                            {parsed.thinking.into_iter().filter(|t| !t.trim().is_empty()).map(|t| view! {
                                                                <details class="thinking-container">
                                                                    <summary>
                                                                        <span class="thinking-dot"></span>
                                                                        "▸ Thinking"
                                                                    </summary>
                                                                    <div class="thinking-content">{t}</div>
                                                                </details>
                                                            }).collect_view()}
                                                            // Active think block — OPEN, tokens stream live inside
                                                            {still_thinking.then(|| view! {
                                                                <details class="thinking-container thinking-live" open>
                                                                    <summary>
                                                                        <span class="thinking-dot thinking-dot--pulse"></span>
                                                                        "▸ Thinking..."
                                                                        <span class="stream-cursor"></span>
                                                                    </summary>
                                                                    <div class="thinking-content">{current}</div>
                                                                </details>
                                                            })}
                                                            // Answer text (after </think>)
                                                            <div class="message-text" inner_html={markdown_to_html(&parsed.answer)}></div>
                                                            // Cursor while streaming answer
                                                            {(!still_thinking).then(||
                                                                view! { <span class="stream-cursor"></span> }
                                                            )}
                                                        }.into_view()
                                                    }}
                                                </div>
                                            </div>
                                        })}
```

Replace entirely with:

```rust
                                        // ── Live streaming message
                                        // Reads chat.streaming_content — does NOT read chat.messages.
                                        // Renders plain text during streaming; markdown is applied
                                        // only when the message moves to the completed list at stream end.
                                        {show_streaming.then(|| view! {
                                            <div class="msg-row msg-ai">
                                                <div class="bubble-ai">
                                                    {move || {
                                                        let content = chat.streaming_content.get();
                                                        if content.is_empty() {
                                                            return view! {
                                                                <div class="cx-stream-dots"><span></span><span></span><span></span></div>
                                                            }.into_view();
                                                        }
                                                        let parsed = parse_think(&content);
                                                        let still_thinking = parsed.still_thinking;
                                                        let current = parsed.current_think.clone();
                                                        view! {
                                                            {parsed.thinking.into_iter().filter(|t| !t.trim().is_empty()).map(|t| view! {
                                                                <details class="thinking-container">
                                                                    <summary>
                                                                        <span class="thinking-dot"></span>
                                                                        "▸ Thinking"
                                                                    </summary>
                                                                    <div class="thinking-content">{t}</div>
                                                                </details>
                                                            }).collect_view()}
                                                            {still_thinking.then(|| view! {
                                                                <details class="thinking-container thinking-live" open>
                                                                    <summary>
                                                                        <span class="thinking-dot thinking-dot--pulse"></span>
                                                                        "▸ Thinking..."
                                                                        <span class="stream-cursor"></span>
                                                                    </summary>
                                                                    <div class="thinking-content">{current}</div>
                                                                </details>
                                                            })}
                                                            // Plain text during streaming — no markdown_to_html() call per token.
                                                            // Full markdown renders when stream ends and message moves to completed list.
                                                            <div class="message-text">{parsed.answer.clone()}</div>
                                                            {(!still_thinking).then(||
                                                                view! { <span class="stream-cursor"></span> }
                                                            )}
                                                        }.into_view()
                                                    }}
                                                </div>
                                            </div>
                                        })}
```

- [ ] **Step 4: Build to confirm it compiles**

```powershell
cd d:\FeralLocalAI\frontend
cargo check 2>&1 | Select-String -Pattern "error\[" | head -30
```

Expected: zero errors. Common error: `streaming_msg` still referenced somewhere — check the meta-pairing code for stray uses and replace with `show_streaming`.

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/pages/chat.rs
git commit -m "feat: streaming display reads streaming_content only, plain text during stream"
```

---

## Task 4: Fix Auto-Scroll — At-Bottom Tracking

**Files:**
- Modify: `frontend/src/pages/chat.rs`

**Context:** The current `create_effect` auto-scrolls unconditionally on every `chat.messages` change (line ~146–154). After Task 2, `chat.messages` no longer changes per-token so that effect is now mostly harmless, but we still need auto-scroll during streaming. We need to: (a) track whether the user is at the scroll bottom, (b) only auto-scroll during streaming if at-bottom, (c) show a `↓ New content` pill when not at bottom during streaming.

- [ ] **Step 1: Add at_bottom signal and scroll listener**

In `ChatPage`, immediately after the `(live_token_count, ...)` signal declarations (around line 136), add:

```rust
let (at_bottom, set_at_bottom) = create_signal(true);

// Register scroll listener once on component mount (no signal reads = runs exactly once).
create_effect(move |_| {
    if let Some(el) = web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.get_element_by_id("feral-chat-scroll"))
        .and_then(|e| e.dyn_into::<web_sys::HtmlElement>().ok())
    {
        let closure = Closure::<dyn FnMut()>::new(move || {
            if let Some(e) = web_sys::window()
                .and_then(|w| w.document())
                .and_then(|d| d.get_element_by_id("feral-chat-scroll"))
                .and_then(|el| el.dyn_into::<web_sys::HtmlElement>().ok())
            {
                let is_at = e.scroll_top() + e.client_height() >= e.scroll_height() - 50;
                set_at_bottom.set(is_at);
            }
        });
        let _ = el.add_event_listener_with_callback("scroll", closure.as_ref().unchecked_ref());
        closure.forget();
    }
});
```

- [ ] **Step 2: Replace the existing auto-scroll effect**

Find the current auto-scroll effect (around lines 146–154):

```rust
// Auto-scroll to bottom when messages update
create_effect(move |_| {
    let _ = chat.messages.get();
    if let Some(el) = web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.get_element_by_id("feral-chat-scroll"))
    {
        el.set_scroll_top(el.scroll_height());
    }
});
```

Replace with two effects:

```rust
// Scroll on new token — but only if user is already at bottom.
create_effect(move |_| {
    let _ = chat.streaming_content.get();
    if at_bottom.get_untracked() {
        if let Some(el) = web_sys::window()
            .and_then(|w| w.document())
            .and_then(|d| d.get_element_by_id("feral-chat-scroll"))
        {
            el.set_scroll_top(el.scroll_height());
        }
    }
});

// Always scroll to bottom when a new message is sent (user sent a message or
// stream completed and messages re-rendered with markdown). Reset at_bottom too.
create_effect(move |_| {
    let _ = chat.messages.get();
    if let Some(el) = web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.get_element_by_id("feral-chat-scroll"))
    {
        el.set_scroll_top(el.scroll_height());
    }
    set_at_bottom.set(true);
});
```

Note: `get_untracked()` inside the streaming_content effect means the effect only re-runs on `streaming_content` changes — not on `at_bottom` changes. This is intentional.

- [ ] **Step 3: Add the ↓ pill button in the view**

Inside the `cx-canvas` `<main>`, just before the `cx-input-bay` div (around line 806), add:

```rust
// ↓ New content pill — shown when user scrolled up during streaming
{move || (busy.get() && !at_bottom.get()).then(|| view! {
    <button
        class="cx-scroll-pill"
        on:click=move |_| {
            if let Some(el) = web_sys::window()
                .and_then(|w| w.document())
                .and_then(|d| d.get_element_by_id("feral-chat-scroll"))
            {
                el.set_scroll_top(el.scroll_height());
                set_at_bottom.set(true);
            }
        }
    >"↓ New content"</button>
})}
```

- [ ] **Step 4: Build to confirm**

```powershell
cd d:\FeralLocalAI\frontend
cargo check 2>&1 | Select-String -Pattern "error\[" | head -30
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/pages/chat.rs
git commit -m "feat: auto-scroll only when at-bottom, add scroll-to-bottom pill during streaming"
```

---

## Task 5: Fix Speed Tracking to Use streaming_content

**Files:**
- Modify: `frontend/src/pages/chat.rs`

**Context:** The existing speed-tracking `create_effect` (around lines 157–187) subscribes to `chat.messages` to find the last assistant content length. After Task 2, `chat.messages` no longer updates per-token, so the effect must switch to `chat.streaming_content` for live updates.

- [ ] **Step 1: Replace the speed-tracking effect**

Find the effect starting with:

```rust
// Token speed tracking: detect first token, count tokens, compute speed on finish
create_effect(move |prev: Option<(bool, String)>| {
    let is_busy = busy.get();
    let last_content = chat.messages.get()
        .into_iter()
        .filter(|m| m.role == "assistant")
        .last()
        .map(|m| m.content)
        .unwrap_or_default();
    ...
```

Replace with:

```rust
// Token speed tracking: subscribes to streaming_content (not chat.messages)
// so it updates per-token during streaming without triggering list re-renders.
create_effect(move |prev: Option<(bool, String)>| {
    let is_busy = busy.get();
    let streaming = chat.streaming_content.get();

    let (prev_busy, prev_content) = prev.unwrap_or((false, String::new()));

    // Detect first token (content transitions from empty to non-empty while busy)
    if is_busy && prev_content.is_empty() && !streaming.is_empty() {
        set_stream_start_ms.set(Some(js_sys::Date::now()));
    }
    // Update live token count each token (rough estimate: 4 chars ≈ 1 token)
    if is_busy && !streaming.is_empty() {
        set_live_token_count.set((streaming.chars().count() / 4).max(1) as u32);
    }
    // When busy transitions false→done: streaming content has been cleared by the batch
    // in main.rs, but live_token_count still holds the final value from the last token.
    if prev_busy && !is_busy {
        let tokens = live_token_count.get_untracked();
        let speed = stream_start_ms.get_untracked()
            .map(|start| {
                let elapsed = (js_sys::Date::now() - start) / 1000.0;
                if elapsed > 0.05 { tokens as f32 / elapsed as f32 } else { 0.0 }
            })
            .unwrap_or(0.0);
        set_ai_meta.update(|v| v.push((format_datetime_now(), tokens, speed)));
        set_stream_start_ms.set(None);
    }

    (is_busy, streaming)
});
```

- [ ] **Step 2: Build to confirm**

```powershell
cd d:\FeralLocalAI\frontend
cargo check 2>&1 | Select-String -Pattern "error\[" | head -20
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```powershell
git add frontend/src/pages/chat.rs
git commit -m "fix: speed tracking subscribes to streaming_content instead of chat.messages"
```

---

## Task 6: Add ↓ Pill CSS

**Files:**
- Modify: `frontend/styles.css`

**Context:** The `stream-cursor` and `cx-stream-dots` CSS already exist. We only need to add styles for the new `cx-scroll-pill` button.

- [ ] **Step 1: Check that stream-cursor blink animation is correct**

Read lines 600–620 of `frontend/styles.css` and confirm `.stream-cursor` has a blink animation. It should look like:

```css
.stream-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: currentColor;
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: feral-blink 0.85s step-end infinite;
}
@keyframes feral-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
```

If the animation exists (already confirmed by grep), no change needed here.

- [ ] **Step 2: Add cx-scroll-pill styles**

Append the following to `frontend/styles.css` before the final closing comment (or at the end of the file):

```css
/* ── Scroll-to-bottom pill (shown when user scrolled up during streaming) ── */
.cx-scroll-pill {
  position: absolute;
  bottom: 100px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  padding: 6px 14px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font);
  cursor: pointer;
  opacity: 0.92;
  transition: opacity var(--t-fast), transform var(--t-fast);
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  animation: feral-fade-in 0.15s ease;
}
.cx-scroll-pill:hover {
  opacity: 1;
  transform: translateX(-50%) translateY(-1px);
}
```

Also ensure the `cx-canvas` or its parent has `position: relative` so the absolute pill positions correctly. The `cx-canvas` is `<main class="cx-canvas">`. Find the `.cx-canvas` rule in styles.css and add `position: relative;` if not already present.

- [ ] **Step 3: Build and visually verify**

```powershell
cd d:\FeralLocalAI
cargo tauri dev 2>&1 | Select-Object -First 5
```

Start a chat, scroll up during a long response. Confirm the `↓ New content` pill appears. Click it and confirm it jumps to bottom. Confirm it disappears when manually scrolled to bottom.

- [ ] **Step 4: Commit**

```powershell
git add frontend/styles.css
git commit -m "feat: add scroll-to-bottom pill CSS for streaming auto-scroll UX"
```

---

## Task 7: Full Build and Smoke Test

**Files:** No changes — verification only.

- [ ] **Step 1: Full release build**

```powershell
cd d:\FeralLocalAI\frontend
cargo build --release 2>&1 | Select-String -Pattern "error\[" | head -20
```

Expected: zero errors.

- [ ] **Step 2: Run the app and test streaming**

```powershell
cd d:\FeralLocalAI
cargo tauri dev
```

Manually verify (checklist):

- [ ] Load a model and send a message
- [ ] Tokens appear one by one without visible chunk-dumping
- [ ] Blinking cursor `|` is visible at the end of the streaming text
- [ ] Cursor disappears immediately when streaming completes
- [ ] Completed message renders with full markdown (bold, code blocks, etc.)
- [ ] Token speed shows in the message footer after completion (e.g. "23 tokens/sec")
- [ ] Scroll stays at bottom as new tokens arrive when already at bottom
- [ ] Scrolling up mid-stream shows the `↓ New content` pill
- [ ] Clicking the pill jumps to bottom and the pill disappears
- [ ] After streaming ends, scrolling back up is smooth with no force-scroll
- [ ] Typing indicator (three dots) shows before first token arrives
- [ ] Opening a second conversation and switching back works normally

- [ ] **Step 3: Test with thinking model (if available)**

Send a message to a model that emits `<think>...</think>` blocks. Verify:
- [ ] Active thinking block is open and labeled "▸ Thinking..." with a cursor
- [ ] Completed thinking blocks collapse properly
- [ ] Answer text appears after thinking block closes

---

## Self-Review

### Spec Coverage Check

| Requirement | Covered by |
|---|---|
| Per-token rendering without batch dumping | Task 2 (streaming_content) + Task 3 (streaming display) |
| No full component re-render per token | Task 3 (outer closure no longer reads chat.messages per-token) |
| Blinking cursor | Already in CSS; Task 3 ensures it's rendered during streaming |
| Cursor disappears on stream end | Task 3: cursor is inside `show_streaming.then(...)` which turns false at end |
| Auto-scroll only when at bottom | Task 4 |
| `↓ New content` pill | Task 4 + Task 6 |
| Pill disappears on manual scroll to bottom | Task 4 (scroll listener sets at_bottom=true) |
| Typing indicator (dots) before first token | Already works; preserved in Task 3 (empty content check) |
| Progressive markdown (plain during stream, markdown on complete) | Task 3 (plain text during) + Task 2 (markdown applied when moved to completed list) |
| CSS transition for markdown switch | Not added — the markdown appears on the completed message naturally via Leptos re-render |
| Token speed counter live during streaming | Task 5 |
| 50+ t/s performance | Task 2+3 eliminate per-token O(n) work |
| Rust backend unchanged | ✅ No backend files modified |
| Message persistence unchanged | ✅ Done handler still saves to sessions |

### Gaps

**Markdown transition (opacity fade):** The spec mentions `transition: opacity 0.15s ease` when plain text switches to markdown at stream end. This is optional polish. The `.message-text` rule in styles.css can have `transition: opacity 0.1s ease` added and a Leptos approach would be to briefly set opacity:0 then 1 — but this requires a separate signal and setTimeout. Skip for now; the switch is instantaneous but not jarring since the text content was already visible.

**Token speed display "during" streaming:** The spec says show it below the streaming message. Currently the live speed is only in `live_token_count` signal but not rendered during streaming. The per-token speed could be shown in a `<div class="cx-mf-speed">` inside the streaming message bubble. This is a minor enhancement not required for the core fix.

**Exact token count (not char/4 estimate):** The `live_token_count` estimate uses `chars().count() / 4`. For accuracy, a `stream_token_count` field in ChatContext could increment by 1 per token event. This is a minor improvement.

### Placeholder Scan

No TBD, TODO, or "similar to Task N" patterns. All code blocks are complete.

### Type Consistency

- `streaming_content: RwSignal<String>` — field name used consistently in context.rs, main.rs (`.update(|s| s.push_str(...))`, `.get()`, `.set(String::new())`), and chat.rs (`.get()` in streaming closure and speed effect)
- `show_streaming: bool` — replaces `streaming_msg: Option<Message>` in chat.rs; `.then(|| view! {...})` used consistently
- `at_bottom: ReadSignal<bool>`, `set_at_bottom: WriteSignal<bool>` — created with `create_signal(true)`, used in scroll listener closure and pill button
- `batch()` — from `use leptos::*` in main.rs; wraps three signal updates in done handler
