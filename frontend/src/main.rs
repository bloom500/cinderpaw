use leptos::*;
use leptos_router::*;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use js_sys;

mod context;
mod tauri_bridge;
mod pages;

use context::{ChatContext, ChatSessionSummary, DownloadContext, LayoutContext, ModelLoadContext, PersistedSummary};
use pages::{agents::AgentsPage, chat::ChatPage, models::ModelsPage, settings::SettingsPage};
use pages::components::sidebar::Sidebar;
use pages::components::hw_notification::HwNotification;
use pages::types::Message;

fn session_title(msgs: &[Message]) -> String {
    msgs.iter()
        .find(|m| m.role == "user")
        .map(|m| {
            let t = m.content.trim();
            let end = t.char_indices().nth(38).map(|(i, _)| i).unwrap_or(t.len());
            if t.len() > end { format!("{}…", &t[..end]) } else { t.to_string() }
        })
        .unwrap_or_else(|| "Conversation".into())
}

fn main() {
    console_error_panic_hook::set_once();
    let document = web_sys::window().unwrap().document().unwrap();
    let app_el = document.query_selector("#app").unwrap().unwrap();
    leptos::mount_to(app_el.unchecked_into(), || view! { <App/> });
}

#[component]
fn App() -> impl IntoView {
    let dl = DownloadContext {
        downloading: create_rw_signal(false),
        progress:    create_rw_signal(0.0f32),
        model_name:  create_rw_signal(String::new()),
        dl_id:       create_rw_signal(None::<String>),
        dl_done:     create_rw_signal(false),
        dl_error:    create_rw_signal(None::<String>),
    };
    provide_context(dl);

    let chat = ChatContext::new();
    provide_context(chat);

    let model_load = ModelLoadContext::new();
    provide_context(model_load);

    // ── Boot hydration: load conversation history from disk ───────────────────
    wasm_bindgen_futures::spawn_local(async move {
        if let Ok(summaries) = tauri_bridge::invoke::<Vec<PersistedSummary>>(
            "load_conversations",
            &serde_json::json!({}),
        ).await {
            // Sort newest-first by updated_at (lexicographic ISO-8601 works correctly)
            let mut sorted = summaries;
            sorted.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

            chat.history.update(|h| {
                for s in sorted {
                    if !h.iter().any(|e| e.id == s.id) {
                        h.push(ChatSessionSummary { id: s.id, title: s.title });
                    }
                }
            });
        }
    });

    let layout = LayoutContext::new();
    provide_context(layout);

    // Listeners live for the entire app lifetime (closures are forgotten intentionally).
    tauri_bridge::listen("feral://download-progress", move |evt: JsValue| {
        if let Ok(obj) = serde_wasm_bindgen::from_value::<serde_json::Value>(evt) {
            if let Some(p) = obj.get("payload")
                .and_then(|p| p.get("progress"))
                .and_then(|p| p.as_f64())
            {
                dl.progress.set(p as f32);
                if !dl.downloading.get_untracked() {
                    dl.downloading.set(true);
                }
            }
        }
    });

    tauri_bridge::listen("feral://download-complete", move |_: JsValue| {
        dl.downloading.set(false);
        dl.progress.set(1.0);
        dl.dl_done.set(true);
        dl.dl_id.set(None);
        dl.dl_error.set(None);
    });

    // Stream token listeners — registered ONCE at app level to prevent duplicate
    // listener accumulation when ChatPage mounts/unmounts across navigation.
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
                        // Background session: append to a plain HashMap buffer (no
                        // signal write). Flushed into `sessions` on stream-done or
                        // when the user navigates back via load_session.
                        chat.bg_buffers.update_value(|b| {
                            b.entry(tok_session).or_default().push_str(&tok);
                        });
                    }
                }
            }
        }
    });

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
                chat.sessions.update(|s| { s.insert(done_session.clone(), msgs.clone()); });
                chat.history.update(|h| {
                    if let Some(entry) = h.iter_mut().find(|s| s.id == done_session) {
                        entry.title = title.clone();
                    } else {
                        h.push(ChatSessionSummary { id: done_session.clone(), title: title.clone() });
                    }
                });

                // Persist to disk immediately — no buffering
                let persist_id = done_session.clone();
                let persist_title = title;
                let persist_msgs = msgs;
                wasm_bindgen_futures::spawn_local(async move {
                    let _ = tauri_bridge::invoke_unit("save_conversation", &serde_json::json!({
                        "id": persist_id,
                        "title": persist_title,
                        "messages": persist_msgs,
                    })).await;
                });
            }
        } else if !done_session.is_empty() {
            // Stream completed for a background session — flush accumulated
            // tokens into sessions, then update title.
            chat.flush_bg_buffer(&done_session);
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

    tauri_bridge::listen("feral://stream-error", move |evt: JsValue| {
        let err_session = serde_wasm_bindgen::from_value::<serde_json::Value>(evt).ok()
            .and_then(|obj| obj.get("payload")?.get("session_id")?.as_str().map(str::to_string))
            .unwrap_or_default();
        if chat.active_session_id.get().as_deref() == Some(&err_session) {
            chat.busy.set(false);
        }
    });

    tauri_bridge::listen("feral://download-error", move |evt: JsValue| {
        dl.downloading.set(false);
        dl.progress.set(0.0);
        dl.dl_id.set(None);
        if let Ok(obj) = serde_wasm_bindgen::from_value::<serde_json::Value>(evt) {
            let payload = obj.get("payload");
            let cancelled = payload
                .and_then(|p| p.get("cancelled"))
                .and_then(|c| c.as_bool())
                .unwrap_or(false);
            if cancelled {
                dl.dl_error.set(None);
            } else {
                let err = payload
                    .and_then(|p| p.get("error"))
                    .and_then(|e| e.as_str())
                    .unwrap_or("Download failed")
                    .to_string();
                dl.dl_error.set(Some(err));
            }
        }
    });

    // Global model-load-progress listener — handles both chat pill and models page.
    tauri_bridge::listen("model-load-progress", move |evt: JsValue| {
        if let Ok(obj) = serde_wasm_bindgen::from_value::<serde_json::Value>(evt) {
            if let Some(p) = obj.get("payload") {
                if let Some(pct) = p.get("percentage").and_then(|v| v.as_f64()) {
                    model_load.progress.set(pct);
                    if (pct - 100.0).abs() < f64::EPSILON {
                        model_load.loading.set(false);
                    }
                }
                if let Some(txt) = p.get("status_text").and_then(|v| v.as_str()) {
                    model_load.status.set(txt.to_string());
                }
            }
        }
    });

    // ── Persistent Layout Shell ─────────────────────────────────────────────────
    // <Sidebar/> mounts ONCE at app boot and never re-renders across navigation.
    // <Routes/> swaps only the inner page view inside <main class="app-main">.
    view! {
        <Router>
            // ── Custom titlebar (replaces native OS bar) ──────────────────────
            <div class="app-titlebar" data-tauri-drag-region="true">
                <div class="app-titlebar-drag" data-tauri-drag-region="true"></div>
                <div class="app-titlebar-btns">
                    <button class="app-tb-btn app-tb-min" title="Minimize"
                        on:click=|_| { let _ = js_sys::eval("window.__TAURI__.window.getCurrentWindow().minimize()"); }>
                        <span></span>
                    </button>
                    <button class="app-tb-btn app-tb-max" title="Maximize"
                        on:click=|_| { let _ = js_sys::eval("window.__TAURI__.window.getCurrentWindow().toggleMaximize()"); }>
                        <span></span>
                    </button>
                    <button class="app-tb-btn app-tb-close" title="Close"
                        on:click=|_| { let _ = js_sys::eval("window.__TAURI__.window.getCurrentWindow().close()"); }>
                        <span></span>
                    </button>
                </div>
            </div>
            <div class="app-shell">
                <Sidebar/>
                <main class="app-main">
                    <HwNotification/>
                    <Routes>
                        <Route path="/" view=ChatPage/>
                        <Route path="/chat" view=ChatPage/>
                        <Route path="/models" view=ModelsPage/>
                        <Route path="/agents" view=AgentsPage/>
                        <Route path="/settings" view=SettingsPage/>
                    </Routes>
                </main>
            </div>
        </Router>
    }
}
