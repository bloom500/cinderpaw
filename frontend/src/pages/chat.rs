use leptos::*;
use serde_json::json;
use wasm_bindgen::prelude::*;

use crate::pages::types::{InferParams, LoadedModel, Message};
use crate::tauri_bridge;

#[derive(Clone)]
struct Conversation {
    id: u32,
    title: String,
    messages: Vec<Message>,
}

#[component]
pub fn ChatPage() -> impl IntoView {
    let (loaded, set_loaded) = create_signal::<Option<LoadedModel>>(None);

    // Conversation history (in-memory)
    let (conversations, set_conversations) = create_signal::<Vec<Conversation>>(vec![]);
    let (active_conv_id, set_active_conv_id) = create_signal::<Option<u32>>(None);
    let (next_id, set_next_id) = create_signal(1u32);

    // Chat state
    let (messages, set_messages) = create_signal::<Vec<Message>>(vec![]);
    let (input, set_input) = create_signal(String::new());
    let (system_prompt, set_system_prompt) = create_signal(String::new());
    let (busy, set_busy) = create_signal(false);

    // Right panel
    let (panel_open, set_panel_open) = create_signal(true);

    // Inference params
    let (temp, set_temp) = create_signal(0.8f32);
    let (max_tokens, set_max_tokens) = create_signal(1024u32);
    let (top_p, set_top_p) = create_signal(0.95f32);
    let (repeat, set_repeat) = create_signal(1.1f32);

    // Load active model on mount
    spawn_local(async move {
        if let Ok(l) = tauri_bridge::invoke::<Option<LoadedModel>>("get_loaded_model", json!({})).await {
            set_loaded.set(l);
        }
    });

    // Auto-scroll to bottom when messages update
    create_effect(move |_| {
        let _ = messages.get();
        if let Some(el) = web_sys::window()
            .and_then(|w| w.document())
            .and_then(|d| d.get_element_by_id("feral-chat-scroll"))
        {
            el.set_scroll_top(el.scroll_height());
        }
    });

    let new_chat = move |_| {
        let current = messages.get();
        if !current.is_empty() {
            let title = current
                .iter()
                .find(|m| m.role == "user")
                .map(|m| {
                    let t = m.content.trim();
                    let end = t.char_indices().nth(38).map(|(i, _)| i).unwrap_or(t.len());
                    if t.len() > end { format!("{}…", &t[..end]) } else { t.to_string() }
                })
                .unwrap_or_else(|| "Conversation".into());
            let id = next_id.get();
            set_next_id.set(id + 1);
            set_conversations.update(|c| c.push(Conversation { id, title, messages: current }));
        }
        set_messages.set(vec![]);
        set_active_conv_id.set(None);
    };

    // load_conv: Copy-friendly (captures only Copy signals)
    let load_conv = move |conv: Conversation| {
        set_messages.set(conv.messages);
        set_active_conv_id.set(Some(conv.id));
    };

    let send = move |_| {
        let user_msg = input.get();
        if user_msg.is_empty() || busy.get() { return; }
        set_input.set(String::new());
        set_busy.set(true);

        let mut msgs = messages.get();
        let sys = system_prompt.get();
        if !sys.is_empty() && !msgs.iter().any(|m| m.role == "system") {
            msgs.insert(0, Message { role: "system".into(), content: sys });
        }
        msgs.push(Message { role: "user".into(), content: user_msg });
        msgs.push(Message { role: "assistant".into(), content: String::new() });
        set_messages.set(msgs.clone());

        let params = InferParams {
            temperature: temp.get(),
            top_p: top_p.get(),
            repeat_penalty: repeat.get(),
            max_tokens: max_tokens.get(),
            system_prompt: None,
        };

        spawn_local(async move {
            let window = web_sys::window().unwrap();
            let tauri = js_sys::Reflect::get(&window, &JsValue::from_str("__TAURI__")).unwrap();
            let core = js_sys::Reflect::get(&tauri, &JsValue::from_str("core")).unwrap();
            let channel_ctor = js_sys::Reflect::get(&core, &JsValue::from_str("Channel")).unwrap();
            let channel = js_sys::Reflect::construct(
                channel_ctor.unchecked_ref::<js_sys::Function>(),
                &js_sys::Array::new(),
            ).unwrap();

            let handler = Closure::wrap(Box::new(move |tok: JsValue| {
                let s = tok.as_string().unwrap_or_default();
                set_messages.update(|m| {
                    if let Some(last) = m.last_mut() {
                        if last.role == "assistant" { last.content.push_str(&s); }
                    }
                });
            }) as Box<dyn FnMut(JsValue)>);
            js_sys::Reflect::set(&channel, &JsValue::from_str("onmessage"), handler.as_ref().unchecked_ref()).unwrap();
            handler.forget();

            let args_val = serde_wasm_bindgen::to_value(&json!({
                "messages": msgs,
                "params": params,
            })).unwrap();
            js_sys::Reflect::set(&args_val, &JsValue::from_str("onToken"), &channel).unwrap();

            let invoke_fn = js_sys::Reflect::get(&core, &JsValue::from_str("invoke")).unwrap();
            let promise = invoke_fn.unchecked_ref::<js_sys::Function>()
                .call2(&core, &JsValue::from_str("chat_stream"), &args_val)
                .unwrap();
            let _ = wasm_bindgen_futures::JsFuture::from(js_sys::Promise::from(promise)).await;
            set_busy.set(false);
        });
    };

    // Pre-compute closures that use && (rstml parser can't handle && in attributes)
    let tab1_cls = move || if temp.get() <= 0.45 { "ctrl-cr-tab active" } else { "ctrl-cr-tab" };
    let tab2_cls = move || {
        let t = temp.get();
        if t > 0.45 && t <= 0.9 { "ctrl-cr-tab active" } else { "ctrl-cr-tab" }
    };
    let tab3_cls = move || if temp.get() > 0.9 { "ctrl-cr-tab active" } else { "ctrl-cr-tab" };

    view! {
        <div class=move || if panel_open.get() { "feral-chat with-controls" } else { "feral-chat" }>

            // ── LEFT: History sidebar ──────────────────────────────────────
            <div class="chat-hist">
                <div class="chat-hist-header">
                    <span class="chat-hist-title">"History"</span>
                    <button class="btn-new-chat" on:click=new_chat>"+ New"</button>
                </div>
                <div class="chat-hist-list">
                    {move || {
                        let convs = conversations.get();
                        let active = active_conv_id.get();
                        if convs.is_empty() {
                            view! {
                                <div class="chat-hist-empty">"No conversations yet"</div>
                            }.into_view()
                        } else {
                            convs.into_iter().rev().map(|conv| {
                                let id = conv.id;
                                let is_active = active == Some(id);
                                let title = conv.title.clone();
                                let conv2 = conv.clone();
                                view! {
                                    <div
                                        class=if is_active { "chat-hist-item active" } else { "chat-hist-item" }
                                        on:click=move |_| load_conv(conv2.clone())
                                    >
                                        <span class="chat-hist-dot">"◆"</span>
                                        <span class="chat-hist-name">{title}</span>
                                    </div>
                                }.into_view()
                            }).collect_view()
                        }
                    }}
                </div>
            </div>

            // ── CENTER: Chat workspace ─────────────────────────────────────
            <div class="chat-work">
                // Top bar
                <div class="chat-topbar">
                    <div class="chat-topbar-left">
                        <span class="chat-topbar-badge">"✦"</span>
                        <div class="chat-topbar-model">
                            <span class="chat-topbar-label">"Active Model"</span>
                            <span class="chat-topbar-name">
                                {move || loaded.get().map(|l| l.name).unwrap_or_else(|| "none loaded".into())}
                            </span>
                        </div>
                    </div>
                    <div class="chat-topbar-actions">
                        <button class="btn ghost sm" on:click=move |_| set_messages.set(vec![])>"Clear"</button>
                        <button
                            class=move || if panel_open.get() { "btn ghost sm ctrl-btn-active" } else { "btn ghost sm" }
                            on:click=move |_| set_panel_open.update(|v| *v = !*v)
                        >
                            {move || if panel_open.get() { "⊟ Controls" } else { "⊞ Controls" }}
                        </button>
                    </div>
                </div>

                // Messages area
                <div class="chat-msgs" id="feral-chat-scroll">
                    {move || {
                        let msgs = messages.get();
                        let visible: Vec<_> = msgs.into_iter().filter(|m| m.role != "system").collect();
                        let len = visible.len();
                        let is_busy = busy.get();

                        if len == 0 {
                            view! {
                                <div class="chat-empty">
                                    <div class="chat-empty-glyph">"✦"</div>
                                    <div class="chat-empty-title">"Feral AI"</div>
                                    <div class="chat-empty-sub">
                                        {move || loaded.get()
                                            .map(|l| format!("Talking to {}", l.name))
                                            .unwrap_or_else(|| "Load a model from the Models page to begin".into())}
                                    </div>
                                </div>
                            }.into_view()
                        } else {
                            visible.into_iter().enumerate().map(|(i, m)| {
                                let is_user = m.role == "user";
                                let show_cursor = is_busy && i == len - 1 && !is_user;
                                if is_user {
                                    view! {
                                        <div class="msg-row msg-user">
                                            <div class="bubble-user">{m.content}</div>
                                        </div>
                                    }.into_view()
                                } else {
                                    view! {
                                        <div class="msg-row msg-ai">
                                            <div class="ai-avatar">"✦"</div>
                                            <div class="bubble-ai">
                                                {m.content}
                                                {if show_cursor {
                                                    view! { <span class="stream-cursor"></span> }.into_view()
                                                } else {
                                                    view! { <span></span> }.into_view()
                                                }}
                                            </div>
                                        </div>
                                    }.into_view()
                                }
                            }).collect_view()
                        }
                    }}
                </div>

                // Input box
                <div class="chat-input-area">
                    <div class="chat-input-wrap">
                        <textarea
                            class="chat-input-box"
                            placeholder="Message Feral…"
                            rows="1"
                            prop:value=move || input.get()
                            on:input=move |e| set_input.set(event_target_value(&e))
                            on:keydown=move |e| {
                                if e.key() == "Enter" && !e.shift_key() {
                                    e.prevent_default();
                                    send(());
                                }
                            }
                        ></textarea>
                        <button
                            class=move || if busy.get() { "chat-send-btn sending" } else { "chat-send-btn" }
                            disabled=move || busy.get()
                            on:click=move |_| send(())
                        >
                            {move || if busy.get() {
                                view! { <span class="send-spinner"></span> }.into_view()
                            } else {
                                view! { <span>"Send"</span> }.into_view()
                            }}
                        </button>
                    </div>
                    <div class="chat-input-hint">"Enter to send  ·  Shift+Enter for new line"</div>
                </div>
            </div>

            // ── RIGHT: Controls panel ──────────────────────────────────────
            {move || if panel_open.get() {
                view! {
                    <div class="chat-ctrl">

                        // Active model badge
                        <div class="ctrl-sect">
                            <div class="ctrl-model-badge">
                                <span class="ctrl-model-dot"></span>
                                <div class="ctrl-model-info">
                                    <span class="ctrl-model-tag">"Active Model"</span>
                                    <span class="ctrl-model-name">
                                        {move || loaded.get().map(|l| l.name).unwrap_or_else(|| "None loaded".into())}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div class="ctrl-sep"></div>

                        // Response Style (Creativity)
                        <div class="ctrl-sect">
                            <div class="ctrl-label">"Response Style"</div>
                            <div class="ctrl-sub">"How the model thinks and generates"</div>

                            <div class="ctrl-cr-tabs">
                                <div class=tab1_cls on:click=move |_| set_temp.set(0.2)>
                                    <span class="ctrl-cr-icon">"⌗"</span>
                                    <span>"Precise"</span>
                                </div>
                                <div class=tab2_cls on:click=move |_| set_temp.set(0.7)>
                                    <span class="ctrl-cr-icon">"◎"</span>
                                    <span>"Balanced"</span>
                                </div>
                                <div class=tab3_cls on:click=move |_| set_temp.set(1.1)>
                                    <span class="ctrl-cr-icon">"✦"</span>
                                    <span>"Creative"</span>
                                </div>
                            </div>

                            <input class="ctrl-slider" type="range" min="0.1" max="1.5" step="0.05"
                                prop:value=move || temp.get().to_string()
                                on:input=move |e| set_temp.set(event_target_value(&e).parse().unwrap_or(0.8))/>

                            <div class="ctrl-cr-use">
                                {move || match temp.get() {
                                    t if t <= 0.45 => "Best for: code, math, structured data",
                                    t if t <= 0.9  => "Best for: chat, summaries, Q&A",
                                    _              => "Best for: writing, ideas, brainstorming",
                                }}
                            </div>
                        </div>

                        <div class="ctrl-sep"></div>

                        // Response Length
                        <div class="ctrl-sect">
                            <div class="ctrl-label">"Response Length"</div>
                            <div class="ctrl-slider-row">
                                <input class="ctrl-slider" type="range" min="128" max="8192" step="128"
                                    prop:value=move || max_tokens.get().to_string()
                                    on:input=move |e| set_max_tokens.set(event_target_value(&e).parse().unwrap_or(1024))/>
                                <span class="ctrl-val">{move || max_tokens.get().to_string()}</span>
                            </div>
                        </div>

                        <div class="ctrl-sep"></div>

                        // Advanced params
                        <div class="ctrl-sect">
                            <div class="ctrl-label">"Advanced"</div>

                            <div class="ctrl-adv-row">
                                <span class="ctrl-adv-key">"Nucleus Sampling"</span>
                                <span class="ctrl-val">{move || format!("{:.2}", top_p.get())}</span>
                            </div>
                            <input class="ctrl-slider" type="range" min="0" max="1" step="0.01"
                                prop:value=move || top_p.get().to_string()
                                on:input=move |e| set_top_p.set(event_target_value(&e).parse().unwrap_or(0.95))/>

                            <div class="ctrl-adv-row" style="margin-top:10px">
                                <span class="ctrl-adv-key">"Repeat Penalty"</span>
                                <span class="ctrl-val">{move || format!("{:.2}", repeat.get())}</span>
                            </div>
                            <input class="ctrl-slider" type="range" min="1" max="2" step="0.01"
                                prop:value=move || repeat.get().to_string()
                                on:input=move |e| set_repeat.set(event_target_value(&e).parse().unwrap_or(1.1))/>
                        </div>

                        <div class="ctrl-sep"></div>

                        // Agent persona / system prompt
                        <div class="ctrl-sect ctrl-persona-sect">
                            <div class="ctrl-label">"Agent Persona"</div>
                            <div class="ctrl-sub">"System instructions for the model"</div>
                            <textarea
                                class="ctrl-persona-box"
                                placeholder="You are a helpful assistant that…"
                                prop:value=move || system_prompt.get()
                                on:input=move |e| set_system_prompt.set(event_target_value(&e))
                            ></textarea>
                        </div>

                    </div>
                }.into_view()
            } else {
                view! { <span></span> }.into_view()
            }}

        </div>
    }
}
