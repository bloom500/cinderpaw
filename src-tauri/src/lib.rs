mod agents;
mod api;
mod byok;
mod conversations;
mod events;
mod gpu_detect;
mod inference;
mod models;
mod openclaw;
mod openclaw_connection;
mod openclaw_sidecar;
mod paths;
mod projects;
mod settings;
mod skills;
mod sysinfo_mod;
mod tools;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Emitter, State};
use tokio::sync::mpsc;

use crate::agents::AgentConfig;
use crate::inference::{InferParams, Message, ModelManager};
use crate::models::ModelInfo;
use crate::settings::Settings;
use crate::sysinfo_mod::SystemInfo;

/// Per-download cancellation flag. Cloned into the spawned download task and
/// into the AppState map so `cancel_download` can flip it from another command.
type CancelFlag = Arc<AtomicBool>;

pub struct AppState {
    pub manager: Arc<ModelManager>,
    pub downloads: Arc<Mutex<HashMap<String, CancelFlag>>>,
    pub stop_signal: Arc<AtomicBool>,
    pub settings: Settings,
    /// System info pre-computed in a background thread at startup so the
    /// first call to get_system_info() returns instantly.
    pub system_info_cache: Arc<Mutex<Option<SystemInfo>>>,
}

fn download_key(repo_id: &str, filename: &str) -> String {
    format!("{}::{}", repo_id, filename)
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProgressPayload {
    pub percentage: f64,
    pub status_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DownloadProgress {
    pub repo_id: String,
    pub filename: String,
    pub progress: f32,
}

// ---------- Model commands ----------

#[tauri::command]
#[specta::specta]
fn get_models() -> Result<Vec<ModelInfo>, String> {
    let mut list = models::scan_models_dir().map_err(|e| e.to_string())?;
    // No way to know "loaded" here without state; mark from singleton:
    // (intentionally left false — UI uses get_loaded_model below)
    let _ = &mut list;
    Ok(list)
}

#[tauri::command]
#[specta::specta]
fn get_loaded_model(state: State<AppState>) -> Option<inference::LoadedModel> {
    state.manager.current()
}

/// Starts a download in a detached Tokio task and returns its ID immediately.
/// Progress streams over `feral://download-progress`.
/// Completion: `feral://download-complete`. Failure: `feral://download-error`.
/// Use `cancel_download(model_id)` to abort an in-flight download.
#[tauri::command]
#[specta::specta]
async fn download_model(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
    filename: String,
) -> Result<String, String> {
    let key = download_key(&repo_id, &filename);

    // Refuse concurrent download of the same file (would race on the .part path).
    {
        let map = state.downloads.lock();
        if map.contains_key(&key) {
            return Err(format!("Download already in progress: {}", key));
        }
    }

    let cancel: CancelFlag = Arc::new(AtomicBool::new(false));
    state.downloads.lock().insert(key.clone(), cancel.clone());

    // Progress forwarder: mpsc<f32> → Tauri events.
    let (tx, mut rx) = mpsc::channel::<f32>(32);
    {
        let app = app.clone();
        let repo = repo_id.clone();
        let file = filename.clone();
        tokio::spawn(async move {
            while let Some(p) = rx.recv().await {
                let _ = app.emit(
                    "feral://download-progress",
                    events::DownloadProgressEvent {
                        repo_id: repo.clone(),
                        filename: file.clone(),
                        progress: p,
                    },
                );
            }
        });
    }

    // Detached download task — frees the IPC reply so UI stays fluid.
    let app_for_task = app.clone();
    let downloads_map = state.downloads.clone();
    let key_for_task = key.clone();
    let repo_for_task = repo_id.clone();
    let file_for_task = filename.clone();
    let cancel_for_task = cancel.clone();
    tokio::spawn(async move {
        let result = models::download_hf_model(
            repo_for_task.clone(),
            file_for_task.clone(),
            tx,
            cancel_for_task.clone(),
        )
        .await;

        // Always release the slot first.
        downloads_map.lock().remove(&key_for_task);

        match result {
            Ok(path) => {
                let _ = app_for_task.emit(
                    "feral://download-complete",
                    events::DownloadCompleteEvent {
                        repo_id: repo_for_task.clone(),
                        filename: file_for_task.clone(),
                        path: path.to_string_lossy().into_owned(),
                    },
                );
            }
            Err(e) => {
                let cancelled = cancel_for_task.load(Ordering::Relaxed);
                let kind = if cancelled { "cancelled" } else { "error" };
                tracing::warn!(repo=%repo_for_task, file=%file_for_task, kind, error=%e, "download ended");
                let _ = app_for_task.emit(
                    "feral://download-error",
                    events::DownloadErrorEvent {
                        repo_id: repo_for_task.clone(),
                        filename: file_for_task.clone(),
                        error: e.to_string(),
                        cancelled,
                    },
                );
            }
        }
    });

    Ok(key)
}

/// Aborts an in-flight download by ID (`repo_id::filename`).
/// The download task observes the flag on its next chunk boundary,
/// deletes the partial `.part` file, and emits `feral://download-error`
/// with `cancelled: true`.
#[tauri::command]
#[specta::specta]
fn cancel_download(state: State<AppState>, model_id: String) -> Result<(), String> {
    let map = state.downloads.lock();
    match map.get(&model_id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err(format!("No active download: {}", model_id)),
    }
}

#[tauri::command]
#[specta::specta]
async fn load_model(
    state: State<'_, AppState>,
    path: String,
) -> Result<inference::LoadedModel, String> {
    let manager = state.manager.clone();
    let n_gpu_layers = state.settings.default_gpu_layers;
    tokio::task::spawn_blocking(move || {
        manager.load(PathBuf::from(path), n_gpu_layers).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Load a model with real-time progress events emitted to the frontend.
/// Emits `"model-load-progress"` with `{ percentage: f64, status_text: String }`.
/// The progress task runs in a separate tokio task; the UI never freezes.
#[tauri::command]
#[specta::specta]
async fn start_model_load(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<inference::LoadedModel, String> {
    use std::time::Duration;

    let manager = state.manager.clone();
    let path_buf = PathBuf::from(&path);
    let n_gpu_layers = state.settings.default_gpu_layers;

    let _ = app.emit("model-load-progress", events::ModelLoadProgressEvent {
        percentage: 0.0,
        status_text: "Initializing...".into(),
    });

    // Estimate load duration from file size (~80 MB/s mmap throughput), clamp 3s–90s.
    let file_size = std::fs::metadata(&path_buf).map(|m| m.len()).unwrap_or(2 << 30);
    let est_ms = ((file_size as f64 / (80.0 * 1024.0 * 1024.0)) * 1_000.0)
        .clamp(3_000.0, 90_000.0) as u64;

    let done = Arc::new(AtomicBool::new(false));
    let done2 = done.clone();
    let app2 = app.clone();

    let milestones: Vec<(f64, &'static str)> = vec![
        (8.0,  "Mapping model file..."),
        (28.0, "Loading attention layers..."),
        (52.0, "Allocating memory..."),
        (75.0, "Warming KV cache..."),
        (90.0, "Finalizing..."),
    ];

    tokio::spawn(async move {
        let mut prev = 0.0f64;
        for (target, label) in milestones {
            if done2.load(Ordering::Relaxed) { break; }
            let gap = target - prev;
            let steps = 12u64;
            let step_ms = ((est_ms as f64 * gap / 90.0) / steps as f64).max(50.0) as u64;
            for i in 1..=steps {
                if done2.load(Ordering::Relaxed) { break; }
                tokio::time::sleep(Duration::from_millis(step_ms)).await;
                let pct = (prev + gap * i as f64 / steps as f64).min(99.0);
                let _ = app2.emit("model-load-progress", events::ModelLoadProgressEvent {
                    percentage: pct,
                    status_text: label.to_string(),
                });
            }
            prev = target;
        }
    });

    let result = tokio::task::spawn_blocking(move || {
        manager.load(path_buf, n_gpu_layers).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    done.store(true, Ordering::Relaxed);

    match result {
        Ok(model) => {
            let _ = app.emit("model-load-progress", events::ModelLoadProgressEvent {
                percentage: 100.0,
                status_text: "Model Loaded!".into(),
            });
            Ok(model)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
#[specta::specta]
fn unload_model(state: State<AppState>) {
    state.manager.unload();
}

#[tauri::command]
#[specta::specta]
fn delete_model(state: State<AppState>, path: String) -> Result<(), String> {
    let target = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("invalid path: {}", e))?;
    let models_dir = crate::paths::models_dir()
        .canonicalize()
        .map_err(|e| format!("could not resolve models dir: {}", e))?;
    if !target.starts_with(&models_dir) {
        return Err("path is outside models directory".into());
    }
    // Force-unload on the Rust side if this model is currently loaded.
    // The frontend already calls unload(), but a failed-load can leave
    // an llama.cpp file handle open without putting anything in the manager.
    // Unconditional unload + retry gives the OS time to release mmap handles.
    state.manager.unload();
    models::delete_model(&target).map_err(|e| e.to_string())
}

/// Fetches file size in bytes for a HuggingFace model file via HTTP HEAD.
/// Used by the frontend to display download size before starting a download.
#[tauri::command]
#[specta::specta]
async fn get_model_size_info(repo_id: String, filename: String) -> Result<u64, String> {
    let client = reqwest::Client::builder()
        .user_agent("feral/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("https://huggingface.co/{}/resolve/main/{}", repo_id, filename);
    let resp = client.head(&url).send().await.map_err(|e| e.to_string())?;

    resp.content_length()
        .ok_or_else(|| "Content-Length not present in response".to_string())
}

/// Fetches the size of the largest GGUF file in a HuggingFace model repository
/// by first getting the file list from the model details API, then making parallel
/// HEAD requests to get file sizes. Returns a human-readable string (e.g. "4.25 GB").
/// Used by the frontend Browse tab to show model sizes directly in the results list.
#[tauri::command]
#[specta::specta]
async fn get_hf_model_size(repo_id: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("feral/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    // Fetch model details to get the list of GGUF files
    let detail_url = format!("https://huggingface.co/api/models/{}", repo_id);

    #[derive(serde::Deserialize)]
    struct ModelSibling {
        rfilename: String,
    }
    #[derive(serde::Deserialize)]
    struct ModelDetail {
        siblings: Vec<ModelSibling>,
    }

    let resp = client.get(&detail_url).send().await.map_err(|e| e.to_string())?;
    let model: ModelDetail = resp.json().await.map_err(|e| e.to_string())?;

    // Get all GGUF filenames
    let gguf_files: Vec<String> = model.siblings.into_iter()
        .filter(|s| s.rfilename.ends_with(".gguf"))
        .map(|s| s.rfilename)
        .collect();

    if gguf_files.is_empty() {
        return Err("No GGUF files found".to_string());
    }

    // Make parallel HEAD requests to get file sizes
    let sizes: Vec<u64> = futures::future::join_all(
        gguf_files.iter().map(|fname| {
            let client = client.clone();
            let repo_id = repo_id.clone();
            let fname = fname.clone();
            async move {
                let url = format!("https://huggingface.co/{}/resolve/main/{}", repo_id, fname);
                match client.head(&url).send().await {
                    Ok(resp) => resp.content_length().unwrap_or(0),
                    Err(_) => 0,
                }
            }
        })
    ).await;

    let largest_bytes = sizes.iter().max().copied().unwrap_or(0);

    if largest_bytes == 0 {
        return Err("Could not determine file size".to_string());
    }

    let gb = largest_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    Ok(format!("{:.2} GB", gb))
}

// ---------- Chat ----------

#[tauri::command]
#[specta::specta]
fn stop_generation(state: State<AppState>) {
    state.stop_signal.store(true, Ordering::SeqCst);
}

#[tauri::command]
#[specta::specta]
async fn chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    messages: Vec<Message>,
    params: InferParams,
    session_id: String,
) -> Result<(), String> {
    use futures::StreamExt;
    // Reset stop signal before each new generation so a previous stop doesn't
    // immediately abort the next request.
    state.stop_signal.store(false, Ordering::SeqCst);
    let stop = state.stop_signal.clone();
    let mut stream = Box::pin(state.manager.stream_chat(messages, params, stop.clone()));
    while let Some(tok) = stream.next().await {
        if stop.load(Ordering::SeqCst) {
            let _ = app.emit("feral://stream-done", events::StreamDoneEvent { session_id: session_id.clone() });
            return Ok(());
        }
        match tok {
            Ok(t) => {
                let _ = app.emit("feral://token", events::TokenEvent { session_id: session_id.clone(), text: t });
            }
            Err(e) => {
                let _ = app.emit("feral://stream-error", events::StreamErrorEvent { session_id: session_id.clone(), error: e.to_string() });
                return Err(e.to_string());
            }
        }
    }
    let _ = app.emit("feral://stream-done", events::StreamDoneEvent { session_id: session_id.clone() });
    Ok(())
}

// ---------- System ----------

#[tauri::command]
#[specta::specta]
async fn get_system_info(state: State<'_, AppState>) -> Result<SystemInfo, String> {
    // Return cached value immediately if background thread has finished
    if let Some(info) = state.system_info_cache.lock().clone() {
        return Ok(info);
    }
    // Cache not ready yet — compute now, store for future calls
    let cache = state.system_info_cache.clone();
    tokio::task::spawn_blocking(move || {
        let info = sysinfo_mod::collect();
        *cache.lock() = Some(info.clone());
        info
    })
    .await
    .map_err(|e| e.to_string())
}

// ---------- Agents ----------

#[tauri::command]
#[specta::specta]
fn save_agent(cfg: AgentConfig) -> Result<AgentConfig, String> {
    agents::save(&cfg).map_err(|e| e.to_string())?;
    Ok(cfg)
}

#[tauri::command]
#[specta::specta]
fn get_agents() -> Result<Vec<AgentConfig>, String> {
    agents::list().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn delete_agent(id: String) -> Result<(), String> {
    agents::delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn get_agent_presets() -> Vec<AgentConfig> {
    agents::presets()
}

#[tauri::command]
#[specta::specta]
async fn run_agent(
    state: State<'_, AppState>,
    agent_id: String,
    prompt: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    let list = agents::list().map_err(|e| e.to_string())?;
    let cfg = list.into_iter().find(|a| a.id == agent_id)
        .ok_or_else(|| format!("agent {} not found", agent_id))?;
    let mut rx = if cfg.preferred_runtime.as_deref() == Some("openclaw") {
        openclaw::run_openclaw(cfg, prompt)
    } else {
        agents::run(cfg, prompt, state.manager.clone())
    };
    while let Some(ev) = rx.recv().await {
        let _ = on_event.send(ev);
    }
    Ok(())
}

// ---------- HuggingFace browser ----------

/// Handles both missing fields AND explicit JSON nulls, falling back to Default.
/// `#[serde(default)]` alone only handles missing fields; `null` would still error
/// on non-Option primitives like u64/u32/String.
fn deser_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + serde::Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct HfModelSummary {
    pub id: String,
    pub author: String,
    #[specta(type = specta_typescript::Number)]
    pub downloads: u64,
    pub likes: u32,
    pub last_modified: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct HfFile {
    pub rfilename: String,
    #[specta(type = Option<specta_typescript::Number>)]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct HfModelDetail {
    pub id: String,
    pub author: String,
    #[specta(type = specta_typescript::Number)]
    pub downloads: u64,
    pub likes: u32,
    pub last_modified: String,
    pub tags: Vec<String>,
    pub gguf_files: Vec<HfFile>,
    pub readme: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct HfSearchPage {
    pub models: Vec<HfModelSummary>,
    pub next_cursor: Option<String>,
}

#[tauri::command]
#[specta::specta]
async fn search_hf_models(query: String, cursor: Option<String>) -> Result<HfSearchPage, String> {
    let client = reqwest::Client::builder()
        .user_agent("feral/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    #[derive(Deserialize)]
    struct RawModel {
        id: String,
        #[serde(default)]
        author: Option<String>,
        #[serde(default, deserialize_with = "deser_default")]
        downloads: u64,
        #[serde(default, deserialize_with = "deser_default")]
        likes: u32,
        #[serde(rename = "lastModified", default, deserialize_with = "deser_default")]
        last_modified: String,
        #[serde(default)]
        tags: Vec<String>,
    }

    let url = cursor.unwrap_or_else(|| {
        if query.is_empty() {
            // No query — show most downloaded GGUF models
            "https://huggingface.co/api/models?filter=gguf&sort=downloads&direction=-1&limit=50&full=false".to_string()
        } else {
            // With query — HF default sort = relevance ranking
            format!(
                "https://huggingface.co/api/models?search={}&filter=gguf&limit=50&full=false",
                urlencoding::encode(&query)
            )
        }
    });

    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;

    // Parse Link header for next-page cursor
    let next_cursor = resp.headers()
        .get("link")
        .and_then(|v| v.to_str().ok())
        .and_then(|link| {
            link.split(',')
                .find(|p| p.contains(r#"rel="next""#))
                .and_then(|p| {
                    let s = p.find('<')? + 1;
                    let e = p.find('>')?;
                    Some(p[s..e].trim().to_string())
                })
        });

    let raw: Vec<RawModel> = resp.json().await.map_err(|e| e.to_string())?;

    Ok(HfSearchPage {
        models: raw.into_iter().map(|m| HfModelSummary {
            author: m.author.unwrap_or_else(|| {
                m.id.split('/').next().unwrap_or("").to_string()
            }),
            id: m.id,
            downloads: m.downloads,
            likes: m.likes,
            last_modified: m.last_modified,
            tags: m.tags,
        }).collect(),
        next_cursor,
    })
}

#[tauri::command]
#[specta::specta]
async fn get_hf_model_detail(repo_id: String) -> Result<HfModelDetail, String> {
    let client = reqwest::Client::builder()
        .user_agent("feral/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    #[derive(Deserialize)]
    struct RawModel {
        id: String,
        #[serde(default)]
        author: Option<String>,
        #[serde(default, deserialize_with = "deser_default")]
        downloads: u64,
        #[serde(default, deserialize_with = "deser_default")]
        likes: u32,
        #[serde(rename = "lastModified", default, deserialize_with = "deser_default")]
        last_modified: String,
        #[serde(default)]
        tags: Vec<String>,
        #[serde(default)]
        siblings: Vec<RawSibling>,
    }
    #[derive(Deserialize)]
    struct LfsInfo {
        size: u64,
    }
    #[derive(Deserialize)]
    struct RawSibling {
        rfilename: String,
        #[serde(default)]
        size: Option<u64>,
        #[serde(default)]
        lfs: Option<LfsInfo>,
    }

    #[derive(Deserialize)]
    struct TreeEntry {
        path: String,
        #[serde(default)]
        size: Option<u64>,
    }

    let url = format!("https://huggingface.co/api/models/{}", repo_id);
    let tree_url = format!("https://huggingface.co/api/models/{}/tree/main", repo_id);

    // Fetch model metadata and tree listing in parallel
    let (raw_resp, tree_resp) = tokio::join!(
        client.get(&url).send(),
        client.get(&tree_url).send()
    );

    let raw: RawModel = raw_resp.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    // Tree endpoint reliably returns actual file sizes (not LFS pointer sizes)
    let tree_sizes: std::collections::HashMap<String, u64> = match tree_resp {
        Ok(r) if r.status().is_success() => {
            r.json::<Vec<TreeEntry>>().await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|e| e.size.filter(|&n| n > 1_048_576).map(|s| (e.path, s)))
                .collect()
        }
        _ => std::collections::HashMap::new(),
    };

    let gguf_files = raw.siblings.into_iter()
        .filter(|s| s.rfilename.ends_with(".gguf"))
        .map(|s| {
            // Priority: tree API size > lfs.size > siblings.size
            let actual_size = tree_sizes.get(&s.rfilename).copied()
                .or_else(|| s.lfs.as_ref().map(|l| l.size))
                .or(s.size)
                .filter(|&n| n > 1_048_576);
            HfFile { rfilename: s.rfilename, size: actual_size }
        })
        .collect();

    // Fetch README
    let readme_url = format!("https://huggingface.co/{}/raw/main/README.md", repo_id);
    let readme = client.get(&readme_url).send().await.ok()
        .and_then(|r| if r.status().is_success() { Some(r) } else { None });
    let readme_text = if let Some(r) = readme {
        r.text().await.ok().map(|t| t.chars().take(2000).collect())
    } else {
        None
    };

    Ok(HfModelDetail {
        author: raw.author.unwrap_or_else(|| {
            raw.id.split('/').next().unwrap_or("").to_string()
        }),
        id: raw.id,
        downloads: raw.downloads,
        likes: raw.likes,
        last_modified: raw.last_modified,
        tags: raw.tags,
        gguf_files,
        readme: readme_text,
    })
}

// ---------- Conversations ----------

#[tauri::command]
#[specta::specta]
fn save_conversation(
    id: String,
    title: String,
    messages: Vec<conversations::PersistedMessage>,
) -> Result<(), String> {
    conversations::save(&id, &title, &messages).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn load_conversations() -> Result<Vec<conversations::ConversationSummary>, String> {
    conversations::load_all().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn load_conversation(id: String) -> Result<conversations::Conversation, String> {
    conversations::load(&id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn delete_conversation(id: String) -> Result<(), String> {
    conversations::delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn clear_all_conversations() -> Result<(), String> {
    conversations::clear_all().map_err(|e| e.to_string())
}

// ---------- Projects ----------

#[tauri::command]
#[specta::specta]
fn load_projects() -> Result<Vec<projects::ProjectSummary>, String> {
    projects::load_all().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn save_project(id: String, name: String, conversation_ids: Vec<String>) -> Result<(), String> {
    projects::save(&projects::ProjectSummary { id, name, conversation_ids })
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn delete_project(id: String) -> Result<(), String> {
    projects::delete(&id).map_err(|e| e.to_string())
}

// ---------- Settings ----------

#[tauri::command]
#[specta::specta]
fn get_settings() -> Settings { settings::load() }

#[tauri::command]
#[specta::specta]
fn save_settings(settings: Settings) -> Result<(), String> {
    settings::save(&settings).map_err(|e| e.to_string())
}

// ---------- BYOK ----------

/// Append a path segment to a base URL that may already contain a query string.
/// e.g. url_join("https://api.minimax.chat/v1?GroupId=123", "chat/completions")
///      → "https://api.minimax.chat/v1/chat/completions?GroupId=123"
fn url_join(base: &str, path: &str) -> String {
    match base.find('?') {
        Some(q) => {
            let (base_path, query) = base.split_at(q);
            format!("{}/{}{}", base_path.trim_end_matches('/'), path.trim_start_matches('/'), query)
        }
        None => format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/')),
    }
}

#[tauri::command]
#[specta::specta]
fn get_byok_settings() -> Vec<byok::ProviderInfo> {
    let settings = byok::load(&settings::load());
    settings.get_all_providers()
}

#[tauri::command]
#[specta::specta]
fn save_byok_provider(provider_id: String, enabled: bool, api_key: String, base_url: Option<String>, default_model: Option<String>) -> Result<(), String> {
    let mut settings = byok::load(&settings::load());
    let config = byok::ProviderConfig {
        enabled,
        api_key,
        base_url,
        default_model,
    };
    settings.update_provider(&provider_id, config);
    byok::save(&settings).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
async fn test_byok_provider(provider_id: String, api_key: String, base_url: Option<String>) -> Result<byok::TestProviderResponse, String> {
    use byok::Provider;

    let provider = match provider_id.as_str() {
        "openai" => Provider::Openai,
        "anthropic" => Provider::Anthropic,
        "google" => Provider::Google,
        "kimi" => Provider::Kimi,
        "glm" => Provider::Glm,
        "minimax" => Provider::Minimax,
        "groq" => Provider::Groq,
        "mistral" => Provider::Mistral,
        "deepseek" => Provider::Deepseek,
        "openrouter" => Provider::Openrouter,
        _ => Provider::Custom,
    };

    let url = base_url.unwrap_or_else(|| provider.default_base_url().to_string());
    let models_endpoint = url_join(&url, "models");
    let chat_endpoint   = url_join(&url, "chat/completions");

    let client = reqwest::Client::builder()
        .user_agent("feral/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let header_key    = provider.api_key_header();
    let header_prefix = provider.api_key_prefix();
    let auth_value    = format!("{}{}", header_prefix, api_key);

    // First try GET /models (OpenAI-compatible providers expose this)
    let models_resp = client
        .get(&models_endpoint)
        .header(header_key, &auth_value)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let models_status = models_resp.status();

    if models_status.is_success() {
        #[derive(serde::Deserialize)]
        struct ModelList { data: Option<Vec<serde_json::Value>> }
        let models: Vec<String> = models_resp.json::<ModelList>().await
            .ok()
            .and_then(|r| r.data)
            .map(|items| items.iter()
                .filter_map(|v| v.get("id").and_then(|id| id.as_str()).map(String::from))
                .collect())
            .unwrap_or_default();
        return Ok(byok::TestProviderResponse {
            success: true,
            message: "Connection successful".to_string(),
            models,
        });
    }

    // If /models returned 401/403 the key is wrong — report immediately.
    if models_status == 401 || models_status == 403 {
        let body = models_resp.text().await.unwrap_or_default();
        return Ok(byok::TestProviderResponse {
            success: false,
            message: format!("Auth failed (HTTP {}): {}", models_status.as_u16(), body),
            models: vec![],
        });
    }

    // /models returned 404 or another non-auth error — provider may not expose it.
    // Fall back: send a minimal non-streaming chat completion to verify credentials.
    let probe = serde_json::json!({
        "model": "__probe__",
        "messages": [{ "role": "user", "content": "Hi" }],
        "max_tokens": 1,
        "stream": false,
    });
    let chat_resp = client
        .post(&chat_endpoint)
        .header(header_key, &auth_value)
        .header("Content-Type", "application/json")
        .json(&probe)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let chat_status = chat_resp.status();
    let chat_body   = chat_resp.text().await.unwrap_or_default();

    // 401/403 = bad key; 4xx on model-not-found (404/400/422) = key is valid
    if chat_status == 401 || chat_status == 403 {
        Ok(byok::TestProviderResponse {
            success: false,
            message: format!("Auth failed (HTTP {}): {}", chat_status.as_u16(), chat_body),
            models: vec![],
        })
    } else {
        Ok(byok::TestProviderResponse {
            success: true,
            message: "Connection successful (auth verified via chat endpoint)".to_string(),
            models: vec![],
        })
    }
}

/// Stream a chat completion from an OpenAI-compatible cloud provider via BYOK.
/// Supports the full agentic tool-use loop: if the model responds with tool_calls,
/// the tools are executed and the results are fed back until the model returns a
/// plain content response.
#[tauri::command]
#[specta::specta]
async fn chat_cloud_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: String,
    model: String,
    messages: Vec<inference::Message>,
    params: inference::InferParams,
    session_id: String,
) -> Result<(), String> {
    use futures::StreamExt;

    let byok = byok::load(&settings::load());
    let cfg = byok.get_provider(&provider_id).cloned().unwrap_or_default();

    macro_rules! emit_err {
        ($msg:expr) => {{
            let s: String = $msg;
            let _ = app.emit("feral://stream-error", events::StreamErrorEvent {
                session_id: session_id.clone(),
                error: s.clone(),
            });
            return Err(s);
        }};
    }

    if !cfg.enabled   { emit_err!(format!("Provider '{}' is not enabled", provider_id)); }
    if cfg.api_key.is_empty() { emit_err!(format!("No API key configured for provider '{}'", provider_id)); }

    let provider = match provider_id.as_str() {
        "openai"     => byok::Provider::Openai,
        "anthropic"  => byok::Provider::Anthropic,
        "google"     => byok::Provider::Google,
        "kimi"       => byok::Provider::Kimi,
        "glm"        => byok::Provider::Glm,
        "minimax"    => byok::Provider::Minimax,
        "groq"       => byok::Provider::Groq,
        "mistral"    => byok::Provider::Mistral,
        "deepseek"   => byok::Provider::Deepseek,
        "openrouter" => byok::Provider::Openrouter,
        _            => byok::Provider::Custom,
    };

    let base_url = cfg.base_url.unwrap_or_else(|| provider.default_base_url().to_string());
    let endpoint = url_join(&base_url, "chat/completions");
    let auth_value = format!("{}{}", provider.api_key_prefix(), cfg.api_key);

    let client = reqwest::Client::builder()
        .user_agent("feral/0.1")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| { let _ = app.emit("feral://stream-error", events::StreamErrorEvent { session_id: session_id.clone(), error: e.to_string() }); e.to_string() })?;

    // Build tool definitions from the enabled tool IDs passed in params
    let tool_defs: Vec<serde_json::Value> = params.tools
        .as_ref()
        .map(|ids| ids.iter()
            .filter_map(|id| tools::ToolType::from_name(id))
            .map(|t| t.to_openai_definition())
            .collect())
        .unwrap_or_default();

    // Build initial message context
    let mut ctx: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = &params.system_prompt {
        if !sys.is_empty() {
            ctx.push(serde_json::json!({ "role": "system", "content": sys }));
        }
    }
    for m in &messages {
        ctx.push(serde_json::json!({ "role": m.role, "content": m.content }));
    }

    state.stop_signal.store(false, Ordering::SeqCst);
    let stop = state.stop_signal.clone();

    // Agentic loop: continue until the model returns a plain content response
    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = app.emit("feral://stream-done", events::StreamDoneEvent { session_id });
            return Ok(());
        }

        let mut body = serde_json::json!({
            "model": model,
            "messages": ctx,
            "stream": true,
            "temperature": params.temperature,
            "top_p": params.top_p,
            "max_tokens": params.max_tokens,
        });
        if !tool_defs.is_empty() {
            body["tools"] = serde_json::json!(tool_defs);
            body["tool_choice"] = serde_json::json!("auto");
        }

        let resp = client
            .post(&endpoint)
            .header(provider.api_key_header(), &auth_value)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| { let _ = app.emit("feral://stream-error", events::StreamErrorEvent { session_id: session_id.clone(), error: e.to_string() }); e.to_string() })?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body_text = resp.text().await.unwrap_or_default();
            emit_err!(format!("HTTP {}: {}", status, body_text));
        }

        let mut byte_stream = resp.bytes_stream();
        let mut line_buf = String::new();

        // Accumulators for the current response turn
        let mut content_acc = String::new();
        // index → (call_id, function_name, arguments_fragment)
        let mut pending_calls: std::collections::HashMap<usize, (String, String, String)> =
            std::collections::HashMap::new();
        let mut finish_reason = String::new();

        'sse: while let Some(chunk) = byte_stream.next().await {
            if stop.load(Ordering::SeqCst) {
                let _ = app.emit("feral://stream-done", events::StreamDoneEvent { session_id });
                return Ok(());
            }
            let bytes = chunk.map_err(|e| { let _ = app.emit("feral://stream-error", events::StreamErrorEvent { session_id: session_id.clone(), error: e.to_string() }); e.to_string() })?;
            let text = String::from_utf8_lossy(&bytes);

            for ch in text.chars() {
                if ch == '\n' {
                    let line = line_buf.trim().to_string();
                    line_buf.clear();
                    if line.is_empty() { continue; }
                    if line == "data: [DONE]" { break 'sse; }

                    if let Some(json_str) = line.strip_prefix("data: ") {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                            let choice = val.get("choices").and_then(|c| c.get(0));
                            if let Some(choice) = choice {
                                if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
                                    if !fr.is_empty() { finish_reason = fr.to_string(); }
                                }
                                if let Some(delta) = choice.get("delta") {
                                    // Plain text content
                                    if let Some(tok) = delta.get("content").and_then(|c| c.as_str()) {
                                        if !tok.is_empty() {
                                            content_acc.push_str(tok);
                                            let _ = app.emit("feral://token", events::TokenEvent {
                                                session_id: session_id.clone(),
                                                text: tok.to_string(),
                                            });
                                        }
                                    }
                                    // Tool call fragments
                                    if let Some(tc_arr) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                                        for tc in tc_arr {
                                            let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                            let entry = pending_calls.entry(idx)
                                                .or_insert_with(|| (String::new(), String::new(), String::new()));
                                            if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                                                entry.0 = id.to_string();
                                            }
                                            if let Some(func) = tc.get("function") {
                                                if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                                                    entry.1 = name.to_string();
                                                }
                                                if let Some(args) = func.get("arguments").and_then(|v| v.as_str()) {
                                                    entry.2.push_str(args);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else {
                    line_buf.push(ch);
                }
            }
        }

        // If no tool calls, we're done
        if finish_reason != "tool_calls" || pending_calls.is_empty() {
            break;
        }

        // Sort by index so the assistant message lists them in order
        let mut sorted: Vec<(usize, (String, String, String))> = pending_calls.into_iter().collect();
        sorted.sort_by_key(|(idx, _)| *idx);

        // Append assistant turn with tool_calls to context
        let asst_tool_calls: Vec<serde_json::Value> = sorted.iter()
            .map(|(_, (id, name, args))| serde_json::json!({
                "id": id,
                "type": "function",
                "function": { "name": name, "arguments": args }
            }))
            .collect();

        ctx.push(serde_json::json!({
            "role": "assistant",
            "content": serde_json::Value::Null,
            "tool_calls": asst_tool_calls,
        }));

        // Execute each tool and append its result to context
        for (_, (id, name, args_str)) in &sorted {
            let args: serde_json::Value = serde_json::from_str(args_str)
                .unwrap_or(serde_json::json!({}));
            let result = if let Some(tool_type) = tools::ToolType::from_name(name) {
                tools::execute(tool_type, args).await
            } else {
                tools::ToolResult { name: name.clone(), ok: false, output: format!("Unknown tool: {}", name) }
            };
            ctx.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": id,
                "content": result.output,
            }));
        }
        // Loop continues — model will now generate a response using the tool results
    }

    let _ = app.emit("feral://stream-done", events::StreamDoneEvent { session_id });
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn read_file_as_text(path: String) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("Invalid path: {}", e))?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|e| format!("Stat failed: {}", e))?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("File too large (max 10 MB)".into());
    }
    std::fs::read_to_string(&canonical).map_err(|e| format!("Read failed: {}", e))
}

// ---------- Entry ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
        .init();

    let _ = paths::ensure_dirs();

    let settings = settings::load();
    let manager = Arc::new(ModelManager::new());

    // Pre-compute system info in a background thread so the first IPC call
    // returns instantly instead of waiting 2-3 s for PowerShell + sysinfo.
    let system_info_cache: Arc<Mutex<Option<SystemInfo>>> = Arc::new(Mutex::new(None));
    {
        let cache = system_info_cache.clone();
        std::thread::spawn(move || {
            let info = sysinfo_mod::collect();
            *cache.lock() = Some(info);
        });
    }

    let state = AppState {
        manager: manager.clone(),
        downloads: Arc::new(Mutex::new(HashMap::new())),
        stop_signal: Arc::new(AtomicBool::new(false)),
        settings,
        system_info_cache,
    };

    let specta_builder = tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            get_models,
            get_loaded_model,
            download_model,
            cancel_download,
            load_model,
            start_model_load,
            unload_model,
            delete_model,
            chat_stream,
            stop_generation,
            get_system_info,
            save_agent,
            get_agents,
            delete_agent,
            get_agent_presets,
            run_agent,
            save_conversation,
            load_conversations,
            load_conversation,
            delete_conversation,
            clear_all_conversations,
            load_projects,
            save_project,
            delete_project,
            get_settings,
            save_settings,
            search_hf_models,
            get_hf_model_detail,
            get_model_size_info,
            get_hf_model_size,
            get_byok_settings,
            save_byok_provider,
            test_byok_provider,
            chat_cloud_stream,
            read_file_as_text,
            skills::list_installed_skills,
            skills::get_installed_skill_content,
            skills::fetch_remote_skills,
            skills::fetch_community_skills,
            skills::preview_remote_skill,
            skills::preview_local_skill,
            skills::skill_exists_cmd,
            skills::install_skill,
            skills::remove_skill,
            openclaw::openclaw_detect,
            openclaw::openclaw_status,
            openclaw::openclaw_open_docs,
            openclaw::openclaw_test_message,
            openclaw::openclaw_test_agent_message,
            openclaw::openclaw_warmup_agent,
            openclaw_connection::get_openclaw_connection_settings,
            openclaw_connection::save_openclaw_connection_settings,
            openclaw_connection::clear_openclaw_token,
        ])
        .events(tauri_specta::collect_events![
            crate::events::TokenEvent,
            crate::events::StreamDoneEvent,
            crate::events::StreamErrorEvent,
            crate::events::DownloadProgressEvent,
            crate::events::DownloadCompleteEvent,
            crate::events::DownloadErrorEvent,
            crate::events::ModelLoadProgressEvent,
        ]);

    // TODO: re-enable once all u64 fields have #[specta(type = Number)] annotations.
    // The specta export requires every u64/i64 field to be annotated because
    // TypeScript loses precision on integers > 2^53.
    // #[cfg(debug_assertions)]
    // specta_builder
    //     .export(
    //         specta_typescript::Typescript::default()
    //             .header("// AUTO-GENERATED — do not edit. Regenerated by `cargo tauri dev/build`.\n"),
    //         "../frontend-react/src/lib/tauri/bindings.ts",
    //     )
    //     .expect("failed to export specta bindings");

    let specta_builder_for_setup = specta_builder.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(move |app| {
            specta_builder_for_setup.mount_events(app);
            let _handle = app.handle().clone();
            // Start API server in background if enabled.
            let cfg = settings::load();
            if cfg.api_server_enabled {
                let api_state = api::ApiState { manager: manager.clone() };
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = api::serve(api_state, cfg.api_port).await {
                        tracing::error!(?e, "api server stopped");
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(specta_builder.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_key_format() {
        assert_eq!(download_key("TheBloke/Mistral-7B", "model.Q4_K_M.gguf"),
                   "TheBloke/Mistral-7B::model.Q4_K_M.gguf");
    }

    #[test]
    fn download_key_uniqueness() {
        let k1 = download_key("repo/a", "file.gguf");
        let k2 = download_key("repo/b", "file.gguf");
        let k3 = download_key("repo/a", "other.gguf");
        assert_ne!(k1, k2);
        assert_ne!(k1, k3);
        assert_ne!(k2, k3);
    }

    #[test]
    fn deser_default_handles_null() {
        // Simulates serde deserializing a JSON null into a type with Default
        let json = serde_json::json!(null);
        let result: u64 = serde_json::from_value::<Option<u64>>(json)
            .unwrap()
            .unwrap_or_default();
        assert_eq!(result, 0u64);
    }

    #[test]
    fn deser_default_handles_missing_via_option() {
        // Validates the pattern used in HfModelSummary/HfModelDetail deserialization
        #[derive(serde::Deserialize)]
        struct Row {
            #[serde(default, deserialize_with = "super::deser_default")]
            downloads: u64,
            #[serde(default, deserialize_with = "super::deser_default")]
            likes: u32,
        }
        let with_nulls: Row = serde_json::from_str(r#"{"downloads": null, "likes": null}"#).unwrap();
        assert_eq!(with_nulls.downloads, 0);
        assert_eq!(with_nulls.likes, 0);

        let with_values: Row = serde_json::from_str(r#"{"downloads": 1234, "likes": 42}"#).unwrap();
        assert_eq!(with_values.downloads, 1234);
        assert_eq!(with_values.likes, 42);

        let missing: Row = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(missing.downloads, 0);
    }
}
