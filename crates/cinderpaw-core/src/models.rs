use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc::Sender;

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    #[specta(type = specta_typescript::Number)]
    pub size_bytes: u64,
    pub quant: Option<String>,
    pub ctx_len: Option<u32>,
    pub loaded: bool,
    pub modelfile: Option<Modelfile>,
    /// True for a model that turns text into vectors and cannot hold a
    /// conversation. Carried on the struct rather than re-derived per caller,
    /// because there are fourteen callers and the ones that must NOT filter —
    /// the embedder looking for its own model, a screen that lists what is on
    /// disk to delete it — are as important as the ones that must.
    pub is_embedding: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, specta::Type)]
pub struct Modelfile {
    pub system_prompt: Option<String>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub repeat_penalty: Option<f32>,
    pub ctx_len: Option<u32>,
    pub template: Option<String>,
}

pub fn scan_models_dir() -> Result<Vec<ModelInfo>> {
    paths::ensure_dirs()?;
    let dir = paths::models_dir();
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext != "gguf" {
                continue;
            }
            let meta = entry.metadata()?;
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();
            let quant = parse_quant(&name);
            let modelfile = load_modelfile(&path);
            let embedding = is_embedding_model(&name);
            out.push(ModelInfo {
                id: name.clone(),
                name,
                path: path.clone(),
                size_bytes: meta.len(),
                quant,
                ctx_len: modelfile.as_ref().and_then(|m| m.ctx_len),
                loaded: false,
                modelfile,
                is_embedding: embedding,
            });
        }
    }
    Ok(out)
}

/// Whether a GGUF on disk is an embedding model rather than something that can
/// answer.
///
/// By filename, which is a heuristic, and the honest reason it is good enough:
/// these families ship under their own names and nobody renames them, because
/// the file arrives from a downloader that names it. The alternative — reading
/// the GGUF header for a missing chat template — means opening every file on
/// every scan, and the scan runs on screens that just want a list.
///
/// Wrong in the safe direction if it ever misses one: the load path refuses
/// embedding models too, so a miss here costs a confusing entry in a picker,
/// not a broken chat.
///
/// ponytail: name match. Read the GGUF metadata if a model ever slips through.
pub fn is_embedding_model(name: &str) -> bool {
    let n = name.to_lowercase();
    ["bge", "e5-", "gte-", "embed", "minilm", "nomic-embed", "all-mpnet"]
        .iter()
        .any(|m| n.contains(m))
}

pub(crate) fn parse_quant(name: &str) -> Option<String> {
    let upper = name.to_uppercase();
    for q in ["Q2_K", "Q3_K", "Q4_0", "Q4_K_M", "Q4_K_S", "Q5_0", "Q5_K_M", "Q6_K", "Q8_0", "F16", "F32"] {
        if upper.contains(q) {
            return Some(q.to_string());
        }
    }
    None
}

fn load_modelfile(gguf_path: &Path) -> Option<Modelfile> {
    let mf = gguf_path.with_extension("feral");
    let bytes = std::fs::read(&mf).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn delete_model(path: &Path) -> Result<()> {
    if path.exists() {
        remove_file_with_retry(path)?;
    }
    let mf = path.with_extension("feral");
    if mf.exists() {
        let _ = remove_file_with_retry(&mf);
    }
    Ok(())
}

/// Delete a file, retrying on Windows ERROR_SHARING_VIOLATION (os error 32).
///
/// A failed `llama_load_model_from_file` call can leave a memory-mapped handle
/// open on Windows. llama.cpp's C++ cleanup is correct but asynchronous —
/// the OS releases the mapping a few hundred ms after the Rust error returns.
/// Retrying with backoff lets that window close without requiring an app restart.
/// On a slow or contended disk (or right after a failed 9B-class load) the
/// original 200/500/1000 ms schedule wasn't always enough — bumped to
/// 500/1000/2000/3000 ms (6.5 s cumulative) so this rarely needs a restart.
fn remove_file_with_retry(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // os error 32 = ERROR_SHARING_VIOLATION on Windows
            #[cfg(windows)]
            if e.raw_os_error() == Some(32) {
                for delay_ms in [500u64, 1000, 2000, 3000] {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    match std::fs::remove_file(path) {
                        Ok(()) => return Ok(()),
                        Err(retry_err) if retry_err.raw_os_error() == Some(32) => continue,
                        Err(retry_err) => return Err(retry_err.into()),
                    }
                }
                return Err(anyhow::anyhow!(
                    "File is still locked after ~7 s of retries. \
                     Restart the app and try again — this happens when a model \
                     failed to load and Windows has not yet released the file handle."
                ));
            }
            Err(e.into())
        }
    }
}

/// Download a GGUF model from HuggingFace. Streams progress (0.0..=1.0).
/// Respects `cancel` flag — on cancellation, the partial `.part` file is removed
/// and an error is returned. Progress is throttled at the source to per-percent.
pub async fn download_hf_model(
    repo_id: String,
    filename: String,
    progress: Sender<f32>,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    download_hf_model_to(repo_id, filename, paths::models_dir(), progress, cancel).await
}

