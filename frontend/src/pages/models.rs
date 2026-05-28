use leptos::*;
use leptos_router::use_navigate;
use serde::{Deserialize, Serialize};
use serde_json::json;
use wasm_bindgen::JsValue;

use crate::pages::types::{human_bytes, LoadedModel, ModelInfo, SystemInfo};
use crate::tauri_bridge;
use crate::context::{DownloadContext, ModelLoadContext};

// ── BYOK Panel ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ByokProviderInfo {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub has_api_key: bool,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
}

#[component]
fn ByokPanel() -> impl IntoView {
    let (providers, set_providers) = create_signal::<Vec<ByokProviderInfo>>(vec![]);
    let (expanded, set_expanded) = create_signal::<Option<String>>(None);
    let (saving, set_saving) = create_signal(false);
    let (test_result, set_test_result) = create_signal::<Option<(bool, String)>>(None);
    let (testing, set_testing) = create_signal(false);
    let (edit_api_key, set_edit_api_key) = create_signal(std::collections::HashMap::<String, String>::new());
    let (edit_base_url, set_edit_base_url) = create_signal(std::collections::HashMap::<String, String>::new());
    let (edit_model, set_edit_model) = create_signal(std::collections::HashMap::<String, String>::new());
    let (edit_enabled, set_edit_enabled) = create_signal(std::collections::HashMap::<String, bool>::new());

    let load_providers = move || {
        spawn_local(async move {
            match tauri_bridge::invoke::<Vec<ByokProviderInfo>>("get_byok_settings", json!({})).await {
                Ok(list) => {
                    set_providers.set(list.clone());
                    let mut keys = std::collections::HashMap::new();
                    let mut urls = std::collections::HashMap::new();
                    let mut models = std::collections::HashMap::new();
                    let mut enabled = std::collections::HashMap::new();
                    for p in list.iter() {
                        keys.insert(p.id.clone(), String::new());
                        urls.insert(p.id.clone(), p.base_url.clone().unwrap_or_default());
                        models.insert(p.id.clone(), p.default_model.clone().unwrap_or_default());
                        enabled.insert(p.id.clone(), p.enabled);
                    }
                    set_edit_api_key.set(keys);
                    set_edit_base_url.set(urls);
                    set_edit_model.set(models);
                    set_edit_enabled.set(enabled);
                }
                Err(e) => tracing::error!("get_byok_settings: {}", e),
            }
        });
    };
    load_providers();

    let save_provider = move |provider_id: String| {
        set_saving.set(true);
        set_test_result.set(None);
        let api_key = edit_api_key.get().get(&provider_id).cloned().unwrap_or_default();
        let base_url = edit_base_url.get().get(&provider_id).cloned().filter(|s| !s.is_empty());
        let default_model = edit_model.get().get(&provider_id).cloned().filter(|s| !s.is_empty());
        let enabled = edit_enabled.get().get(&provider_id).copied().unwrap_or(false);
        let provider_id_copy = provider_id.clone();
        spawn_local(async move {
            match tauri_bridge::invoke::<()>("save_byok_provider", json!({
                "providerId": provider_id_copy,
                "enabled": enabled,
                "apiKey": api_key,
                "baseUrl": base_url,
                "defaultModel": default_model,
            })).await {
                Ok(_) => {
                    set_expanded.set(None);
                    load_providers();
                }
                Err(e) => set_test_result.set(Some((false, format!("Save failed: {}", e)))),
            }
            set_saving.set(false);
        });
    };

    let test_provider = move |provider_id: String| {
        set_testing.set(true);
        set_test_result.set(None);
        let api_key = edit_api_key.get().get(&provider_id).cloned().unwrap_or_default();
        let base_url = edit_base_url.get().get(&provider_id).cloned().filter(|s| !s.is_empty());
        let provider_id_copy = provider_id.clone();
        spawn_local(async move {
            match tauri_bridge::invoke::<serde_json::Value>("test_byok_provider", json!({
                "providerId": provider_id_copy,
                "apiKey": api_key,
                "baseUrl": base_url,
            })).await {
                Ok(result) => {
                    let success = result.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                    let message = result.get("message").and_then(|v| v.as_str()).unwrap_or("Unknown response").to_string();
                    set_test_result.set(Some((success, message)));
                }
                Err(e) => set_test_result.set(Some((false, format!("Test failed: {}", e)))),
            }
            set_testing.set(false);
        });
    };

    view! {
        <div class="byok-grid">
            <For each=move || providers.get() key=|p| p.id.clone() children=move |p: ByokProviderInfo| {
                let pid_click = p.id.clone();
                let pid_class = p.id.clone();
                // Input handler IDs — each captured once, cloned on each event.
                let id_key     = p.id.clone();
                let id_url     = p.id.clone();
                let id_mod     = p.id.clone();
                let id_ena     = p.id.clone();
                let id_tst     = p.id.clone();
                let id_sav     = p.id.clone();
                // Separate clones for reactive disabled checks on both buttons.
                let id_dis_tst = p.id.clone();
                let id_dis_sav = p.id.clone();

                let api_key_val       = edit_api_key.get().get(&p.id).cloned().unwrap_or_default();
                let base_url_val      = edit_base_url.get().get(&p.id).cloned().unwrap_or_default();
                let default_model_val = edit_model.get().get(&p.id).cloned().unwrap_or_default();
                let enabled_val       = edit_enabled.get().get(&p.id).copied().unwrap_or(false);

                view! {
                    // `open` class drives the CSS max-height animation.
                    <div class=move || if expanded.get() == Some(pid_class.clone()) { "byok-card open" } else { "byok-card" }>
                        <div class="byok-card-header" on:click=move |_| {
                            let currently = expanded.get() == Some(pid_click.clone());
                            set_expanded.set(if currently { None } else { Some(pid_click.clone()) });
                            set_test_result.set(None);
                        }>
                            <div class="byok-provider-status">
                                <span class=if p.has_api_key { "status-dot green" } else { "status-dot" }></span>
                                <span class="byok-provider-name">{p.name.clone()}</span>
                            </div>
                            <div class="byok-card-actions">
                                <span class="dim" style="font-size:0.8rem">
                                    {if p.has_api_key { "Configured" } else { "Not set" }}
                                </span>
                                <span class="byok-expand-icon">"▸"</span>
                            </div>
                        </div>

                        // Body always in DOM — CSS transition animates open/close.
                        <div class="byok-card-body">
                            <div class="byok-field">
                                <label class="byok-label">"API Key"</label>
                                <input class="byok-input" type="password" placeholder="sk-..."
                                    prop:value={api_key_val}
                                    on:input=move |e| {
                                        let val = event_target_value(&e);
                                        set_edit_api_key.update(|m| { m.insert(id_key.clone(), val); });
                                    }
                                />
                            </div>
                            <div class="byok-field">
                                <label class="byok-label">"Base URL (optional)"</label>
                                <input class="byok-input" type="text" placeholder="https://api.openai.com/v1"
                                    prop:value={base_url_val}
                                    on:input=move |e| {
                                        let val = event_target_value(&e);
                                        set_edit_base_url.update(|m| { m.insert(id_url.clone(), val); });
                                    }
                                />
                            </div>
                            <div class="byok-field">
                                <label class="byok-label">"Default Model (optional)"</label>
                                <input class="byok-input" type="text" placeholder="gpt-4o"
                                    prop:value={default_model_val}
                                    on:input=move |e| {
                                        let val = event_target_value(&e);
                                        set_edit_model.update(|m| { m.insert(id_mod.clone(), val); });
                                    }
                                />
                            </div>
                            <div class="byok-field byok-toggle-row">
                                <label class="byok-label">"Enabled"</label>
                                <input class="byok-toggle" type="checkbox"
                                    prop:checked={enabled_val}
                                    on:change=move |e| {
                                        let checked = event_target_checked(&e);
                                        set_edit_enabled.update(|m| { m.insert(id_ena.clone(), checked); });
                                    }
                                />
                            </div>
                            {move || test_result.get().map(|(success, msg)| view! {
                                <div class=move || format!("byok-test-result {}", if success { "success" } else { "error" })>
                                    {msg}
                                </div>
                            })}
                            <div class="byok-card-btns">
                                <button class="btn sm"
                                    disabled=move || testing.get() || edit_api_key.get().get(&id_dis_tst).map(|s| s.is_empty()).unwrap_or(true)
                                    on:click=move |_| test_provider(id_tst.clone())>
                                    {move || if testing.get() { "Testing..." } else { "Test Connection" }}
                                </button>
                                <button class="btn sm primary"
                                    disabled=move || saving.get() || edit_api_key.get().get(&id_dis_sav).map(|s| s.is_empty()).unwrap_or(true)
                                    on:click=move |_| save_provider(id_sav.clone())>
                                    {move || if saving.get() { "Saving..." } else { "Save" }}
                                </button>
                            </div>
                        </div>
                    </div>
                }
            }/>
        </div>
    }
}

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
pub struct HfSearchPage {
    pub models: Vec<HfModelSummary>,
    pub next_cursor: Option<String>,
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

/// Translate a GGUF quant suffix to a human-readable quality label.
fn quant_to_quality(q: &str) -> &'static str {
    let q = q.to_lowercase();
    // Order matters — most specific first
    if q.contains("iq1") { "Ultra fast (lower quality)" }
    else if q.contains("iq2") || q.contains("q2_k") || q.contains("q2") { "Fastest" }
    else if q.contains("q3") { "Fast" }
    else if q.contains("q4_k_m") || q.contains("q4_k") { "Balanced quality" }
    else if q.contains("q4") { "Standard quality" }
    else if q.contains("q5") { "High quality" }
    else if q.contains("q6") { "Very high quality" }
    else if q.contains("q8") { "Best quality" }
    else if q.contains("f16") || q.contains("fp16") || q.contains("bf16") { "Full precision" }
    else if q.contains("f32") { "Full precision (32-bit)" }
    else { "Standard" }
}

