use leptos::*;
use leptos_router::{A, use_navigate};
use pulldown_cmark::{html, Options, Parser};
use serde_json::json;
use wasm_bindgen::JsCast;
use wasm_bindgen::closure::Closure;
use web_sys::{HtmlElement, HtmlTextAreaElement, MouseEvent, KeyboardEvent};

use crate::context::{ChatContext, ChatSessionSummary, LayoutContext};
use crate::pages::types::{InferParams, LoadedModel, Message, ModelInfo};
use crate::pages::models::ByokProviderInfo;
use crate::tauri_bridge;

struct ParsedMessage {
    /// Completed <think>…</think> blocks
    thinking: Vec<String>,
    /// Partial content currently being streamed inside an unclosed <think> block
    current_think: String,
    /// Content outside think blocks (the actual answer)
    answer: String,
    /// True while streaming is still inside a <think> block
    still_thinking: bool,
}

/// If the markdown text has an odd number of fenced code block openers (```),
/// append a closing fence so the parser doesn't leave an open <pre> block.
fn close_open_code_blocks(md: &str) -> std::borrow::Cow<str> {
    let count = md.split("```").count() - 1; // n occurrences = n+1 parts → count = n
    if count % 2 == 1 {
        std::borrow::Cow::Owned(format!("{}\n```", md))
    } else {
        std::borrow::Cow::Borrowed(md)
    }
}

fn markdown_to_html(md: &str) -> String {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_TASKLISTS);
    let parser = Parser::new_ext(md, opts);
    let mut output = String::new();
    html::push_html(&mut output, parser);
    output
}

fn parse_think(content: &str) -> ParsedMessage {
    let mut thinking: Vec<String> = Vec::new();
    let mut answer = String::new();
    let mut current_think = String::new();
    let mut in_think = false;
    let mut rest = content;

    loop {
        if in_think {
            match rest.find("</think>") {
                Some(pos) => {
                    current_think.push_str(&rest[..pos]);
                    thinking.push(std::mem::take(&mut current_think));
                    rest = &rest[pos + 8..];
                    in_think = false;
                }
                None => {
                    current_think.push_str(rest);
                    break;
                }
            }
        } else {
            match rest.find("<think>") {
                Some(pos) => {
                    answer.push_str(&rest[..pos]);
                    rest = &rest[pos + 7..];
                    in_think = true;
                }
                None => {
                    answer.push_str(rest);
                    break;
                }
            }
        }
    }

    ParsedMessage {
        thinking,
        current_think,
        answer: answer.trim_start().to_string(),
        still_thinking: in_think,
    }
}


fn format_time_now() -> String {
    let date = js_sys::Date::new_0();
    let mut h = date.get_hours() as u32;
    let m = date.get_minutes() as u32;
    let suffix = if h >= 12 { "PM" } else { "AM" };
    h = if h == 0 { 12 } else if h > 12 { h - 12 } else { h };
    format!("{}:{:02} {}", h, m, suffix)
}

fn format_datetime_now() -> String {
    let date = js_sys::Date::new_0();
    let months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let month = months[date.get_month() as usize];
    let day = date.get_date();
    let year = date.get_full_year();
    let mut h = date.get_hours() as u32;
    let m = date.get_minutes() as u32;
    let suffix = if h >= 12 { "PM" } else { "AM" };
    h = if h == 0 { 12 } else if h > 12 { h - 12 } else { h };
    format!("{} {}, {}, {}:{:02} {}", month, day, year, h, m, suffix)
}

fn strip_model_name(name: &str) -> String {
    let n = name.to_lowercase();
    let n = n.trim_end_matches(".gguf");
    let n = if let Some(idx) = n.rfind('.') {
        let suffix = &n[idx + 1..];
        if suffix.starts_with('q') || suffix.starts_with('f') { &n[..idx] } else { n }
    } else { n };
    n.to_string()
}