/// Like [`download_hf_model`] but writes into `dest_dir` (e.g. the whisper dir
/// for STT models) instead of the LLM models dir. The temp file is the final
/// name plus `.part`, so it works for any extension (`.gguf`, `.bin`, …).
pub async fn download_hf_model_to(
    repo_id: String,
    filename: String,
    dest_dir: PathBuf,
    progress: Sender<f32>,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    // `filename` comes from the caller — ultimately from the webview — and was
    // joined onto the models dir unchecked, so `safe/../../.ssh/authorized_keys`
    // normalised its way clean out of it and the download wrote wherever the
    // process could. Subdirectories stay legal (a sharded repo really does keep
    // its GGUF one level down); escaping the destination does not.
    std::fs::create_dir_all(&dest_dir)?;
    let dest = crate::rsi::paths::safe_join(&dest_dir, Path::new(&filename))
        .with_context(|| format!("refusing to download to '{filename}'"))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    download_hf_file_as(repo_id, filename, dest, progress, cancel).await
}

/// Like [`download_hf_model_to`] but the file lands at `dest`, whatever the repo
/// happens to call it.
///
/// The two are not always the same. A community Piper voice lives at
/// `voices/raluca/ro_RO-raluca-high.onnx` in its own repo, but on disk every
/// voice sits at `<lang>/<locale>/<name>/<quality>/` regardless of where it came
/// from — one layout the loader can rely on, instead of one per upstream.
pub async fn download_hf_file_as(
    repo_id: String,
    filename: String,
    dest: PathBuf,
    progress: Sender<f32>,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    paths::ensure_dirs()?;
    // The final name plus `.part`, so it works for any extension — and built by
    // appending to the whole path, not via `with_file_name`, which reads a
    // `filename` containing slashes as a fresh relative path and buried the temp
    // file under a duplicate of the directory tree.
    let tmp = {
        let mut p = dest.clone().into_os_string();
        p.push(".part");
        PathBuf::from(p)
    };

    // Cleanup helper — runs on every exit path (cancel, error, success-on-rename-fail)
    let cleanup_tmp = |tmp: &Path| {
        if tmp.exists() {
            let _ = std::fs::remove_file(tmp);
        }
    };

    let url = format!(
        "https://huggingface.co/{}/resolve/main/{}",
        repo_id, filename
    );

    let client = reqwest::Client::builder()
        .user_agent("feral/0.1")
        .timeout(std::time::Duration::from_secs(60 * 60))
        .build()
        .with_context(|| "build reqwest client")?;

    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => return Err(anyhow!("network: {}", e)),
    };
    let resp = match resp.error_for_status() {
        Ok(r) => r,
        Err(e) => return Err(anyhow!("HTTP {}: {}", e.status().map(|s| s.as_u16()).unwrap_or(0), e)),
    };

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut last_emitted_percent: u64 = 0;

    if let Some(parent) = tmp.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create dir {:?}", parent))?;
    }

    let mut file = tokio::fs::File::create(&tmp)
        .await
        .with_context(|| format!("create {:?}", tmp))?;

    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            cleanup_tmp(&tmp);
            return Err(anyhow!("Download cancelled"));
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                cleanup_tmp(&tmp);
                return Err(anyhow!("stream error: {}", e));
            }
        };
        if let Err(e) = file.write_all(&chunk).await {
            drop(file);
            cleanup_tmp(&tmp);
            return Err(anyhow!("disk write: {}", e));
        }
        downloaded += chunk.len() as u64;

        if total > 0 {
            let pct = (downloaded * 100) / total;
            if pct > last_emitted_percent {
                last_emitted_percent = pct;
                let _ = progress.send(pct as f32 / 100.0).await;
            }
        }
    }

    if let Err(e) = file.flush().await {
        cleanup_tmp(&tmp);
        return Err(anyhow!("flush: {}", e));
    }
    drop(file);

    if let Err(e) = tokio::fs::rename(&tmp, &dest).await {
        cleanup_tmp(&tmp);
        return Err(anyhow!("rename {:?} → {:?}: {}", tmp, dest, e));
    }
    let _ = progress.send(1.0).await;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_quant_detects_known_quants() {
        let cases = vec![
            ("model.Q4_K_M.gguf", "Q4_K_M"),
            ("model.Q6_K.gguf", "Q6_K"),
            ("model.Q8_0.gguf", "Q8_0"),
            ("model.Q2_K.gguf", "Q2_K"),
            ("model.F16.gguf", "F16"),
            ("model.q4_k_m.gguf", "Q4_K_M"), // lowercase input
        ];
        for (name, expected) in cases {
            assert_eq!(parse_quant(name).as_deref(), Some(expected), "failed for: {}", name);
        }
    }

    #[test]
    fn parse_quant_ministral_real_filename() {
        let result = parse_quant("Ministral-3-3B-Reasoning-2512.Q6_K.gguf");
        assert_eq!(result.as_deref(), Some("Q6_K"));
    }

    #[test]
    fn parse_quant_returns_none_for_unknown() {
        assert!(parse_quant("some-model-no-quant.gguf").is_none());
        assert!(parse_quant("model.gguf").is_none());
    }

    #[test]
    fn parse_quant_prefers_first_match() {
        // Q4_K_M should be found before Q4_K_S in the list
        let result = parse_quant("model.Q4_K_M.gguf");
        assert_eq!(result.as_deref(), Some("Q4_K_M"));
    }

    #[test]
    fn embedding_models_are_not_chat_models() {
        // The one that actually shipped on every machine and broke a session.
        assert!(is_embedding_model("bge-m3-Q8_0.gguf"));
        assert!(is_embedding_model("nomic-embed-text-v1.5.gguf"));
        assert!(is_embedding_model("all-MiniLM-L6-v2.gguf"));
        // Real chat models must survive, including one carrying a capital E.
        assert!(!is_embedding_model("Qwen3.8-4B-Q6_K.gguf"));
        assert!(!is_embedding_model("Meta-Llama-3-8B-Instruct.Q4_K_M.gguf"));
    }
}
