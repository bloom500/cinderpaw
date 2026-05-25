use leptos::*;
use leptos_router::A;
use pulldown_cmark::{html, Options, Parser};
use serde_json::json;
use wasm_bindgen::JsCast;
use web_sys::{HtmlTextAreaElement, MouseEvent, KeyboardEvent};

use crate::context::{ChatContext, ChatSessionSummary};
use crate::pages::components::hw_notification::HwNotification;
use crate::pages::types::{InferParams, LoadedModel, Message};
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


fn session_title(msgs: &[crate::pages::types::Message]) -> String {
    msgs.iter()
        .find(|m| m.role == "user")
        .map(|m| {
            let t = m.content.trim();
            let end = t.char_indices().nth(38).map(|(i, _)| i).unwrap_or(t.len());
            if t.len() > end { format!("{}…", &t[..end]) } else { t.to_string() }
        })
        .unwrap_or_else(|| "Conversation".into())
}

#[component]
pub fn ChatPage() -> impl IntoView {
    let (loaded, set_loaded) = create_signal::<Option<LoadedModel>>(None);

    // Global chat context
    let chat = use_context::<ChatContext>().expect("ChatContext not provided");

    // Local UI state
    let (input, set_input) = create_signal(String::new());
    let (system_prompt, set_system_prompt) = create_signal(String::new());
    let busy = chat.busy;
    let (history_open, set_history_open) = create_signal(false);
    let (controls_open, set_controls_open) = create_signal(false);
    let (temp, set_temp) = create_signal(0.8f32);
    let (max_tokens, set_max_tokens) = create_signal(4096u32);
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
        let _ = chat.messages.get();
        if let Some(el) = web_sys::window()
            .and_then(|w| w.document())
            .and_then(|d| d.get_element_by_id("feral-chat-scroll"))
        {
            el.set_scroll_top(el.scroll_height());
        }
    });

    let save_current_session = move || {
        let current = chat.messages.get();
        if current.is_empty() { return; }
        let current_id = chat.active_session_id.get()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let title = session_title(&current);
        chat.sessions.update(|s| { s.insert(current_id.clone(), current); });
        chat.history.update(|h| {
            if let Some(entry) = h.iter_mut().find(|s| s.id == current_id) {
                entry.title = title;
            } else {
                h.push(ChatSessionSummary { id: current_id, title });
            }
        });
    };

    let new_chat = move |_: MouseEvent| {
        save_current_session();
        let new_id = uuid::Uuid::new_v4().to_string();
        chat.history.update(|h| {
            h.push(ChatSessionSummary { id: new_id.clone(), title: "New Conversation".into() });
        });
        chat.active_session_id.set(Some(new_id));
        chat.messages.set(vec![]);
        busy.set(false);
    };

    let load_conv = move |id: String| {
        save_current_session();
        let msgs = chat.sessions.get().get(&id).cloned().unwrap_or_default();
        chat.active_session_id.set(Some(id));
        chat.messages.set(msgs);
        busy.set(false);
    };

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

    // Pre-compute closures that use && (rstml parser can't handle && in attributes)
    let tab1_cls = move || if temp.get() <= 0.45 { "ctrl-cr-tab active" } else { "ctrl-cr-tab" };
    let tab2_cls = move || {
        let t = temp.get();
        if t > 0.45 && t <= 0.9 { "ctrl-cr-tab active" } else { "ctrl-cr-tab" }
    };
    let tab3_cls = move || if temp.get() > 0.9 { "ctrl-cr-tab active" } else { "ctrl-cr-tab" };

    // Derived: are there any visible (non-system) messages?
    let has_messages = move || chat.messages.get().iter().any(|m| m.role != "system");

    // Short model name for the pill badge (strips .gguf and quant suffix)
    let pill_model_name = move || {
        loaded.get()
            .map(|l| {
                let n = l.name.to_lowercase();
                // strip ".gguf" then optional ".q*"/".f*" quant suffix
                let n = n.trim_end_matches(".gguf");
                let n = if let Some(idx) = n.rfind('.') {
                    let suffix = &n[idx + 1..];
                    if suffix.starts_with('q') || suffix.starts_with('f') { &n[..idx] } else { n }
                } else { n };
                n.to_string()
            })
            .unwrap_or_else(|| "no model".into())
    };

    view! {
        <div class="cx-root">

            // ── HW RECOMMENDATION TOAST ───────────────────────────────────
            <HwNotification/>

            // ── TOP BAR (burger + brand + controls) ──────────────────────
            <div class="cx-topbar">
                <div class="cx-topbar-side">
                    <button class="cx-icon-btn cx-burger"
                        on:click=move |_| set_history_open.update(|v| *v = !*v)
                        title="Conversations">"≡"</button>
                    <span class="cx-brand">"Feral"</span>
                </div>
                <button class="cx-controls-pill"
                    on:click=move |_| set_controls_open.update(|v| *v = !*v)
                    title="Controls">
                    <span class="cx-gear">"⚙"</span>
                    <span>"Controls"</span>
                </button>
            </div>

            // ── HISTORY DRAWER (left, slides in) ─────────────────────────
            <div class=move || if history_open.get() { "cx-overlay open" } else { "cx-overlay" }
                 on:click=move |_| set_history_open.set(false)></div>
            <aside class=move || if history_open.get() { "cx-drawer cx-drawer-left open" } else { "cx-drawer cx-drawer-left" }>
                <div class="cx-drawer-header">
                    <span class="cx-drawer-title">"Conversations"</span>
                    <button class="cx-icon-btn cx-drawer-close"
                        on:click=move |_| set_history_open.set(false)>"×"</button>
                </div>
                <div class="cx-drawer-nav">
                    <A href="/models" class="cx-nav-link">"◧ Models"</A>
                    <A href="/agents" class="cx-nav-link">"⚙ Agents"</A>
                    <A href="/settings" class="cx-nav-link">"⚒ Settings"</A>
                </div>
                <div class="cx-drawer-section">
                    <div class="cx-drawer-section-header">
                        <span class="cx-drawer-section-label">"History"</span>
                        <button class="cx-new-btn" on:click=move |e| {
                            new_chat(e);
                            set_history_open.set(false);
                        }>"+ New"</button>
                    </div>
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
                                                set_history_open.set(false);
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
            </aside>

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

                    <div class="ctrl-sect">
                        <div class="ctrl-label">"Response Style"</div>
                        <div class="ctrl-sub">"How the model thinks and generates"</div>
                        <div class="ctrl-cr-tabs">
                            <div class=tab1_cls on:click=move |_| set_temp.set(0.2)>
                                <span class="ctrl-cr-icon">"⌗"</span><span>"Precise"</span>
                            </div>
                            <div class=tab2_cls on:click=move |_| set_temp.set(0.7)>
                                <span class="ctrl-cr-icon">"◎"</span><span>"Balanced"</span>
                            </div>
                            <div class=tab3_cls on:click=move |_| set_temp.set(1.1)>
                                <span class="ctrl-cr-icon">"✦"</span><span>"Creative"</span>
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

                    <div class="ctrl-sect ctrl-persona-sect">
                        <div class="ctrl-label">"Agent Persona"</div>
                        <div class="ctrl-sub">"System instructions for the model"</div>
                        <textarea class="ctrl-persona-box"
                            placeholder="You are a helpful assistant that…"
                            prop:value=move || system_prompt.get()
                            on:input=move |e| set_system_prompt.set(event_target_value(&e))></textarea>
                    </div>
                </div>
            </aside>

            // ── MAIN CANVAS ──────────────────────────────────────────────
            <main class="cx-canvas">

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

                                    let (completed, streaming_msg) =
                                        if is_busy
                                            && visible.last().map(|m| m.role == "assistant").unwrap_or(false)
                                        {
                                            let last = visible.last().cloned();
                                            (&visible[..visible.len() - 1], last)
                                        } else {
                                            (&visible[..], None)
                                        };

                                    view! {
                                        // ── Completed messages
                                        {completed.iter().map(|m| {
                                            if m.role == "user" {
                                                view! {
                                                    <div class="msg-row msg-user">
                                                        <div class="bubble-user">{m.content.clone()}</div>
                                                    </div>
                                                }.into_view()
                                            } else {
                                                let parsed = parse_think(&m.content);
                                                let partial = parsed.current_think.clone();
                                                view! {
                                                    <div class="msg-row msg-ai">
                                                        <div class="ai-avatar">"✦"</div>
                                                        <div class="bubble-ai">
                                                            // Completed think blocks
                                                            {parsed.thinking.into_iter().filter(|t| !t.trim().is_empty()).map(|t| view! {
                                                                <details class="thinking-container">
                                                                    <summary>
                                                                        <span class="thinking-dot"></span>
                                                                        "Thinking Process..."
                                                                    </summary>
                                                                    <div class="thinking-content">{t}</div>
                                                                </details>
                                                            }).collect_view()}
                                                            // Partial think block (generation cut off inside <think>)
                                                            {(!partial.trim().is_empty()).then(|| view! {
                                                                <details class="thinking-container">
                                                                    <summary>
                                                                        <span class="thinking-dot"></span>
                                                                        "Thinking Process... (incomplete)"
                                                                    </summary>
                                                                    <div class="thinking-content">{partial}</div>
                                                                </details>
                                                            })}
                                                            <div class="message-text" inner_html={markdown_to_html(&parsed.answer)}></div>
                                                        </div>
                                                    </div>
                                                }.into_view()
                                            }
                                        }).collect_view()}

                                        // ── Live streaming message
                                        {streaming_msg.map(|_| view! {
                                            <div class="msg-row msg-ai">
                                                <div class="ai-avatar">"✦"</div>
                                                <div class="bubble-ai">
                                                    {move || {
                                                        let msgs = chat.messages.get();
                                                        let content = msgs.iter()
                                                            .filter(|m| m.role != "system")
                                                            .last()
                                                            .map(|m| m.content.clone())
                                                            .unwrap_or_default();
                                                        let parsed = parse_think(&content);
                                                        let still_thinking = parsed.still_thinking;
                                                        let current = parsed.current_think.clone();
                                                        view! {
                                                            // Completed think blocks (collapsed)
                                                            {parsed.thinking.into_iter().filter(|t| !t.trim().is_empty()).map(|t| view! {
                                                                <details class="thinking-container">
                                                                    <summary>
                                                                        <span class="thinking-dot"></span>
                                                                        "Thinking Process..."
                                                                    </summary>
                                                                    <div class="thinking-content">{t}</div>
                                                                </details>
                                                            }).collect_view()}
                                                            // Active think block — OPEN, tokens stream live inside
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
                                                            // Answer text (after </think>)
                                                            <div class="message-text" inner_html={markdown_to_html(&parsed.answer)}></div>
                                                            // Cursor while streaming answer
                                                            {(!still_thinking).then(||
                                                                view! { <span class="stream-cursor"></span> }
                                                            )}
                                                        }
                                                    }}
                                                </div>
                                            </div>
                                        })}
                                    }
                                }}
                            </div>
                        }.into_view()
                    } else {
                        // Empty state: mascot centered in the body
                        view! {
                            <div class="cx-empty-center">
                                <img class="cx-above-mascot" src="/public/LOGO%20NO%20BG.png" alt="Feral" />
                            </div>
                        }.into_view()
                    }}
                </div>

                // ── INPUT: fixed at bottom, in flow (not absolute) ────────
                <div class="cx-input-bay">
                    <div class="cx-pill">

                        // Textarea is ALWAYS in the DOM — never conditionally rendered.
                        // Destroying/recreating it on each keystroke (via a reactive block)
                        // would lose focus after every character typed.
                        <textarea
                            class="cx-pill-textarea"
                            class:cx-hidden=move || chip_mode.get()
                            placeholder="What's on your mind?"
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
            </main>
        </div>
    }
}
