use leptos::*;
use leptos_router::*;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

mod context;
mod tauri_bridge;
mod pages;

use context::{ChatContext, ChatSessionSummary, DownloadContext};
use pages::{agents::AgentsPage, chat::ChatPage, models::ModelsPage, settings::SettingsPage};
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

    view! {
        <Router>
            <div class="layout">
                <Sidebar/>
                <main class="main">
                    <Routes>
                        <Route path="/" view=ModelsPage/>
                        <Route path="/models" view=ModelsPage/>
                        <Route path="/chat" view=ChatPage/>
                        <Route path="/agents" view=AgentsPage/>
                        <Route path="/settings" view=SettingsPage/>
                    </Routes>
                </main>
            </div>
        </Router>
    }
}

#[component]
fn Sidebar() -> impl IntoView {
    let dl = use_context::<DownloadContext>().expect("DownloadContext not provided");
    let chat = use_context::<ChatContext>().expect("ChatContext not provided");

    view! {
        <aside class="sidebar">
            <div class="brand">"FERAL"</div>
            <NavItem href="/models" icon="◧" label="Models"/>
            <NavItem href="/chat" icon="✦" label="Chat"/>
            <NavItem href="/agents" icon="⚙" label="Agents"/>
            <NavItem href="/settings" icon="⚒" label="Settings"/>

            <div class="sidebar-spacer"></div>

            {move || {
                let history: Vec<_> = chat.history.get().iter().rev().map(|s| {
                    let title = s.title.clone();
                    view! {
                        <A href="/chat" class="sidebar-chat-item">{title}</A>
                    }.into_view()
                }).collect();
                if history.is_empty() {
                    view! { <span></span> }.into_view()
                } else {
                    view! {
                        <div class="sidebar-chat-hist">
                            <div class="sidebar-chat-hist-label">"Recent Chats"</div>
                            {history}
                        </div>
                    }.into_view()
                }
            }}

            {move || dl.downloading.get().then(|| view! {
                <div class="sidebar-dl">
                    <div class="sidebar-dl-name">{move || {
                        let raw = dl.model_name.get();
                        if raw.chars().count() > 20 {
                            format!("{}…", raw.chars().take(20).collect::<String>())
                        } else {
                            raw
                        }
                    }}</div>
                    <div class="sidebar-dl-label">
                        "Downloading · "
                        {move || format!("{:.0}%", dl.progress.get() * 100.0)}
                    </div>
                    <div class="sidebar-dl-track">
                        <div
                            class="sidebar-dl-fill"
                            style=move || format!("width:{:.1}%", dl.progress.get() * 100.0)
                        ></div>
                    </div>
                </div>
            })}
        </aside>
    }
}

#[component]
fn NavItem(href: &'static str, icon: &'static str, label: &'static str) -> impl IntoView {
    view! {
        <A href=href class="nav-link" active_class="active">
            <span class="nav-icon">{icon}</span>
            <span>{label}</span>
        </A>
    }
}
