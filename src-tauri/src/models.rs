use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc::Sender;

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub quant: Option<String>,
    pub ctx_len: Option<u32>,
    pub loaded: bool,
    pub modelfile: Option<Modelfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
            out.push(ModelInfo {
                id: name.clone(),
                name,
                path: path.clone(),
                size_bytes: meta.len(),
                quant,
                ctx_len: modelfile.as_ref().and_then(|m| m.ctx_len),
                loaded: false,
                modelfile,
            });
        }
    }
    Ok(out)
}

fn parse_quant(name: &str) -> Option<String> {
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
        std::fs::remove_file(path)?;
    }
    let mf = path.with_extension("feral");
    if mf.exists() {
        let _ = std::fs::remove_file(mf);
    }
    Ok(())
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
    paths::ensure_dirs()?;
    let dest = paths::models_dir().join(&filename);
    let tmp = dest.with_extension("gguf.part");

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
    let mut last_pct: i32 = -1;

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
            let pct = ((downloaded * 100) / total) as i32;
            if pct != last_pct {
                last_pct = pct;
                let _ = progress.send(downloaded as f32 / total as f32).await;
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
