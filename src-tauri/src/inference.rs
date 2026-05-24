use anyhow::Result;
use async_stream::stream;
use futures::Stream;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferParams {
    pub temperature: f32,
    pub top_p: f32,
    pub repeat_penalty: f32,
    pub max_tokens: u32,
    pub system_prompt: Option<String>,
}

impl Default for InferParams {
    fn default() -> Self {
        Self {
            temperature: 0.8,
            top_p: 0.95,
            repeat_penalty: 1.1,
            max_tokens: 1024,
            system_prompt: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedModel {
    pub path: PathBuf,
    pub name: String,
    pub ctx_len: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
    pub name: String,
    pub vram_mb: u64,
    pub supports_vulkan: bool,
}

/// Detect available GPU. Best-effort — uses sysinfo + heuristic.
/// Real GPU probe would call into Vulkan / DXGI; we keep this minimal.
pub fn detect_gpu() -> GpuInfo {
    // Heuristic: on Windows, assume Vulkan-capable AMD/NVIDIA if present.
    GpuInfo {
        name: "Unknown GPU".into(),
        vram_mb: 0,
        supports_vulkan: cfg!(target_os = "windows") || cfg!(target_os = "linux"),
    }
}

/// Model manager — holds at most one loaded model.
#[derive(Default)]
pub struct ModelManager {
    pub current: Arc<Mutex<Option<LoadedModel>>>,
}

impl ModelManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load(&self, path: PathBuf) -> Result<LoadedModel> {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("model")
            .to_string();

        #[cfg(feature = "inference")]
        let ctx_len = backend::load(&path)?;
        #[cfg(not(feature = "inference"))]
        let ctx_len = 4096u32;

        let loaded = LoadedModel { path, name, ctx_len };
        *self.current.lock() = Some(loaded.clone());
        Ok(loaded)
    }

    pub fn unload(&self) {
        #[cfg(feature = "inference")]
        backend::unload();
        *self.current.lock() = None;
    }

    pub fn current(&self) -> Option<LoadedModel> {
        self.current.lock().clone()
    }

    /// Stream chat completion. Yields token strings.
    pub fn stream_chat(
        &self,
        messages: Vec<Message>,
        params: InferParams,
    ) -> impl Stream<Item = Result<String>> + Send + 'static {
        let _loaded = self.current.lock().clone();
        stream! {
            #[cfg(feature = "inference")]
            {
                if _loaded.is_none() {
                    yield Err(anyhow::anyhow!("no model loaded"));
                    return;
                }
                let mut rx = backend::generate(messages, params);
                while let Some(tok) = rx.recv().await {
                    yield Ok(tok);
                }
            }
            #[cfg(not(feature = "inference"))]
            {
                // Stub: echo a canned response token-by-token so the UI works
                // without the inference feature.
                let prompt = messages.last().map(|m| m.content.clone()).unwrap_or_default();
                let _ = params;
                let reply = format!(
                    "[feral stub — build with `--features inference` for real generation] You said: {}",
                    prompt.chars().take(200).collect::<String>()
                );
                for word in reply.split_inclusive(' ') {
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    yield Ok(word.to_string());
                }
            }
        }
    }
}

#[cfg(feature = "inference")]
mod backend {
    //! Real backend wiring goes here. Kept thin so the project compiles
    //! without the C++ toolchain on first checkout.
    use super::{InferParams, Message};
    use anyhow::Result;
    use std::path::Path;
    use tokio::sync::mpsc;

    pub fn load(_path: &Path) -> Result<u32> {
        // TODO: initialize LlamaModel via llama-cpp-2; return context length.
        Ok(4096)
    }

    pub fn unload() {}

    pub fn generate(_messages: Vec<Message>, _params: InferParams) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel(64);
        tokio::spawn(async move {
            let _ = tx.send("[inference backend not yet wired]".into()).await;
        });
        rx
    }
}