#[component]
pub fn ChatPage() -> impl IntoView {
    let (loaded, set_loaded) = create_signal::<Option<LoadedModel>>(None);

    // Global chat context
    let chat = use_context::<ChatContext>().expect("ChatContext not provided");
    // Global layout context (sidebar collapse state — owned by the shell)
    let layout = use_context::<LayoutContext>().expect("LayoutContext not provided");

    // Local UI state
    let (input, set_input) = create_signal(String::new());
    let (system_prompt, set_system_prompt) = create_signal(String::new());
    let busy = chat.busy;

    let (controls_open, set_controls_open) = create_signal(false);
    let (temp, set_temp) = create_signal(0.7f32);
    let (max_tokens, set_max_tokens) = create_signal(4096u32);
    let (top_p, set_top_p) = create_signal(0.95f32);
    let (repeat, set_repeat) = create_signal(1.1f32);
    let (gpu_layers, set_gpu_layers) = create_signal(100i32);

    // Per-completed-AI-message metadata lives in the chat context now so it survives
    // navigation between pages without resetting.
    let ai_meta = chat.ai_meta;
    let set_ai_meta = chat.ai_meta;
    let (stream_start_ms, set_stream_start_ms) = create_signal::<Option<f64>>(None);
    let (live_token_count, set_live_token_count) = create_signal::<u32>(0);
    let (ctx_open, set_ctx_open) = create_signal(false);
    let (at_bottom, set_at_bottom) = create_signal(true);

    // Model selector dropdown
    let (model_dd_open, set_model_dd_open) = create_signal(false);
    let (local_models, set_local_models) = create_signal::<Vec<ModelInfo>>(vec![]);
    let (byok_providers, set_byok_providers) = create_signal::<Vec<ByokProviderInfo>>(vec![]);
    let (loading_pill, set_loading_pill) = create_signal(false);
    let navigate = use_navigate();

    // Register scroll listener once on component mount (no signal reads inside = runs exactly once).
    create_effect(move |_| {
        if let Some(el) = web_sys::window()
            .and_then(|w| w.document())
            .and_then(|d| d.get_element_by_id("feral-chat-scroll"))
            .and_then(|e| e.dyn_into::<HtmlElement>().ok())
        {
            let closure = Closure::<dyn FnMut()>::new(move || {
                if let Some(e) = web_sys::window()
                    .and_then(|w| w.document())
                    .and_then(|d| d.get_element_by_id("feral-chat-scroll"))
                    .and_then(|el| el.dyn_into::<HtmlElement>().ok())
                {
                    let is_at = e.scroll_top() + e.client_height() >= e.scroll_height() - 50;
                    set_at_bottom.set(is_at);
                }
            });
            let _ = el.add_event_listener_with_callback("scroll", closure.as_ref().unchecked_ref());
            closure.forget();
        }
    });

    // Load active model on mount
    spawn_local(async move {
        if let Ok(l) = tauri_bridge::invoke::<Option<LoadedModel>>("get_loaded_model", json!({})).await {
            set_loaded.set(l);
        }
    });

    // Scroll on new token — but only if user is already at the scroll bottom.
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

    // Always scroll to bottom when messages change (new message sent or stream completed).
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
        // When busy transitions to false: streaming content has been cleared by the batch
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

    // Conversation save / new / load are owned by ChatContext now (called from
    // the global Sidebar). They stay reachable from here only via `chat.*` if
    // ever needed; no local closures required.
    let send = move |_: ()| {
        let user_msg = input.get();
        if user_msg.is_empty() || busy.get() { return; }
        set_input.set(String::new());
        busy.set(true);

        if chat.active_session_id.get().is_none() {
            let new_id = uuid::Uuid::new_v4().to_string();
            chat.history.update(|h| {
                h.push(ChatSessionSummary { id: new_id.clone(), title: "New Conversation".into() });
            });
            chat.active_session_id.set(Some(new_id));
        }

        let mut msgs = chat.messages.get();
        let sys = system_prompt.get();
        if !sys.is_empty() && !msgs.iter().any(|m| m.role == "system") {
            msgs.insert(0, Message { role: "system".into(), content: sys });
        }
        msgs.push(Message { role: "user".into(), content: user_msg });

        // inference_msgs must NOT include the empty assistant placeholder —
        // build_prompt would emit a completed empty assistant turn which causes
        // most models to immediately sample an EOG token and produce no output.
        let inference_msgs = msgs.clone();

        // Push the UI placeholder AFTER cloning for inference.
        msgs.push(Message { role: "assistant".into(), content: String::new() });
        chat.messages.set(msgs.clone());

        let params = InferParams {
            temperature: temp.get(),
            top_p: top_p.get(),
            repeat_penalty: repeat.get(),
            max_tokens: max_tokens.get(),
            system_prompt: None,
        };

        let sid = chat.active_session_id.get().unwrap_or_default();
        spawn_local(async move {
            if let Err(e) = tauri_bridge::invoke::<()>(
                "chat_stream",
                json!({ "messages": inference_msgs, "params": params, "sessionId": sid }),
            ).await {
                busy.set(false);
                web_sys::console::error_1(&format!("chat_stream: {}", e).into());
            }
        });
    };

    // True when input is long enough to switch to file-chip mode.
    // Must be a memo (not inline) because > inside view! attributes is parsed as closing tag.
    let chip_mode = create_memo(move |_| input.get().len() > 1000);

    // Pre-built closures for response style pill classes (rstml can't parse > / && in attrs)
    let style_precise_cls = move || {
        let t = temp.get();
        if t <= 0.45 { "ctrl-style-pill active" } else { "ctrl-style-pill" }
    };
    let style_balanced_cls = move || {
        let t = temp.get();
        let in_range = t > 0.45 && t <= 0.9;
        if in_range { "ctrl-style-pill active" } else { "ctrl-style-pill" }
    };
    let style_creative_cls = move || {
        let t = temp.get();
        if t > 0.9 { "ctrl-style-pill active" } else { "ctrl-style-pill" }
    };

    // Derived: are there any visible (non-system) messages?
    let has_messages = move || chat.messages.get().iter().any(|m| m.role != "system");

    // Short model name for the pill badge (strips .gguf and quant suffix)
    let pill_model_name = move || {
        loaded.get()
            .map(|l| strip_model_name(&l.name))
            .unwrap_or_else(|| "no model".into())
    };

    view! {
        <div class="cx-root">

            // ── RIGHT COLUMN (topbar + canvas) — flex column inside the app shell ──
            <div class="cx-right-col">

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

                    <div class="cx-pill-wrapper">
                        <div class="cx-tpill">
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
                                    {move || if loading_pill.get() { "Loading\u{2026}".to_string() } else { pill_model_name() }}
                                </span>
                            </button>
                            <div class="cx-pill-sep"></div>
                            <button class="cx-pill-right"
                                on:click=move |_| set_controls_open.update(|v| *v = !*v)
                                title="Controls"
                            >
                                <span class="cx-gear">"⚙"</span>
                            </button>
                        </div>

                        {move || model_dd_open.get().then(|| view! {
                            <div class="cx-dd-overlay"
                                on:click=move |_| set_model_dd_open.set(false)
                            ></div>
                        })}

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
                                        {if is_active { Some(view! { <span class="cx-dd-check">"✓"</span> }) } else { None }}
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
            </div>

            // ── MAIN CANVAS ──────────────────────────────────────────────
            <main class=move || if has_messages() { "cx-canvas" } else { "cx-canvas cx-canvas--empty" }>

                // Spacer above — expands when empty to push content to center
                <div class="cx-v-spacer cx-v-spacer--top"></div>

                // ── BODY: scrollable zone (messages OR empty mascot) ──────
                <div class="cx-body" id="feral-chat-scroll">
                    {move || if has_messages() {
                        view! {
                            <div class="cx-msgs">
                                {move || {
                                    // Snapshot messages once. Split into:
                                    //   - completed: all messages except the last assistant when busy
                                    //   - streaming: the last assistant message while busy (rendered
                                    //     in its own reactive closure so only IT re-renders per token)
                                    let msgs = chat.messages.get();
                                    let is_busy = busy.get();
                                    let visible: Vec<_> = msgs.into_iter()
                                        .filter(|m| m.role != "system")
                                        .collect();

                                    let (completed, show_streaming) =
                                        if is_busy
                                            && visible.last().map(|m| m.role == "assistant").unwrap_or(false)
                                        {
                                            (&visible[..visible.len() - 1], true)
                                        } else {
                                            (&visible[..], false)
                                        };

                                    // Pre-pair messages with metadata for Jan-style footer
                                    let meta_snap = ai_meta.get();
                                    let mut ai_count = 0usize;
                                    let completed_with_meta: Vec<_> = completed.iter().map(|m| {
                                        if m.role == "assistant" {
                                            let t = (m.content.chars().count() / 4).max(1) as u32;
                                            let meta = meta_snap.get(ai_count).cloned()
                                                .unwrap_or_else(|| (String::new(), t, 0.0));
                                            ai_count += 1;
                                            (m.clone(), Some(meta))
                                        } else {
                                            (m.clone(), None)
                                        }
                                    }).collect();
                                    // Index of last AI message (its footer stays visible)
                                    let last_ai_idx = completed_with_meta.iter()
                                        .enumerate()
                                        .filter(|(_, (m, _))| m.role == "assistant")
                                        .last()
                                        .map(|(i, _)| i);

                                    view! {
                                        // ── Completed messages
                                        {completed_with_meta.into_iter().enumerate().map(|(msg_idx, (m, meta))| {
                                            if m.role == "user" {
                                                view! {
                                                    <div class="msg-row msg-user">
                                                        <div class="bubble-user">{m.content.clone()}</div>
                                                    </div>
                                                }.into_view()
                                            } else {
                                                let parsed = parse_think(&m.content);
                                                let partial = parsed.current_think.clone();
                                                let answer_for_copy = parsed.answer.clone();
                                                let (dt, toks, speed) = meta.unwrap_or_else(|| {
                                                    let t = (m.content.chars().count() / 4).max(1) as u32;
                                                    (format_datetime_now(), t, 0.0)
                                                });
                                                let has_speed = speed > 0.5;
                                                let speed_label = format!("{:.0} tokens/sec", speed);
                                                let tokens_label = format!("({} tokens)", toks);
                                                let footer_cls = if last_ai_idx == Some(msg_idx) && !is_busy {
                                                    "cx-msg-footer visible"
                                                } else {
                                                    "cx-msg-footer"
                                                };
                                                view! {
                                                    <div class="msg-row msg-ai">
                                                        <div class="bubble-ai">
                                                            {parsed.thinking.into_iter().filter(|t| !t.trim().is_empty()).map(|t| view! {
                                                                <details class="thinking-container">
                                                                    <summary>
                                                                        <span class="thinking-chevron"></span>
                                                                        "Thinking"
                                                                    </summary>
                                                                    <div class="thinking-content">{t}</div>
                                                                </details>
                                                            }).collect_view()}
                                                            {(!partial.trim().is_empty()).then(|| view! {
                                                                <details class="thinking-container">
                                                                    <summary>
                                                                        <span class="thinking-chevron"></span>
                                                                        "Thinking"
                                                                    </summary>
                                                                    <div class="thinking-content">{partial}</div>
                                                                </details>
                                                            })}
                                                            <div class="message-text" inner_html={markdown_to_html(&parsed.answer)}></div>
                                                        </div>
                                                        // ── Jan-style footer: time | actions | speed | tokens
                                                        <div class={footer_cls}>
                                                            <span class="cx-mf-time">{dt}</span>
                                                            <div class="cx-mf-actions">
                                                                <button class="cx-mf-btn" title="Copy"
                                                                    on:click=move |_| {
                                                                        if let Some(clip) = web_sys::window().map(|w| w.navigator().clipboard()) {
                                                                            let _ = clip.write_text(&answer_for_copy);
                                                                        }
                                                                    }>
                                                                    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                                                                        <path d="M9 1H3a1 1 0 00-1 1v8"/>
                                                                        <rect x="5" y="4" width="7" height="9" rx="1"/>
                                                                    </svg>
                                                                </button>
                                                                <button class="cx-mf-btn" title="Edit">
                                                                    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                                                                        <path d="M10 2l2 2-7 7H3v-2l7-7z"/>
                                                                    </svg>
                                                                </button>
                                                                <button class="cx-mf-btn" title="Delete">
                                                                    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                                                                        <polyline points="2,4 12,4"/>
                                                                        <path d="M5 4V2h4v2M4 4l.7 8h4.6L10 4"/>
                                                                    </svg>
                                                                </button>
                                                                <button class="cx-mf-btn" title="Regenerate">
                                                                    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                                                                        <path d="M12 7A5 5 0 102 7"/>
                                                                        <polyline points="12,3 12,7 8,7"/>
                                                                    </svg>
                                                                </button>
                                                            </div>
                                                            <div style="flex:1"></div>
                                                            {has_speed.then(|| view! {
                                                                <div class="cx-mf-speed">
                                                                    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                                                                        <path d="M1.5 9.5A5.5 5.5 0 0112.5 9.5"/>
                                                                        <line x1="7" y1="9.5" x2="10.5" y2="4.5"/>
                                                                        <circle cx="7" cy="9.5" r="0.8" fill="currentColor" stroke="none"/>
                                                                    </svg>
                                                                    <span>{speed_label}</span>
                                                                </div>
                                                            })}
                                                            <span class="cx-mf-tokens">{tokens_label}</span>
                                                        </div>
                                                    </div>
                                                }.into_view()
                                            }
                                        }).collect_view()}

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
                                                                        <span class="thinking-chevron"></span>
                                                                        "Thinking"
                                                                    </summary>
                                                                    <div class="thinking-content">{t}</div>
                                                                </details>
                                                            }).collect_view()}
                                                            {still_thinking.then(|| view! {
                                                                <details class="thinking-container thinking-live" open>
                                                                    <summary>
                                                                        <span class="thinking-dot thinking-dot--pulse"></span>
                                                                        "Thinking..."
                                                                        <span class="stream-cursor"></span>
                                                                    </summary>
                                                                    <div class="thinking-content">{current}</div>
                                                                </details>
                                                            })}
                                                            // Render markdown during streaming with open code-block protection.
                                                            <div class="message-text" inner_html={markdown_to_html(&close_open_code_blocks(&parsed.answer))}></div>
                                                            {(!still_thinking).then(||
                                                                view! { <span class="stream-cursor"></span> }
                                                            )}
                                                        }.into_view()
                                                    }}
                                                </div>
                                            </div>
                                        })}
                                    }
                                }}
                            </div>
                        }.into_view()
                    } else {
                        view! { <div></div> }.into_view()
                    }}
                </div>

                // ── EMPTY INLINE: greeting + chips, shown as sibling when no messages
                {move || (!has_messages()).then(|| {
                    let suggestions = ["Explain something complex", "Help me write code", "Summarize a document"];
                    view! {
                        <div class="cx-empty-inline">
                            <div class="cx-empty-prompt">"What's on your mind?"</div>
                            <div class="cx-empty-chips">
                                {suggestions.iter().map(|s| {
                                    let label: &'static str = s;
                                    view! {
                                        <button class="cx-empty-chip"
                                            on:click=move |_| {
                                                set_input.set(label.to_string());
                                                if let Some(el) = web_sys::window()
                                                    .and_then(|w| w.document())
                                                    .and_then(|d| d.query_selector(".cx-pill-textarea").ok().flatten())
                                                {
                                                    if let Ok(ta) = el.dyn_into::<HtmlTextAreaElement>() {
                                                        let _ = ta.focus();
                                                    }
                                                }
                                            }>
                                            {label}
                                        </button>
                                    }
                                }).collect_view()}
                            </div>
                        </div>
                    }
                })}

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

                // ── INPUT: fixed at bottom, in flow (not absolute) ────────
                <div class="cx-input-bay">
                    <div class="cx-pill">

                        // Textarea is ALWAYS in the DOM — never conditionally rendered.
                        // Destroying/recreating it on each keystroke (via a reactive block)
                        // would lose focus after every character typed.
                        <textarea
                            class="cx-pill-textarea"
                            class:cx-hidden=move || chip_mode.get()
                            placeholder="Ask me anything..."
                            rows="1"
                            prop:value=move || input.get()
                            on:input=move |e| {
                                let val = event_target_value(&e);
                                set_input.set(val);
                                if let Some(ta) = e.target()
                                    .and_then(|t| t.dyn_into::<HtmlTextAreaElement>().ok())
                                {
                                    let style = ta.style();
                                    let _ = style.set_property("height", "auto");
                                    let h = ta.scroll_height();
                                    let _ = style.set_property("height", &format!("{}px", h));
                                }
                            }
                            on:keydown=move |e: KeyboardEvent| {
                                if e.key() == "Enter" && !e.shift_key() {
                                    e.prevent_default();
                                    send(());
                                }
                            }></textarea>

                        // File chip — separate reactive block, does NOT touch the textarea.
                        {move || {
                            let text = input.get();
                            if chip_mode.get() {
                                let preview: String = text.chars().take(72).collect();
                                let preview = if text.chars().count() > 72 {
                                    format!("{}…", preview)
                                } else {
                                    preview
                                };
                                let char_count = text.len();
                                Some(view! {
                                    <div class="cx-file-chip">
                                        <div class="cx-file-icon"><span>"📄"</span></div>
                                        <div class="cx-file-info">
                                            <span class="cx-file-name">"prompt.txt"</span>
                                            <span class="cx-file-preview">{preview}</span>
                                            <span class="cx-file-meta">{format!("{} characters", char_count)}</span>
                                        </div>
                                        <button class="cx-file-remove" title="Remove"
                                            on:click=move |_| set_input.set(String::new())>"×"</button>
                                    </div>
                                })
                            } else {
                                None
                            }
                        }}

                        <div class="cx-pill-meta">
                            <A href="/models" class="cx-pill-model">
                                <span class="cx-pill-model-dot"></span>
                                <span class="cx-pill-model-name">{move || pill_model_name()}</span>
                            </A>
                            <div style="flex:1"></div>
                            // Context window ring — full conversation token estimate + live popup
                            {move || {
                                let all_msgs = chat.messages.get();
                                let prompt_toks: u32 = all_msgs.iter()
                                    .filter(|m| m.role == "user")
                                    .map(|m| (m.content.chars().count() / 4) as u32)
                                    .sum();
                                let completion_toks: u32 = all_msgs.iter()
                                    .filter(|m| m.role == "assistant")
                                    .map(|m| (m.content.chars().count() / 4) as u32)
                                    .sum();
                                let input_toks = (input.get().chars().count() / 4) as u32;
                                let total_toks = prompt_toks + completion_toks + input_toks;
                                let ctx_max = max_tokens.get();
                                let remaining = ctx_max.saturating_sub(total_toks);
                                let pct = ((total_toks as f32 / ctx_max as f32) * 100.0).min(100.0);
                                let cls = if pct >= 95.0 { "cx-ctx crit" }
                                          else if pct >= 80.0 { "cx-ctx warn" }
                                          else { "cx-ctx" };
                                let pct_label = format!("{:.1}%", pct);
                                let ring_style = format!("--p:{:.1}", pct);
                                let bar_pct = pct;
                                view! {
                                    <div class="cx-ctx-popup-wrap">
                                        <div class=cls style="cursor:pointer"
                                            on:click=move |_| set_ctx_open.update(|v| *v = !*v)>
                                            <span class="cx-ctx-ring" style={ring_style}></span>
                                            <span>{pct_label}</span>
                                        </div>
                                        {move || ctx_open.get().then(|| {
                                            let model_name = loaded.get()
                                                .map(|l| l.name)
                                                .unwrap_or_else(|| "No model".into());
                                            view! {
                                                <div class="cx-ctx-popup">
                                                    <div class="cx-ctx-popup-header">
                                                        <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                                                            <rect x="1" y="4" width="12" height="9" rx="1"/>
                                                            <path d="M5 4V2h4v2"/>
                                                        </svg>
                                                        <div>
                                                            <div class="cx-ctx-popup-title">"Context window"</div>
                                                            <div class="cx-ctx-popup-model">{model_name}</div>
                                                        </div>
                                                    </div>
                                                    <div class="cx-ctx-popup-pct">{format!("{:.1}%", bar_pct)}</div>
                                                    <div class="cx-ctx-popup-bar">
                                                        <div class="cx-ctx-popup-bar-fill"
                                                            style=format!("width:{:.1}%", bar_pct)></div>
                                                    </div>
                                                    <div class="cx-ctx-popup-row">
                                                        <span>"↑ Prompt"</span>
                                                        <span class="val">{prompt_toks}</span>
                                                    </div>
                                                    <div class="cx-ctx-popup-row">
                                                        <span>"↓ Completion"</span>
                                                        <span class="val">{completion_toks}</span>
                                                    </div>
                                                    <div class="cx-ctx-popup-divider"></div>
                                                    <div class="cx-ctx-popup-row">
                                                        <span>"Σ Used"</span>
                                                        <span class="val">{total_toks}</span>
                                                    </div>
                                                    <div class="cx-ctx-popup-row cx-ctx-popup-remaining">
                                                        <span>"Remaining"</span>
                                                        <span class="val">{remaining}</span>
                                                    </div>
                                                </div>
                                            }
                                        })}
                                    </div>
                                }
                            }}
                            {move || if busy.get() {
                                view! {
                                    <button class="cx-pill-stop"
                                        title="Stop generation"
                                        on:click=move |_| {
                                            spawn_local(async move {
                                                let _ = tauri_bridge::invoke::<()>("stop_generation", json!({})).await;
                                            });
                                        }>
                                        <span class="cx-stop-icon"></span>
                                    </button>
                                }.into_view()
                            } else {
                                view! {
                                    <button class="cx-pill-send"
                                        disabled=move || input.get().is_empty()
                                        on:click=move |_: MouseEvent| send(())
                                        title="Send">"↑"</button>
                                }.into_view()
                            }}
                        </div>
                    </div>
                </div>

                // Spacer below — mirrors top spacer, keeps input centered when empty
                <div class="cx-v-spacer cx-v-spacer--bottom"></div>

            </main>
            </div> // cx-right-col

            // ── CONTROLS DRAWER (right, slides in) ───────────────────────
            <div class=move || if controls_open.get() { "cx-overlay open" } else { "cx-overlay" }
                 on:click=move |_| set_controls_open.set(false)></div>
            <aside class=move || if controls_open.get() { "cx-drawer cx-drawer-right open" } else { "cx-drawer cx-drawer-right" }>
                <div class="cx-drawer-header">
                    <span class="cx-drawer-title">"Controls"</span>
                    <button class="cx-icon-btn cx-drawer-close"
                        on:click=move |_| set_controls_open.set(false)>"×"</button>
                </div>

                <div class="cx-drawer-body">
                    // ─ Active model card
                    <div class="ctrl-sect">
                        <div class="ctrl-model-badge">
                            <span class="ctrl-model-dot"></span>
                            <div class="ctrl-model-info">
                                <span class="ctrl-model-tag">"Active Model"</span>
                                <span class="ctrl-model-name">
                                    {move || loaded.get()
                                        .map(|l| format!("{} · Loaded", l.name))
                                        .unwrap_or_else(|| "None loaded".into())}
                                </span>
                            </div>
                        </div>
                    </div>

                    <div class="ctrl-sep"></div>

                    // ─ Response style pills
                    <div class="ctrl-sect">
                        <div class="ctrl-label">"Response Style"</div>
                        <div class="ctrl-style-pills">
                            <button class=style_precise_cls
                                on:click=move |_| set_temp.set(0.2)>"Precise"</button>
                            <button class=style_balanced_cls
                                on:click=move |_| set_temp.set(0.7)>"Balanced"</button>
                            <button class=style_creative_cls
                                on:click=move |_| set_temp.set(1.1)>"Creative"</button>
                        </div>
                        <div class="ctrl-style-desc">
                            {move || match temp.get() {
                                t if t <= 0.45 => "Factual, deterministic",
                                t if t <= 0.9  => "Best for chat, summaries",
                                _              => "Imaginative, varied",
                            }}
                        </div>
                    </div>

                    <div class="ctrl-sep"></div>

                    // ─ Response Length (steppers)
                    <div class="ctrl-sect">
                        <div class="ctrl-num-row">
                            <div class="ctrl-num-head">
                                <span class="ctrl-num-name">"Response Length"</span>
                                <div class="ctrl-num-stepper">
                                    <button class="ctrl-num-btn"
                                        on:click=move |_| set_max_tokens.update(|v| *v = (*v).saturating_sub(128).max(128))
                                        prop:disabled=move || max_tokens.get() <= 128>"−"</button>
                                    <span class="ctrl-num-val">{move || max_tokens.get().to_string()}</span>
                                    <button class="ctrl-num-btn"
                                        on:click=move |_| set_max_tokens.update(|v| *v = (*v + 128).min(8192))
                                        prop:disabled=move || max_tokens.get() >= 8192>"+"</button>
                                </div>
                            </div>
                            <div class="ctrl-num-desc">"Maximum tokens in response"</div>
                        </div>
                    </div>

                    <div class="ctrl-sep"></div>

                    // ─ Temperature
                    <div class="ctrl-sect">
                        <div class="ctrl-num-row">
                            <div class="ctrl-num-head">
                                <span class="ctrl-num-name">"Temperature"</span>
                                <div class="ctrl-num-stepper">
                                    <button class="ctrl-num-btn"
                                        on:click=move |_| set_temp.update(|v| *v = (*v - 0.1).max(0.0))
                                        prop:disabled=move || temp.get() <= 0.0>"−"</button>
                                    <span class="ctrl-num-val">{move || format!("{:.1}", temp.get())}</span>
                                    <button class="ctrl-num-btn"
                                        on:click=move |_| set_temp.update(|v| *v = (*v + 0.1).min(2.0))
                                        prop:disabled=move || temp.get() >= 2.0>"+"</button>
                                </div>
                            </div>
                            <div class="ctrl-num-desc">"Higher = more creative, lower = more precise"</div>
                        </div>
                    </div>

                    <div class="ctrl-sep"></div>

                    // ─ Nucleus Sampling
                    <div class="ctrl-sect">
                        <div class="ctrl-num-row">
                            <div class="ctrl-num-head">
                                <span class="ctrl-num-name">"Nucleus Sampling"</span>
                                <div class="ctrl-num-stepper">
                                    <button class="ctrl-num-btn"
                                        on:click=move |_| set_top_p.update(|v| *v = (*v - 0.05).max(0.0))
                                        prop:disabled=move || top_p.get() <= 0.0>"−"</button>
                                    <span class="ctrl-num-val">{move || format!("{:.2}", top_p.get())}</span>
                                    <button class="ctrl-num-btn"
                                        on:click=move |_| set_top_p.update(|v| *v = (*v + 0.05).min(1.0))
                                        prop:disabled=move || top_p.get() >= 1.0>"+"</button>
                                </div>
                            </div>
                            <div class="ctrl-num-desc">"Probability mass for token selection"</div>
                        </div>
                    </div>

                    <div class="ctrl-sep"></div>

                    // ─ Repeat Penalty
                    <div class="ctrl-sect">
                        <div class="ctrl-num-row">
                            <div class="ctrl-num-head">
                                <span class="ctrl-num-name">"Repeat Penalty"</span>
                                <div class="ctrl-num-stepper">
                                    <button class="ctrl-num-btn"
                                        on:click=move |_| set_repeat.update(|v| *v = (*v - 0.05).max(1.0))
                                        prop:disabled=move || repeat.get() <= 1.0>"−"</button>
                                    <span class="ctrl-num-val">{move || format!("{:.2}", repeat.get())}</span>
                                    <button class="ctrl-num-btn"
                                        on:click=move |_| set_repeat.update(|v| *v = (*v + 0.05).min(2.0))
                                        prop:disabled=move || repeat.get() >= 2.0>"+"</button>
                                </div>
                            </div>
                            <div class="ctrl-num-desc">"Penalizes repeated tokens"</div>
                        </div>
                    </div>

                    <div class="ctrl-sep"></div>

                    // ─ GPU Layers
                    <div class="ctrl-sect">
                        <div class="ctrl-num-row">
                            <div class="ctrl-num-head">
                                <span class="ctrl-num-name">"GPU Layers"</span>
                                <div class="ctrl-num-stepper">
                                    <button class="ctrl-num-btn"
                                        on:click=move |_| set_gpu_layers.update(|v| *v = (*v - 1).max(0))
                                        prop:disabled=move || gpu_layers.get() <= 0>"−"</button>
                                    <span class="ctrl-num-val">{move || gpu_layers.get().to_string()}</span>
                                    <button class="ctrl-num-btn"
                                        on:click=move |_| set_gpu_layers.update(|v| *v = (*v + 1).min(100))
                                        prop:disabled=move || gpu_layers.get() >= 100>"+"</button>
                                </div>
                            </div>
                            <div class="ctrl-num-desc">"0 = CPU only · 100 = Maximum GPU offload"</div>
                        </div>
                    </div>

                    <div class="ctrl-sep"></div>

                    // ─ Agent persona
                    <div class="ctrl-sect ctrl-persona-sect">
                        <div class="ctrl-label">"Agent Persona"</div>
                        <div class="ctrl-sub">"System instructions for the model"</div>
                        <textarea class="ctrl-persona-box"
                            placeholder="You are a helpful assistant..."
                            prop:value=move || system_prompt.get()
                            on:input=move |e| set_system_prompt.set(event_target_value(&e))></textarea>
                    </div>
                </div>
            </aside>

        </div>
    }
}