/// Strip ".gguf" and quant suffix from a filename for friendly display.
pub fn clean_model_name(name: &str) -> String {
    let lower = name.to_lowercase();
    let stripped = lower.strip_suffix(".gguf").unwrap_or(&lower);
    // Strip trailing .q*-* / .iq*-* / .f16 etc.
    let cleaned = if let Some(idx) = stripped.rfind('.') {
        let suffix = &stripped[idx + 1..];
        if suffix.starts_with('q') || suffix.starts_with("iq") || suffix.starts_with('f') || suffix.starts_with("bf") {
            &stripped[..idx]
        } else { stripped }
    } else { stripped };
    // Title-case each segment for readability
    cleaned.split(&['-', '_'][..])
        .map(|s| {
            let mut chars = s.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Extract the quant string from a filename like "model.Q4_K_M.gguf".
fn extract_quant(filename: &str) -> String {
    let lower = filename.to_lowercase();
    let no_ext = lower.strip_suffix(".gguf").unwrap_or(&lower);
    if let Some(idx) = no_ext.rfind('.') {
        let suffix = &no_ext[idx + 1..];
        if suffix.starts_with('q') || suffix.starts_with("iq") || suffix.starts_with('f') || suffix.starts_with("bf") {
            return suffix.to_uppercase();
        }
    }
    "—".into()
}

/// Size in GB (1 decimal).
fn size_gb(bytes: u64) -> String {
    let gb = bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    if gb < 1.0 {
        format!("{:.0} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.1} GB", gb)
    }
}

/// Returns (label, css-class) for the quality badge shown on each variant row.
fn quant_to_badge(quant: &str) -> (&'static str, &'static str) {
    let q = quant.to_lowercase();
    if q.contains("f16") || q.contains("fp16") || q.contains("bf16") || q.contains("f32") {
        ("Full", "full")
    } else if q.contains("q8") || q.contains("q6") {
        ("High", "high")
    } else if q.contains("q4_k") || q.contains("q5") {
        ("Balanced", "balanced")
    } else if q.contains("q4") || q.contains("q3") || q.contains("iq2") || q.contains("q2") {
        ("Small", "small")
    } else if q.contains("iq1") || q.contains("q1") {
        ("Tiny", "tiny")
    } else {
        ("Standard", "small")
    }
}

/// Numeric quality rank for a GGUF file — higher = better quality.
fn quant_quality_rank(filename: &str) -> u32 {
    let q = extract_quant(filename).to_lowercase();
    if q.contains("f16") || q.contains("fp16") || q.contains("bf16") { 100 }
    else if q.contains("q8") { 80 }
    else if q.contains("q6") { 70 }
    else if q.contains("q5_k_m") { 62 }
    else if q.contains("q5") { 60 }
    else if q.contains("q4_k_m") { 55 }
    else if q.contains("q4_k") { 52 }
    else if q.contains("q4") { 40 }
    else if q.contains("q3") { 30 }
    else if q.contains("iq2") || q.contains("q2") { 20 }
    else if q.contains("iq1") { 10 }
    else { 35 }
}

/// Three-level compatibility classification.
#[derive(Clone, Copy, PartialEq)]
enum Compat { Fits, Slow, No }

/// Returns None when no system info is available.
fn compat_level(bytes: u64, sys: &Option<SystemInfo>) -> Option<Compat> {
    sys.as_ref().map(|s| {
        let capacity = if s.vram_total_mb > 0 {
            (s.vram_total_mb as u64) * 1024 * 1024
        } else {
            (s.ram_total_mb.saturating_sub(s.ram_used_mb) as u64) * 1024 * 1024
        };
        if capacity == 0 { return Compat::No; }
        let comfortable = capacity * 7 / 10;
        if bytes <= comfortable { Compat::Fits }
        else if bytes <= capacity { Compat::Slow }
        else { Compat::No }
    })
}

/// Pick the best-fit GGUF file based on available RAM/VRAM.
/// Prefers the highest quality that still fits comfortably in memory.
fn pick_fitted_file(files: &[HfFile], sys: &Option<SystemInfo>) -> Option<HfFile> {
    if files.is_empty() { return None; }

    let fits: Vec<&HfFile> = files.iter()
        .filter(|f| matches!(compat_level(f.size.unwrap_or(0), sys), Some(Compat::Fits)))
        .collect();

    if !fits.is_empty() {
        return fits.into_iter()
            .max_by_key(|f| quant_quality_rank(&f.rfilename))
            .cloned();
    }

    // Nothing fits comfortably — pick smallest that's Slow
    let slow: Vec<&HfFile> = files.iter()
        .filter(|f| matches!(compat_level(f.size.unwrap_or(0), sys), Some(Compat::Slow)))
        .collect();

    if !slow.is_empty() {
        return slow.into_iter()
            .min_by_key(|f| f.size.unwrap_or(u64::MAX))
            .cloned();
    }

    // Last resort: smallest available file
    files.iter().min_by_key(|f| f.size.unwrap_or(u64::MAX)).cloned()
}

/// Predict the expected fitted quantization tier from hardware without fetching any model.
/// Used to label the Download pill on collapsed cards.
fn global_fitted_quant(sys: &Option<SystemInfo>) -> String {
    let mb = sys.as_ref().map(|s| {
        if s.vram_total_mb > 0 { s.vram_total_mb }
        else { s.ram_total_mb.saturating_sub(s.ram_used_mb) }
    }).unwrap_or(8192);
    if mb >= 32768      { "Q8_0".to_string() }
    else if mb >= 24576 { "Q6_K".to_string() }
    else if mb >= 12288 { "Q5_K_M".to_string() }
    else if mb >= 8192  { "Q4_K_M".to_string() }
    else if mb >= 4096  { "Q3_K_M".to_string() }
    else                { "Q2_K".to_string() }
}

/// Short repo name (drop "{author}/" prefix).
fn short_repo(id: &str) -> String {
    id.rsplit('/').next().unwrap_or(id).to_string()
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
    sysinfo: ReadSignal<Option<SystemInfo>>,
) -> impl IntoView {
    let tags: Vec<String> = detail.tags.iter().take(6).cloned().collect();
    let files = detail.gguf_files.clone();
    let readme = detail.readme.clone();
    let title = detail.id.clone();
    let stats = format!("⬇ {}  ♥ {}  {}", fmt_num(detail.downloads), detail.likes, fmt_date(&detail.last_modified));

    // Pre-populate from lfs.size returned by backend (correct actual file size).
    // HEAD requests fire only for the rare files where lfs.size was absent.
    let repo_id = detail.id.clone();
    let initial_sizes: std::collections::HashMap<String, u64> = files.iter()
        .filter_map(|f| f.size.filter(|&n| n > 0).map(|sz| (f.rfilename.clone(), sz)))
        .collect();
    let (file_sizes, set_file_sizes) = create_signal(initial_sizes);

    for f in files.iter().filter(|f| f.size.filter(|&n| n > 0).is_none()) {
        let repo = repo_id.clone();
        let fname = f.rfilename.clone();
        spawn_local(async move {
            if let Ok(bytes) = tauri_bridge::invoke::<u64>(
                "get_model_size_info",
                json!({ "repoId": repo, "filename": fname })
            ).await {
                if bytes > 0 {
                    set_file_sizes.update(|m| { m.insert(fname, bytes); });
                }
            }
        });
    }

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
                        let fname_for_size = fname.clone();
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
                                <span class="file-size hf-model-size">{move || {
                                    // Always prefer fetched size (reliable via HEAD request)
                                    if let Some(&bytes) = file_sizes.get().get(&fname_for_size) {
                                        human_bytes(bytes)
                                    } else {
                                        "...".to_string()
                                    }
                                }}</span>
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
    let ml = use_context::<ModelLoadContext>().expect("ModelLoadContext not provided");
    let loaded = ml.loaded;
    let set_loaded = ml.loaded.write_only();
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
    let load_progress = ml.progress;
    let load_status = ml.status;
    let (popular_loaded, set_popular_loaded) = create_signal(false);
    let (hf_next_cursor, set_hf_next_cursor) = create_signal::<Option<String>>(None);
    let (deleting_model, set_deleting_model) = create_signal::<Option<String>>(None);
    let (fitted_fetching_repo, set_fitted_fetching_repo) = create_signal::<Option<String>>(None);
    let navigate = use_navigate();

    // Load popular GGUF models on mount so Browse tab isn't empty
    let load_popular = move || {
        if popular_loaded.get() { return; }
        set_hf_loading.set(true);
        set_hf_error.set(None);
        set_hf_results.set(vec![]);
        set_hf_next_cursor.set(None);
        set_hf_selected.set(None);
        spawn_local(async move {
            match tauri_bridge::invoke::<HfSearchPage>(
                "search_hf_models", json!({ "query": "llama", "cursor": null })
            ).await {
                Ok(page) => {
                    set_hf_results.set(page.models);
                    set_hf_next_cursor.set(page.next_cursor);
                    set_popular_loaded.set(true);
                }
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
        set_hf_next_cursor.set(None);
        set_hf_selected.set(None);
        set_popular_loaded.set(false);
        spawn_local(async move {
            match tauri_bridge::invoke::<HfSearchPage>(
                "search_hf_models", json!({ "query": q, "cursor": null })
            ).await {
                Ok(page) => {
                    set_hf_results.set(page.models);
                    set_hf_next_cursor.set(page.next_cursor);
                }
                Err(e) => set_hf_error.set(Some(format!("Search failed: {}", e))),
            }
            set_hf_loading.set(false);
        });
    };

    let do_load_more = move || {
        let cursor = match hf_next_cursor.get() { Some(c) => c, None => return };
        set_hf_loading.set(true);
        spawn_local(async move {
            match tauri_bridge::invoke::<HfSearchPage>(
                "search_hf_models", json!({ "query": "", "cursor": cursor })
            ).await {
                Ok(page) => {
                    set_hf_results.update(|list| list.extend(page.models));
                    set_hf_next_cursor.set(page.next_cursor);
                }
                Err(e) => set_hf_error.set(Some(format!("Load more failed: {}", e))),
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
        ml.progress.set(0.0);
        ml.status.set("Initializing...".into());
        ml.loading.set(true);
        set_load_error.set(None);
        spawn_local(async move {
            match tauri_bridge::invoke::<LoadedModel>(
                "start_model_load", json!({ "path": path })
            ).await {
                Ok(l) => { ml.loaded.set(Some(l)); set_load_error.set(None); }
                Err(e) => { set_load_error.set(Some(e)); }
            }
            ml.loading.set(false);
            ml.progress.set(0.0);
            ml.status.set(String::new());
            set_loading_path.set(None);
        });
    };

    let do_load_hf = {
        let nav = navigate.clone();
        Callback::new(move |path: String| {
            let nav2 = nav.clone();
            set_loading_path.set(Some(path.clone()));
            ml.progress.set(0.0);
            ml.status.set("Initializing...".into());
            ml.loading.set(true);
            set_load_error.set(None);
            spawn_local(async move {
                match tauri_bridge::invoke::<LoadedModel>(
                    "start_model_load", json!({ "path": path })
                ).await {
                    Ok(l) => {
                        ml.loaded.set(Some(l));
                        set_load_error.set(None);
                        nav2("/chat", Default::default());
                    }
                    Err(e) => { set_load_error.set(Some(e)); }
                }
                ml.loading.set(false);
                ml.progress.set(0.0);
                ml.status.set(String::new());
                set_loading_path.set(None);
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
        set_deleting_model.set(Some(path.clone()));
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
            set_deleting_model.set(None);
        });
    };

    let tab_local_cls = move || if tab.get() == "local" { "mlib-tab active" } else { "mlib-tab" };
    let tab_browse_cls = move || if tab.get() == "browse" { "mlib-tab active" } else { "mlib-tab" };
    let tab_custom_cls = move || if tab.get() == "byok" { "mlib-tab active" } else { "mlib-tab" };

    view! {
        <div class="mlib-root">

        // ─ System bar (clean single line)
        {move || sysinfo.get().map(|s| {
            let vram = if s.vram_total_mb > 0 {
                format!("{} GB VRAM", (s.vram_total_mb as f64 / 1024.0).round() as u32)
            } else { "Integrated GPU".to_string() };
            let ram = format!("{} GB RAM", (s.ram_total_mb as f64 / 1024.0).round() as u32);
            view! {
                <div class="mlib-sysbar">
                    <b>{s.gpu_name}</b>
                    <span class="sep"></span>
                    <span>{vram}</span>
                    <span class="sep"></span>
                    <span>{ram}</span>
                    <span class="sep"></span>
                    {if s.supports_vulkan {
                        view! { <span class="vulkan-ok">"Vulkan ✓"</span> }.into_view()
                    } else {
                        view! { <span>"Vulkan unavailable"</span> }.into_view()
                    }}
                </div>
            }
        })}

        // ─ Pill tabs
        <div class="mlib-tabs">
            <button class=tab_local_cls on:click=move |_| set_tab.set("local")>"Local Models"</button>
            <button class=tab_browse_cls on:click=move |_| set_tab.set("browse")>"Browse HuggingFace"</button>
            <button class=tab_custom_cls on:click=move |_| set_tab.set("byok")>"Add Custom"</button>
        </div>

        {move || (tab.get() == "local").then(|| view! {
            <div class="mlib-local">
                {move || load_error.get().map(|e| view! {
                    <div class="mlib-error">{e}</div>
                })}
                {move || if local_models.get().is_empty() {
                    view! { <div class="mlib-empty">"No models installed yet. Switch to Browse HuggingFace to download your first model."</div> }.into_view()
                } else {
                    view! {
                        <div class="mlib-local-grid">
                            <For
                                each=move || local_models.get()
                                key=|m| m.path.clone()
                                children=move |m: ModelInfo| {
                                    let path = m.path.clone();
                                    let path_for_cls = path.clone();
                                    let path_for_badge = path.clone();
                                    let display_name = clean_model_name(&m.name);
                                    let size_str = size_gb(m.size_bytes);
                                    let quality = quant_to_quality(m.quant.as_deref().unwrap_or(""));
                                    let card_cls = move || {
                                        if loaded.get().map(|l| l.path == path_for_cls).unwrap_or(false) {
                                            "mlib-local-card active"
                                        } else { "mlib-local-card" }
                                    };
                                    view! {
                                        <div class=card_cls>
                                            <div class="mlib-local-name">{display_name}</div>
                                            <div class="mlib-local-meta">
                                                <span>{size_str}</span>
                                                <span class="sep">"·"</span>
                                                <span>{quality}</span>
                                                {move || loaded.get()
                                                    .filter(|l| l.path == path_for_badge)
                                                    .map(|_| view! {
                                                        <>
                                                            <span class="sep">"·"</span>
                                                            <span class="mlib-active-badge">"Active"</span>
                                                        </>
                                                    })}
                                            </div>
                                            {move || {
                                                let p = path.clone();
                                                if loaded.get().map(|l| l.path == p).unwrap_or(false) {
                                                    let p_del = p.clone();
                                                    let is_deleting = move || deleting_model.get() == Some(p.clone());
                                                    let is_deleting_disabled = is_deleting.clone();
                                                    view! {
                                                        <div class="mlib-local-actions">
                                                            <button class="mlib-btn-mini ghost" on:click=do_unload>"Unload"</button>
                                                            <button
                                                                class="mlib-btn-mini danger"
                                                                disabled=move || is_deleting_disabled()
                                                                on:click=move |_| do_delete(p_del.clone())>
                                                                {move || if is_deleting() {
                                                                    view! { <span class="btn-delete-spinner"></span> }.into_view()
                                                                } else {
                                                                    "Delete".into_view()
                                                                }}
                                                            </button>
                                                        </div>
                                                    }.into_view()
                                                } else if loading_path.get().as_deref() == Some(p.as_str()) {
                                                    view! {
                                                        <div class="mlib-dl-bar">
                                                            <div class="mlib-dl-row">
                                                                <span>{move || load_status.get()}</span>
                                                                <span>{move || format!("{:.0}%", load_progress.get())}</span>
                                                            </div>
                                                            <div class="mlib-dl-track">
                                                                <div class="mlib-dl-fill" style=move || format!("width:{}%", load_progress.get())></div>
                                                            </div>
                                                        </div>
                                                    }.into_view()
                                                } else {
                                                    let p_load = p.clone();
                                                    let p_del = p.clone();
                                                    let is_deleting = move || deleting_model.get() == Some(p.clone());
                                                    let is_deleting_disabled = is_deleting.clone();
                                                    view! {
                                                        <div class="mlib-local-actions">
                                                            <button class="mlib-btn-mini" on:click=move |_| do_load(p_load.clone())>"Load"</button>
                                                            <button
                                                                class="mlib-btn-mini danger"
                                                                disabled=move || is_deleting_disabled()
                                                                on:click=move |_| do_delete(p_del.clone())>
                                                                {move || if is_deleting() {
                                                                    view! { <span class="btn-delete-spinner"></span> }.into_view()
                                                                } else {
                                                                    "Delete".into_view()
                                                                }}
                                                            </button>
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
            <div class="mlib-browse">
                // Toolbar: search + sort + downloaded filter
                <div class="mlib-toolbar">
                    <div class="mlib-search">
                        <span class="mlib-search-icon">"⌕"</span>
                        <input
                            type="text"
                            placeholder="Search models on HuggingFace..."
                            prop:value=move || hf_query.get()
                            on:input=move |e| set_hf_query.set(event_target_value(&e))
                            on:keydown=move |e| { if e.key() == "Enter" { do_search(); } }
                        />
                    </div>
                    <button class="mlib-sort" on:click=move |_| do_search()>"Search"</button>
                </div>

                {move || hf_error.get().map(|e| view! { <div class="mlib-error">{e}</div> })}
                {move || hf_loading.get().then(|| view! { <div class="mlib-loading">"Searching..."</div> })}

                // Single-column card list
                <div class="mlib-list">
                    <For
                        each=move || hf_results.get()
                        key=|m| m.id.clone()
                        children=move |m: HfModelSummary| {
                            let repo_id = m.id.clone();
                            let repo_id_click = repo_id.clone();
                            let repo_id_match = repo_id.clone();
                            let short = short_repo(&repo_id);
                            let downloads = m.downloads;
                            let likes = m.likes;
                            let last_modified = fmt_date(&m.last_modified);
                            let has_tools = m.tags.iter().any(|t| {
                                let t = t.to_lowercase();
                                t.contains("tool") || t.contains("function")
                            });
                            // Description fallback — use first non-empty tag-derived text
                            let desc = if m.tags.is_empty() {
                                String::new()
                            } else {
                                m.tags.iter().take(3).cloned().collect::<Vec<_>>().join(" · ")
                            };

                            let is_expanded = create_memo(move |_| {
                                hf_selected.get().as_ref().map(|d| d.id == repo_id_match).unwrap_or(false)
                            });

                            // Fitted file for this card (computed reactively — no is_expanded gate
                            // so the Download pill can appear even on collapsed cards)
                            let fitted_file_memo = create_memo(move |_| -> Option<HfFile> {
                                hf_selected.get()
                                    .and_then(|d| pick_fitted_file(&d.gguf_files, &sysinfo.get()))
                            });

                            let repo_check = repo_id.clone();
                            let is_fitted_fetching = create_memo(move |_| {
                                fitted_fetching_repo.get().as_deref() == Some(&repo_check)
                            });
                            let repo_pill = repo_id.clone();
                            let repo_var  = repo_id.clone();
                            let sys_pill  = sysinfo;
                            let dl_pill   = dl;
                            let do_pill_click = move |_| {
                                if dl_pill.downloading.get() || fitted_fetching_repo.get().is_some() { return; }
                                if is_expanded.get() {
                                    if let Some(file) = fitted_file_memo.get() {
                                        let repo = repo_pill.clone();
                                        let key  = format!("{}::{}", repo, file.rfilename);
                                        dl_pill.model_name.set(file.rfilename.clone());
                                        dl_pill.downloading.set(true);
                                        dl_pill.progress.set(0.0);
                                        dl_pill.dl_done.set(false);
                                        dl_pill.dl_error.set(None);
                                        dl_pill.dl_id.set(Some(key));
                                        let fname = file.rfilename.clone();
                                        spawn_local(async move {
                                            if let Err(e) = tauri_bridge::invoke::<String>(
                                                "download_model",
                                                json!({ "repoId": repo, "filename": fname })
                                            ).await {
                                                dl_pill.dl_error.set(Some(format!("Could not start download: {}", e)));
                                                dl_pill.downloading.set(false);
                                                dl_pill.dl_id.set(None);
                                            }
                                        });
                                    }
                                } else {
                                    let repo = repo_pill.clone();
                                    set_fitted_fetching_repo.set(Some(repo.clone()));
                                    let sys = sys_pill.get();
                                    spawn_local(async move {
                                        match tauri_bridge::invoke::<HfModelDetail>(
                                            "get_hf_model_detail", json!({ "repoId": repo.clone() })
                                        ).await {
                                            Ok(detail) => {
                                                if let Some(best) = pick_fitted_file(&detail.gguf_files, &sys) {
                                                    let key = format!("{}::{}", detail.id, best.rfilename);
                                                    dl_pill.model_name.set(best.rfilename.clone());
                                                    dl_pill.downloading.set(true);
                                                    dl_pill.progress.set(0.0);
                                                    dl_pill.dl_done.set(false);
                                                    dl_pill.dl_error.set(None);
                                                    dl_pill.dl_id.set(Some(key));
                                                    let fname = best.rfilename.clone();
                                                    if let Err(e) = tauri_bridge::invoke::<String>(
                                                        "download_model",
                                                        json!({ "repoId": repo, "filename": fname })
                                                    ).await {
                                                        dl_pill.dl_error.set(Some(format!("Could not start download: {}", e)));
                                                        dl_pill.downloading.set(false);
                                                        dl_pill.dl_id.set(None);
                                                    }
                                                }
                                            }
                                            Err(_) => {}
                                        }
                                        set_fitted_fetching_repo.set(None);
                                    });
                                }
                            };

                            let author = m.id.split('/').next().unwrap_or("").to_string();

                            view! {
                                <div class="mlib-card">
                                    // ── Header: name + always-visible Download pill ───────────
                                    <div class="mlib-card-head">
                                        <div class="mlib-card-head-left">
                                            <span class="mlib-card-name">{short}</span>
                                            {move || {
                                                if !is_expanded.get() { return None; }
                                                fitted_file_memo.get().map(|f| {
                                                    let sz = f.size.map(size_gb).unwrap_or_default();
                                                    let compat = compat_level(f.size.unwrap_or(0), &sysinfo.get());
                                                    let badge = match compat {
                                                        Some(Compat::Fits) => Some(("mlib-compat-badge fits", "✓ Fits")),
                                                        Some(Compat::Slow) => Some(("mlib-compat-badge slow", "! Slow")),
                                                        Some(Compat::No)   => Some(("mlib-compat-badge no",   "✕ Won't fit")),
                                                        None => None,
                                                    };
                                                    view! {
                                                        <>
                                                            {if !sz.is_empty() { view!{<span class="mlib-card-size">{sz}</span>}.into_view() } else { view!{<></>}.into_view() }}
                                                            {badge.map(|(cls, txt)| view!{<span class=cls>{txt}</span>}.into_view())}
                                                        </>
                                                    }
                                                })
                                            }}
                                        </div>
                                        <button class="mlib-fitted-btn"
                                            disabled=move || dl.downloading.get() || fitted_fetching_repo.get().is_some()
                                            on:click=do_pill_click>
                                            {move || {
                                                if is_fitted_fetching.get() {
                                                    "Fetching...".to_string()
                                                } else if is_expanded.get() {
                                                    fitted_file_memo.get()
                                                        .map(|f| format!("Download · {}", extract_quant(&f.rfilename)))
                                                        .unwrap_or_else(|| format!("Download · {}", global_fitted_quant(&sysinfo.get())))
                                                } else {
                                                    format!("Download · {}", global_fitted_quant(&sysinfo.get()))
                                                }
                                            }}
                                        </button>
                                    </div>

                                    // ── Description ──────────────────────────────────────────
                                    {if !desc.is_empty() {
                                        view! { <div class="mlib-card-desc">{desc}</div> }.into_view()
                                    } else { view! { <></> }.into_view() }}

                                    // ── Footer: meta chips + toggle ───────────────────────────
                                    <div class="mlib-card-foot">
                                        <div class="mlib-card-meta">
                                            <span class="mlib-meta-chip">"By "{author}</span>
                                            <span class="mlib-meta-chip">"↓ "{fmt_num(downloads)}</span>
                                            <span class="mlib-meta-chip">"♥ "{likes.to_string()}</span>
                                            <span class="mlib-meta-chip">{last_modified}</span>
                                            {if has_tools {
                                                view! { <span class="mlib-meta-chip tag-tools">"🔧 Tools"</span> }.into_view()
                                            } else { view! { <></> }.into_view() }}
                                        </div>
                                        <button class="mlib-variants-toggle"
                                            on:click=move |_| {
                                                if is_expanded.get() {
                                                    set_hf_selected.set(None);
                                                    set_selected_file.set(None);
                                                } else {
                                                    select_model(repo_id_click.clone());
                                                }
                                            }>
                                            {move || if is_expanded.get() { "Hide variants ▴" } else { "Show variants ▾" }}
                                        </button>
                                    </div>

                                    // ── Expanded variants ─────────────────────────────────────
                                    {move || if is_expanded.get() {
                                        if hf_detail_loading.get() {
                                            view! { <div class="mlib-loading">"Loading variants..."</div> }.into_view()
                                        } else if let Some(detail) = hf_selected.get() {
                                            let files = detail.gguf_files.clone();
                                            let rec_fname = fitted_file_memo.get().map(|f| f.rfilename);
                                            let rvar = repo_var.clone();
                                            view! {
                                                <div class="mlib-variants">
                                                    <For
                                                        each=move || files.clone()
                                                        key=|f| f.rfilename.clone()
                                                        children={
                                                            let rvar = rvar.clone();
                                                            move |f: HfFile| {
                                                                let fname = f.rfilename.clone();
                                                                let fname_no_ext = fname.strip_suffix(".gguf").unwrap_or(&fname).to_string();
                                                                let quant = extract_quant(&fname);
                                                                let (badge_lbl, badge_cls_str) = quant_to_badge(&quant);
                                                                let badge_full_cls = format!("mlib-vq-badge {}", badge_cls_str);
                                                                let is_recommended = rec_fname.as_deref() == Some(&fname);
                                                                let installed = local_models.get().iter().any(|m| m.name == fname);
                                                                let size_str = match f.size {
                                                                    Some(b) if b > 0 => size_gb(b),
                                                                    _ => "—".to_string(),
                                                                };
                                                                let compat = compat_level(f.size.unwrap_or(0), &sysinfo.get());
                                                                let (icon_char, icon_cls, dot_cls, lbl_text, desc_text) = match compat {
                                                                    Some(Compat::Fits) => ("✓", "compat-fits",    "fits",    "Fits",       "Should run comfortably on your device"),
                                                                    Some(Compat::Slow) => ("!",  "compat-slow",    "slow",    "May be slow","Will run but leaves little memory headroom"),
                                                                    Some(Compat::No)   => ("✕", "compat-no",      "no",      "Won't fit",  "Likely exceeds your available memory"),
                                                                    None               => ("·",  "compat-unknown", "unknown", "Unknown",    ""),
                                                                };
                                                                let icon_full_cls = format!("mlib-compat-icon {}", icon_cls);
                                                                let lbl_full_cls  = format!("mlib-tooltip-compat-label {}", dot_cls);
                                                                let dot_full_cls  = format!("mlib-tooltip-dot {}", dot_cls);
                                                                let fname_tt   = fname.clone();
                                                                let quant_tt   = quant.clone();
                                                                let fname_match = fname.clone();
                                                                let repo_v = rvar.clone();
                                                                let fname_v = fname.clone();
                                                                let dl_v = dl;
                                                                let do_variant_dl = move |_| {
                                                                    let repo  = repo_v.clone();
                                                                    let fname = fname_v.clone();
                                                                    let key   = format!("{}::{}", repo, fname);
                                                                    dl_v.model_name.set(fname.clone());
                                                                    dl_v.downloading.set(true);
                                                                    dl_v.progress.set(0.0);
                                                                    dl_v.dl_done.set(false);
                                                                    dl_v.dl_error.set(None);
                                                                    dl_v.dl_id.set(Some(key));
                                                                    let fname2 = fname.clone();
                                                                    spawn_local(async move {
                                                                        if let Err(e) = tauri_bridge::invoke::<String>(
                                                                            "download_model",
                                                                            json!({ "repoId": repo, "filename": fname2 })
                                                                        ).await {
                                                                            dl_v.dl_error.set(Some(format!("Could not start download: {}", e)));
                                                                            dl_v.downloading.set(false);
                                                                            dl_v.dl_id.set(None);
                                                                        }
                                                                    });
                                                                };

                                                                view! {
                                                                    <div class="mlib-variant">
                                                                        <div class="mlib-variant-info">
                                                                            <span class="mlib-variant-fname">{fname_no_ext}</span>
                                                                            <span class=badge_full_cls>{badge_lbl}</span>
                                                                            {if is_recommended {
                                                                                view! { <span class="mlib-variant-recommended">"Recommended"</span> }.into_view()
                                                                            } else { view!{<></>}.into_view() }}
                                                                        </div>
                                                                        <span class="mlib-variant-size">{size_str}</span>
                                                                        {compat.map(|_| view! {
                                                                            <div class="mlib-compat-wrap">
                                                                                <span class=icon_full_cls>{icon_char}</span>
                                                                                <div class="mlib-compat-tooltip">
                                                                                    <div class="mlib-tooltip-header">"Model Variant Information"</div>
                                                                                    <div class="mlib-tooltip-filename">{fname_tt}</div>
                                                                                    <div class="mlib-tooltip-section">
                                                                                        <span class="mlib-tooltip-label">"Quantization"</span>
                                                                                        <span class="mlib-tooltip-value">{quant_tt}</span>
                                                                                    </div>
                                                                                    <div class="mlib-tooltip-section">
                                                                                        <span class="mlib-tooltip-label">"Device compatibility"</span>
                                                                                        <div class="mlib-tooltip-compat-row">
                                                                                            <span class=dot_full_cls></span>
                                                                                            <span class=lbl_full_cls>{lbl_text}</span>
                                                                                        </div>
                                                                                        <div class="mlib-tooltip-desc">{desc_text}</div>
                                                                                    </div>
                                                                                    <div class="mlib-tooltip-note">
                                                                                        "Estimated from file size and your hardware."
                                                                                    </div>
                                                                                </div>
                                                                            </div>
                                                                        })}
                                                                        {if installed {
                                                                            view! { <span class="mlib-variant-installed">"Installed"</span> }.into_view()
                                                                        } else {
                                                                            let fname_c = fname_match.clone();
                                                                            let fname_d = fname_match.clone();
                                                                            view! {
                                                                                <>
                                                                                    <button class="mlib-btn-mini danger"
                                                                                        style=move || if !dl.downloading.get() || dl.model_name.get() != fname_c { "display:none" } else { "" }
                                                                                        on:click=move |_| do_cancel.call(())>
                                                                                        "Cancel"
                                                                                    </button>
                                                                                    <button class="mlib-btn-download-icon"
                                                                                        style=move || if dl.downloading.get() && dl.model_name.get() == fname_d { "display:none" } else { "" }
                                                                                        title="Download"
                                                                                        on:click=do_variant_dl>
                                                                                        "↓"
                                                                                    </button>
                                                                                </>
                                                                            }.into_view()
                                                                        }}
                                                                    </div>
                                                                }
                                                            }
                                                        }
                                                    />
                                                    {move || (dl.downloading.get() && hf_selected.get().is_some()).then(|| view! {
                                                        <div class="mlib-dl-bar">
                                                            <div class="mlib-dl-row">
                                                                <span>{move || format!("Downloading {}", dl.model_name.get())}</span>
                                                                <span>{move || format!("{:.0}%", dl.progress.get() * 100.0)}</span>
                                                            </div>
                                                            <div class="mlib-dl-track">
                                                                <div class="mlib-dl-fill"
                                                                    style=move || format!("width:{}%", (dl.progress.get() * 100.0) as u32)></div>
                                                            </div>
                                                        </div>
                                                    })}
                                                </div>
                                            }.into_view()
                                        } else {
                                            view! { <></> }.into_view()
                                        }
                                    } else {
                                        view! { <></> }.into_view()
                                    }}
                                </div>
                            }
                        }
                    />
                </div>

                {move || hf_next_cursor.get().map(|_| view! {
                    <button
                        class="mlib-btn-download"
                        style="align-self:center;margin-top:8px"
                        disabled=move || hf_loading.get()
                        on:click=move |_| do_load_more()>
                        {move || if hf_loading.get() { "Loading..." } else { "Load More" }}
                    </button>
                })}

                {move || dl.dl_done.get().then(|| view! {
                    <div class="mlib-error" style="background:rgba(34,197,94,0.08);border-color:rgba(34,197,94,0.25);color:#86efac">
                        {move || format!("✓ {} installed successfully", dl.model_name.get())}
                    </div>
                })}
            </div>
        })}

        {move || (tab.get() == "byok").then(|| view! {
            <div class="byok-tab">
                <div class="mlib-card-name" style="margin-bottom:6px">"Cloud Providers"</div>
                <div class="mlib-card-desc" style="margin-bottom:18px">"Bring your own API key for cloud AI providers. Keys are stored locally."</div>
                <ByokPanel />
            </div>
        })}

        </div>
    }
}
