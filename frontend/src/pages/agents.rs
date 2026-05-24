use leptos::*;
use serde_json::json;
use wasm_bindgen::prelude::*;

use crate::pages::types::{AgentConfig, ModelInfo, ToolType};
use crate::tauri_bridge;

#[component]
pub fn AgentsPage() -> impl IntoView {
    let (agents, set_agents) = create_signal::<Vec<AgentConfig>>(vec![]);
    let (presets, set_presets) = create_signal::<Vec<AgentConfig>>(vec![]);
    let (models, set_models) = create_signal::<Vec<ModelInfo>>(vec![]);
    let (editing, set_editing) = create_signal::<Option<AgentConfig>>(None);
    let (run_for, set_run_for) = create_signal::<Option<String>>(None);
    let (run_prompt, set_run_prompt) = create_signal(String::new());
    let (events, set_events) = create_signal::<Vec<String>>(vec![]);

    let refresh = move || {
        spawn_local(async move {
            if let Ok(a) = tauri_bridge::invoke::<Vec<AgentConfig>>("get_agents", json!({})).await {
                set_agents.set(a);
            }
            if let Ok(p) = tauri_bridge::invoke::<Vec<AgentConfig>>("get_agent_presets", json!({})).await {
                set_presets.set(p);
            }
            if let Ok(m) = tauri_bridge::invoke::<Vec<ModelInfo>>("get_models", json!({})).await {
                set_models.set(m);
            }
        });
    };
    refresh();

    let new_blank = move || AgentConfig {
        id: rand_id(),
        name: "New Agent".into(),
        system_prompt: String::new(),
        model_id: models.get().first().map(|m| m.id.clone()).unwrap_or_default(),
        tools: vec![],
        params: None,
    };

    let delete = move |id: String| {
        spawn_local(async move {
            let _ = tauri_bridge::invoke_unit("delete_agent", json!({ "id": id })).await;
            if let Ok(a) = tauri_bridge::invoke::<Vec<AgentConfig>>("get_agents", json!({})).await {
                set_agents.set(a);
            }
        });
    };

    let do_run = move |_| {
        let Some(id) = run_for.get() else { return };
        let prompt = run_prompt.get();
        if prompt.is_empty() { return; }
        set_events.set(vec![]);
        spawn_local(async move {
            let window = web_sys::window().unwrap();
            let tauri = js_sys::Reflect::get(&window, &JsValue::from_str("__TAURI__")).unwrap();
            let core = js_sys::Reflect::get(&tauri, &JsValue::from_str("core")).unwrap();
            let channel_ctor = js_sys::Reflect::get(&core, &JsValue::from_str("Channel")).unwrap();
            let channel = js_sys::Reflect::construct(
                channel_ctor.unchecked_ref::<js_sys::Function>(),
                &js_sys::Array::new(),
            ).unwrap();

            let handler = Closure::wrap(Box::new(move |ev: JsValue| {
                let s = ev.as_string().unwrap_or_default();
                set_events.update(|v| v.push(s));
            }) as Box<dyn FnMut(JsValue)>);
            js_sys::Reflect::set(&channel, &JsValue::from_str("onmessage"), handler.as_ref().unchecked_ref()).unwrap();
            handler.forget();

            let args_val = serde_wasm_bindgen::to_value(&json!({
                "agentId": id,
                "prompt": prompt,
            })).unwrap();
            js_sys::Reflect::set(&args_val, &JsValue::from_str("onEvent"), &channel).unwrap();

            let invoke_fn = js_sys::Reflect::get(&core, &JsValue::from_str("invoke")).unwrap();
            let promise = invoke_fn.unchecked_ref::<js_sys::Function>()
                .call2(&core, &JsValue::from_str("run_agent"), &args_val)
                .unwrap();
            let _ = wasm_bindgen_futures::JsFuture::from(js_sys::Promise::from(promise)).await;
        });
    };

    // Use {move || ...} instead of <Show> to avoid complex fallback parsing issues
    view! {
        <h1 class="page-title">"Agents"</h1>

        {move || {
            if let Some(cfg) = editing.get() {
                view! {
                    <AgentEditor
                        cfg=cfg
                        models=models
                        on_save=Callback::new(move |c: AgentConfig| {
                            spawn_local(async move {
                                let _ = tauri_bridge::invoke_unit("save_agent", json!({ "cfg": c })).await;
                                if let Ok(a) = tauri_bridge::invoke::<Vec<AgentConfig>>("get_agents", json!({})).await {
                                    set_agents.set(a);
                                }
                            });
                            set_editing.set(None);
                        })
                        on_cancel=Callback::new(move |_| set_editing.set(None))
                    />
                }.into_view()
            } else {
                view! {
                    <div>
                        <div class="row" style="margin-bottom: 12px;">
                            <button class="btn" on:click=move |_| set_editing.set(Some(new_blank()))>"+ New Agent"</button>
                        </div>

                        <h2 class="section-title">"Saved Agents"</h2>
                        <div class="grid">
                            <For each=move || agents.get() key=|a| a.id.clone()
                                children=move |a: AgentConfig| {
                                    let id1 = a.id.clone();
                                    let id2 = a.id.clone();
                                    let cfg = a.clone();
                                    view! {
                                        <div class="card col">
                                            <b>{a.name.clone()}</b>
                                            <div class="kv"><b>{a.model_id.clone()}</b></div>
                                            <div class="tool-list">
                                                {a.tools.iter().map(|t| {
                                                    let label = t.label();
                                                    view!{ <span class="tool-chip on">{label}</span> }
                                                }).collect_view()}
                                            </div>
                                            <div class="row">
                                                <button class="btn" on:click=move |_| set_run_for.set(Some(id1.clone()))>"Run"</button>
                                                <button class="btn ghost" on:click=move |_| set_editing.set(Some(cfg.clone()))>"Edit"</button>
                                                <button class="btn danger" on:click=move |_| delete(id2.clone())>"Delete"</button>
                                            </div>
                                        </div>
                                    }
                                }
                            />
                        </div>

                        <h2 class="section-title">"Presets"</h2>
                        <div class="grid">
                            <For each=move || presets.get() key=|a| a.id.clone()
                                children=move |a: AgentConfig| {
                                    let cfg = a.clone();
                                    view! {
                                        <div class="card col">
                                            <b>{a.name.clone()}</b>
                                            <div class="kv">{a.system_prompt.chars().take(80).collect::<String>()}</div>
                                            <button class="btn" on:click=move |_| set_editing.set(Some(cfg.clone()))>"Use Template"</button>
                                        </div>
                                    }
                                }
                            />
                        </div>

                        {move || run_for.get().map(|_| view! {
                            <h2 class="section-title">"Run Agent"</h2>
                            <div class="card col">
                                <textarea class="textarea" placeholder="Prompt..."
                                    on:input=move |e| set_run_prompt.set(event_target_value(&e))>
                                    {run_prompt.get()}
                                </textarea>
                                <div class="row">
                                    <button class="btn" on:click=do_run>"Run"</button>
                                    <button class="btn ghost" on:click=move |_| set_run_for.set(None)>"Close"</button>
                                </div>
                                // Plain map avoids turbofish-in-view! parser issues
                                <div>
                                    {move || events.get().into_iter().map(|e| {
                                        let cls = if e.contains("tool_call") || e.contains("tool_result") {
                                            "event tool"
                                        } else if e.contains("\"error\"") {
                                            "event error"
                                        } else {
                                            "event"
                                        };
                                        view! { <div class=cls>{e}</div> }.into_view()
                                    }).collect_view()}
                                </div>
                            </div>
                        })}
                    </div>
                }.into_view()
            }
        }}
    }
}

