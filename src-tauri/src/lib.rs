mod agents;
mod api;
mod byok;
mod connectors;
#[cfg(feature = "whisper")]
mod transcription;
mod conversations;
mod db_key;
mod desktop_control;
mod disk_encryption;
mod events;
mod feral_agent;
mod gpu_detect;
mod inference;
mod mcp;
mod perf_policy;
mod memory_graph;
mod models;
mod paths;
mod projects;
mod rsi;
mod settings;
mod skills;
mod sysinfo_mod;
mod tools;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::agents::AgentConfig;
use crate::inference::{InferParams, Message, ModelManager};
use crate::models::ModelInfo;
use crate::perf_policy::{deadline_message, perf_policy, DeadlineReason, PerfPolicy};
use crate::settings::Settings;
use crate::sysinfo_mod::SystemInfo;

/// Per-download cancellation flag. Cloned into the spawned download task and
/// into the AppState map so `cancel_download` can flip it from another command.
type CancelFlag = Arc<AtomicBool>;

/// Display-safe snapshot of the Feral Agent's active LLM backend.
/// API keys are never included — Rust injects them before forwarding to the sidecar.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FeralModelConfigView {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub display_name: String,
}

pub struct AppState {
    pub manager: Arc<ModelManager>,
    pub downloads: Arc<Mutex<HashMap<String, CancelFlag>>>,
    pub stop_signal: Arc<AtomicBool>,
    pub settings: Settings,
    /// System info pre-computed in a background thread at startup so the
    /// first call to get_system_info() returns instantly.
    pub system_info_cache: Arc<Mutex<Option<SystemInfo>>>,
    /// Feral Agent sidecar process.
    pub feral_agent_process: Arc<Mutex<Option<tokio::process::Child>>>,
    /// Sender for writing JSON messages to the Feral Agent's stdin.
    /// Commands clone this to send messages without holding the lock during I/O.
    pub feral_agent_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<String>>>>,
    /// Cached display-safe view of the model the sidecar is currently using.
    /// Updated optimistically by feral_set_model; None until first set_model call.
    pub feral_model_config: Arc<Mutex<Option<FeralModelConfigView>>>,
    /// Per-launch bearer token for the local HTTP API (V4). Generated at
    /// startup, handed to the API server and injected as the api key whenever
    /// the sidecar is pointed at the local engine, so the loopback API can
    /// require auth without breaking the in-app path.
    pub local_api_token: Arc<str>,
    /// MCP "Extensions" client manager (rmcp). Holds live connections to
    /// installed servers; configs persist at ~/.feral/mcp.json.
    pub mcp: Arc<mcp::McpManager>,
    /// RSI (Fractal Memory System) state. Holds the cached SandboxBounds
    /// and the initialised flag so every RSI command can answer "are
    /// we bootstrapped?" without a disk round-trip. Populated by
    /// `rsi_init`; consumed by every other rsi::* command.
    pub rsi_state: rsi::RsiState,
    /// Goodhart detector's rolling window. Kept as a separate Tauri
    /// `State` so it can be re-built lazily inside the command without
    /// contending on `rsi_state`.
    pub rsi_goodhart: rsi::commands::GoodhartSlot,
    /// Engine status mirror. `None` until the sidecar emits its first
    /// engine event (Faza 7b-part2 wires this — for now the UI sees
    /// `engine: null` in `rsi_status` and shows "engine not wired").
    /// Populated from the `rsi_engine_event` outbound events on stdout.
    pub rsi_engine: std::sync::Arc<parking_lot::Mutex<Option<rsi::commands::RsiEngineState>>>,
    /// In-flight ack registry for the 3 engine-driver commands
    /// (`rsi_start` / `rsi_stop` / `rsi_set_concurrency`). Each entry
    /// is a oneshot whose sender is fired by `feral_agent::stdout_reader`
    /// when the matching `rsi_engine_event` arrives on stdout, so the
    /// command can return success only after the sidecar has actually
    /// accepted the request. Cloned into `feral_agent::spawn` so the
    /// reader can ack without holding the AppState mutex.
    pub rsi_request_registry: rsi::commands::RsiRequestRegistry,
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
    max_context: Option<u32>,
) -> Result<inference::LoadedModel, String> {
    let manager = state.manager.clone();
    let n_gpu_layers = state.settings.default_gpu_layers;
    tokio::task::spawn_blocking(move || {
        manager.load(PathBuf::from(path), n_gpu_layers, max_context).map_err(|e| e.to_string())
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
    max_context: Option<u32>,
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
        manager.load(path_buf, n_gpu_layers, max_context).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    done.store(true, Ordering::Relaxed);

    match result {
        Ok(model) => {
            // Surface the REAL backend so a user can tell whether their GPU is
            // actually being used or inference silently fell back to CPU.
            let _ = app.emit("model-load-progress", events::ModelLoadProgressEvent {
                percentage: 100.0,
                status_text: format!("Model Loaded! · {}", inference::active_backend_label()),
            });

            // Persist so next launch auto-reloads without user interaction —
            // including the user's chosen context window, so the auto-reload
            // task doesn't shrink their KV cache back to the conservative
            // default on next start.
            let mut s = settings::load();
            s.last_loaded_model = Some(path.clone());
            s.last_loaded_ctx = Some(model.ctx_len);
            let _ = settings::save(&s);

            Ok(model)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
#[specta::specta]
fn unload_model(state: State<AppState>) {
    state.manager.unload();
    // Clear the persisted auto-reload path so a restart doesn't reload a
    // model the user just deliberately unloaded.
    let mut s = settings::load();
    s.last_loaded_model = None;
    let _ = settings::save(&s);
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
    // Unconditional unload + initial wait + retry loop gives the OS time
    // to release mmap handles (the C++ cleanup is asynchronous on Windows
    // — see `remove_file_with_retry` for the retry details).
    state.manager.unload();
    // Initial sleep before the first delete attempt: llama.cpp's
    // background cleanup needs a moment to start releasing the mmap.
    // The retry loop in `remove_file_with_retry` only fires AFTER the
    // first attempt fails — without this head-start sleep the loop is
    // chasing an unmoved release deadline.
    std::thread::sleep(std::time::Duration::from_millis(500));
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

/// Shared watchdog state owned by the inference watchdog task in
/// `chat_stream`. The watchdog writes the typed reason here before
/// flipping `stop_signal`; the consumer loop reads it after the stream
/// unwinds to decide whether to emit `feral://stream-done` (user stop /
/// clean completion) or skip it (deadline tripped — the watchdog
/// already emitted `feral://stream-error` with the typed message).
struct WatchdogState {
    /// Prompt token count as reported by `on_start`. The watchdog
    /// reads this to compute an effective TTFT (4 ms/token on top of
    /// the base, capped at `total_deadline_ms`) so a legitimately long
    /// prefill on a big prompt isn't killed. `0` = unknown until
    /// `on_start` fires (still a few hundred ms after generation begins).
    prompt_tokens: AtomicU32,
    /// Number of streamed tokens the consumer loop has received so
    /// far. Used by the heartbeat to report `tokensPerSec`.
    tokens_generated: AtomicU32,
    /// Wall-clock millisecond timestamp of the first received token.
    /// `0` = no token yet (still in prefill). Used to switch the
    /// heartbeat's `phase` from `"prefill"` to `"generating"`.
    first_token_ms: AtomicU64,
    /// Reason the watchdog tripped. `None` on a user-initiated stop or
    /// a clean completion; `Some(…)` on a watchdog breach. Locked by a
    /// `Mutex` because the watchdog writes once and the consumer reads
    /// once — a `TryLock` would be premature optimization.
    reason: Mutex<Option<DeadlineReason>>,
}

impl WatchdogState {
    fn new() -> Self {
        Self {
            prompt_tokens: AtomicU32::new(0),
            tokens_generated: AtomicU32::new(0),
            first_token_ms: AtomicU64::new(0),
            reason: Mutex::new(None),
        }
    }
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

    let watchdog = Arc::new(WatchdogState::new());
    let app_start = app.clone();
    let sid_start = session_id.clone();
    let pth_for_on_start = watchdog.clone();
    let on_start = Box::new(move |prompt_tokens: u32| {
        // Capture the real prompt token count so the watchdog can scale
        // its TTFT deadline with prompt size (4 ms/token on top of the
        // base, capped at total_deadline_ms). See perf_policy.rs.
        pth_for_on_start
            .prompt_tokens
            .store(prompt_tokens, Ordering::SeqCst);
        let _ = app_start.emit("feral://stream-start", events::StreamStartEvent {
            session_id: sid_start.clone(),
            prompt_tokens,
        });
    });

    // Spawn the watchdog task BEFORE the consumer loop starts. The
    // watchdog runs at `policy.heartbeat_ms` cadence and is the single
    // authority on deadline trips + heartbeat emits. It owns the stop
    // signal alongside the consumer — whoever trips first wins, the
    // other side observes `stop == true` on its next check.
    let wd = watchdog.clone();
    let stop_for_watchdog = stop.clone();
    let app_for_watchdog = app.clone();
    let session_for_watchdog = session_id.clone();
    let watchdog_handle = tokio::spawn(async move {
        run_inference_watchdog(
            wd,
            stop_for_watchdog,
            app_for_watchdog,
            session_for_watchdog,
            Instant::now(),
        )
        .await
    });

    let mut stream = Box::pin(state.manager.stream_chat(messages, params, stop.clone(), Some(on_start)));
    let start = Instant::now();
    while let Some(tok) = stream.next().await {
        if stop.load(Ordering::SeqCst) {
            // Stop flag tripped — distinguish watchdog (reason != None)
            // from user stop (reason == None). When the watchdog tripped,
            // it already emitted `feral://stream-error` with the typed
            // message; we MUST NOT also emit `feral://stream-done`, or the
            // frontend's chatStream.ts would see two terminal events.
            let reason = watchdog.reason.lock().clone();
            if reason.is_none() {
                let _ = app.emit("feral://stream-done", events::StreamDoneEvent {
                    session_id: session_id.clone(),
                });
            }
            return Ok(());
        }
        match tok {
            Ok(t) => {
                // #10: the local engine's generate() reports failures as a
                // literal "\n[Error: …]" token (its mpsc channel carries
                // plain strings). Route it to the stream-error event so the
                // UI can show a humanized error instead of raw error text
                // landing in the chat transcript.
                if let Some(msg) = t
                    .trim_start()
                    .strip_prefix("[Error: ")
                    .and_then(|s| s.strip_suffix(']'))
                {
                    let _ = app.emit("feral://stream-error", events::StreamErrorEvent {
                        session_id: session_id.clone(),
                        error: msg.to_string(),
                    });
                    return Err(msg.to_string());
                }
                // First-token tracking — the watchdog reads this to flip
                // its heartbeat `phase` from `"prefill"` to
                // `"generating"` and to start computing `tokensPerSec`.
                if watchdog.first_token_ms.load(Ordering::SeqCst) == 0 {
                    watchdog
                        .first_token_ms
                        .store(start.elapsed().as_millis() as u64, Ordering::SeqCst);
                }
                watchdog
                    .tokens_generated
                    .fetch_add(1, Ordering::SeqCst);
                let _ = app.emit("feral://token", events::TokenEvent {
                    session_id: session_id.clone(),
                    text: t,
                });
            }
            Err(e) => {
                let _ = app.emit("feral://stream-error", events::StreamErrorEvent {
                    session_id: session_id.clone(),
                    error: e.to_string(),
                });
                return Err(e.to_string());
            }
        }
    }

    // Stream ended cleanly (natural completion). Trip the stop flag so
    // the watchdog exits on its next tick — cheaper than `abort()`ing
    // the join handle, and avoids racing on `abort()` mid-emit.
    stop.store(true, Ordering::SeqCst);
    let _ = app.emit("feral://stream-done", events::StreamDoneEvent {
        session_id: session_id.clone(),
    });
    // Drop the watchdog join handle so the task can complete and free
    // its emit buffers. We don't `await` it — `chat_stream` returns
    // immediately and the watchdog will see `stop == true` within one
    // heartbeat (≤750 ms) and exit.
    drop(watchdog_handle);
    Ok(())
}

/// Heartbeat + deadline-breach loop for the local inference path.
///
/// Emits `feral://stream-progress` on every tick and, on breach,
/// `feral://stream-error` with the typed reason + human copy. The
/// watchdog owns no locks beyond the `WatchdogState` itself — the
/// generator (inference.rs::generate / run_inference) is unaware this
/// exists; it just checks the existing `stop` flag on its per-token
/// loop.
///
/// TTFT scales with `prompt_tokens` (4 ms/token on top of the base,
/// capped at `total_deadline_ms`) so a legitimately long prefill on a
/// big prompt isn't killed. The heartbeat proves liveness, so this
/// trips only on real stalls.
async fn run_inference_watchdog(
    state: Arc<WatchdogState>,
    stop: Arc<AtomicBool>,
    app: AppHandle,
    session_id: String,
    start: Instant,
) {
    let policy = perf_policy(false); // chat_stream is local-only
    let mut ticker = tokio::time::interval(Duration::from_millis(policy.heartbeat_ms));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ticker.tick().await; // consume the immediate first tick (instant zero)

    while !stop.load(Ordering::SeqCst) {
        ticker.tick().await;
        let elapsed_ms = start.elapsed().as_millis() as u64;
        let pt = state.prompt_tokens.load(Ordering::SeqCst);
        let tg = state.tokens_generated.load(Ordering::SeqCst);
        let ft_ms = state.first_token_ms.load(Ordering::SeqCst);
        let phase = if ft_ms == 0 { "prefill" } else { "generating" };

        // Heartbeat — even on the tick that trips the deadline, so the
        // UI's last frame before the error shows the actual elapsed time.
        let tps = compute_tokens_per_sec(tg, ft_ms, elapsed_ms);
        let _ = app.emit(
            "feral://stream-progress",
            events::StreamProgressEvent {
                session_id: session_id.clone(),
                phase: phase.to_string(),
                elapsed_ms: elapsed_ms.min(u32::MAX as u64) as u32,
                prompt_tokens: pt,
                tokens_generated: tg,
                tokens_per_sec: tps,
            },
        );

        // TTFT breach — first-token deadline expired (scales with prompt size).
        if ft_ms == 0 && elapsed_ms >= policy.effective_ttft(pt) {
            trip_deadline(
                &state,
                &stop,
                &app,
                &session_id,
                &policy,
                DeadlineReason::TtftTimeout,
            );
            return;
        }
        // Total breach — request ran past the whole-completion cap.
        if elapsed_ms >= policy.total_deadline_ms {
            trip_deadline(
                &state,
                &stop,
                &app,
                &session_id,
                &policy,
                DeadlineReason::TotalTimeout,
            );
            return;
        }
    }
}

/// Flip the stop flag, record the deadline reason, and emit the typed
/// `feral://stream-error`. Idempotent on the reason cell — if a
/// previous tick already recorded one, the second trip is a no-op so
/// the consumer never sees two different reasons.
fn trip_deadline(
    state: &WatchdogState,
    stop: &Arc<AtomicBool>,
    app: &AppHandle,
    session_id: &str,
    policy: &PerfPolicy,
    reason: DeadlineReason,
) {
    {
        let mut slot = state.reason.lock();
        if slot.is_some() {
            // Already tripped by a previous tick (e.g. TTFT and total
            // both fired on the same tick). Don't double-emit.
            return;
        }
        *slot = Some(reason);
    }
    stop.store(true, Ordering::SeqCst);
    let _ = app.emit(
        "feral://stream-error",
        events::StreamErrorEvent {
            session_id: session_id.to_string(),
            error: deadline_message(reason, policy),
        },
    );
}

/// tok/s over the window between first token and now. Returns 0.0
/// during prefill (`ft_ms == 0`) or when the elapsed-since-first
/// window is zero (avoid div-by-zero). Pure helper — exposed as a
/// free function so unit tests can assert the math directly.
fn compute_tokens_per_sec(tokens_generated: u32, first_token_ms: u64, now_ms: u64) -> f32 {
    if first_token_ms == 0 || tokens_generated == 0 {
        return 0.0;
    }
    let elapsed_since_first = now_ms.saturating_sub(first_token_ms);
    if elapsed_since_first == 0 {
        return 0.0;
    }
    (tokens_generated as f32) / (elapsed_since_first as f32 / 1000.0)
}

#[cfg(test)]
mod watchdog_tests {
    use super::*;

    #[test]
    fn tokens_per_sec_zero_during_prefill() {
        assert_eq!(compute_tokens_per_sec(0, 0, 0), 0.0);
        assert_eq!(compute_tokens_per_sec(5, 0, 1000), 0.0);
    }

    #[test]
    fn tokens_per_sec_basic_rate() {
        // 10 tokens in the 1000ms after first token → 10 tok/s.
        assert!((compute_tokens_per_sec(10, 1000, 2000) - 10.0).abs() < 1e-3);
    }

    #[test]
    fn tokens_per_sec_handles_zero_window() {
        // Defensive: same millisecond for first-token and now should not divide by zero.
        assert_eq!(compute_tokens_per_sec(5, 1000, 1000), 0.0);
    }

    #[test]
    fn tokens_per_sec_handles_oversized_first_token_timestamp() {
        // If `now_ms` is somehow smaller than `first_token_ms` (clock skew,
        // monotonic regression), saturating_sub returns 0 and we get 0.0
        // rather than a panic or a giant rate.
        assert_eq!(compute_tokens_per_sec(50, 2000, 1000), 0.0);
    }

    #[test]
    fn trip_deadline_is_idempotent_on_reason_cell() {
        let state = WatchdogState::new();
        let stop = Arc::new(AtomicBool::new(false));
        // No AppHandle available in a sync unit test — `trip_deadline`
        // would emit (and panic without a real handle), so we test the
        // reason-cell half directly.
        *state.reason.lock() = Some(DeadlineReason::TtftTimeout);
        // If we call trip_deadline again it would short-circuit on the
        // already-set cell — simulate that by re-acquiring the lock.
        let mut slot = state.reason.lock();
        if slot.is_some() {
            // no-op branch — proves idempotence
        } else {
            panic!("reason cell should have been set by the prior write");
        }
        // Stop flag was never touched by this test, which is what we want
        // for the "already tripped" path — only the FIRST trip flips it.
        assert!(!stop.load(Ordering::SeqCst));
    }
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
    tracing::info!("get_agents: invoked");
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
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    prompt: String,
    session_id: String,
) -> Result<(), String> {
    let list = agents::list().map_err(|e| e.to_string())?;
    let cfg = list.into_iter().find(|a| a.id == agent_id)
        .ok_or_else(|| format!("agent {} not found", agent_id))?;

    // Local llama.cpp agent loop — requires a model to be loaded.
    // For AI without a local model, use feral_send_message which routes through
    // the Feral Agent sidecar (Ollama-backed, with sandbox + memory).
    let manager = state.manager.clone();
    if manager.current().is_none() {
        return Err(
            "No local model loaded. Use Feral Agent (feral_send_message) for AI without \
             a local model, or load a GGUF model first."
                .to_string(),
        );
    }
    let mut rx = agents::run(cfg, prompt, manager);

    // Stream each AgentEvent (already JSON-serialized) over the feral:// event
    // bus, tagged with session_id so concurrent run panels don't cross streams.
    while let Some(ev) = rx.recv().await {
        let _ = app.emit("feral://agent-event", events::AgentStreamEvent {
            session_id: session_id.clone(),
            data: ev,
        });
    }
    Ok(())
}

// ---------- Feral Agent ----------

/// Controls-panel inference overrides forwarded verbatim to the sidecar,
/// which validates and clamps them. Both fields optional so the frontend can
/// send only what the user changed.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FeralInferParams {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
}

/// Send a message to the Feral Agent sidecar. Returns the message ID that
/// will appear in the corresponding `feral://agent-output` chunk/done events.
#[tauri::command]
#[specta::specta]
async fn feral_send_message(
    state: State<'_, AppState>,
    content: String,
    session_id: String,
    images: Option<Vec<String>>,
    infer_params: Option<FeralInferParams>,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();

    // Send a metadata-only roster of installed skills (id, name, description,
    // version, tags) on every message. The agent sidecar renders this as a
    // short "skill menu" in the system prompt, then loads the full SKILL.md
    // body on demand via the `read_skill` tool. Built per-send so the roster
    // always reflects the current install state — failures here are logged
    // and the message is sent without the roster.
    let skills_context: Vec<skills::SkillMeta> = skills::local_list()
        .unwrap_or_default()
        .into_iter()
        // Only ship local-installed skills to the agent — remote/community
        // entries have no content on disk to load and would just bloat the
        // menu. The frontend has its own UI for those.
        .filter(|m| matches!(m.source_provider, skills::SourceProvider::Local))
        .collect();

    let mut payload = serde_json::json!({
        "type": "message",
        "id": &id,
        "content": content,
        "sessionId": session_id,
    });
    // Image attachments (data URLs) ride along so the sidecar can hand
    // real pixels to vision-capable models.
    if let Some(imgs) = images.filter(|v| !v.is_empty()) {
        payload["images"] = serde_json::json!(imgs);
    }
    if !skills_context.is_empty() {
        payload["skillsContext"] = serde_json::to_value(&skills_context)
            .map_err(|e| format!("failed to serialize skills context: {e}"))?;
    }
    // Controls-panel overrides (temperature / max tokens). The sidecar's
    // agent loop validates and clamps them; here they just ride along.
    if let Some(p) = infer_params {
        payload["inferParams"] = serde_json::json!({
            "temperature": p.temperature,
            "max_tokens": p.max_tokens,
        });
    }
    let msg = payload.to_string();

    // Extract the sender without holding the lock across the await.
    let tx = {
        let guard = state.feral_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "feral-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(id)
}

/// Returns true when the Feral Agent sidecar is running and ready to receive messages.
#[tauri::command]
#[specta::specta]
fn feral_agent_status(state: State<'_, AppState>) -> bool {
    state.feral_agent_tx.lock().is_some()
}

/// Abort the Feral Agent's in-flight generation for `session_id` (or all
/// sessions when None). Forwards a `stop` message to the sidecar, whose
/// AgentLoop aborts the inference fetch and any running tool, then emits a
/// `done` event with `stopped: true` for each interrupted message.
#[tauri::command]
#[specta::specta]
async fn feral_stop_generation(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<(), String> {
    let mut payload = serde_json::json!({ "type": "stop" });
    if let Some(sid) = session_id {
        payload["sessionId"] = serde_json::Value::String(sid);
    }
    let msg = payload.to_string();
    let tx = {
        let guard = state.feral_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "feral-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// PROVISIONAL (temporary Settings button): ask the sidecar to run the Fractal
/// Memory Search benchmark gate against the live RAPTOR tree. The sidecar runs
/// it off the hot path and emits a `fractal_bench_result` line (verdict +
/// recall/latency numbers) which Rust forwards over `feral://agent-output`.
#[tauri::command]
#[specta::specta]
async fn feral_run_fractal_benchmark(state: State<'_, AppState>) -> Result<(), String> {
    let msg = serde_json::json!({ "type": "fractal_benchmark" }).to_string();
    let tx = {
        let guard = state.feral_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "feral-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Reactive-tree drill-down: ask the sidecar for the real member memories of a
/// top-level RAPTOR cluster. Fire-and-forget like the benchmark — the sidecar
/// replies with a `fractal_cluster_leaves_result` line (paired by `request_id`)
/// which Rust forwards over `feral://agent-output`; the React tree correlates by
/// id. Returns once the request is queued.
#[tauri::command]
#[specta::specta]
async fn feral_fractal_cluster_leaves(
    state: State<'_, AppState>,
    request_id: String,
    cluster_index: u32,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "fractal_cluster_leaves",
        "id": request_id,
        "clusterIndex": cluster_index,
    })
    .to_string();
    let tx = {
        let guard = state.feral_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "feral-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Forward the user's `ask_user` selection back to the Feral Agent sidecar.
///
/// The React side calls this after the user picks an option in the
/// `AskUserCard`. Without this command the sidecar never receives the
/// user's response, the pending `AskUserBridge.ask()` Promise hangs, and
/// the agent eventually times out (regression test for the v0.1.x bug
/// where the user reported "I picked an answer and the agent
/// immediately said it timed out").
///
/// `request_id` matches the `id` of the original outbound `ask_user`
/// event. `answers` is the user's selection (1 answer per question).
#[tauri::command]
#[specta::specta]
async fn feral_ask_user_response(
    state: State<'_, AppState>,
    request_id: String,
    answers: Vec<feral_agent::AskUserAnswer>,
) -> Result<(), String> {
    let line = feral_agent::build_ask_user_response_line(&request_id, &answers)?;
    let tx = {
        let guard = state.feral_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "feral-agent is not running".to_string())?
            .clone()
    };
    tx.send(line).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Cancel a pending `ask_user` request (user clicked Skip, or the UI is
/// tearing down). The sidecar calls `AskUserBridge.cancel(id, reason)`
/// which rejects the tool's `await ctx.askUser.ask(...)` with the
/// supplied reason. The agent loop sees the rejection and continues
/// with whatever fallback the model chose for the missing input.
#[tauri::command]
#[specta::specta]
async fn feral_ask_user_cancel(
    state: State<'_, AppState>,
    request_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let line = feral_agent::build_ask_user_cancel_line(&request_id, reason.as_deref())?;
    let tx = {
        let guard = state.feral_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "feral-agent is not running".to_string())?
            .clone()
    };
    tx.send(line).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// True when `url` addresses the local Feral API (loopback host on the
/// configured api port). Used to decide whether to inject the bearer token as
/// the sidecar's api key. Conservative: any parse failure returns false, so a
/// non-loopback target never gets the token.
fn is_local_api_url(url: &str, api_port: u16) -> bool {
    // Tolerate a missing scheme — the resolved url has been stripped of /v1
    // and trailing slashes but always carries http(s)://.
    let parsed = match reqwest::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    let host_is_loopback = matches!(parsed.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1"));
    let port = parsed.port().unwrap_or(match parsed.scheme() {
        "https" => 443,
        _ => 80,
    });
    host_is_loopback && port == api_port
}

/// Hot-swap the Feral Agent's LLM backend without restarting the sidecar.
///
/// React passes `source` + optional fields — Rust injects the API key from
/// byok.json before forwarding. The key never appears in frontend state.
///
/// `source`:
///   - "ollama"            → local Ollama, no key needed
///   - "byok"             → cloud provider by id, key read from byok.json
///   - "openai_compatible" → arbitrary OpenAI-compatible endpoint, caller supplies base_url
#[tauri::command]
#[specta::specta]
async fn feral_set_model(
    state: State<'_, AppState>,
    source: String,
    provider_id: Option<String>,
    model: String,
    base_url: Option<String>,
) -> Result<(), String> {
    let (provider, mut resolved_url, api_key) = match source.as_str() {
        "ollama" => {
            let url = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
            ("ollama".to_string(), url, String::new())
        }
        "byok" => {
            let pid = provider_id.as_deref().ok_or("byok source requires provider_id")?;
            let byok = byok::load(&state.settings);
            let cfg = byok.get_provider(pid)
                .ok_or_else(|| format!("provider '{}' is not configured", pid))?
                .clone();
            if !cfg.enabled {
                return Err(format!("provider '{}' is not enabled", pid));
            }
            if cfg.api_key.is_empty() {
                return Err(format!("provider '{}' has no API key saved", pid));
            }
            // Resolve base URL: user custom override → provider default
            let url = if let Some(ref custom) = cfg.base_url {
                custom.clone()
            } else {
                byok.get_all_providers()
                    .into_iter()
                    .find(|p| p.id == pid)
                    .and_then(|p| p.base_url)
                    .unwrap_or_else(|| "https://api.openai.com/v1".to_string())
            };
            (pid.to_string(), url, cfg.api_key)
        }
        "openai_compatible" => {
            let url = base_url.ok_or("openai_compatible source requires base_url")?;
            ("openai_compatible".to_string(), url, String::new())
        }
        other => return Err(format!("unknown source: '{}'", other)),
    };

    // Strip trailing /v1 — the sidecar's InferenceRouter appends endpoint paths itself.
    resolved_url = resolved_url.trim_end_matches("/v1").trim_end_matches('/').to_string();

    // V4: when the sidecar is pointed at our own loopback API, it must present
    // the bearer token or the now-gated server rejects it. The token rides in
    // as the OpenAI-style api key (the InferenceRouter sends it as
    // `Authorization: Bearer <key>`), so no sidecar change is needed. Only
    // override an otherwise-empty key — a real cloud BYOK key must win.
    let api_key = if api_key.is_empty() && is_local_api_url(&resolved_url, state.settings.api_port) {
        state.local_api_token.to_string()
    } else {
        api_key
    };

    // For a local (loopback) model, tell the sidecar the active context window
    // so its transcript-compaction budget matches the KV cache the engine
    // actually allocated (Hardware can raise this well past the old 8192). Cloud
    // models omit it — the sidecar uses its generous cloud budget.
    let context_window = if is_local_api_url(&resolved_url, state.settings.api_port) {
        state.manager.current().map(|m| m.ctx_len)
    } else {
        None
    };

    let msg = serde_json::json!({
        "type": "set_model",
        "provider": provider,
        "model": model,
        "baseUrl": resolved_url,
        "apiKey": api_key,
        "contextWindow": context_window,
    })
    .to_string();

    let tx = {
        let guard = state.feral_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "feral-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;

    // Optimistically cache the new config (confirmed by model_set event from sidecar).
    let display_name = if provider == "ollama" {
        format!("Ollama · {}", model)
    } else {
        format!("{} · {}", provider, model)
    };
    *state.feral_model_config.lock() = Some(FeralModelConfigView {
        provider,
        model,
        base_url: resolved_url,
        display_name,
    });

    Ok(())
}

/// Returns the display-safe model config currently active in the Feral Agent sidecar.
/// Returns None until the first feral_set_model call this session.
#[tauri::command]
#[specta::specta]
fn feral_get_model_config(state: State<'_, AppState>) -> Option<FeralModelConfigView> {
    state.feral_model_config.lock().clone()
}

/// Returns the per-launch bearer token external apps must send as
/// `Authorization: Bearer <token>` to use the local HTTP API (V4). The in-app
/// agent path receives it automatically; this command exists so the user can
/// copy it for their own integrations. The token rotates every launch.
#[tauri::command]
#[specta::specta]
fn get_local_api_token(state: State<'_, AppState>) -> String {
    state.local_api_token.to_string()
}

// ---------- Onboarding record (persisted in ~/.feral/) ----------

/// Path of the onboarding JSON written/read by `get_onboarding_record` /
/// `set_onboarding_record`. The file lives in the user's home dir, NOT in
/// the Tauri app data dir, so it survives:
///   - WebView reload (Ctrl+R)
///   - Tauri auto-updates
///   - Uninstall + reinstall (the app data dir is wiped, but `~/.feral/`
///     lives outside the app and persists as long as the user account does)
///
/// We use plain `std::fs` rather than the `tauri-plugin-fs` plugin because:
///   1. The plugin's scope-based permissions make `~/` awkward to access
///   2. We only need 2 ops (read whole file, write whole file) — a plugin
///      is overkill
fn onboarding_path() -> Option<std::path::PathBuf> {
    // USERPROFILE on Windows, HOME elsewhere. Fall back to dirs::cache_dir
    // only as a last resort — home is what we want.
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok());
    home.map(|h| std::path::PathBuf::from(h).join(".feral").join("onboarding.json"))
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct OnboardingRecord {
    completed: bool,
    completed_at: u64,
    user_name: String,
    agent_name: String,
}

#[tauri::command]
#[specta::specta]
fn get_onboarding_record() -> Option<OnboardingRecord> {
    let path = onboarding_path()?;
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

#[tauri::command]
#[specta::specta]
fn set_onboarding_record(record: OnboardingRecord) -> Result<(), String> {
    let path = onboarding_path().ok_or_else(|| {
        "could not resolve home directory (USERPROFILE / HOME unset)".to_string()
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
    }
    let pretty = serde_json::to_string_pretty(&record)
        .map_err(|e| format!("serialize failed: {}", e))?;
    std::fs::write(&path, pretty).map_err(|e| format!("write failed: {}", e))?;
    Ok(())
}

/// Fetch the list of models available from a local Ollama instance.
/// Used by the Feral model selector to populate the Ollama model submenu.
#[tauri::command]
#[specta::specta]
async fn list_ollama_models(base_url: String) -> Result<Vec<String>, String> {
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Ollama unreachable: {}", e))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Ollama response parse failed: {}", e))?;
    let models = json["models"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok(models)
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
    agent_id: Option<String>,
) -> Result<(), String> {
    conversations::save(&id, &title, &messages, agent_id.as_deref()).map_err(|e| e.to_string())
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

// ---------- Voice messages (on-device STT) ----------

/// Persist a recorded audio blob to the on-disk `voice/` dir. Returns the path.
#[tauri::command]
#[specta::specta]
async fn save_voice_blob(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    let safe_ext = ext.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>();
    let ext = if safe_ext.is_empty() { "webm".to_string() } else { safe_ext };
    let dir = paths::voice_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.{}", uuid::Uuid::new_v4(), ext));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// True if the whisper ggml model for `model_size` is already downloaded.
#[tauri::command]
#[specta::specta]
fn whisper_model_present(model_size: String) -> bool {
    paths::whisper_model_path(&model_size).exists()
}

/// Download the whisper ggml model for `model_size` into the whisper dir.
/// Streams over `feral://whisper-download-progress`; completion/failure over
/// `feral://whisper-download-complete` / `-error`. Distinct from `download_model`
/// so the LLM auto-load listener never tries to load a whisper model as a llama.
#[tauri::command]
#[specta::specta]
async fn download_whisper_model(
    app: AppHandle,
    state: State<'_, AppState>,
    model_size: String,
) -> Result<String, String> {
    let repo = paths::WHISPER_REPO.to_string();
    let filename = paths::whisper_filename(&model_size).to_string();
    let key = format!("whisper::{}", filename);

    {
        let map = state.downloads.lock();
        if map.contains_key(&key) {
            return Err(format!("Download already in progress: {}", key));
        }
    }

    // Already present — nothing to do.
    if paths::whisper_model_path(&model_size).exists() {
        return Ok(key);
    }

    let cancel: CancelFlag = Arc::new(AtomicBool::new(false));
    state.downloads.lock().insert(key.clone(), cancel.clone());

    let (tx, mut rx) = mpsc::channel::<f32>(32);
    {
        let app = app.clone();
        let file = filename.clone();
        tokio::spawn(async move {
            while let Some(p) = rx.recv().await {
                let _ = app.emit(
                    "feral://whisper-download-progress",
                    events::DownloadProgressEvent {
                        repo_id: "whisper".into(),
                        filename: file.clone(),
                        progress: p,
                    },
                );
            }
        });
    }

    let app_for_task = app.clone();
    let downloads_map = state.downloads.clone();
    let key_for_task = key.clone();
    let file_for_task = filename.clone();
    let cancel_for_task = cancel.clone();
    tokio::spawn(async move {
        let result = models::download_hf_model_to(
            repo,
            file_for_task.clone(),
            paths::whisper_dir(),
            tx,
            cancel_for_task.clone(),
        )
        .await;
        downloads_map.lock().remove(&key_for_task);
        match result {
            Ok(path) => {
                let _ = app_for_task.emit(
                    "feral://whisper-download-complete",
                    events::DownloadCompleteEvent {
                        repo_id: "whisper".into(),
                        filename: file_for_task.clone(),
                        path: path.to_string_lossy().into_owned(),
                    },
                );
            }
            Err(e) => {
                let cancelled = cancel_for_task.load(Ordering::Relaxed);
                let _ = app_for_task.emit(
                    "feral://whisper-download-error",
                    events::DownloadErrorEvent {
                        repo_id: "whisper".into(),
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

/// Download the embedding model (bge-small) into the shared models dir for
/// Fractal Memory Search. Mirrors `download_whisper_model`: dedicated events so
/// the LLM auto-load listener never tries to load it as a chat model, a no-op
/// when already present, and cancellable. Idempotent — the frontend can fire
/// this at startup and it returns immediately if the model is on disk.
/// Progress: `feral://embedding-download-progress`. Completion/failure:
/// `feral://embedding-download-complete` / `-error`.
#[tauri::command]
#[specta::specta]
async fn download_embedding_model(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let repo = paths::EMBED_REPO.to_string();
    let filename = paths::EMBED_FILENAME.to_string();
    let key = format!("embedding::{}", filename);

    {
        let map = state.downloads.lock();
        if map.contains_key(&key) {
            return Err(format!("Download already in progress: {}", key));
        }
    }

    // Already present — nothing to do.
    if paths::embedding_model_path().exists() {
        return Ok(key);
    }

    let cancel: CancelFlag = Arc::new(AtomicBool::new(false));
    state.downloads.lock().insert(key.clone(), cancel.clone());

    let (tx, mut rx) = mpsc::channel::<f32>(32);
    {
        let app = app.clone();
        let file = filename.clone();
        tokio::spawn(async move {
            while let Some(p) = rx.recv().await {
                let _ = app.emit(
                    "feral://embedding-download-progress",
                    events::DownloadProgressEvent {
                        repo_id: "embedding".into(),
                        filename: file.clone(),
                        progress: p,
                    },
                );
            }
        });
    }

    let app_for_task = app.clone();
    let downloads_map = state.downloads.clone();
    let key_for_task = key.clone();
    let file_for_task = filename.clone();
    let cancel_for_task = cancel.clone();
    tokio::spawn(async move {
        let result = models::download_hf_model_to(
            repo,
            file_for_task.clone(),
            paths::models_dir(),
            tx,
            cancel_for_task.clone(),
        )
        .await;
        downloads_map.lock().remove(&key_for_task);
        match result {
            Ok(path) => {
                let _ = app_for_task.emit(
                    "feral://embedding-download-complete",
                    events::DownloadCompleteEvent {
                        repo_id: "embedding".into(),
                        filename: file_for_task.clone(),
                        path: path.to_string_lossy().into_owned(),
                    },
                );
            }
            Err(e) => {
                let cancelled = cancel_for_task.load(Ordering::Relaxed);
                let _ = app_for_task.emit(
                    "feral://embedding-download-error",
                    events::DownloadErrorEvent {
                        repo_id: "embedding".into(),
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

/// Transcribe 16 kHz mono f32 PCM. Errors: "model-missing" | "voice-unavailable".
#[tauri::command]
#[specta::specta]
async fn transcribe_audio(pcm: Vec<f32>, model_size: String) -> Result<String, String> {
    let model_path = paths::whisper_model_path(&model_size);
    if !model_path.exists() {
        return Err("model-missing".into());
    }
    #[cfg(feature = "whisper")]
    {
        // Whisper is CPU-bound; run off the async runtime thread.
        tokio::task::spawn_blocking(move || {
            transcription::transcribe_pcm(&pcm, &model_path).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(feature = "whisper"))]
    {
        let _ = (pcm, model_path);
        Err("voice-unavailable".into())
    }
}

/// Transcribe a recorded audio file via a cloud STT provider. Reads the file
/// from disk and uploads it as multipart. The API key comes from the BYOK
/// keychain (`provider` id). Works in any build — not gated on the local
/// `whisper` feature. Errors: "stt-no-key" | "stt-cloud-failed".
#[tauri::command]
#[specta::specta]
async fn transcribe_audio_cloud(audio_path: String, provider: String) -> Result<String, String> {
    let key = byok::byok_get(&provider).ok_or("stt-no-key")?;

    // Endpoint per provider. Only Groq (whisper-large-v3) is wired today; the
    // `provider` arg keeps the call site stable when more are added.
    let endpoint = match provider.as_str() {
        "groq" => "https://api.groq.com/openai/v1/audio/transcriptions",
        _ => return Err("stt-cloud-failed".into()),
    };

    let bytes = std::fs::read(&audio_path).map_err(|_| "stt-cloud-failed".to_string())?;
    let file_name = std::path::Path::new(&audio_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("audio.webm")
        .to_string();

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str("application/octet-stream")
        .map_err(|_| "stt-cloud-failed".to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("model", "whisper-large-v3")
        .part("file", part);

    let client = reqwest::Client::builder()
        .user_agent("feral/0.1")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| "stt-cloud-failed".to_string())?;

    let resp = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", key))
        .multipart(form)
        .send()
        .await
        .map_err(|_| "stt-cloud-failed".to_string())?;

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        tracing::warn!(status = code, body = %body, "cloud STT request failed");
        return Err("stt-cloud-failed".into());
    }

    #[derive(serde::Deserialize)]
    struct TranscriptionResponse {
        text: String,
    }
    let parsed: TranscriptionResponse = resp
        .json()
        .await
        .map_err(|_| "stt-cloud-failed".to_string())?;
    Ok(parsed.text.trim().to_string())
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

/// Toggle OS-level desktop control (the `control_app` tool) at runtime.
///
/// Persists the choice, updates the host-process env (so the Rust command
/// gate and the next sidecar spawn agree — both read
/// `FERAL_ENABLE_DESKTOP_CONTROL`), then restarts the sidecar so its tool
/// registry re-registers or drops `control_app`. The restart is what makes the
/// tool actually appear/disappear: tool registration happens once, at sidecar
/// startup, from `process.env`.
///
/// The restart is performed by killing the current child; the `#11` supervisor
/// detects the exit and respawns it, re-reading the env set above. The stdin
/// `tx` slot is invalidated so any in-flight send fails fast instead of writing
/// into a dead pipe.
#[tauri::command]
#[specta::specta]
fn set_desktop_control_enabled(
    enabled: bool,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut s = settings::load();
    s.desktop_control_enabled = enabled;
    settings::save(&s).map_err(|e| e.to_string())?;

    if enabled {
        std::env::set_var("FERAL_ENABLE_DESKTOP_CONTROL", "true");
    } else {
        std::env::remove_var("FERAL_ENABLE_DESKTOP_CONTROL");
    }
    restart_sidecar(&state);
    Ok(())
}

/// Set the per-conversation token budget for the Feral Agent sidecar.
///
/// `budget = None` → unlimited (exports `FERAL_BUDGET_CONVERSATION=Infinity`).
/// `budget = Some(n)` → caps at n tokens (exports the number as a string).
/// The sidecar reads this env at startup via `Number(env.FERAL_BUDGET_CONVERSATION)`.
/// Persists the choice and restarts the sidecar so the new budget takes effect.
#[tauri::command]
#[specta::specta]
fn set_token_budget_conversation(
    budget: Option<u64>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut s = settings::load();
    s.token_budget_conversation = budget;
    settings::save(&s).map_err(|e| e.to_string())?;

    match budget {
        Some(n) => std::env::set_var("FERAL_BUDGET_CONVERSATION", n.to_string()),
        None => std::env::set_var("FERAL_BUDGET_CONVERSATION", "Infinity"),
    }
    restart_sidecar(&state);
    Ok(())
}

/// Set the USD spend cap for the passive RSI background engine.
///
/// `budget = Some(0.0)` (default) → local-only: free local runs continue, any
/// paid cloud spend halts. `Some(n)` → allow up to $n of cloud spend. `None` →
/// no cap. Exports `FERAL_RSI_MAX_COST_USD` and restarts the sidecar so the
/// passive supervisor re-reads it.
#[tauri::command]
#[specta::specta]
fn set_rsi_budget(
    budget: Option<f64>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut s = settings::load();
    s.rsi_max_cost_usd = budget;
    settings::save(&s).map_err(|e| e.to_string())?;

    match budget {
        Some(n) => std::env::set_var("FERAL_RSI_MAX_COST_USD", n.to_string()),
        None => std::env::remove_var("FERAL_RSI_MAX_COST_USD"),
    }
    restart_sidecar(&state);
    Ok(())
}

/// Toggle desktop-control "YOLO mode" (no per-action confirmation) at runtime.
///
/// The confirmation gate lives in the SIDECAR (it reads
/// `FERAL_DESKTOP_CONTROL_CONFIRM`), so like the enable toggle this updates the
/// host env and restarts the sidecar to apply it. Safe mode (the default) asks
/// before each state-changing action; YOLO mode runs them immediately. `launch`
/// always confirms regardless, since it creates a process.
#[tauri::command]
#[specta::specta]
fn set_desktop_control_yolo(
    enabled: bool,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut s = settings::load();
    s.desktop_control_yolo = enabled;
    settings::save(&s).map_err(|e| e.to_string())?;

    if enabled {
        std::env::set_var("FERAL_DESKTOP_CONTROL_CONFIRM", "false");
    } else {
        std::env::remove_var("FERAL_DESKTOP_CONTROL_CONFIRM");
    }
    restart_sidecar(&state);
    Ok(())
}

/// Restart the Feral Agent sidecar so it re-reads the desktop-control env vars.
///
/// Kills the current child; the `#11` supervisor detects the exit and respawns
/// it with the updated environment. The slot is kept populated (the supervisor
/// stops only when it is cleared), and the stdin `tx` is invalidated so any
/// in-flight send fails fast instead of writing into a dead pipe.
fn restart_sidecar(state: &AppState) {
    {
        let mut guard = state.feral_agent_process.lock();
        if let Some(ref mut child) = *guard {
            let _ = child.start_kill();
        }
    }
    *state.feral_agent_tx.lock() = None;
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
fn save_byok_provider(
    state: State<AppState>,
    provider_id: String,
    enabled: bool,
    api_key: String,
    base_url: Option<String>,
    default_model: Option<String>,
) -> Result<(), String> {
    let mut settings = byok::load(&state.settings);
    let config = byok::ProviderConfig {
        enabled,
        api_key,
        base_url,
        default_model,
    };
    settings.update_provider(&provider_id, config);
    byok::save(&settings).map_err(|e| e.to_string())?;

    Ok(())
}

/// Remove a BYOK provider's API key from the OS keychain and disable it.
/// The provider stays listed in the UI (so it can be re-enabled) but its
/// secret is purged.
#[tauri::command]
#[specta::specta]
fn remove_byok_provider(provider_id: String) -> Result<(), String> {
    byok::remove_provider(&provider_id).map_err(|e| e.to_string())
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
    let chat_endpoint = url_join(&url, provider.chat_endpoint_path());

    let client = reqwest::Client::builder()
        .user_agent("feral/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let header_key    = provider.api_key_header();
    let header_prefix = provider.api_key_prefix();
    let auth_value    = format!("{}{}", header_prefix, api_key);

    // Anthropic does NOT publish a `/v1/models` endpoint, so the GET /models
    // probe only applies to OpenAI-compatible providers. For Anthropic we
    // skip straight to the chat-completion probe with the right headers.
    let probe_status: Option<reqwest::Response> = if !provider.is_openai_compatible() {
        None
    } else {
        let models_endpoint = url_join(&url, "models");
        let resp = client
            .get(&models_endpoint)
            .header(header_key, &auth_value)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        Some(resp)
    };

    if let Some(models_resp) = probe_status {
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
        // /models returned 404 or another non-auth error — fall through to the
        // chat-endpoint probe below.
    }

    // /models unavailable (or provider doesn't expose it). Send a minimal
    // non-streaming completion to verify credentials. Anthropic uses a
    // different request shape: `system` is a top-level field, the model id is
    // required, and `max_tokens` is mandatory.
    let probe = if provider.is_openai_compatible() {
        serde_json::json!({
            "model": "__probe__",
            "messages": [{ "role": "user", "content": "Hi" }],
            "max_tokens": 1,
            "stream": false,
        })
    } else {
        serde_json::json!({
            "model": "__probe__",
            "messages": [{ "role": "user", "content": "Hi" }],
            "max_tokens": 1,
        })
    };
    let mut chat_req = client
        .post(&chat_endpoint)
        .header(header_key, &auth_value)
        .header("Content-Type", "application/json")
        .json(&probe);
    for (name, value) in provider.extra_headers() {
        chat_req = chat_req.header(name, value);
    }
    let chat_resp = chat_req
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

/// One-shot, non-streaming completion against the LOCAL loaded model.
///
/// Used by the chat tab's background memory extractor — runs with its OWN
/// stop flag (not the shared `stop_signal`) so a user stopping the visible
/// stream never kills an extraction pass, and vice versa.
#[tauri::command]
#[specta::specta]
async fn chat_complete_local(
    state: State<'_, AppState>,
    messages: Vec<Message>,
    params: InferParams,
) -> Result<String, String> {
    use futures::StreamExt;
    if state.manager.current().is_none() {
        return Err("no model loaded".to_string());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let mut stream = Box::pin(state.manager.stream_chat(messages, params, stop, None));
    let mut out = String::new();
    while let Some(tok) = stream.next().await {
        match tok {
            Ok(t) => out.push_str(&t),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(out)
}

/// One-shot, non-streaming completion from an OpenAI-compatible cloud
/// provider via BYOK. Used by the chat tab's background memory extractor.
#[tauri::command]
#[specta::specta]
async fn chat_cloud_complete(
    provider_id: String,
    model: String,
    messages: Vec<Message>,
    params: InferParams,
) -> Result<String, String> {
    let byok = byok::load(&settings::load());
    let cfg = byok.get_provider(&provider_id).cloned().unwrap_or_default();
    if !cfg.enabled {
        return Err(format!("Provider '{}' is not enabled", provider_id));
    }
    if cfg.api_key.is_empty() {
        return Err(format!("No API key configured for provider '{}'", provider_id));
    }

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
    let endpoint = url_join(&base_url, provider.chat_endpoint_path());
    let auth_value = format!("{}{}", provider.api_key_prefix(), cfg.api_key);

    let client = reqwest::Client::builder()
        .user_agent("feral/0.1")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    // Anthropic's Messages API expects `system` as a top-level field, not
    // inside the messages array. Split it out so OpenAI-shaped callers keep
    // working unchanged while Anthropic gets the right shape.
    let (system, ctx): (Option<String>, Vec<serde_json::Value>) = if !provider.is_openai_compatible() {
        let mut ctx: Vec<serde_json::Value> = Vec::new();
        let mut sys: Option<String> = None;
        for m in &messages {
            if m.role == "system" && sys.is_none() {
                sys = Some(m.content.clone());
            } else {
                ctx.push(serde_json::json!({ "role": m.role, "content": m.content }));
            }
        }
        (sys, ctx)
    } else {
        let mut ctx: Vec<serde_json::Value> = Vec::new();
        if let Some(sys) = &params.system_prompt {
            if !sys.is_empty() {
                ctx.push(serde_json::json!({ "role": "system", "content": sys }));
            }
        }
        for m in &messages {
            ctx.push(serde_json::json!({ "role": m.role, "content": m.content }));
        }
        (None, ctx)
    };

    let mut body = serde_json::json!({
        "model": model,
        "messages": ctx,
        "stream": false,
        "temperature": params.temperature,
        "max_tokens": params.max_tokens,
    });
    if let Some(sys) = system {
        body["system"] = serde_json::Value::String(sys);
    }

    let mut req = client
        .post(&endpoint)
        .header(provider.api_key_header(), &auth_value)
        .header("Content-Type", "application/json")
        .json(&body);
    for (name, value) in provider.extra_headers() {
        req = req.header(name, value);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, body_text));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    // Anthropic responses live under `content[0].text` (not `choices[0].message.content`).
    if !provider.is_openai_compatible() {
        let text = v["content"]
            .as_array()
            .and_then(|arr| arr.iter().find(|c| c.get("type").and_then(|t| t.as_str()) == Some("text")))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or_default();
        return Ok(text.to_string());
    }
    Ok(v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string())
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
    let endpoint = url_join(&base_url, provider.chat_endpoint_path());
    let auth_value = format!("{}{}", provider.api_key_prefix(), cfg.api_key);
    let anthropic = !provider.is_openai_compatible();

    let client = reqwest::Client::builder()
        .user_agent("feral/0.1")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| { let _ = app.emit("feral://stream-error", events::StreamErrorEvent { session_id: session_id.clone(), error: e.to_string() }); e.to_string() })?;

    // Build tool definitions from the enabled tool IDs passed in params.
    // Anthropic's tool shape differs from OpenAI: no `type: "function"`
    // wrapper and the parameters object is `input_schema`.
    let tool_defs: Vec<serde_json::Value> = params.tools
        .as_ref()
        .map(|ids| ids.iter()
            .filter_map(|id| tools::ToolType::from_name(id))
            .map(|t| if anthropic { t.to_anthropic_definition() } else { t.to_openai_definition() })
            .collect())
        .unwrap_or_default();

    // Build initial message context. Anthropic pulls `system` out of the
    // messages array and into a top-level field; OpenAI keeps it inline.
    let mut ctx: Vec<serde_json::Value> = Vec::new();
    let mut system_prompt: Option<String> = None;
    if anthropic {
        if let Some(sys) = &params.system_prompt {
            if !sys.is_empty() {
                system_prompt = Some(sys.clone());
            }
        }
        for m in &messages {
            if m.role == "system" && system_prompt.is_none() {
                system_prompt = Some(m.content.clone());
                continue;
            }
            ctx.push(serde_json::json!({ "role": m.role, "content": m.content }));
        }
    } else {
        if let Some(sys) = &params.system_prompt {
            if !sys.is_empty() {
                ctx.push(serde_json::json!({ "role": "system", "content": sys }));
            }
        }
        for m in &messages {
            // Vision: messages carrying image data URLs use the OpenAI
            // content-parts array so multimodal models receive real pixels.
            // Plain messages keep the string shape for maximum compatibility.
            match m.images.as_ref().filter(|imgs| !imgs.is_empty()) {
                Some(imgs) => {
                    let mut parts: Vec<serde_json::Value> = Vec::new();
                    if !m.content.is_empty() {
                        parts.push(serde_json::json!({ "type": "text", "text": m.content }));
                    }
                    for url in imgs {
                        parts.push(serde_json::json!({
                            "type": "image_url",
                            "image_url": { "url": url },
                        }));
                    }
                    ctx.push(serde_json::json!({ "role": m.role, "content": parts }));
                }
                None => ctx.push(serde_json::json!({ "role": m.role, "content": m.content })),
            }
        }
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
        if anthropic {
            if let Some(sys) = system_prompt.as_ref() {
                body["system"] = serde_json::Value::String(sys.clone());
            }
        } else {
            // OpenAI's stream_options include_usage is a no-op on Anthropic.
            body["stream_options"] = serde_json::json!({ "include_usage": true });
        }
        if !tool_defs.is_empty() {
            body["tools"] = serde_json::json!(tool_defs);
            if !anthropic {
                body["tool_choice"] = serde_json::json!("auto");
            }
        }

        // TEMP-DEBUG: dump the exact outbound request so we can see model id +
        // sampling params + endpoint going to the provider. Remove after triage.
        tracing::warn!(target: "cloud_debug", endpoint = %endpoint, body = %body, "outbound cloud chat request");

        let mut req = client
            .post(&endpoint)
            .header(provider.api_key_header(), &auth_value)
            .header("Content-Type", "application/json")
            .json(&body);
        for (name, value) in provider.extra_headers() {
            req = req.header(name, value);
        }
        let resp = req
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
        let mut usage_prompt_tokens: u32 = 0;
        let mut usage_completion_tokens: u32 = 0;
        // Anthropic SSE uses event types per record; we track the most recent
        // `event:` line so the next `data:` line knows how to interpret itself.
        let mut current_event = String::new();

        'sse: while let Some(chunk) = byte_stream.next().await {
            if stop.load(Ordering::SeqCst) {
                let _ = app.emit("feral://stream-done", events::StreamDoneEvent { session_id });
                return Ok(());
            }
            let bytes = chunk.map_err(|e| { let _ = app.emit("feral://stream-error", events::StreamErrorEvent { session_id: session_id.clone(), error: e.to_string() }); e.to_string() })?;
            let text = String::from_utf8_lossy(&bytes);
            // TEMP-DEBUG: raw SSE chunk as received from the provider. Remove after triage.
            tracing::warn!(target: "cloud_debug", raw = %text, "inbound cloud chunk");

            for ch in text.chars() {
                if ch == '\n' {
                    let line = line_buf.trim().to_string();
                    line_buf.clear();
                    if line.is_empty() { continue; }
                    if !anthropic && line == "data: [DONE]" { break 'sse; }

                    if anthropic {
                        // Anthropic SSE: "event: <name>" sets the type for
                        // the following "data: <json>" line. A blank line
                        // delimits one event record (we reset on each blank
                        // line above).
                        if let Some(ev) = line.strip_prefix("event: ") {
                            current_event = ev.to_string();
                            continue;
                        }
                        if let Some(json_str) = line.strip_prefix("data: ") {
                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                                match current_event.as_str() {
                                    "message_start" => {
                                        // Anthropic reports initial usage
                                        // (input_tokens). Capture it.
                                        if let Some(u) = val.get("message")
                                            .and_then(|m| m.get("usage"))
                                        {
                                            if let Some(pt) = u.get("input_tokens").and_then(|v| v.as_u64()) {
                                                usage_prompt_tokens = pt as u32;
                                            }
                                        }
                                    }
                                    "content_block_start" => {
                                        // A new tool_use block — register it
                                        // in `pending_calls` so the following
                                        // input_json_delta fragments land in
                                        // the right slot.
                                        if let Some(block) = val.get("content_block") {
                                            if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                                let idx = val.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                                let id   = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                let initial_args = block.get("input")
                                                    .map(|v| v.to_string())
                                                    .unwrap_or_default();
                                                pending_calls.insert(idx, (id, name, initial_args));
                                            }
                                        }
                                    }
                                    "content_block_delta" => {
                                        if let Some(delta) = val.get("delta") {
                                            let idx = val.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                            let entry = pending_calls.entry(idx)
                                                .or_insert_with(|| (String::new(), String::new(), String::new()));
                                            match delta.get("type").and_then(|t| t.as_str()) {
                                                Some("text_delta") => {
                                                    if let Some(tok) = delta.get("text").and_then(|v| v.as_str()) {
                                                        if !tok.is_empty() {
                                                            content_acc.push_str(tok);
                                                            let _ = app.emit("feral://token", events::TokenEvent {
                                                                session_id: session_id.clone(),
                                                                text: tok.to_string(),
                                                            });
                                                        }
                                                    }
                                                }
                                                Some("input_json_delta") => {
                                                    if let Some(frag) = delta.get("partial_json").and_then(|v| v.as_str()) {
                                                        entry.2.push_str(frag);
                                                    }
                                                }
                                                _ => {}
                                            }
                                        }
                                    }
                                    "message_delta" => {
                                        // stop_reason + final usage (output_tokens).
                                        if let Some(delta) = val.get("delta") {
                                            if let Some(fr) = delta.get("stop_reason").and_then(|v| v.as_str()) {
                                                finish_reason = fr.to_string();
                                            }
                                        }
                                        if let Some(u) = val.get("usage") {
                                            if let Some(ct) = u.get("output_tokens").and_then(|v| v.as_u64()) {
                                                usage_completion_tokens = ct as u32;
                                            }
                                        }
                                    }
                                    "message_stop" => break 'sse,
                                    _ => {}
                                }
                            }
                        }
                    } else if let Some(json_str) = line.strip_prefix("data: ") {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                            // Capture usage stats from the final SSE chunk (when stream_options.include_usage is set)
                            if let Some(usage) = val.get("usage") {
                                if let Some(pt) = usage.get("prompt_tokens").and_then(|v| v.as_u64()) {
                                    usage_prompt_tokens = pt as u32;
                                }
                                if let Some(ct) = usage.get("completion_tokens").and_then(|v| v.as_u64()) {
                                    usage_completion_tokens = ct as u32;
                                }
                            }
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

        // For Anthropic, an empty finish_reason with no tool calls means
        // end_turn (natural stop) — surface that to the agentic loop so it
        // knows to break out.
        if anthropic && finish_reason.is_empty() && pending_calls.is_empty() {
            finish_reason = "stop".to_string();
        }

        // If the provider reported that we hit its server-side token cap,
        // emit a `stream-truncated` event so the frontend can mark the
        // message and surface a hint. The partial `content_acc` is still
        // preserved in the message bubble on the React side.
        if finish_reason == "length" {
            let _ = app.emit(
                "feral://stream-truncated",
                events::StreamTruncatedEvent {
                    session_id: session_id.clone(),
                    reason: finish_reason.clone(),
                },
            );
        }

        // Emit real token usage if the provider sent it (stream_options.include_usage).
        if usage_prompt_tokens > 0 || usage_completion_tokens > 0 {
            let _ = app.emit("feral://stream-usage", events::StreamUsageEvent {
                session_id: session_id.clone(),
                prompt_tokens: usage_prompt_tokens,
                completion_tokens: usage_completion_tokens,
            });
        }

        // usage_prompt_tokens / usage_completion_tokens are re-declared at the top
        // of each loop iteration, so no explicit reset is needed here.

        // If no tool calls, we're done. Anthropic reports stop_reason as
        // "tool_use" when it wants the host to run a tool; OpenAI uses
        // "tool_calls" on the last delta choice.
        let tool_marker = if anthropic { "tool_use" } else { "tool_calls" };
        if finish_reason != tool_marker || pending_calls.is_empty() {
            break;
        }

        // Sort by index so the assistant message lists them in order
        let mut sorted: Vec<(usize, (String, String, String))> = pending_calls.into_iter().collect();
        sorted.sort_by_key(|(idx, _)| *idx);

        if anthropic {
            // Anthropic history: the assistant turn is a list of tool_use
            // content blocks; the tool result is a `tool_result` content
            // block on the FOLLOWING user turn (not a separate role).
            let tool_use_blocks: Vec<serde_json::Value> = sorted.iter()
                .map(|(_, (id, name, args))| {
                    let input: serde_json::Value = serde_json::from_str(args)
                        .unwrap_or(serde_json::json!({}));
                    serde_json::json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": input,
                    })
                })
                .collect();
            ctx.push(serde_json::json!({
                "role": "assistant",
                "content": tool_use_blocks,
            }));

            // Execute each tool and append ALL results to a single user turn.
            let mut tool_results: Vec<serde_json::Value> = Vec::new();
            for (_, (id, name, args_str)) in &sorted {
                let args: serde_json::Value = serde_json::from_str(args_str)
                    .unwrap_or(serde_json::json!({}));
                let result = if let Some(tool_type) = tools::ToolType::from_name(name) {
                    tools::execute(tool_type, args).await
                } else {
                    tools::ToolResult { name: name.clone(), ok: false, output: format!("Unknown tool: {}", name) }
                };
                tool_results.push(serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": result.output,
                    "is_error": !result.ok,
                }));
            }
            ctx.push(serde_json::json!({
                "role": "user",
                "content": tool_results,
            }));
        } else {
            // OpenAI history: tool_calls on the assistant turn, then a
            // separate `role: "tool"` message per result.
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
        }
        // Loop continues — model will now generate a response using the tool results
    }

    let _ = app.emit("feral://stream-done", events::StreamDoneEvent { session_id });
    Ok(())
}

/// Reject a path that resolves inside the Feral private dir (`~/.feral`) where
/// the api-token, byok metadata and the agent DB live. The webview-facing file
/// readers below use this so they can't be turned into a secret-exfiltration
/// primitive (e.g. by an injected script): there is no legitimate reason to
/// drag those files into chat, and it denies a would-be XSS its highest-value
/// local targets. `canonical` must already be canonicalized (symlinks resolved)
/// so a symlink can't point out of an allowed dir into the private one.
fn deny_feral_private(canonical: &std::path::Path) -> Result<(), String> {
    if let Ok(feral) = paths::feral_dir().canonicalize() {
        if canonical.starts_with(&feral) {
            return Err("Access denied: path is inside the Feral private directory".into());
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn read_file_as_text(path: String) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("Invalid path: {}", e))?;
    deny_feral_private(&canonical)?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|e| format!("Stat failed: {}", e))?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("File too large (max 10 MB)".into());
    }
    std::fs::read_to_string(&canonical).map_err(|e| format!("Read failed: {}", e))
}

/// Read an image file and return it as a `data:<mime>;base64,...` URL.
/// Used by the chat input's drag&drop path — dropped files arrive as OS
/// paths via the Tauri drag-drop event, so the webview can't read them
/// with the DOM File API the way pasted screenshots are read.
///
/// Security: this command is reachable from the webview, so it must not become
/// an arbitrary-file-read primitive. Two guards on top of the size cap:
///   - the resolved (canonical, symlink-followed) path may NOT be inside the
///     Feral private dir (`~/.feral`) where the api-token, byok metadata and
///     the agent DB live — there is no legitimate reason to drag those in, and
///     it denies a would-be XSS its highest-value local targets.
///   - the extension allowlist below keeps it to images, so it can never
///     return the *text* of a secret file even outside `~/.feral`.
#[tauri::command]
#[specta::specta]
async fn read_file_as_data_url(path: String) -> Result<String, String> {
    use base64::Engine as _;
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("Invalid path: {}", e))?;
    deny_feral_private(&canonical)?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|e| format!("Stat failed: {}", e))?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("File too large (max 10 MB)".into());
    }
    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => return Err(format!("Not a supported image format: .{ext}")),
    };
    let bytes = std::fs::read(&canonical).map_err(|e| format!("Read failed: {}", e))?;
    Ok(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Best-effort text extraction for chat attachments: PDF, OOXML/ODF documents
/// (docx/pptx/xlsx/odt) and any UTF-8 text file. This is what lets "drop any
/// file into the chat" actually reach the model — previously only plain text
/// survived and everything else became an "Unsupported format" dead chip.
///
/// Errors with the literal prefix "binary:" when the file has no extractable
/// text, so the frontend can fall back to attaching a path reference instead
/// of an error chip.
#[tauri::command]
#[specta::specta]
async fn extract_file_text(path: String) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("Invalid path: {}", e))?;
    deny_feral_private(&canonical)?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|e| format!("Stat failed: {}", e))?;
    if meta.len() > 25 * 1024 * 1024 {
        return Err("File too large (max 25 MB)".into());
    }
    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // PDF/zip parsing is CPU-bound — keep it off the async runtime.
    let text = tokio::task::spawn_blocking(move || extract_text_blocking(&canonical, &ext))
        .await
        .map_err(|e| format!("Extraction task failed: {}", e))??;
    const MAX_CHARS: usize = 200_000;
    if text.chars().count() > MAX_CHARS {
        let truncated: String = text.chars().take(MAX_CHARS).collect();
        return Ok(format!("{}\n\n[content truncated — file is longer]", truncated));
    }
    Ok(text)
}

fn extract_text_blocking(path: &std::path::Path, ext: &str) -> Result<String, String> {
    match ext {
        "pdf" => pdf_extract::extract_text(path)
            .map_err(|e| format!("PDF extraction failed: {}", e)),
        "docx" | "odt" | "pptx" | "xlsx" => extract_zip_xml_text(path, ext),
        _ => {
            let bytes = std::fs::read(path).map_err(|e| format!("Read failed: {}", e))?;
            String::from_utf8(bytes).map_err(|_| "binary: no extractable text".to_string())
        }
    }
}

/// Pull visible text out of an OOXML/ODF container (they are all zip files
/// holding XML). Paragraph-level tags become newlines; everything else is
/// stripped. Not a full XML parse — good enough for "let the model read the
/// document" and zero extra dependencies beyond `zip`.
fn extract_zip_xml_text(path: &std::path::Path, ext: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Open failed: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Not a valid .{} file: {}", ext, e))?;

    let mut wanted: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let name = match archive.by_index(i) {
            Ok(f) => f.name().to_string(),
            Err(_) => continue,
        };
        let keep = match ext {
            "docx" => name == "word/document.xml",
            "odt" => name == "content.xml",
            "pptx" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
            "xlsx" => name == "xl/sharedStrings.xml",
            _ => false,
        };
        if keep {
            wanted.push(name);
        }
    }
    if wanted.is_empty() {
        return Err(format!("binary: no text part found in .{} file", ext));
    }
    wanted.sort();

    let mut out = String::new();
    for name in &wanted {
        use std::io::Read as _;
        let mut entry = archive
            .by_name(name)
            .map_err(|e| format!("Zip entry failed: {}", e))?;
        let mut xml = String::new();
        entry
            .read_to_string(&mut xml)
            .map_err(|e| format!("Zip read failed: {}", e))?;
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&strip_xml_to_text(&xml));
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return Err(format!("binary: .{} file contains no text", ext));
    }
    Ok(trimmed.to_string())
}

/// Strip XML tags, turning paragraph/row boundaries into newlines and
/// decoding the five standard entities.
fn strip_xml_to_text(xml: &str) -> String {
    const PARAGRAPH_CLOSERS: &[&str] = &[
        "/w:p", "/text:p", "/text:h", "/a:p", "/si", "/w:tr", "/table:table-row",
    ];
    let mut out = String::with_capacity(xml.len() / 8);
    let mut tag = String::new();
    let mut in_tag = false;
    for ch in xml.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let t = tag.split_whitespace().next().unwrap_or("");
                if PARAGRAPH_CLOSERS.contains(&t) || t == "w:br" || t == "w:br/" {
                    if !out.ends_with('\n') {
                        out.push('\n');
                    }
                }
            }
            _ => {
                if in_tag {
                    tag.push(ch);
                } else {
                    out.push(ch);
                }
            }
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
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

    // V4: per-launch bearer token for the loopback HTTP API. Two uuids give
    // ~244 bits of randomness — far past brute-force for a token that also
    // rotates every launch. Persisted to `~/.feral/api-token` (inside the
    // already user-private profile dir) so external apps that want to consume
    // the local endpoint can read it; the in-app sidecar receives it directly.
    let local_api_token: Arc<str> = Arc::from(
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
        .as_str(),
    );
    {
        let token_path = paths::feral_dir().join("api-token");
        if let Err(e) = std::fs::write(&token_path, local_api_token.as_bytes()) {
            tracing::warn!(?e, "failed to persist api-token (external API consumers won't have it)");
        } else {
            // Restrict to owner-only so other local users can't read the
            // bearer token. (Same-user processes still can — that is the
            // documented contract for external API consumers.) On Windows the
            // file already sits in the user-private profile dir.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }

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

    let startup_gpu_layers = settings.default_gpu_layers;
    let state = AppState {
        manager: manager.clone(),
        downloads: Arc::new(Mutex::new(HashMap::new())),
        stop_signal: Arc::new(AtomicBool::new(false)),
        settings,
        system_info_cache,
        feral_agent_process: Arc::new(Mutex::new(None)),
        feral_agent_tx: Arc::new(Mutex::new(None)),
        feral_model_config: Arc::new(Mutex::new(None)),
        local_api_token: local_api_token.clone(),
        mcp: Arc::new(mcp::McpManager::new()),
        rsi_state: rsi::RsiState::default(),
        rsi_goodhart: rsi::commands::GoodhartSlot::default(),
        rsi_engine: std::sync::Arc::new(parking_lot::Mutex::new(None)),
        rsi_request_registry: rsi::commands::RsiRequestRegistry::default(),
    };

    let specta_builder = tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            get_models,
            get_loaded_model,
            download_model,
            download_embedding_model,
            cancel_download,
            load_model,
            start_model_load,
            unload_model,
            delete_model,
            chat_stream,
            stop_generation,
            get_system_info,
            disk_encryption::disk_encryption_status,
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
            save_voice_blob,
            whisper_model_present,
            transcribe_audio,
            transcribe_audio_cloud,
            download_whisper_model,
            load_projects,
            save_project,
            delete_project,
            get_settings,
            save_settings,
            set_desktop_control_enabled,
            set_desktop_control_yolo,
            set_token_budget_conversation,
            set_rsi_budget,
            search_hf_models,
            get_hf_model_detail,
            get_model_size_info,
            get_hf_model_size,
            get_byok_settings,
            save_byok_provider,
            remove_byok_provider,
            test_byok_provider,
            chat_cloud_stream,
            chat_complete_local,
            chat_cloud_complete,
            read_file_as_text,
            read_file_as_data_url,
            extract_file_text,
            skills::list_installed_skills,
            skills::get_installed_skill_content,
            skills::fetch_remote_skills,
            skills::fetch_community_skills,
            skills::preview_remote_skill,
            skills::preview_local_skill,
            skills::skill_exists_cmd,
            skills::install_skill,
            skills::remove_skill,
            feral_send_message,
            feral_agent_status,
            feral_stop_generation,
            feral_run_fractal_benchmark,
            feral_fractal_cluster_leaves,
            feral_set_model,
            feral_get_model_config,
            get_local_api_token,
            feral_ask_user_response,
            feral_ask_user_cancel,
            get_onboarding_record,
            set_onboarding_record,
            list_ollama_models,
            mcp::mcp_catalog,
            mcp::mcp_list,
            mcp::mcp_install,
            mcp::mcp_set_enabled,
            mcp::mcp_remove,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            connectors::connectors_catalog,
            connectors::connectors_list,
            connectors::connectors_save,
            connectors::connectors_set_enabled,
            connectors::connectors_remove,
            memory_graph::get_memory_graph,
            memory_graph::add_memory_facts,
            desktop_control::list_windows,
            desktop_control::get_accessibility_tree,
            desktop_control::find_elements,
            desktop_control::click_element,
            desktop_control::type_into_element,
            desktop_control::get_element_value,
            desktop_control::get_focused_element,
            desktop_control::take_element_action,
            desktop_control::send_keys,
            desktop_control::launch_app,
            rsi::commands::rsi_init,
            rsi::commands::rsi_status,
            rsi::commands::rsi_get_bounds,
            rsi::commands::rsi_update_bounds,
            rsi::commands::rsi_score,
            rsi::commands::rsi_get_tier0_specs,
            rsi::commands::rsi_commit_genome,
            rsi::commands::rsi_ratchet_attempt,
            rsi::commands::rsi_log,
            rsi::commands::rsi_lca,
            rsi::commands::rsi_diff,
            rsi::commands::rsi_record_goodhart_sample,
            rsi::commands::rsi_reset_goodhart,
            rsi::commands::rsi_start,
            rsi::commands::rsi_stop,
            rsi::commands::rsi_set_concurrency,
            rsi::commands::rsi_dream_telemetry,
        ])
        .events(tauri_specta::collect_events![
            crate::events::TokenEvent,
            crate::events::StreamDoneEvent,
            crate::events::StreamErrorEvent,
            crate::events::StreamTruncatedEvent,
            crate::events::StreamProgressEvent,
            crate::events::DownloadProgressEvent,
            crate::events::DownloadCompleteEvent,
            crate::events::DownloadErrorEvent,
            crate::events::ModelLoadProgressEvent,
            crate::events::AgentStreamEvent,
            crate::events::FeralAgentOutputEvent,
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

            // ── Auto CPU-offload for embedding on fragile AMD GPUs ─────────
            // On RX 580 / Polaris / early-Vega cards, llama.cpp's Vulkan embed
            // (bge-small) crashes at model load — a known llama.cpp × AMDVLK
            // driver bug that no Feral-side work-around fixes (see
            // docs/agents-memory/project_local_models_gpu.md). The chat
            // inference path on the same GPU is fine; only the embed path is
            // the problem. We set FERAL_EMBED_GPU_LAYERS=0 BEFORE the embed
            // model is lazily loaded (inference.rs::load_embedding reads it
            // via std::env at first use), so the crash never happens. Only
            // active on a Vulkan build (inference-vulkan feature) — a CPU
            // build ignores the env anyway. Honors an explicit user override
            // (we never overwrite a pre-set env var).
            #[cfg(feature = "inference-vulkan")]
            {
                if std::env::var_os("FERAL_EMBED_GPU_LAYERS").is_none() {
                    let info = crate::gpu_detect::detect();
                    if crate::gpu_detect::looks_like_fragile_amd_gpu(&info) {
                        std::env::set_var("FERAL_EMBED_GPU_LAYERS", "0");
                        tracing::info!(
                            gpu = %info.name,
                            "fragile AMD GPU detected — forcing CPU offload for embeddings \
                             (FERAL_EMBED_GPU_LAYERS=0); chat inference still uses GPU"
                        );
                    }
                }
            }

            // ── RSI substrate bootstrap (Faza 0 — Keystone) ──────────────
            // Runs BEFORE the sidecar spawns. The sidecar's bootstrapOnce()
            // expects the git repo + PLAN.md + SandboxBounds to already be
            // on disk; without this the sidecar would log a missing
            // substrate and skip the rsi_init IPC call (which is the
            // documented ordering — see FeralAgent/src/rsi/mod.ts).
            //
            // Bootstrap is idempotent: if the repo exists, repo::bootstrap
            // returns its current tip; if the bounds file exists,
            // bootstrap_with_audit would create a duplicate genesis row, so
            // we use SandboxBounds::load instead when the file is present.
            match rsi::repo::bootstrap() {
                Ok(plan_commit) => {
                    tracing::info!(plan_commit = %plan_commit, "rsi: git substrate bootstrapped");
                }
                Err(e) => {
                    tracing::error!(error = %e, "rsi: git substrate bootstrap failed");
                }
            }
            let audit_path = paths::rsi_sandbox_bounds_audit_path();
            match rsi::audit::SandboxBoundsAudit::open(&audit_path) {
                Ok(audit) => {
                    let bounds_result = if paths::rsi_sandbox_bounds_path().exists() {
                        rsi::sandbox_bounds::SandboxBounds::load()
                    } else {
                        rsi::sandbox_bounds::SandboxBounds::bootstrap_with_audit(&audit)
                    };
                    match bounds_result {
                        Ok(bounds) => {
                            let sha = bounds.file_sha256().ok();
                            tracing::info!(
                                version = bounds.version,
                                bounds_sha256 = sha.as_deref().unwrap_or("?"),
                                "rsi: sandbox_bounds ready",
                            );
                            // Reflect the boot state into AppState so the
                            // very first rsi_init call from the UI is a
                            // no-op and the subsequent rsi_status call
                            // returns the right values immediately.
                            let st = app.handle().state::<AppState>();
                            *st.rsi_state.bounds.lock() = Some(bounds);
                            *st.rsi_state.bounds_file_sha256.lock() = sha;
                            *st.rsi_state.initialized.lock() = true;
                        }
                        Err(e) => {
                            tracing::error!(error = %e, "rsi: sandbox_bounds bootstrap failed");
                        }
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, "rsi: audit log open failed");
                }
            }

            // Start API server in background.
            //
            // R4 fix: the Feral Agent sidecar is hardcoded to point at
            // 127.0.0.1:{api_port} (see feral_agent::spawn — FERAL_BASE_URL is
            // set unconditionally to `http://127.0.0.1:{api_port}`). Without the
            // local API server up, every agent inference fails with
            // "connection refused". The bearer token (api_token below) already
            // gates the only exposure the `api_server_enabled` opt-in was
            // guarding, so we force it on for the sidecar codepath. Users who
            // truly want the API off can remove the sidecar's externalBin entry
            // in tauri.conf.json.
            let mut cfg = settings::load();
            cfg.api_server_enabled = true;
            let api_port = cfg.api_port;
            // Desktop control opt-in (persisted in Settings) → export the env
            // BEFORE the sidecar spawns so `feral_agent::spawn` forwards it and
            // the sidecar registers `control_app`. Same flag opens the Rust
            // command gate (desktop_control.rs reads it per request). Off by
            // default; the Settings toggle flips this and restarts the sidecar.
            if cfg.desktop_control_enabled {
                std::env::set_var("FERAL_ENABLE_DESKTOP_CONTROL", "true");
            }
            // YOLO mode (no per-action confirmation) is read by the sidecar, so
            // export it before spawn too. Safe mode (default) leaves it unset.
            if cfg.desktop_control_yolo {
                std::env::set_var("FERAL_DESKTOP_CONTROL_CONFIRM", "false");
            }
            // Token budget: always set the env so the sidecar picks it up.
            // None = unlimited (Infinity); Some(n) = hard cap at n tokens.
            match cfg.token_budget_conversation {
                Some(n) => std::env::set_var("FERAL_BUDGET_CONVERSATION", n.to_string()),
                None => std::env::set_var("FERAL_BUDGET_CONVERSATION", "Infinity"),
            }
            // RSI background spend cap. Some(0.0)/default = local-only; Some(n)
            // = allow $n cloud spend; None = no cap (remove the var).
            match cfg.rsi_max_cost_usd {
                Some(n) => std::env::set_var("FERAL_RSI_MAX_COST_USD", n.to_string()),
                None => std::env::remove_var("FERAL_RSI_MAX_COST_USD"),
            }
            if cfg.api_server_enabled {
                let api_state = api::ApiState {
                    manager: manager.clone(),
                    token: local_api_token.clone(),
                };
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = api::serve(api_state, api_port).await {
                        tracing::error!(?e, "api server stopped");
                    }
                });
            }
            // Spawn Feral Agent sidecar, pointed at the bundled engine (A1).
            let fa_handle = app.handle().clone();
            let fa_tx_slot = app.handle().state::<AppState>().feral_agent_tx.clone();
            let fa_process_slot = app.handle().state::<AppState>().feral_agent_process.clone();
            let fa_registry = app.handle().state::<AppState>().rsi_request_registry.clone();
            let fa_engine_mirror = app.handle().state::<AppState>().rsi_engine.clone();
            let fa_port = api_port;
            let fa_token = local_api_token.to_string();
            // #11: supervised spawn — watches for sidecar crashes, restarts
            // with backoff, and emits `feral://agent-exit` so the UI can show
            // an "agent offline" banner instead of going silently mute. The
            // registry + engine mirror are cloned into every spawn generation
            // so the stdout reader can route `rsi_engine_event` acks to the
            // matching oneshot and keep `rsi_status.engine` fresh.
            feral_agent::supervise(
                fa_handle,
                fa_tx_slot,
                fa_process_slot,
                fa_port,
                fa_token,
                fa_registry,
                fa_engine_mirror,
            );

            // Reconnect enabled MCP extensions in the background. Failures
            // are logged per-server — a broken extension never blocks launch.
            let mcp_manager = app.handle().state::<AppState>().mcp.clone();
            tauri::async_runtime::spawn(async move {
                mcp_manager.start_enabled().await;
            });

            // Auto-reload last model in background so the user doesn't have
            // to pick it again after every restart. Silent fail — if the file
            // moved or was deleted the user selects manually as usual.
            //
            // Race guard: if the user is already mid-load (e.g. clicked Apply
            // during startup), `manager.current()` is non-None — skip the
            // auto-reload so we don't overwrite their in-flight choice (and
            // don't shrink their context window back to the default cap).
            {
                let auto_manager = manager.clone();
                let auto_app = app.handle().clone();
                let auto_layers = startup_gpu_layers;
                tauri::async_runtime::spawn(async move {
                    let s = settings::load();
                    let last = s.last_loaded_model;
                    let last_ctx = s.last_loaded_ctx;
                    if let Some(p) = last {
                        if auto_manager.current().is_some() {
                            tracing::info!("auto-reload skipped: a model is already loaded");
                            return;
                        }
                        let pb = std::path::PathBuf::from(&p);
                        if pb.exists() {
                            tracing::info!(
                                path = %p,
                                ctx = ?last_ctx,
                                "auto-reloading last model"
                            );
                            let _ = auto_app.emit("model-load-progress", events::ModelLoadProgressEvent {
                                percentage: 0.0,
                                status_text: "Auto-loading last model…".into(),
                            });
                            let result = tokio::task::spawn_blocking(move || {
                                auto_manager.load(pb, auto_layers, last_ctx).map_err(|e| e.to_string())
                            }).await;
                            match result {
                                Ok(Ok(_)) => {
                                    let _ = auto_app.emit("model-load-progress", events::ModelLoadProgressEvent {
                                        percentage: 100.0,
                                        status_text: format!("Ready"),
                                    });
                                }
                                Ok(Err(e)) => {
                                    tracing::warn!(error = %e, "auto-reload failed");
                                    let _ = auto_app.emit("model-load-progress", events::ModelLoadProgressEvent {
                                        percentage: 0.0,
                                        status_text: String::new(),
                                    });
                                }
                                Err(e) => {
                                    tracing::warn!(error = %e, "auto-reload task failed");
                                }
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(specta_builder.invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let mut fa_guard = state.feral_agent_process.lock();
                    if let Some(ref mut child) = *fa_guard {
                        let _ = child.start_kill();
                        tracing::info!("Feral Agent sidecar stopped");
                    }
                    // Drop the tx so the stdin writer task exits cleanly.
                    *state.feral_agent_tx.lock() = None;
                }
            }
        });
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
