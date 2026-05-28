use leptos::*;
use leptos_router::{use_location, A};
use wasm_bindgen::JsCast;
use wasm_bindgen::closure::Closure;
use leptos_router::use_navigate;

use crate::context::{ChatContext, DownloadContext, LayoutContext};

/// Persistent app sidebar. Lives in the root layout shell — survives every
/// route navigation, never re-mounts. Owns nav links, recent-chats list,
/// download progress card, and the Focus Mode toggle (Ctrl+B).
#[component]
pub fn Sidebar() -> impl IntoView {
    let layout = use_context::<LayoutContext>().expect("LayoutContext not provided");
    let chat = use_context::<ChatContext>().expect("ChatContext not provided");
    let dl = use_context::<DownloadContext>().expect("DownloadContext not provided");

    let location = use_location();
    let nav_cls = move |target: &'static str| {
        let path = location.pathname.get();
        let is_active = if target == "/chat" {
            path == "/chat"
        } else if target == "/models" {
            path == "/models"
        } else {
            path == target
        };
        if is_active { "cx-nav-link active" } else { "cx-nav-link" }
    };

    // Ctrl+B keyboard shortcut — registered once at app level via this component
    // (which mounts once in the shell and never unmounts).
    create_effect(move |prev: Option<()>| {
        if prev.is_some() { return; } // run once
        let closure = Closure::<dyn FnMut(_)>::new(move |e: web_sys::KeyboardEvent| {
            if e.ctrl_key() && e.key().to_lowercase() == "b" {
                e.prevent_default();
                layout.toggle();
            }
        });
        if let Some(window) = web_sys::window() {
            let _ = window.add_event_listener_with_callback(
                "keydown",
                closure.as_ref().unchecked_ref(),
            );
        }
        closure.forget();
    });

    // First-paint guard — drop `no-transition` after one tick so the initial
    // collapsed state restored from localStorage doesn't animate in.
    create_effect(move |prev: Option<()>| {
        if prev.is_some() { return; }
        let cb = Closure::<dyn FnMut()>::new(move || {
            layout.no_transition.set(false);
        });
        if let Some(window) = web_sys::window() {
            let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(
                cb.as_ref().unchecked_ref(),
                0,
            );
        }
        cb.forget();
    });

    let aside_cls = move || {
        let mut cls = String::from("cx-sidebar");
        if layout.sidebar_collapsed.get() { cls.push_str(" collapsed"); }
        if layout.no_transition.get() { cls.push_str(" no-transition"); }
        cls
    };

    // Navigate to /chat when interacting with chat-only actions; lets the user
    // start a new chat or pick a recent thread from any page.
    let navigate = use_navigate();

    let new_chat = {
        let navigate = navigate.clone();
        move |_| {
            chat.start_new();
            navigate("/chat", Default::default());
        }
    };

    view! {
        <aside class=aside_cls>
            // ── Brand header: logo + action icons ─────────────────────────────
            <div class="cx-sidebar-header" data-tauri-drag-region="true">
                <span class="cx-sidebar-brand">"Feral"</span>
                <div class="cx-sidebar-header-actions">
                    // Download status icon — badge pulses when active
                    <button class=move || if dl.downloading.get() {
                            "cx-sb-icon-btn cx-sb-icon-btn--active"
                        } else {
                            "cx-sb-icon-btn"
                        } title="Downloads">
                        <svg viewBox="0 0 16 16" width="15" height="15" fill="none"
                            stroke="currentColor" stroke-width="1.4"
                            stroke-linecap="round" stroke-linejoin="round">
                            <path d="M8 2v8M5 7l3 3 3-3"/>
                            <path d="M3 13h10"/>
                        </svg>
                        {move || dl.downloading.get().then(|| view! {
                            <span class="cx-sb-icon-badge"></span>
                        })}
                    </button>
                    // Focus mode / sidebar collapse
                    <button class="cx-sb-icon-btn" title="Toggle sidebar (Ctrl+B)"
                        on:click=move |_| layout.toggle()>
                        <svg viewBox="0 0 16 16" width="15" height="15" fill="none"
                            stroke="currentColor" stroke-width="1.4"
                            stroke-linecap="round" stroke-linejoin="round">
                            <rect x="2" y="2" width="12" height="12" rx="2"/>
                            <line x1="6" y1="2" x2="6" y2="14"/>
                        </svg>
                    </button>
                </div>
            </div>

            <button class="cx-new-chat-full" on:click=new_chat>
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none"
                    stroke="currentColor" stroke-width="1.5"
                    stroke-linecap="round" stroke-linejoin="round">
                    <line x1="8" y1="3" x2="8" y2="13"/>
                    <line x1="3" y1="8" x2="13" y2="8"/>
                </svg>
                <span class="cx-nav-label">"New Chat"</span>
                <span class="cx-nav-shortcut">"Ctrl N"</span>
            </button>

            <div class="cx-drawer-nav">
                <A href="/chat" class=move || nav_cls("/chat")>
                    <svg viewBox="0 0 16 16" width="16" height="16" fill="none"
                        stroke="currentColor" stroke-width="1.5"
                        stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 3h10a1 1 0 011 1v6a1 1 0 01-1 1H9l-3 2v-2H3a1 1 0 01-1-1V4a1 1 0 011-1z"/>
                    </svg>
                    <span class="cx-nav-label">"Chat"</span>
                </A>
                <A href="/models" class=move || nav_cls("/models")>
                    <svg viewBox="0 0 16 16" width="16" height="16" fill="none"
                        stroke="currentColor" stroke-width="1.5"
                        stroke-linecap="round" stroke-linejoin="round">
                        <path d="M8 2l6 3.5v5L8 14 2 10.5v-5z"/>
                        <path d="M2 5.5l6 3.5 6-3.5"/>
                        <line x1="8" y1="9" x2="8" y2="14"/>
                    </svg>
                    <span class="cx-nav-label">"Models"</span>
                </A>
                <A href="/agents" class=move || nav_cls("/agents")>
                    <svg viewBox="0 0 16 16" width="16" height="16" fill="none"
                        stroke="currentColor" stroke-width="1.5"
                        stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="8" cy="5.5" r="2.5"/>
                        <path d="M2 14c0-2.8 2.7-5 6-5s6 2.2 6 5"/>
                    </svg>
                    <span class="cx-nav-label">"Assistants"</span>
                </A>
                <A href="/settings" class=move || nav_cls("/settings")>
                    <svg viewBox="0 0 16 16" width="16" height="16" fill="none"
                        stroke="currentColor" stroke-width="1.5"
                        stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="8" cy="8" r="2.5"/>
                        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M11.4 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4"/>
                    </svg>
                    <span class="cx-nav-label">"Settings"</span>
                </A>
            </div>

            <div class="cx-drawer-section">
                <div class="cx-thread-group">
                    <div class="cx-thread-group-header">
                        <span class="cx-thread-group-label">"Recent"</span>
                        <button class="cx-thread-more-btn" title="More">"···"</button>
                    </div>
                    <div class="cx-hist-list">
                        {move || {
                            let convs = chat.history.get();
                            let active = chat.active_session_id.get();
                            if convs.is_empty() {
                                view! { <div class="cx-hist-empty">"No conversations yet"</div> }.into_view()
                            } else {
                                let nav = navigate.clone();
                                convs.into_iter().rev().map(|s| {
                                    let is_active = active.as_ref() == Some(&s.id);
                                    let title = s.title.clone();
                                    let id = s.id.clone();
                                    let nav = nav.clone();
                                    view! {
                                        <div
                                            class=if is_active { "cx-hist-item active" } else { "cx-hist-item" }
                                            on:click=move |_| {
                                                chat.load_session(id.clone());
                                                nav("/chat", Default::default());
                                            }
                                        >
                                            <span class="cx-hist-name">{title}</span>
                                        </div>
                                    }.into_view()
                                }).collect_view()
                            }
                        }}
                    </div>
                </div>
            </div>

            // ── Download progress card (only while a download is active) ─────────
            {move || dl.downloading.get().then(|| view! {
                <div class="cx-sidebar-dl">
                    <div class="cx-sidebar-dl-name">{move || {
                        let raw = dl.model_name.get();
                        if raw.chars().count() > 22 {
                            format!("{}…", raw.chars().take(22).collect::<String>())
                        } else {
                            raw
                        }
                    }}</div>
                    <div class="cx-sidebar-dl-label">
                        "Downloading · "
                        {move || format!("{:.0}%", dl.progress.get() * 100.0)}
                    </div>
                    <div class="cx-sidebar-dl-track">
                        <div
                            class="cx-sidebar-dl-fill"
                            style=move || format!("width:{:.1}%", dl.progress.get() * 100.0)
                        ></div>
                    </div>
                </div>
            })}

            <div class="cx-sidebar-footer">"v0.1.0"</div>
        </aside>
    }
}
