use anyhow::Result;
use async_stream::stream;
use futures::Stream;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct InferParams {
    pub temperature: f32,
    pub top_p: f32,
    pub repeat_penalty: f32,
    pub max_tokens: u32,
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
}

impl Default for InferParams {
    fn default() -> Self {
        Self {
            temperature: 0.8,
            top_p: 0.95,
            repeat_penalty: 1.1,
            max_tokens: 1024,
            system_prompt: None,
            tools: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
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

/// Detect available GPU using platform-native APIs.
pub fn detect_gpu() -> GpuInfo {
    crate::gpu_detect::detect()
}

// ── Template detection & prompt building ─────────────────────────────────────
// These are pure string functions — no llama.cpp dependency, always compiled.

pub(crate) fn detect_template(name: &str) -> &'static str {
    let low = name.to_lowercase();
    if low.contains("llama-3") || low.contains("llama3") || low.contains("llama_3")
        || low.contains("meta-llama")
    {
        "llama3"
    } else if low.contains("mistral") || low.contains("mixtral") || low.contains("ministral") {
        "mistral"
    } else if low.contains("gemma") {
        "gemma"
    } else {
        // ChatML covers Qwen (all versions), Phi-3, ChatGLM, DeepSeek, and most finetunes.
        "chatml"
    }
}

const MARKDOWN_DIRECTIVE: &str = "Always respond using clean, valid Markdown. \
Use standard syntax for headings, bold, italic, and lists. \
For source code, always use fenced code blocks with the language specified (e.g. ```rust, ```python, ```bash). \
Never return raw HTML tags in your answer.";

pub(crate) fn build_prompt(messages: &[Message], model_name: &str) -> String {
    // Strip any trailing empty assistant placeholder the UI may have left in the list.
    // An empty assistant turn confuses models: they see a completed (empty) turn and
    // immediately sample an EOG token, producing no output.
    let messages: Vec<&Message> = messages.iter()
        .filter(|m| !(m.role == "assistant" && m.content.trim().is_empty()))
        .collect();

    // Build an augmented message list: inject/prepend the Markdown formatting directive
    // into the system message (or create one) so all models respond in valid Markdown.
    let has_system = messages.iter().any(|m| m.role == "system");
    let augmented: Vec<Message>;
    let messages: Vec<&Message> = if has_system {
        augmented = messages.iter().map(|m| {
            if m.role == "system" {
                Message {
                    role: "system".into(),
                    content: format!("{}\n\n{}", MARKDOWN_DIRECTIVE, m.content),
                }
            } else {
                (*m).clone()
            }
        }).collect();
        augmented.iter().collect()
    } else {
        let synthetic = Message { role: "system".into(), content: MARKDOWN_DIRECTIVE.into() };
        augmented = std::iter::once(synthetic)
            .chain(messages.iter().map(|m| (*m).clone()))
            .collect();
        augmented.iter().collect()
    };

    match detect_template(model_name) {
        "llama3" => {
            let mut s = String::new();
            for m in &messages {
                s.push_str(&format!(
                    "<|start_header_id|>{}<|end_header_id|>\n\n{}<|eot_id|>",
                    m.role, m.content
                ));
            }
            s.push_str("<|start_header_id|>assistant<|end_header_id|>\n\n");
            s
        }
        "mistral" => {
            let mut s = String::new();
            let mut pending_user = String::new();
            for m in &messages {
                match m.role.as_str() {
                    "system" => pending_user.push_str(&format!("{}\n\n", m.content)),
                    "user" => {
                        pending_user.push_str(&m.content);
                        s.push_str(&format!("[INST] {} [/INST]", pending_user.trim()));
                        pending_user.clear();
                    }
                    "assistant" => s.push_str(&format!(" {} </s>", m.content)),
                    _ => {}
                }
            }
            s
        }
        "gemma" => {
            let mut s = String::new();
            for m in &messages {
                match m.role.as_str() {
                    "user" | "system" => {
                        s.push_str(&format!("<start_of_turn>user\n{}<end_of_turn>\n", m.content));
                    }
                    "assistant" => {
                        s.push_str(&format!("<start_of_turn>model\n{}<end_of_turn>\n", m.content));
                    }
                    _ => {}
                }
            }
            s.push_str("<start_of_turn>model\n");
            s
        }
        _ => {
            // ChatML — Qwen (all versions), Phi-3, ChatGLM, DeepSeek, etc.
            let mut s = String::new();
            for m in &messages {
                s.push_str(&format!("<|im_start|>{}\n{}<|im_end|>\n", m.role, m.content));
            }
            s.push_str("<|im_start|>assistant\n");
            s
        }
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

    pub fn load(&self, path: PathBuf, n_gpu_layers: i32) -> Result<LoadedModel> {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("model")
            .to_string();

        #[cfg(feature = "inference")]
        let ctx_len = backend::load(&path, n_gpu_layers)?;
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
    /// `stop` is checked between tokens — set it to `true` to interrupt generation.
    /// `on_start` is called once with the real prompt token count right before generation begins.
    pub fn stream_chat(
        &self,
        messages: Vec<Message>,
        params: InferParams,
        stop: Arc<AtomicBool>,
        on_start: Option<Box<dyn Fn(u32) + Send + 'static>>,
    ) -> impl Stream<Item = Result<String>> + Send + 'static {
        let _loaded = self.current.lock().clone();
        stream! {
            #[cfg(feature = "inference")]
            {
                if _loaded.is_none() {
                    yield Err(anyhow::anyhow!("no model loaded"));
                    return;
                }
                let mut rx = backend::generate(messages, params, stop.clone(), on_start);
                while let Some(tok) = rx.recv().await {
                    if stop.load(Ordering::Relaxed) { break; }
                    yield Ok(tok);
                }
            }
            #[cfg(not(feature = "inference"))]
            {
                let prompt = messages.last().map(|m| m.content.clone()).unwrap_or_default();
                let _ = (params, on_start);
                let reply = format!(
                    "[feral stub — build with `--features inference` for real generation] You said: {}",
                    prompt.chars().take(200).collect::<String>()
                );
                for word in reply.split_inclusive(' ') {
                    if stop.load(Ordering::Relaxed) { break; }
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    yield Ok(word.to_string());
                }
            }
        }
    }
}

#[cfg(feature = "inference")]
mod backend {
    use super::{InferParams, Message};
    use anyhow::{anyhow, Result};
    use encoding_rs::UTF_8;
    use llama_cpp_2::{
        context::params::LlamaContextParams,
        llama_backend::LlamaBackend,
        llama_batch::LlamaBatch,
        model::{params::LlamaModelParams, AddBos, LlamaModel},
        sampling::LlamaSampler,
    };
    use once_cell::sync::{Lazy, OnceCell};
    use parking_lot::Mutex;
    use std::num::NonZeroU32;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tokio::sync::mpsc;

    // LlamaBackend lives for the app lifetime — initialized once.
    static BACKEND: OnceCell<LlamaBackend> = OnceCell::new();

    // Wrap LlamaModel in a newtype so we can assert Send+Sync.
    // llama_model* is safe to use from multiple threads as long as we
    // don't run concurrent inference (enforced by the Mutex below).
    struct ModelHandle {
        model: LlamaModel,
        name: String,
    }
    unsafe impl Send for ModelHandle {}
    unsafe impl Sync for ModelHandle {}

    static MODEL: Lazy<Mutex<Option<ModelHandle>>> = Lazy::new(|| Mutex::new(None));

    pub fn load(path: &Path, n_gpu_layers: i32) -> Result<u32> {
        let backend = BACKEND.get_or_try_init(|| {
            LlamaBackend::init().map_err(|e| anyhow!("llama backend init: {}", e))
        })?;

        // GPU layers set via Settings; -1 means auto (llama.cpp default)
        let model_params = if n_gpu_layers >= 0 {
            LlamaModelParams::default().with_n_gpu_layers(n_gpu_layers as u32)
        } else {
            LlamaModelParams::default()
        };
        let model = LlamaModel::load_from_file(backend, path, &model_params)
            .map_err(|e| anyhow!("load {:?}: {}", path, e))?;

        let ctx_len = model.n_ctx_train().max(2048);
        let name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        tracing::info!(path=?path, ctx_len, template=%detect_template(&name), "model loaded");
        *MODEL.lock() = Some(ModelHandle { model, name });
        Ok(ctx_len)
    }

    pub fn unload() {
        *MODEL.lock() = None;
        tracing::info!("model unloaded");
    }

    fn detect_template(name: &str) -> &'static str { super::detect_template(name) }
    fn build_prompt(messages: &[Message], model_name: &str) -> String { super::build_prompt(messages, model_name) }

    pub fn generate(
        messages: Vec<Message>,
        params: InferParams,
        stop: Arc<AtomicBool>,
        on_start: Option<Box<dyn Fn(u32) + Send + 'static>>,
    ) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel(256);
        tokio::task::spawn_blocking(move || {
            if let Err(e) = run_inference(&messages, &params, &tx, &stop, on_start.as_deref()) {
                tracing::error!("inference: {}", e);
                let _ = tx.blocking_send(format!("\n[Error: {}]", e));
            }
        });
        rx
    }

    fn run_inference(
        messages: &[Message],
        params: &InferParams,
        tx: &mpsc::Sender<String>,
        stop: &Arc<AtomicBool>,
        on_start: Option<&(dyn Fn(u32) + Send)>,
    ) -> Result<()> {
        let backend = BACKEND.get().ok_or_else(|| anyhow!("backend not initialized"))?;

        let guard = MODEL.lock();
        let handle = guard.as_ref().ok_or_else(|| anyhow!("no model loaded"))?;
        let model = &handle.model;
        let template = detect_template(&handle.name);
        let prompt = build_prompt(messages, &handle.name);
        // Tokenize template-specific stop strings as a fallback for models whose GGUF
        // metadata doesn't mark them as EOG tokens (common in finetunes/merges).
        let extra_stop_tokens: Vec<llama_cpp_2::token::LlamaToken> = {
            let stop_strs: &[&str] = match template {
                "llama3"  => &["<|eot_id|>", "<|end_of_text|>"],
                "mistral" => &["</s>"],
                "gemma"   => &["<end_of_turn>"],
                _         => &["<|im_end|>", "<|endoftext|>"],
            };
            stop_strs.iter()
                .flat_map(|s| model.str_to_token(s, AddBos::Never).unwrap_or_default())
                .collect()
        };
        let tokens = model
            .str_to_token(&prompt, AddBos::Always)
            .map_err(|e| anyhow!("tokenize: {}", e))?;

        let n_prompt = tokens.len();
        if n_prompt == 0 {
            return Err(anyhow!("empty token list after tokenization"));
        }
        if let Some(cb) = on_start {
            cb(n_prompt as u32);
        }

        let ctx_size = NonZeroU32::new(
            (n_prompt as u32 + params.max_tokens + 8).min(model.n_ctx_train()),
        )
        .unwrap_or(NonZeroU32::new(4096).unwrap());

        let ctx_params = LlamaContextParams::default().with_n_ctx(Some(ctx_size));
        let mut ctx = model
            .new_context(backend, ctx_params)
            .map_err(|e| anyhow!("create context: {}", e))?;

        // Prefill in chunks. A single decode of all prompt tokens trips
        // `GGML_ASSERT(n_tokens_all <= cparams.n_batch)` (default n_batch = 2048)
        // for long prompts — notably agent runs whose tool-calling system prompt
        // can exceed 2048 tokens. Chunking keeps every decode within n_batch and
        // bounds the compute buffer regardless of prompt length.
        const PREFILL_CHUNK: usize = 512;
        let mut batch = LlamaBatch::new(PREFILL_CHUNK, 1);
        let mut start = 0usize;
        while start < n_prompt {
            let end = (start + PREFILL_CHUNK).min(n_prompt);
            batch.clear();
            // `i` is the absolute token position (used for both indexing and the
            // logits flag), so a range loop is clearer than iterating the slice.
            #[allow(clippy::needless_range_loop)]
            for i in start..end {
                // Only the final token of the whole prompt needs logits.
                let want_logits = i == n_prompt - 1;
                batch
                    .add(tokens[i], i as i32, &[0], want_logits)
                    .map_err(|e| anyhow!("batch add (prefill): {}", e))?;
            }
            ctx.decode(&mut batch)
                .map_err(|e| anyhow!("decode prefill: {}", e))?;
            start = end;
        }

        // Sampler chain: penalties → top-k → top-p → temperature → random dist.
        // Order matters: penalties first (reshape logits), then truncation samplers
        // (top_k/top_p), then temperature shaping, then final sampling.
        //
        // `params.repeat_penalty` was previously unused — leaving it disconnected
        // caused small models (e.g. Llama-3.2-1B) to spiral into word-salad after
        // ~100 tokens at temp >= 0.7.
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(1234);
        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::penalties(64, params.repeat_penalty, 0.0, 0.0),
            LlamaSampler::top_k(40),
            LlamaSampler::top_p(params.top_p, 1),
            LlamaSampler::temp(params.temperature),
            LlamaSampler::dist(seed),
        ]);

        let mut n_cur = n_prompt as i32;
        let max_new = params.max_tokens as i32;
        // Reuse a single decoder across tokens so multi-byte UTF-8 sequences
        // that span token boundaries are assembled correctly.
        let mut piece_decoder = UTF_8.new_decoder();

        loop {
            if stop.load(Ordering::Relaxed) { break; }

            let token = sampler.sample(&ctx, -1);
            sampler.accept(token);

            if model.is_eog_token(token)
                || extra_stop_tokens.contains(&token)
                || (n_cur - n_prompt as i32) >= max_new
            {
                break;
            }

            let s = model
                .token_to_piece(token, &mut piece_decoder, false, None)
                .unwrap_or_default();

            if tx.blocking_send(s).is_err() {
                break; // frontend disconnected / cancelled
            }

            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .map_err(|e| anyhow!("batch add (gen): {}", e))?;
            ctx.decode(&mut batch)
                .map_err(|e| anyhow!("decode gen: {}", e))?;
            n_cur += 1;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── detect_template ───────────────────────────────────────────────────────

    #[test]
    fn template_llama3_variants() {
        for name in &[
            "Meta-Llama-3-8B-Instruct.Q4_K_M.gguf",
            "llama3-70b.gguf",
            "llama_3_8b.gguf",
            "meta-llama-3.1-8b-instruct.Q5_K_M.gguf",
        ] {
            assert_eq!(detect_template(name), "llama3", "failed for: {}", name);
        }
    }

    #[test]
    fn template_mistral_variants() {
        for name in &[
            "Mistral-7B-Instruct-v0.3.Q4_K_M.gguf",
            "mixtral-8x7b-instruct-v0.1.Q4_K_M.gguf",
            "Mistral-Nemo-Instruct-2407.Q6_K.gguf",
        ] {
            assert_eq!(detect_template(name), "mistral", "failed for: {}", name);
        }
    }

    #[test]
    fn template_ministral_is_mistral_not_chatml() {
        // "ministral" does NOT contain "mistral" as substring — this was the bug.
        assert!("ministral".contains("mistral") == false, "substring check changed");
        assert_eq!(detect_template("Ministral-3-3B-Reasoning-2512.Q6_K.gguf"), "mistral");
        assert_eq!(detect_template("ministral-8b-instruct.gguf"), "mistral");
    }

    #[test]
    fn template_gemma() {
        assert_eq!(detect_template("gemma-2-9b-it-Q4_K_M.gguf"), "gemma");
        assert_eq!(detect_template("gemma-7b-it.gguf"), "gemma");
    }

    #[test]
    fn template_chatml_fallback() {
        for name in &[
            "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
            "Phi-3-mini-4k-instruct-q4.gguf",
            "ChatGLM3-6b.gguf",
            "unknown-model.gguf",
        ] {
            assert_eq!(detect_template(name), "chatml", "failed for: {}", name);
        }
    }

    #[test]
    fn template_detection_is_case_insensitive() {
        assert_eq!(detect_template("LLAMA-3-8B.gguf"), "llama3");
        assert_eq!(detect_template("MISTRAL-7B.gguf"), "mistral");
        assert_eq!(detect_template("MINISTRAL-3B.gguf"), "mistral");
        assert_eq!(detect_template("GEMMA-7B.gguf"), "gemma");
    }

    // ── build_prompt ──────────────────────────────────────────────────────────

    fn msg(role: &str, content: &str) -> Message {
        Message { role: role.into(), content: content.into() }
    }

    #[test]
    fn prompt_llama3_contains_header_tags() {
        let msgs = vec![msg("user", "Hello")];
        let p = build_prompt(&msgs, "meta-llama-3.1-8b.gguf");
        assert!(p.contains("<|start_header_id|>user<|end_header_id|>"));
        assert!(p.contains("Hello<|eot_id|>"));
        assert!(p.ends_with("<|start_header_id|>assistant<|end_header_id|>\n\n"));
    }

    #[test]
    fn prompt_mistral_uses_inst_tags() {
        let msgs = vec![msg("user", "Hello")];
        let p = build_prompt(&msgs, "Mistral-7B-Instruct.gguf");
        assert!(p.contains("[INST]"), "missing [INST]");
        assert!(p.contains("[/INST]"), "missing [/INST]");
        assert!(p.contains("Hello"));
    }

    #[test]
    fn prompt_ministral_uses_inst_tags_not_chatml() {
        let msgs = vec![msg("user", "Salut")];
        let p = build_prompt(&msgs, "Ministral-3-3B-Reasoning-2512.Q6_K.gguf");
        assert!(p.contains("[INST]"), "Ministral should use [INST], not <|im_start|>");
        assert!(!p.contains("<|im_start|>"), "Ministral must NOT use ChatML format");
    }

    #[test]
    fn prompt_mistral_system_prepended_to_first_user() {
        let msgs = vec![msg("system", "Be concise."), msg("user", "Hi")];
        let p = build_prompt(&msgs, "Mistral-7B.gguf");
        assert!(p.contains("Be concise."));
        assert!(p.contains("Hi"));
        // System content should appear before [/INST], not as a separate turn
        let inst_pos = p.find("[INST]").unwrap();
        let sys_pos = p.find("Be concise.").unwrap();
        assert!(sys_pos > inst_pos, "system content should be inside [INST] block");
    }

    #[test]
    fn prompt_chatml_uses_im_tags() {
        let msgs = vec![msg("user", "Hello")];
        let p = build_prompt(&msgs, "Qwen2.5-7B.gguf");
        assert!(p.contains("<|im_start|>user"));
        assert!(p.contains("<|im_end|>"));
        assert!(p.ends_with("<|im_start|>assistant\n"));
    }

    #[test]
    fn prompt_gemma_uses_turn_tags() {
        let msgs = vec![msg("user", "Hello")];
        let p = build_prompt(&msgs, "gemma-7b-it.gguf");
        assert!(p.contains("<start_of_turn>user"));
        assert!(p.contains("<end_of_turn>"));
        assert!(p.ends_with("<start_of_turn>model\n"));
    }

    // ── InferParams defaults ──────────────────────────────────────────────────

    #[test]
    fn infer_params_defaults_are_sensible() {
        let p = InferParams::default();
        assert!(p.temperature > 0.0 && p.temperature <= 2.0);
        assert!(p.top_p > 0.0 && p.top_p <= 1.0);
        assert!(p.repeat_penalty >= 1.0);
        assert!(p.max_tokens >= 128);
        assert!(p.system_prompt.is_none());
    }

    // ── ModelManager state ────────────────────────────────────────────────────

    #[test]
    fn model_manager_starts_empty() {
        let m = ModelManager::new();
        assert!(m.current().is_none());
    }

    #[test]
    fn model_manager_name_extraction() {
        // Verify the PathBuf→name logic used in load()
        let path = std::path::PathBuf::from("/models/Ministral-3-3B.Q6_K.gguf");
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("model").to_string();
        assert_eq!(name, "Ministral-3-3B.Q6_K.gguf");
    }
}
