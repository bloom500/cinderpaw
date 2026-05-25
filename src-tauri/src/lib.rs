mod agents;
mod api;
mod inference;
mod models;
mod paths;
mod settings;
mod sysinfo_mod;
mod tools;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
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
}

fn download_key(repo_id: &str, filename: &str) -> String {
    format!("{}::{}", repo_id, filename)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressPayload {
    pub percentage: f64,
    pub status_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub repo_id: String,
    pub filename: String,
    pub progress: f32,
}

// ---------- Model commands ----------

#[tauri::command]
fn get_models() -> Result<Vec<ModelInfo>, String> {
    let mut list = models::scan_models_dir().map_err(|e| e.to_string())?;
    // No way to know "loaded" here without state; mark from singleton:
    // (intentionally left false — UI uses get_loaded_model below)
    let _ = &mut list;
    Ok(list)
}

#[tauri::command]
fn get_loaded_model(state: State<AppState>) -> Option<inference::LoadedModel> {
    state.manager.current()
}

/// Starts a download in a detached Tokio task and returns its ID immediately.
/// Progress streams over `feral://download-progress`.
/// Completion: `feral://download-complete`. Failure: `feral://download-error`.
/// Use `cancel_download(model_id)` to abort an in-flight download.
#[tauri::command]
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
                    DownloadProgress {
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
                    json!({
                        "repoId": repo_for_task,
                        "filename": file_for_task,
                        "path": path.to_string_lossy(),
                    }),
                );
            }
            Err(e) => {
                let cancelled = cancel_for_task.load(Ordering::Relaxed);
                let kind = if cancelled { "cancelled" } else { "error" };
                tracing::warn!(repo=%repo_for_task, file=%file_for_task, kind, error=%e, "download ended");
                let _ = app_for_task.emit(
                    "feral://download-error",
                    json!({
                        "repoId": repo_for_task,
                        "filename": file_for_task,
                        "error": e.to_string(),
                        "cancelled": cancelled,
                    }),
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
async fn load_model(
    state: State<'_, AppState>,
    path: String,
) -> Result<inference::LoadedModel, String> {
    let manager = state.manager.clone();
    tokio::task::spawn_blocking(move || {
        manager.load(PathBuf::from(path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Load a model with real-time progress events emitted to the frontend.
/// Emits `"model-load-progress"` with `{ percentage: f64, status_text: String }`.
/// The progress task runs in a separate tokio task; the UI never freezes.
#[tauri::command]
async fn start_model_load(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<inference::LoadedModel, String> {
    use std::time::Duration;

    let manager = state.manager.clone();
    let path_buf = PathBuf::from(&path);

    let _ = app.emit("model-load-progress", ProgressPayload {
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
                let pct = prev + gap * i as f64 / steps as f64;
                let _ = app2.emit("model-load-progress", ProgressPayload {
                    percentage: pct,
                    status_text: label.to_string(),
                });
            }
            prev = target;
        }
    });

    let result = tokio::task::spawn_blocking(move || {
        manager.load(path_buf).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    done.store(true, Ordering::Relaxed);

    match result {
        Ok(model) => {
            let _ = app.emit("model-load-progress", ProgressPayload {
                percentage: 100.0,
                status_text: "Model Loaded!".into(),
            });
            Ok(model)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn unload_model(state: State<AppState>) {
    state.manager.unload();
}

#[tauri::command]
fn delete_model(path: String) -> Result<(), String> {
    models::delete_model(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

// ---------- Chat ----------

#[tauri::command]
fn stop_generation(state: State<AppState>) {
    state.stop_signal.store(true, Ordering::SeqCst);
}

#[tauri::command]
async fn chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    messages: Vec<Message>,
    params: InferParams,
    session_id: String,
) -> Result<(), String> {
    use futures::StreamExt;
    // Reset stop signal before new generation
    state.stop_signal.store(false, Ordering::SeqCst);
    let stop = state.stop_signal.clone();
    let mut stream = Box::pin(state.manager.stream_chat(messages, params));
    while let Some(tok) = stream.next().await {
        if stop.load(Ordering::SeqCst) {
            let _ = app.emit("feral://stream-done", serde_json::json!({ "session_id": &session_id }));
            let _ = app.emit("feral://error", serde_json::json!({ "session_id": &session_id, "error": "stopped" }));
            return Ok(());
        }
        match tok {
            Ok(t) => {
                let _ = app.emit("feral://token", serde_json::json!({ "session_id": &session_id, "text": t }));
                let _ = app.emit("feral://thinking", serde_json::json!({ "session_id": &session_id }));
            }
            Err(e) => {
                let _ = app.emit("feral://stream-error", serde_json::json!({ "session_id": &session_id, "error": e.to_string() }));
                let _ = app.emit("feral://error", serde_json::json!({ "session_id": &session_id, "error": e.to_string() }));
                return Err(e.to_string());
            }
        }
    }
    let _ = app.emit("feral://stream-done", serde_json::json!({ "session_id": &session_id }));
    let _ = app.emit("feral://done", serde_json::json!({ "session_id": &session_id }));
    Ok(())
}

// ---------- System ----------

#[tauri::command]
fn get_system_info() -> SystemInfo {
    sysinfo_mod::collect()
}

// ---------- Agents ----------

#[tauri::command]
fn save_agent(cfg: AgentConfig) -> Result<(), String> {
    agents::save(&cfg).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_agents() -> Result<Vec<AgentConfig>, String> {
    agents::list().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_agent(id: String) -> Result<(), String> {
    agents::delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_agent_presets() -> Vec<AgentConfig> {
    agents::presets()
}

#[tauri::command]
async fn run_agent(
    state: State<'_, AppState>,
    agent_id: String,
    prompt: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    let list = agents::list().map_err(|e| e.to_string())?;
    let cfg = list.into_iter().find(|a| a.id == agent_id)
        .ok_or_else(|| format!("agent {} not found", agent_id))?;
    let mut rx = agents::run(cfg, prompt, state.manager.clone());
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfModelSummary {
    pub id: String,
    pub author: String,
    pub downloads: u64,
    pub likes: u32,
    pub last_modified: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfFile {
    pub rfilename: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[tauri::command]
async fn search_hf_models(query: String) -> Result<Vec<HfModelSummary>, String> {
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

    let url = format!(
        "https://huggingface.co/api/models?search={}&filter=gguf&sort=downloads&direction=-1&limit=24&full=false",
        urlencoding::encode(&query)
    );
    let resp: Vec<RawModel> = client.get(&url).send().await
        .map_err(|e| e.to_string())?
        .json().await
        .map_err(|e| e.to_string())?;

    Ok(resp.into_iter().map(|m| HfModelSummary {
        author: m.author.unwrap_or_else(|| {
            m.id.split('/').next().unwrap_or("").to_string()
        }),
        id: m.id,
        downloads: m.downloads,
        likes: m.likes,
        last_modified: m.last_modified,
        tags: m.tags,
    }).collect())
}

#[tauri::command]
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
    struct RawSibling {
        rfilename: String,
        #[serde(default)]
        size: Option<u64>,
    }

    let url = format!("https://huggingface.co/api/models/{}", repo_id);
    let raw: RawModel = client.get(&url).send().await
        .map_err(|e| e.to_string())?
        .json().await
        .map_err(|e| e.to_string())?;

    let gguf_files = raw.siblings.into_iter()
        .filter(|s| s.rfilename.ends_with(".gguf"))
        .map(|s| HfFile { rfilename: s.rfilename, size: s.size })
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

// ---------- Settings ----------

#[tauri::command]
fn get_settings() -> Settings { settings::load() }

#[tauri::command]
fn save_settings(settings: Settings) -> Result<(), String> {
    settings::save(&settings).map_err(|e| e.to_string())
}

// ---------- Entry ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
        .init();

    let _ = paths::ensure_dirs();

    let manager = Arc::new(ModelManager::new());
    let state = AppState {
        manager: manager.clone(),
        downloads: Arc::new(Mutex::new(HashMap::new())),
        stop_signal: Arc::new(AtomicBool::new(false)),
    };

    tauri::Builder::default()
        .manage(state)
        .setup(move |app| {
            let handle = app.handle().clone();
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
        .invoke_handler(tauri::generate_handler![
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
            get_settings,
            save_settings,
            search_hf_models,
            get_hf_model_detail,
        ])
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
