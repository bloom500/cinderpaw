//! On-device STT: voice blob capture, Whisper model download, transcription
//! (local + cloud).

use crate::*;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

/// Persist a recorded audio blob to the on-disk `voice/` dir. Returns the path.
#[tauri::command]
#[specta::specta]
pub(crate) async fn save_voice_blob(bytes: Vec<u8>, ext: String) -> Result<String, String> {
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
pub(crate) fn whisper_model_present(model_size: String) -> bool {
    paths::whisper_model_path(&model_size).exists()
}

/// Download the whisper ggml model for `model_size` into the whisper dir.
/// Streams over `feral://whisper-download-progress`; completion/failure over
/// `feral://whisper-download-complete` / `-error`. Distinct from `download_model`
/// so the LLM auto-load listener never tries to load a whisper model as a llama.
#[tauri::command]
#[specta::specta]
pub(crate) async fn download_whisper_model(
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

/// Transcribe 16 kHz mono f32 PCM. Errors: "model-missing" | "voice-unavailable".
#[tauri::command]
#[specta::specta]
pub(crate) async fn transcribe_audio(pcm: Vec<f32>, model_size: String) -> Result<String, String> {
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
pub(crate) async fn transcribe_audio_cloud(audio_path: String, provider: String) -> Result<String, String> {
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