#[component]
fn AgentEditor(
    cfg: AgentConfig,
    models: ReadSignal<Vec<ModelInfo>>,
    on_save: Callback<AgentConfig>,
    on_cancel: Callback<()>,
) -> impl IntoView {
    let (name, set_name) = create_signal(cfg.name.clone());
    let (sys, set_sys) = create_signal(cfg.system_prompt.clone());
    let (model_id, set_model_id) = create_signal(cfg.model_id.clone());
    let (tools, set_tools) = create_signal(cfg.tools.clone());
    let id = cfg.id.clone();

    let toggle_tool = move |t: ToolType| {
        set_tools.update(|v| {
            if let Some(pos) = v.iter().position(|x| *x == t) {
                v.remove(pos);
            } else {
                v.push(t);
            }
        });
    };

    view! {
        <div class="card col">
            <h2 class="section-title">"Edit Agent"</h2>
            <div class="col">
                <div class="label">"Name"</div>
                <input class="input" prop:value=move || name.get()
                    on:input=move |e| set_name.set(event_target_value(&e))/>
            </div>
            <div class="col">
                <div class="label">"System Prompt"</div>
                <textarea class="textarea" style="min-height: 120px;"
                    on:input=move |e| set_sys.set(event_target_value(&e))>
                    {sys.get()}
                </textarea>
            </div>
            <div class="col">
                <div class="label">"Model"</div>
                <select class="select"
                    on:change=move |e| set_model_id.set(event_target_value(&e))>
                    {move || models.get().into_iter().map(|m| {
                        let selected = model_id.get() == m.id;
                        let val = m.id.clone();
                        view!{ <option value=val selected=selected>{m.name}</option> }.into_view()
                    }).collect_view()}
                </select>
            </div>
            <div class="col">
                <div class="label">"Tools"</div>
                <div class="tool-list">
                    {ToolType::all().iter().map(|t| {
                        let t_own = t.clone();
                        let t_chk = t.clone();
                        let label = t.label();
                        view! {
                            <span
                                class=move || if tools.get().iter().any(|x| *x == t_chk) {
                                    "tool-chip on"
                                } else {
                                    "tool-chip"
                                }
                                on:click=move |_| toggle_tool(t_own.clone())
                            >{label}</span>
                        }
                    }).collect_view()}
                </div>
            </div>
            <div class="row">
                <button class="btn" on:click=move |_| on_save.call(AgentConfig {
                    id: id.clone(),
                    name: name.get(),
                    system_prompt: sys.get(),
                    model_id: model_id.get(),
                    tools: tools.get(),
                    params: None,
                })>"Save Agent"</button>
                <button class="btn ghost" on:click=move |_| on_cancel.call(())>"Cancel"</button>
            </div>
        </div>
    }
}

/// Cheap random ID using Math.random() — avoids needing web-sys Crypto feature.
fn rand_id() -> String {
    let r = || (js_sys::Math::random() * 4294967295.0_f64) as u64;
    format!("{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        r() & 0xffff_ffff,
        r() & 0xffff,
        r() & 0xfff,
        (r() & 0x3fff) | 0x8000,
        r() & 0xffff_ffff_ffff,
    )
}
