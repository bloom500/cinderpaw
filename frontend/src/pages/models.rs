use leptos::*;
use leptos_router::use_navigate;
use serde::{Deserialize, Serialize};
use serde_json::json;
use wasm_bindgen::JsValue;

use crate::pages::types::{human_bytes, LoadedModel, ModelInfo, SystemInfo};
use crate::tauri_bridge;
use crate::context::DownloadContext;

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
    dl_done: ReadSignal<bool>,
    local_models: ReadSignal<Vec<ModelInfo>>,
    do_download: Callback<()>,
    do_cancel: Callback<()>,
    loading_path: ReadSignal<Option<String>>,
    load_progress: ReadSignal<f64>,
    load_status: ReadSignal<String>,
    do_load_hf: Callback<String>,
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

            {move || {
                if dl_done.get() {
                    view! {
                        <div class="dl-success">
                            <svg class="dl-check-svg" viewBox="0 0 52 52">
                                <circle class="dl-check-circle" cx="26" cy="26" r="23" fill="none"/>
                                <polyline class="dl-check-mark" points="14,26 22,34 38,18" fill="none"/>
                            </svg>
                            <span class="dl-success-label">"Model installed successfully"</span>
                        </div>
                    }.into_view()
                } else if downloading.get() {
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
                    let sel = selected_file.get();
                    let installed_path: Option<String> = sel.as_ref().and_then(|sf| {
                        local_models.get().into_iter()
                            .find(|m| m.name == sf.rfilename)
                            .map(|m| m.path.clone())
                    });
                    if let Some(path) = installed_path {
                        let is_loading = loading_path.get().as_deref() == Some(&path);
                        if is_loading {
                            view! {
                                <div class="model-load-bar-wrap">
                                    <div class="model-load-bar-header">
                                        <span class="model-load-bar-status">{move || load_status.get()}</span>
                                        <span class="model-load-bar-pct">{move || format!("{:.0}%", load_progress.get())}</span>
                                    </div>
                                    <div class="model-load-bar-track">
                                        <div class="model-load-bar-fill"
                                            style=move || format!("width:{}%", load_progress.get())>
                                            <div class="model-load-bar-shimmer"></div>
                                        </div>
                                    </div>
                                </div>
                            }.into_view()
                        } else {
                            let p = path.clone();
                            view! {
                                <button
                                    class="btn load-btn"
                                    on:click=move |_| do_load_hf.call(p.clone())
                                >
                                    "Load model"
                                </button>
                            }.into_view()
                        }
                    } else {
                        let no_sel = sel.is_none();
                        view! {
                            <button
                                class="btn download-btn"
                                disabled=no_sel
                                on:click=move |_| do_download.call(())
                            >
                                "Install Model Locally"
                            </button>
                        }.into_view()
                    }
                }
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

    let dl = use_context::<DownloadContext>().expect("DownloadContext not provided");

    let (hf_query, set_hf_query) = create_signal(String::new());
    let (hf_results, set_hf_results) = create_signal::<Vec<HfModelSummary>>(vec![]);
    let (hf_selected, set_hf_selected) = create_signal::<Option<HfModelDetail>>(None);
    let (hf_loading, set_hf_loading) = create_signal(false);
    let (hf_detail_loading, set_hf_detail_loading) = create_signal(false);
    let (hf_error, set_hf_error) = create_signal::<Option<String>>(None);
    let (selected_file, set_selected_file) = create_signal::<Option<HfFile>>(None);
    let (_is_first_model, _set_is_first_model) = create_signal(false);
    let (tab, set_tab) = create_signal("local");
    let (loading_path, set_loading_path) = create_signal::<Option<String>>(None);
    let (load_error, set_load_error) = create_signal::<Option<String>>(None);
    let (load_progress, set_load_progress) = create_signal(0.0f64);
    let (load_status, set_load_status) = create_signal(String::new());
    let (popular_loaded, set_popular_loaded) = create_signal(false);
    let navigate = use_navigate();

    // Load popular GGUF models on mount so Browse tab isn't empty
    let load_popular = move || {
        if popular_loaded.get() { return; }
        set_hf_loading.set(true);
        set_hf_error.set(None);
        set_hf_results.set(vec![]);
        set_hf_selected.set(None);
        spawn_local(async move {
            // Default to searching "llama" sorted by downloads — catches most popular GGUF models
            match tauri_bridge::invoke::<Vec<HfModelSummary>>(
                "search_hf_models", json!({ "query": "llama" })
            ).await {
                Ok(list) => { set_hf_results.set(list); set_popular_loaded.set(true); }
                Err(e) => set_hf_error.set(Some(format!("Failed to load popular models: {}", e))),
            }
            set_hf_loading.set(false);
        });
    };

    // Trigger popular search when Browse tab is first opened
    create_effect(move |_| {
        if tab.get() == "browse" && !popular_loaded.get() {
            load_popular();
        }
    });

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

    // Refresh local model list when a download finishes. State updates are handled
    // globally in App so they persist when the user navigates away.
    tauri_bridge::listen("feral://download-complete", move |_: JsValue| {
        refresh_local();
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
        dl.dl_done.set(false);
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
        dl.model_name.set(file.rfilename.clone());
        dl.downloading.set(true);
        dl.progress.set(0.0);
        dl.dl_done.set(false);
        dl.dl_error.set(None);
        dl.dl_id.set(Some(key));
        spawn_local(async move {
            if let Err(e) = tauri_bridge::invoke::<String>(
                "download_model",
                json!({ "repoId": detail.id, "filename": file.rfilename })
            ).await {
                dl.dl_error.set(Some(format!("Could not start download: {}", e)));
                dl.downloading.set(false);
                dl.dl_id.set(None);
            }
        });
    });

    let do_cancel = Callback::new(move |_: ()| {
        let Some(id) = dl.dl_id.get() else { return };
        dl.downloading.set(false);
        dl.progress.set(0.0);
        dl.dl_id.set(None);
        dl.dl_error.set(None);
        spawn_local(async move {
            let _ = tauri_bridge::invoke_unit(
                "cancel_download",
                json!({ "modelId": id })
            ).await;
        });
    });

    let do_load = move |path: String| {
        set_loading_path.set(Some(path.clone()));
        set_load_progress.set(0.0);
        set_load_status.set("Initializing...".into());
        set_load_error.set(None);
        spawn_local(async move {
            let sp = set_load_progress;
            let ss = set_load_status;
            // Register listener BEFORE invoking to avoid missing the first event.
            let unlisten = tauri_bridge::listen_once_async(
                "model-load-progress",
                move |val: JsValue| {
                    if let Ok(obj) = serde_wasm_bindgen::from_value::<serde_json::Value>(val) {
                        if let Some(p) = obj.get("payload") {
                            if let Some(pct) = p.get("percentage").and_then(|v| v.as_f64()) {
                                sp.set(pct);
                            }
                            if let Some(txt) = p.get("status_text").and_then(|v| v.as_str()) {
                                ss.set(txt.to_string());
                            }
                        }
                    }
                },
            ).await;
            match tauri_bridge::invoke::<LoadedModel>(
                "start_model_load", json!({ "path": path })
            ).await {
                Ok(l) => { set_loaded.set(Some(l)); set_load_error.set(None); }
                Err(e) => { set_load_error.set(Some(e)); }
            }
            tauri_bridge::call_unlisten(&unlisten);
            set_loading_path.set(None);
            set_load_progress.set(0.0);
            set_load_status.set(String::new());
        });
    };

    let do_load_hf = {
        let nav = navigate.clone();
        Callback::new(move |path: String| {
            let nav2 = nav.clone();
            set_loading_path.set(Some(path.clone()));
            set_load_progress.set(0.0);
            set_load_status.set("Initializing...".into());
            set_load_error.set(None);
            spawn_local(async move {
                let sp = set_load_progress;
                let ss = set_load_status;
                let unlisten = tauri_bridge::listen_once_async(
                    "model-load-progress",
                    move |val: JsValue| {
                        if let Ok(obj) = serde_wasm_bindgen::from_value::<serde_json::Value>(val) {
                            if let Some(p) = obj.get("payload") {
                                if let Some(pct) = p.get("percentage").and_then(|v| v.as_f64()) {
                                    sp.set(pct);
                                }
                                if let Some(txt) = p.get("status_text").and_then(|v| v.as_str()) {
                                    ss.set(txt.to_string());
                                }
                            }
                        }
                    },
                ).await;
                match tauri_bridge::invoke::<LoadedModel>(
                    "start_model_load", json!({ "path": path })
                ).await {
                    Ok(l) => {
                        set_loaded.set(Some(l));
                        set_load_error.set(None);
                        nav2("/chat", Default::default());
                    }
                    Err(e) => { set_load_error.set(Some(e)); }
                }
                tauri_bridge::call_unlisten(&unlisten);
                set_loading_path.set(None);
                set_load_progress.set(0.0);
                set_load_status.set(String::new());
            });
        })
    };

    let do_unload = move |_| {
        spawn_local(async move {
            let _ = tauri_bridge::invoke_unit("unload_model", json!({})).await;
            set_loaded.set(None);
        });
    };

    let do_delete = move |path: String| {
        let is_currently_loaded = loaded.get().map(|l| l.path == path).unwrap_or(false);
        spawn_local(async move {
            // Unload first so the file isn't locked on Windows
            if is_currently_loaded {
                let _ = tauri_bridge::invoke_unit("unload_model", json!({})).await;
                set_loaded.set(None);
            }
            match tauri_bridge::invoke_unit("delete_model", json!({ "path": path })).await {
                Ok(_) => {
                    if let Ok(list) = tauri_bridge::invoke::<Vec<ModelInfo>>("get_models", json!({})).await {
                        set_local_models.set(list);
                    }
                }
                Err(e) => set_load_error.set(Some(format!("Delete failed: {}", e))),
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
                {move || load_error.get().map(|e| view! {
                    <div class="dl-error-banner" style="margin-bottom:12px">
                        <span class="dl-error-icon">"!"</span>
                        <span>{e}</span>
                        <button style="margin-left:auto;background:none;border:none;color:inherit;cursor:pointer"
                            on:click=move |_| set_load_error.set(None)>"✕"</button>
                    </div>
                })}
                {move || if local_models.get().is_empty() {
                    view! { <p class="dim">"No models installed. Go to Browse to download one."</p> }.into_view()
                } else {
                    view! {
                        <div class="model-grid">
                            <For
                                each=move || local_models.get()
                                key=|m| m.path.clone()
                                children=move |m: ModelInfo| {
                                    let path = m.path.clone();
                                    let path_dot = path.clone();
                                    let model_name = m.name.clone();
                                    let size_str = human_bytes(m.size_bytes);
                                    let quant = m.quant.clone();
                                    let ctx_len = m.ctx_len;
                                    view! {
                                        <div class="model-card">
                                            <div class="model-card-header">
                                                <span class=move || {
                                                    if loaded.get().map(|l| l.path == path_dot).unwrap_or(false) { "status-dot green" }
                                                    else if loading_path.get().as_deref() == Some(&path_dot) { "status-dot yellow" }
                                                    else { "status-dot" }
                                                }></span>
                                                <b class="model-name">{model_name}</b>
                                            </div>
                                            <div class="model-meta">
                                                <span>{size_str}</span>
                                                {quant.map(|q| view! { <span class="tag">{q}</span> })}
                                                {ctx_len.map(|c| view! { <span class="tag">"ctx "{c}</span> })}
                                            </div>
                                            {move || {
                                                let p = path.clone();
                                                if loaded.get().map(|l| l.path == p).unwrap_or(false) {
                                                    let p_del = p.clone();
                                                    view! {
                                                        <div class="model-actions">
                                                            <button class="btn ghost sm" on:click=do_unload>"Unload"</button>
                                                            <button class="btn danger sm" on:click=move |_| do_delete(p_del.clone())>"Delete"</button>
                                                        </div>
                                                    }.into_view()
                                                } else if loading_path.get().as_deref() == Some(p.as_str()) {
                                                    view! {
                                                        <div class="model-load-bar-wrap">
                                                            <div class="model-load-bar-header">
                                                                <span class="model-load-bar-status">{move || load_status.get()}</span>
                                                                <span class="model-load-bar-pct">{move || format!("{:.0}%", load_progress.get())}</span>
                                                            </div>
                                                            <div class="model-load-bar-track">
                                                                <div class="model-load-bar-fill"
                                                                    style=move || format!("width:{}%", load_progress.get())>
                                                                    <div class="model-load-bar-shimmer"></div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    }.into_view()
                                                } else {
                                                    let p_load = p.clone();
                                                    let p_del = p.clone();
                                                    view! {
                                                        <div class="model-actions">
                                                            <button class="btn sm" on:click=move |_| do_load(p_load.clone())>"Load"</button>
                                                            <button class="btn danger sm" on:click=move |_| do_delete(p_del.clone())>"Delete"</button>
                                                        </div>
                                                    }.into_view()
                                                }
                                            }}
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
                        if dl.dl_done.get() {
                            let model_name = dl.model_name.get();
                            view! {
                                <div class="dl-first-celebrate">
                                    <div class="dl-celebrate-emoji">"🎉"</div>
                                    <h2 class="dl-celebrate-title">"Awesome! You just installed your first AI model locally."</h2>
                                    <p class="dl-celebrate-sub">"Feral is now fully autonomous and ready to operate 100% offline."</p>
                                    <button class="btn-cta-pulse" on:click=move |_| {
                                        let name = model_name.clone();
                                        spawn_local(async move {
                                            if !name.is_empty() {
                                                if let Ok(list) = tauri_bridge::invoke::<Vec<ModelInfo>>("get_models", json!({})).await {
                                                    if let Some(m) = list.into_iter().find(|mm| mm.name == name) {
                                                        let _ = tauri_bridge::invoke::<LoadedModel>(
                                                            "load_model", json!({ "path": m.path })
                                                        ).await;
                                                    }
                                                }
                                            }
                                            let _ = web_sys::window()
                                                .and_then(|w| w.location().set_href("/chat").ok());
                                        });
                                    }>"Go to Chat & Start Creating →"</button>
                                </div>
                            }.into_view()
                        } else if hf_detail_loading.get() {
                            view! { <p class="dim loading">"Loading model info..."</p> }.into_view()
                        } else if let Some(detail) = hf_selected.get() {
                            view! {
                                <HfDetailPanel
                                    detail=detail
                                    selected_file=selected_file
                                    set_selected_file=set_selected_file
                                    downloading=dl.downloading.read_only()
                                    dl_progress=dl.progress.read_only()
                                    dl_error=dl.dl_error.read_only()
                                    dl_done=dl.dl_done.read_only()
                                    local_models=local_models
                                    do_download=do_download
                                    do_cancel=do_cancel
                                    loading_path=loading_path
                                    load_progress=load_progress
                                    load_status=load_status
                                    do_load_hf=do_load_hf
                                />
                            }.into_view()
                        } else {
                            view! { <p class="dim">"Select a model to see details."</p> }.into_view()
                        }
                    }}
                </div>
            </div>
        })}
    }
}
