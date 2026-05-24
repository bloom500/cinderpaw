use leptos::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use wasm_bindgen::JsValue;

use crate::pages::types::{human_bytes, LoadedModel, ModelInfo, SystemInfo};
use crate::tauri_bridge;

fn md_to_html(md: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};

    // Strip YAML frontmatter (--- ... ---) that HF model cards always include
    let content = if md.starts_with("---") {
        let rest = &md[3..];
        // find the closing --- on its own line
        rest.find("\n---")
            .map(|i| rest[i + 4..].trim_start())
            .unwrap_or(md)
    } else {
        md
    };

    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    let parser = Parser::new_ext(content, opts);
    let mut raw = String::new();
    html::push_html(&mut raw, parser);

    // Inject data-lang on <pre> so CSS can show the language label
    // pulldown-cmark emits: <pre><code class="language-bash">
    let needle = "<pre><code class=\"language-";
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw.as_str();
    while let Some(pos) = rest.find(needle) {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + needle.len()..];
        if let Some(q) = after.find('"') {
            let lang = &after[..q];
            out.push_str(&format!("<pre data-lang=\"{}\"><code class=\"language-", lang));
            rest = after;
        } else {
            out.push_str(needle);
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HfModelSummary {
    pub id: String,
    pub author: String,
    pub downloads: u64,
    pub likes: u32,
    pub last_modified: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HfFile {
    pub rfilename: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HfModelDetail {
    pub id: String,
    pub author: String,
    pub downloads: u64,
    pub likes: u32,
    pub last_modified: String,
    pub tags: Vec<String>,
    pub gguf_files: Vec<HfFile>,
    pub readme: Option<String>,
}

fn fmt_date(iso: &str) -> String {
    iso.get(..10).unwrap_or(iso).to_string()
}

fn fmt_num(n: u64) -> String {
    if n >= 1_000_000 { format!("{:.1}M", n as f64 / 1_000_000.0) }
    else if n >= 1_000 { format!("{:.1}K", n as f64 / 1_000.0) }
    else { n.to_string() }
}

// ── Detail panel extracted as a component to keep view! macros simple ──

#[component]
fn HfDetailPanel(
    detail: HfModelDetail,
    selected_file: ReadSignal<Option<HfFile>>,
    set_selected_file: WriteSignal<Option<HfFile>>,
    downloading: ReadSignal<bool>,
    dl_progress: ReadSignal<f32>,
    dl_error: ReadSignal<Option<String>>,
    do_download: Callback<()>,
    do_cancel: Callback<()>,
) -> impl IntoView {
    let tags: Vec<String> = detail.tags.iter().take(6).cloned().collect();
    let files = detail.gguf_files.clone();
    let readme = detail.readme.clone();
    let title = detail.id.clone();
    let stats = format!("⬇ {}  ♥ {}  {}", fmt_num(detail.downloads), detail.likes, fmt_date(&detail.last_modified));

    view! {
        <div class="detail-panel">
            <div class="detail-header">
                <h2 class="detail-title">{title}</h2>
                <div class="detail-stats">{stats}</div>
            </div>

            <div class="tag-row">
                {tags.into_iter().map(|t| view! { <span class="tag">{t}</span> }).collect::<Vec<_>>()}
            </div>

            <h3 class="section-title">"Download Options"</h3>
            <div class="file-list">
                <For
                    each=move || files.clone()
                    key=|f| f.rfilename.clone()
                    children=move |f: HfFile| {
                        let fname = f.rfilename.clone();
                        let size_str = f.size.map(human_bytes).unwrap_or_default();
                        let f2 = f.clone();
                        view! {
                            <div
                                class=move || {
                                    if selected_file.get().as_ref().map(|s| s.rfilename == f.rfilename).unwrap_or(false) {
                                        "file-row selected"
                                    } else { "file-row" }
                                }
                                on:click=move |_| set_selected_file.set(Some(f2.clone()))
                            >
                                <span class="file-name">{fname}</span>
                                <span class="file-size">{size_str}</span>
                            </div>
                        }
                    }
                />
            </div>

            {move || dl_error.get().map(|e| view! {
                <div class="dl-error-banner">
                    <span class="dl-error-icon">"!"</span>
                    <span>{e}</span>
                </div>
            })}

            {move || if downloading.get() {
                view! {
                    <div class="dl-active">
                        <div class="dl-active-row">
                            <div class="dl-active-info">
                                <span class="dl-active-label">"Downloading"</span>
                                <span class="dl-active-pct">{move || format!("{:.0}%", dl_progress.get() * 100.0)}</span>
                            </div>
                            <button
                                class="dl-cancel-btn"
                                on:click=move |_| do_cancel.call(())
                                title="Cancel download"
                            >
                                <span class="dl-cancel-x">"\u{00D7}"</span>
                                <span>"Cancel"</span>
                            </button>
                        </div>
                        <div class="progress">
                            <div style=move || format!("width:{}%", (dl_progress.get() * 100.0) as u32)></div>
                        </div>
                    </div>
                }.into_view()
            } else {
                view! {
                    <button
                        class="btn download-btn"
                        disabled=move || selected_file.get().is_none()
                        on:click=move |_| do_download.call(())
                    >
                        "Install Model Locally"
                    </button>
                }.into_view()
            }}

            {readme.map(|r| {
                let html = md_to_html(&r);
                view! {
                    <div class="readme">
                        <h3 class="section-title">"README"</h3>
                        <div class="readme-body" inner_html=html></div>
                    </div>
                }
            })}
        </div>
    }
}

// ── Main models page ──

#[component]
pub fn ModelsPage() -> impl IntoView {
    let (local_models, set_local_models) = create_signal::<Vec<ModelInfo>>(vec![]);
    let (loaded, set_loaded) = create_signal::<Option<LoadedModel>>(None);
    let (sysinfo, set_sysinfo) = create_signal::<Option<SystemInfo>>(None);

    let (hf_query, set_hf_query) = create_signal(String::new());
    let (hf_results, set_hf_results) = create_signal::<Vec<HfModelSummary>>(vec![]);
    let (hf_selected, set_hf_selected) = create_signal::<Option<HfModelDetail>>(None);
    let (hf_loading, set_hf_loading) = create_signal(false);
    let (hf_detail_loading, set_hf_detail_loading) = create_signal(false);
    let (hf_error, set_hf_error) = create_signal::<Option<String>>(None);
    let (selected_file, set_selected_file) = create_signal::<Option<HfFile>>(None);
    let (downloading, set_downloading) = create_signal(false);
    let (dl_progress, set_dl_progress) = create_signal::<f32>(0.0);
    let (dl_id, set_dl_id) = create_signal::<Option<String>>(None);
    let (dl_error, set_dl_error) = create_signal::<Option<String>>(None);
    let (tab, set_tab) = create_signal("local");

    let refresh_local = move || {
        spawn_local(async move {
            if let Ok(list) = tauri_bridge::invoke::<Vec<ModelInfo>>("get_models", json!({})).await {
                set_local_models.set(list);
            }
            if let Ok(l) = tauri_bridge::invoke::<Option<LoadedModel>>("get_loaded_model", json!({})).await {
                set_loaded.set(l);
            }
            if let Ok(s) = tauri_bridge::invoke::<SystemInfo>("get_system_info", json!({})).await {
                set_sysinfo.set(Some(s));
            }
        });
    };
    refresh_local();

    let _dl_cb = tauri_bridge::listen("feral://download-progress", move |evt: JsValue| {
        if let Ok(obj) = serde_wasm_bindgen::from_value::<serde_json::Value>(evt) {
            if let Some(p) = obj.get("payload").and_then(|p| p.get("progress")).and_then(|p| p.as_f64()) {
                set_dl_progress.set(p as f32);
            }
        }
    });

    let _dl_complete_cb = tauri_bridge::listen("feral://download-complete", move |_evt: JsValue| {
        set_downloading.set(false);
        set_dl_progress.set(0.0);
        set_dl_id.set(None);
        set_dl_error.set(None);
        refresh_local();
    });

    let _dl_error_cb = tauri_bridge::listen("feral://download-error", move |evt: JsValue| {
        set_downloading.set(false);
        set_dl_progress.set(0.0);
        set_dl_id.set(None);
        if let Ok(obj) = serde_wasm_bindgen::from_value::<serde_json::Value>(evt) {
            let payload = obj.get("payload");
            let cancelled = payload
                .and_then(|p| p.get("cancelled"))
                .and_then(|c| c.as_bool())
                .unwrap_or(false);
            if cancelled {
                // User-initiated; no banner needed.
                set_dl_error.set(None);
            } else {
                let err = payload
                    .and_then(|p| p.get("error"))
                    .and_then(|e| e.as_str())
                    .unwrap_or("Download failed");
                set_dl_error.set(Some(err.to_string()));
            }
        }
    });

    let do_search = move || {
        let q = hf_query.get();
        if q.is_empty() { return; }
        set_hf_loading.set(true);
        set_hf_error.set(None);
        set_hf_results.set(vec![]);
        set_hf_selected.set(None);
        spawn_local(async move {
            match tauri_bridge::invoke::<Vec<HfModelSummary>>(
                "search_hf_models", json!({ "query": q })
            ).await {
                Ok(list) => set_hf_results.set(list),
                Err(e) => set_hf_error.set(Some(format!("Search failed: {}", e))),
            }
            set_hf_loading.set(false);
        });
    };

    let select_model = move |repo_id: String| {
        set_hf_detail_loading.set(true);
        set_hf_selected.set(None);
        set_selected_file.set(None);
        spawn_local(async move {
            if let Ok(detail) = tauri_bridge::invoke::<HfModelDetail>(
                "get_hf_model_detail", json!({ "repoId": repo_id })
            ).await {
                let first = detail.gguf_files.first().cloned();
                set_selected_file.set(first);
                set_hf_selected.set(Some(detail));
            }
            set_hf_detail_loading.set(false);
        });
    };

    let do_download = Callback::new(move |_: ()| {
        let detail = match hf_selected.get() { Some(d) => d, None => return };
        let file = match selected_file.get() { Some(f) => f, None => return };
        let key = format!("{}::{}", detail.id, file.rfilename);
        set_downloading.set(true);
        set_dl_progress.set(0.0);
        set_dl_error.set(None);
        set_dl_id.set(Some(key));
        spawn_local(async move {
            // Backend now returns immediately with the download id; failures
            // surface via the `feral://download-error` event listener above.
            if let Err(e) = tauri_bridge::invoke::<String>(
                "download_model",
                json!({ "repoId": detail.id, "filename": file.rfilename })
            ).await {
                set_dl_error.set(Some(format!("Could not start download: {}", e)));
                set_downloading.set(false);
                set_dl_id.set(None);
            }
        });
    });

    let do_cancel = Callback::new(move |_: ()| {
        let Some(id) = dl_id.get() else { return };
        // Optimistically clear the UI; the backend will also emit a
        // cancelled error event which clears state again (idempotent).
        set_downloading.set(false);
        set_dl_progress.set(0.0);
        set_dl_id.set(None);
        set_dl_error.set(None);
        spawn_local(async move {
            let _ = tauri_bridge::invoke_unit(
                "cancel_download",
                json!({ "modelId": id })
            ).await;
        });
    });

    let do_load = move |path: String| {
        spawn_local(async move {
            let _ = tauri_bridge::invoke::<LoadedModel>("load_model", json!({ "path": path })).await;
            if let Ok(l) = tauri_bridge::invoke::<Option<LoadedModel>>("get_loaded_model", json!({})).await {
                set_loaded.set(l);
            }
        });
    };

    let do_unload = move |_| {
        spawn_local(async move {
            let _ = tauri_bridge::invoke_unit("unload_model", json!({})).await;
            set_loaded.set(None);
        });
    };

    let do_delete = move |path: String| {
        spawn_local(async move {
            let _ = tauri_bridge::invoke_unit("delete_model", json!({ "path": path })).await;
            if let Ok(list) = tauri_bridge::invoke::<Vec<ModelInfo>>("get_models", json!({})).await {
                set_local_models.set(list);
            }
        });
    };

    view! {
        {move || sysinfo.get().map(|s| view! {
            <div class="sysbar">
                <div><span class="label">"GPU"</span><b>{s.gpu_name}{if s.supports_vulkan { " · Vulkan" } else { "" }}</b></div>
                <div><span class="label">"VRAM"</span><b>{s.vram_used_mb}" / "{s.vram_total_mb}" MB"</b></div>
                <div><span class="label">"RAM"</span><b>{s.ram_used_mb}" / "{s.ram_total_mb}" MB"</b></div>
                <div><span class="label">"CPU"</span><b>{s.cpu}</b></div>
            </div>
        })}

        <div class="tab-bar">
            <button class=move || if tab.get() == "local" { "tab active" } else { "tab" }
                on:click=move |_| set_tab.set("local")>"Local Models"</button>
            <button class=move || if tab.get() == "browse" { "tab active" } else { "tab" }
                on:click=move |_| set_tab.set("browse")>"Browse HuggingFace"</button>
        </div>

        {move || (tab.get() == "local").then(|| view! {
            <div class="local-tab">
                <h2 class="section-title">"Installed Models"</h2>
                {move || if local_models.get().is_empty() {
                    view! { <p class="dim">"No models installed. Go to Browse to download one."</p> }.into_view()
                } else {
                    view! {
                        <div class="model-grid">
                            <For
                                each=move || local_models.get()
                                key=|m| m.path.clone()
                                children=move |m: ModelInfo| {
                                    let is_loaded = loaded.get().map(|l| l.path == m.path).unwrap_or(false);
                                    let path1 = m.path.clone();
                                    let path2 = m.path.clone();
                                    view! {
                                        <div class="model-card">
                                            <div class="model-card-header">
                                                <span class=move || if is_loaded { "status-dot green" } else { "status-dot" }></span>
                                                <b class="model-name">{m.name.clone()}</b>
                                            </div>
                                            <div class="model-meta">
                                                <span>{human_bytes(m.size_bytes)}</span>
                                                {m.quant.clone().map(|q| view! { <span class="tag">{q}</span> })}
                                                {m.ctx_len.map(|c| view! { <span class="tag">"ctx "{c}</span> })}
                                            </div>
                                            <div class="model-actions">
                                                {if is_loaded {
                                                    view! { <button class="btn ghost sm" on:click=do_unload>"Unload"</button> }.into_view()
                                                } else {
                                                    let p = path1.clone();
                                                    view! { <button class="btn sm" on:click=move |_| do_load(p.clone())>"Load"</button> }.into_view()
                                                }}
                                                <button class="btn danger sm" on:click=move |_| do_delete(path2.clone())>"Delete"</button>
                                            </div>
                                        </div>
                                    }
                                }
                            />
                        </div>
                    }.into_view()
                }}
            </div>
        })}

        {move || (tab.get() == "browse").then(|| view! {
            <div class="browser">
                <div class="browser-left">
                    <div class="search-row">
                        <input
                            class="search-input"
                            placeholder="Search models on HuggingFace..."
                            prop:value=move || hf_query.get()
                            on:input=move |e| set_hf_query.set(event_target_value(&e))
                            on:keydown=move |e| { if e.key() == "Enter" { do_search(); } }
                        />
                        <button class="btn sm" on:click=move |_| do_search()>"Search"</button>
                    </div>

                    {move || hf_error.get().map(|e| view! {
                        <p class="error-msg" style="padding:12px;color:#f87171">{e}</p>
                    })}

                    {move || hf_loading.get().then(|| view! {
                        <p class="dim loading" style="padding:12px">"Searching..."</p>
                    })}

                    <div class="result-list">
                        <For
                            each=move || hf_results.get()
                            key=|m| m.id.clone()
                            children=move |m: HfModelSummary| {
                                let repo_id = m.id.clone();
                                let mid = m.id.clone();
                                let mid2 = m.id.clone();
                                let label = format!("⬇ {}  ♥ {}  {}", fmt_num(m.downloads), m.likes, fmt_date(&m.last_modified));
                                view! {
                                    <div
                                        class=move || {
                                            if hf_selected.get().as_ref().map(|d| d.id == mid).unwrap_or(false) {
                                                "result-item selected"
                                            } else { "result-item" }
                                        }
                                        on:click=move |_| select_model(repo_id.clone())
                                    >
                                        <div class="result-title">{mid2.clone()}</div>
                                        <div class="result-meta">{label}</div>
                                    </div>
                                }
                            }
                        />
                    </div>
                </div>

                <div class="browser-right">
                    {move || {
                        if hf_detail_loading.get() {
                            return view! { <p class="dim loading">"Loading model info..."</p> }.into_view();
                        }
                        match hf_selected.get() {
                            None => view! { <p class="dim">"Select a model to see details."</p> }.into_view(),
                            Some(detail) => view! {
                                <HfDetailPanel
                                    detail=detail
                                    selected_file=selected_file
                                    set_selected_file=set_selected_file
                                    downloading=downloading
                                    dl_progress=dl_progress
                                    dl_error=dl_error
                                    do_download=do_download
                                    do_cancel=do_cancel
                                />
                            }.into_view(),
                        }
                    }}
                </div>
            </div>
        })}
    }
}
