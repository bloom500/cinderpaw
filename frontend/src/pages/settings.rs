use leptos::*;
use serde_json::json;

use crate::pages::types::Settings;
use crate::tauri_bridge;

#[component]
pub fn SettingsPage() -> impl IntoView {
    let (settings, set_settings) = create_signal::<Option<Settings>>(None);
    let (saved, set_saved) = create_signal(false);

    spawn_local(async move {
        if let Ok(s) = tauri_bridge::invoke::<Settings>("get_settings", json!({})).await {
            set_settings.set(Some(s));
        }
    });

    let save = move |_| {
        if let Some(s) = settings.get() {
            spawn_local(async move {
                let _ = tauri_bridge::invoke_unit("save_settings", json!({ "settings": s })).await;
                set_saved.set(true);
            });
        }
    };

    view! {
        <h1 class="page-title">"Settings"</h1>

        {move || match settings.get() {
            None => view! { <div>"Loading…"</div> }.into_view(),
            Some(s) => view! {
                <div class="card col" style="max-width: 600px;">
                    <div class="col">
                        <div class="label">"Models directory"</div>
                        <input class="input" prop:value=s.models_dir.clone()
                            on:input=move |e| set_settings.update(|st| {
                                if let Some(st) = st { st.models_dir = event_target_value(&e); }
                            })/>
                    </div>
                    <div class="col">
                        <div class="label">"Default GPU layers (-1 = all, 0 = CPU)"</div>
                        <input class="input" type="number" prop:value=s.default_gpu_layers.to_string()
                            on:input=move |e| set_settings.update(|st| {
                                if let Some(st) = st { st.default_gpu_layers = event_target_value(&e).parse().unwrap_or(-1); }
                            })/>
                    </div>
                    <div class="row">
                        <input type="checkbox" prop:checked=s.api_server_enabled
                            on:change=move |e| set_settings.update(|st| {
                                if let Some(st) = st { st.api_server_enabled = event_target_checked(&e); }
                            })/>
                        <span>"Enable Ollama-compatible API server"</span>
                    </div>
                    <div class="col">
                        <div class="label">"API port"</div>
                        <input class="input" type="number" prop:value=s.api_port.to_string()
                            on:input=move |e| set_settings.update(|st| {
                                if let Some(st) = st { st.api_port = event_target_value(&e).parse().unwrap_or(11435); }
                            })/>
                    </div>

                    <div class="kv"><b>"Feral version: "</b>{s.version.clone()}</div>
                    <div class="kv"><a href="https://github.com/" target="_blank">"GitHub"</a></div>

                    <div class="row">
                        <button class="btn" on:click=save>"Save"</button>
                        <button class="btn ghost">"Check for updates"</button>
                    </div>
                    {move || saved.get().then(|| view! {
                        <div class="kv" style="color: var(--green);">"✓ Saved"</div>
                    })}
                </div>
            }.into_view()
        }}
    }
}
