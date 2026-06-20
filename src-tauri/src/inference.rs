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
    /// Image attachments as data URLs (`data:image/png;base64,...`).
    /// Consumed by the cloud path (serialized as OpenAI `image_url` content
    /// parts); the local llama.cpp path is text-only and ignores them — the
    /// "[Image attached: name]" note in `content` still describes the upload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
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
    /// Optional GBNF grammar that constrains sampling (tool-call decoding).
    /// When set, a grammar sampler is prepended to the chain so the model can
    /// only emit tokens the grammar allows. `None` = unconstrained (default).
    #[serde(default)]
    pub grammar: Option<String>,
    /// Optional trigger strings for *lazy* grammar enforcement. When present,
    /// the grammar stays dormant until one of these appears in the output
    /// (e.g. the opening of a tool-call fence), so free-text answers are never
    /// constrained — only the structured tool call that follows a trigger is.
    /// Empty/None with a `grammar` set means the grammar applies from the
    /// first token (hard constraint).
    #[serde(default)]
    pub grammar_triggers: Option<Vec<String>>,
    /// P1 (prompt caching): session id from the caller. Currently used for
    /// audit/logging only — contexts are drawn from a small pool (P6) and
    /// each keeps its own KV prefix-diff record, but there is no session →
    /// context affinity yet. The field is plumbed here so a future
    /// session-affinity strategy (route a session back to the context that
    /// holds its prefix) can be added without another breaking schema change.
    #[serde(default)]
    pub session_id: Option<String>,
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
            grammar: None,
            grammar_triggers: None,
            session_id: None,
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

/// Shared message pre-processing for BOTH prompt-building paths (the GGUF
/// chat template and the filename-heuristic fallback):
///   1. Strip any trailing empty assistant placeholder the UI may have left
///      in the list. An empty assistant turn confuses models: they see a
///      completed (empty) turn and immediately sample an EOG token.
///   2. Inject/prepend the Markdown formatting directive into the system
///      message (or create one) so all models respond in valid Markdown.
pub(crate) fn augment_messages(messages: &[Message]) -> Vec<Message> {
    let filtered: Vec<&Message> = messages.iter()
        .filter(|m| !(m.role == "assistant" && m.content.trim().is_empty()))
        .collect();

    let has_system = filtered.iter().any(|m| m.role == "system");
    if has_system {
        filtered.iter().map(|m| {
            if m.role == "system" {
                Message {
                    role: "system".into(),
                    content: format!("{}\n\n{}", MARKDOWN_DIRECTIVE, m.content),
                    images: None,
                }
            } else {
                (*m).clone()
            }
        }).collect()
    } else {
        let synthetic = Message { role: "system".into(), content: MARKDOWN_DIRECTIVE.into(), images: None };
        std::iter::once(synthetic)
            .chain(filtered.iter().map(|m| (*m).clone()))
            .collect()
    }
}

pub(crate) fn build_prompt(messages: &[Message], model_name: &str) -> String {
    let augmented = augment_messages(messages);
    let messages: Vec<&Message> = augmented.iter().collect();

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

    /// Count tokens for `text` with the loaded model's real tokenizer (P3).
    /// Backs the `/tokenize` HTTP endpoint the agent sidecar calls for
    /// accurate context accounting — its GPT-2 BPE fallback miscounts other
    /// vocabularies. Errors when no model is loaded.
    pub fn count_tokens(&self, text: &str) -> Result<usize> {
        #[cfg(feature = "inference")]
        {
            backend::count_tokens(text)
        }
        #[cfg(not(feature = "inference"))]
        {
            // Stub build: the chars/4 heuristic the frontend already uses.
            Ok(text.chars().count().div_ceil(4))
        }
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
                    yield Ok(word);
                }
            }
        }
    }
}

/// Embed a batch of texts into L2-normalized vectors with the dedicated
/// embedding model (separate from the chat model in STATE). Blocking/CPU-bound
/// — async callers MUST wrap this in `spawn_blocking`. Returns one unit vector
/// per input, in input order. Errors when no embedding model is available, so
/// the caller can fall back to lexical/exact retrieval (the Tier-3 leaf layer).
pub fn embed_text(texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
    #[cfg(feature = "inference")]
    {
        backend::embed_batch(&texts)
    }
    #[cfg(not(feature = "inference"))]
    {
        let _ = texts;
        Err(anyhow::anyhow!(
            "embeddings require a build with --features inference"
        ))
    }
}

#[cfg(feature = "inference")]
mod backend {
    use super::{InferParams, Message};
    use anyhow::{anyhow, Result};
    use encoding_rs::UTF_8;
    use llama_cpp_2::{
        context::{
            params::{LlamaContextParams, LlamaPoolingType},
            LlamaContext,
        },
        llama_backend::LlamaBackend,
        llama_batch::LlamaBatch,
        model::{params::LlamaModelParams, AddBos, LlamaChatMessage, LlamaChatTemplate, LlamaModel},
        sampling::LlamaSampler,
        token::LlamaToken,
    };
    use once_cell::sync::{Lazy, OnceCell};
    use parking_lot::{Condvar, Mutex};
    use std::num::NonZeroU32;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tokio::sync::mpsc;

    // LlamaBackend lives for the app lifetime — initialized once.
    static BACKEND: OnceCell<LlamaBackend> = OnceCell::new();

    // ── P6: context pool — concurrent local inference ─────────────────────
    //
    // The old design held one global mutex around a single ModelHandle for
    // the ENTIRE generation, serializing the UI, the HTTP API server, and
    // the agent sidecar behind one another. The fixed design splits the
    // state in two:
    //
    //   * `LlamaModel` — loaded once, shared via `Arc`. The crate marks it
    //     Send + Sync (model.rs in llama_cpp_2); model weights are read-only
    //     during inference, so concurrent decodes against the same model
    //     from DIFFERENT contexts are safe (the standard llama.cpp
    //     multi-context pattern).
    //   * `LlamaContext` — one per in-flight generation, drawn from a pool.
    //     Each context owns its own KV cache and its own `cached_tokens`
    //     prefix-diff record (R1). Contexts are created lazily, up to
    //     `FERAL_MAX_LOCAL_CONTEXTS` (default 2): a single-user workload
    //     pays for one context's KV memory; the second is allocated only
    //     the first time two generations actually overlap. When the pool
    //     is exhausted, `acquire` blocks on a condvar until a context is
    //     returned — that is the only remaining serialization point.
    //
    // CPU note: two parallel decodes each use llama.cpp's default thread
    // count and will oversubscribe cores — throughput per request drops,
    // but neither request is blocked behind the other's full generation.
    //
    // KV-cache reuse (R1) is per-context and EXPLICIT, not automatic: raw
    // `llama_decode` performs no prefix matching (that is llama-server
    // logic), so `run_inference` diffs each new prompt against the
    // context's `cached_tokens`, evicts the divergent suffix with
    // `clear_kv_cache_seq`, and prefills only the new tail. Without that
    // eviction, re-decoding positions that already hold KV cells would
    // corrupt attention and leak cache slots.
    //
    // Self-referential layout (R2). `LlamaContext<'a>` holds a
    // `&'a LlamaModel`. Each pooled context stores that borrow as
    // `'static` (one `unsafe` transmute in `create_context`), made sound
    // by two invariants:
    //   1. The referent lives on the heap behind an `Arc<LlamaModel>`,
    //      whose address is stable across every move of the pool entry,
    //      and `_model` keeps the allocation alive for at least as long
    //      as this entry exists.
    //   2. Field drop order: `context` is declared FIRST → dropped FIRST;
    //      `_model` LAST → dropped LAST. The reference can never outlive
    //      the referent.
    struct PooledContext {
        // SAFETY: see the block comment above — morally a
        // `LlamaContext<'self>` borrowing the Arc heap data below.
        context: LlamaContext<'static>,
        /// R1: tokens currently materialized in THIS context's KV cache —
        /// the previous call's prompt plus everything it generated. Empty
        /// when the cache state is unknown (fresh context, or an error
        /// mid-call), which forces the next call to clear + fully
        /// re-prefill.
        cached_tokens: Vec<LlamaToken>,
        /// Keeps the model allocation alive for this context's lifetime.
        _model: Arc<LlamaModel>,
    }
    // SAFETY: a PooledContext is only ever used by one thread at a time —
    // it is moved out of the pool, used exclusively by that generation's
    // blocking task, and moved back. (Same assertion the old ModelHandle
    // made; `LlamaContext` itself is not auto-Send because it wraps a raw
    // pointer.)
    unsafe impl Send for PooledContext {}

    struct PoolInner {
        idle: Vec<PooledContext>,
        /// Total contexts in existence (idle + checked out). Never exceeds
        /// `ContextPool::max`.
        created: usize,
    }

    struct ContextPool {
        inner: Mutex<PoolInner>,
        /// Signaled whenever a context is returned (or a creation slot is
        /// given back after a failed allocation) so blocked `acquire`s
        /// can re-check.
        available: Condvar,
        max: usize,
    }

    impl ContextPool {
        /// Check out a context, creating one lazily if under the cap, or
        /// blocking until another generation returns one. Called from
        /// `spawn_blocking` threads only — blocking here is fine.
        fn acquire(&self, model: &Arc<LlamaModel>, ctx_len: u32) -> Result<PooledContext> {
            let mut inner = self.inner.lock();
            loop {
                if let Some(ctx) = inner.idle.pop() {
                    return Ok(ctx);
                }
                if inner.created < self.max {
                    // Reserve the slot, then build the context OUTSIDE the
                    // lock (KV allocation is slow). On failure, give the
                    // slot back and wake a waiter so it can retry/create.
                    inner.created += 1;
                    drop(inner);
                    match create_context(model, ctx_len) {
                        Ok(ctx) => return Ok(ctx),
                        Err(e) => {
                            let mut inner = self.inner.lock();
                            inner.created -= 1;
                            drop(inner);
                            self.available.notify_one();
                            return Err(e);
                        }
                    }
                }
                self.available.wait(&mut inner);
            }
        }

        /// Return a context to the pool and wake one waiter.
        fn release(&self, ctx: PooledContext) {
            self.inner.lock().idle.push(ctx);
            self.available.notify_one();
        }
    }

    /// Everything tied to the currently loaded model. `generate` snapshots
    /// an `Arc` of this and releases the global STATE lock immediately, so
    /// load/unload never block behind a running generation and generations
    /// never block behind each other (except in the pool, by design).
    /// In-flight generations on an unloaded model finish on their own Arc;
    /// the model and its contexts are freed when the last Arc drops.
    struct LoadedState {
        name: String,
        ctx_len: u32,
        model: Arc<LlamaModel>,
        pool: ContextPool,
        /// A4: the chat template baked into the GGUF metadata
        /// (`tokenizer.chat_template`), read once at load. When present it is
        /// the authoritative prompt format — a renamed file no longer gets a
        /// wrong template guessed from its filename. `None` for GGUFs without
        /// one; those fall back to the filename heuristic.
        chat_template: Option<LlamaChatTemplate>,
    }

    static STATE: Lazy<Mutex<Option<Arc<LoadedState>>>> = Lazy::new(|| Mutex::new(None));

    /// P6: pool cap. Each context allocates a full `n_ctx`-sized KV cache
    /// (potentially gigabytes for large-context models), so the default
    /// stays small; contexts beyond the first are only created when
    /// generations actually overlap. Override with FERAL_MAX_LOCAL_CONTEXTS.
    fn max_contexts() -> usize {
        std::env::var("FERAL_MAX_LOCAL_CONTEXTS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|&n| n >= 1)
            .unwrap_or(2)
    }

    /// Allocate one pooled context for `model`, sized to `ctx_len`.
    fn create_context(model: &Arc<LlamaModel>, ctx_len: u32) -> Result<PooledContext> {
        let backend = BACKEND
            .get()
            .ok_or_else(|| anyhow!("llama backend not initialized"))?;
        let ctx_size = NonZeroU32::new(ctx_len)
            .ok_or_else(|| anyhow!("invalid ctx_len: {}", ctx_len))?;
        let ctx_params = LlamaContextParams::default().with_n_ctx(Some(ctx_size));
        let context = model
            .new_context(backend, ctx_params)
            .map_err(|e| anyhow!("create context: {}", e))?;
        // SAFETY: the context borrows the `LlamaModel` on the heap behind
        // the Arc — an address stable across moves — and the `_model`
        // clone stored below keeps that allocation alive for at least as
        // long as the context (field drop order: context first). See the
        // PooledContext block comment for the full invariant.
        let context: LlamaContext<'static> = unsafe { std::mem::transmute(context) };
        Ok(PooledContext {
            context,
            cached_tokens: Vec::new(),
            _model: Arc::clone(model),
        })
    }

    // ── Embeddings: a dedicated small model + one serialized context ──────
    //
    // The embedding model (e.g. bge-small) loads INDEPENDENTLY of the chat
    // model in STATE: it is tiny, CPU-cheap, and uses a non-causal context
    // with mean pooling. All embed calls serialize behind one Mutex'd context
    // — embeddings are short, so a pool buys nothing and a single context
    // keeps KV memory negligible. Mean pooling + L2 normalization happen here,
    // so callers receive unit vectors ready for a plain cosine dot product.
    //
    // Self-referential layout mirrors PooledContext: `context` borrows the
    // Arc'd model on the heap (one transmute to 'static), kept alive by the
    // `model` Arc below; `context` is declared FIRST so it drops FIRST.
    struct EmbedState {
        context: LlamaContext<'static>,
        model: Arc<LlamaModel>,
        n_embd: usize,
    }
    // SAFETY: same as PooledContext — only ever used by one thread at a time
    // (serialized behind the EMBED mutex); LlamaContext wraps a raw pointer so
    // it is not auto-Send.
    unsafe impl Send for EmbedState {}

    static EMBED: Lazy<Mutex<Option<EmbedState>>> = Lazy::new(|| Mutex::new(None));

    /// bge-small and friends top out at a 512-token sequence; cap the context
    /// (and truncate inputs) to that — keeps KV memory tiny and matches the
    /// model's training window.
    const EMBED_CTX_LEN: u32 = 512;

    /// Resolve the embedding GGUF: an explicit `FERAL_EMBED_MODEL` override
    /// wins; otherwise the bundled/downloaded default in the models dir. `None`
    /// when absent — the caller then falls back to lexical retrieval.
    fn embedding_model_path() -> Option<PathBuf> {
        if let Ok(p) = std::env::var("FERAL_EMBED_MODEL") {
            let pb = PathBuf::from(p);
            if pb.is_file() {
                return Some(pb);
            }
        }
        let candidate = crate::paths::models_dir().join("bge-small-en-v1.5.Q8_0.gguf");
        if candidate.is_file() {
            Some(candidate)
        } else {
            None
        }
    }

    /// Load the embedding model + its pooled, embeddings-enabled context into
    /// EMBED. CPU-only (`n_gpu_layers = 0`): the model is small and this keeps
    /// VRAM for the chat model.
    fn load_embedding(path: &Path) -> Result<()> {
        let backend = BACKEND.get_or_try_init(|| {
            LlamaBackend::init().map_err(|e| anyhow!("llama backend init: {}", e))
        })?;
        let params = LlamaModelParams::default().with_n_gpu_layers(0);
        let model = Arc::new(
            LlamaModel::load_from_file(backend, path, &params)
                .map_err(|e| anyhow!("load embedding weights {:?}: {}", path, e))?,
        );
        let n_embd = usize::try_from(model.n_embd())
            .map_err(|_| anyhow!("embedding model reports a negative n_embd"))?;
        if n_embd == 0 {
            return Err(anyhow!("embedding model reports n_embd = 0"));
        }
        let ctx_size =
            NonZeroU32::new(EMBED_CTX_LEN).ok_or_else(|| anyhow!("invalid embedding ctx len"))?;
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(Some(ctx_size))
            .with_embeddings(true)
            .with_pooling_type(LlamaPoolingType::Mean);
        let context = model
            .new_context(backend, ctx_params)
            .map_err(|e| anyhow!("create embedding context: {}", e))?;
        // SAFETY: the context borrows the model on the heap behind the Arc (a
        // stable address across moves); the `model` Arc stored alongside keeps
        // that allocation alive at least as long as the context (field drop
        // order: context first). See the PooledContext block comment.
        let context: LlamaContext<'static> = unsafe { std::mem::transmute(context) };
        *EMBED.lock() = Some(EmbedState {
            context,
            model,
            n_embd,
        });
        Ok(())
    }

    /// L2-normalize in place so cosine collapses to a dot product downstream.
    fn l2_normalize(v: &mut [f32]) {
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for x in v.iter_mut() {
                *x /= norm;
            }
        }
    }

    /// Embed a batch of texts → one L2-normalized vector per input, in order.
    /// Lazy-loads the embedding model on first use. Serialized behind EMBED.
    pub fn embed_batch(texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        // Lazy load (idempotent; a rare concurrent double-load just wastes one
        // load — the second overwrites the first).
        if EMBED.lock().is_none() {
            let path = embedding_model_path().ok_or_else(|| {
                anyhow!(
                    "no embedding model found — set FERAL_EMBED_MODEL or place the GGUF in {:?}",
                    crate::paths::models_dir()
                )
            })?;
            load_embedding(&path)?;
        }

        let mut guard = EMBED.lock();
        let state = guard
            .as_mut()
            .ok_or_else(|| anyhow!("embedding model unavailable after load"))?;
        let n_embd = state.n_embd;

        let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
        for text in texts {
            let mut tokens = state
                .model
                .str_to_token(text, AddBos::Always)
                .map_err(|e| anyhow!("embedding tokenize: {}", e))?;
            if tokens.is_empty() {
                // Empty/whitespace input — emit a zero vector so result[i] still
                // lines up with texts[i]; downstream cosine guards zero vectors.
                out.push(vec![0.0; n_embd]);
                continue;
            }
            // bge tops out at EMBED_CTX_LEN; truncate over-long inputs so the
            // batch fits the context (and the default n_batch).
            if tokens.len() > EMBED_CTX_LEN as usize {
                tokens.truncate(EMBED_CTX_LEN as usize);
            }

            let mut batch = LlamaBatch::new(tokens.len(), 1);
            batch
                .add_sequence(&tokens, 0, false)
                .map_err(|e| anyhow!("embedding batch add: {}", e))?;

            // Fresh KV state per text (single shared context, one seq id).
            state.context.clear_kv_cache();
            state
                .context
                .decode(&mut batch)
                .map_err(|e| anyhow!("embedding decode: {}", e))?;

            let emb = state
                .context
                .embeddings_seq_ith(0)
                .map_err(|e| anyhow!("read pooled embedding: {}", e))?;
            let mut v: Vec<f32> = emb.to_vec();
            l2_normalize(&mut v);
            out.push(v);
        }
        Ok(out)
    }

    pub fn load(path: &Path, n_gpu_layers: i32) -> Result<u32> {
        let backend = BACKEND.get_or_try_init(|| {
            LlamaBackend::init().map_err(|e| anyhow!("llama backend init: {}", e))
        })?;

        // GPU offload. `-1` (the Settings default, meaning "auto") offloads ALL
        // layers to the GPU — matching the llama.cpp CLI convention — so a GPU
        // build (inference-vulkan / inference-metal) actually uses the GPU
        // instead of crawling on CPU. (Previously -1 fell through to llama's
        // default of 0 layers = CPU-only, which is why local models were
        // unusably slow.) A non-zero count in a CPU-only build is simply
        // ignored by llama.cpp, so this is safe regardless of how Feral was
        // compiled. `>= 0` honors an explicit user-chosen layer count.
        const OFFLOAD_ALL: u32 = 1_000_000; // llama clamps to the model's layer count
        let requested = if n_gpu_layers >= 0 { n_gpu_layers as u32 } else { OFFLOAD_ALL };

        // Context size — and the eager KV-cache allocation it triggers — MUST be
        // capped. Sizing to the model's full training context is a system-crash
        // hazard: modern models advertise enormous `n_ctx_train` (Jan-v3.5 /
        // Qwen3 expose up to 256K), and the KV cache is allocated EAGERLY when
        // the first context is created. KV cost ≈ 2 * n_layers * n_embd * 2
        // bytes / token, so a 4B model at 256K is ~90 GB — which instantly
        // exhausts memory: on macOS (unified memory) the machine kernel-panics
        // and reboots; on Windows it thrashes to a near-hang. The model file is
        // only a few GB — it's the unbounded context that kills the box.
        //
        // Cap the load-time context at a safe default (8192 — ample for chat +
        // the agent's compressed transcripts), clamped to the model's own max;
        // power users can raise it via FERAL_MAX_CONTEXT.
        const DEFAULT_MAX_CONTEXT: u32 = 8192;
        let cap = std::env::var("FERAL_MAX_CONTEXT")
            .ok()
            .and_then(|v| v.trim().parse::<u32>().ok())
            .filter(|v| *v >= 512)
            .unwrap_or(DEFAULT_MAX_CONTEXT);

        // One load attempt at a given GPU-layer count: load weights, size the
        // context to the model (capped), and eagerly create the first pooled
        // context. The model is shared via Arc (read-only during inference; see
        // the PooledContext block comment). Returns model + ctx_len + the warm
        // first context, or an error if EITHER the weights or the KV allocation
        // failed.
        let attempt = |ngl: u32| -> Result<(Arc<LlamaModel>, u32, PooledContext)> {
            let params = LlamaModelParams::default().with_n_gpu_layers(ngl);
            let model = Arc::new(
                LlamaModel::load_from_file(backend, path, &params)
                    .map_err(|e| anyhow!("load weights: {}", e))?,
            );
            let ctx_len = model.n_ctx_train().max(2048).min(cap);
            // create_context allocates the KV cache — on the GPU when layers are
            // offloaded, so this is the step that returns a null context when
            // VRAM is exhausted (a model/context too big for the card).
            let first = create_context(&model, ctx_len)?;
            Ok((model, ctx_len, first))
        };

        // Try GPU first; on ANY failure — weights won't load, OR the KV cache
        // won't fit in VRAM ("create context: null reference" for a model too
        // big for the GPU) — fall back to CPU so the model still loads (slower)
        // instead of erroring out. A hard GPU *driver crash* can't be caught
        // here, but a clean error can.
        let (model, ctx_len, first) = match attempt(requested) {
            Ok(v) => v,
            Err(e) if requested > 0 => {
                tracing::warn!(
                    error = %e,
                    requested_gpu_layers = requested,
                    "GPU load failed (weights or KV cache) — falling back to CPU"
                );
                attempt(0)
                    .map_err(|e2| anyhow!("load {:?} on CPU after GPU failure: {}", path, e2))?
            }
            Err(e) => return Err(anyhow!("load {:?}: {}", path, e)),
        };

        let name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        // A4: prefer the template the model itself declares over anything
        // guessed from the filename.
        let chat_template = model.chat_template(None).ok();
        let max = max_contexts();
        tracing::info!(
            path = ?path,
            ctx_len,
            max_contexts = max,
            gguf_template = chat_template.is_some(),
            fallback_template = %detect_template(&name),
            "model loaded (context pool ready, per-context KV prefix reuse)"
        );
        *STATE.lock() = Some(Arc::new(LoadedState {
            name,
            ctx_len,
            model,
            pool: ContextPool {
                inner: Mutex::new(PoolInner { idle: vec![first], created: 1 }),
                available: Condvar::new(),
                max,
            },
            chat_template,
        }));
        Ok(ctx_len)
    }

    pub fn unload() {
        // Drop our reference to the loaded state. Generations already in
        // flight hold their own Arc and finish undisturbed; the model and
        // every pooled context are freed when the last Arc drops (within
        // each PooledContext, the context drops before the model Arc by
        // field order).
        *STATE.lock() = None;
        tracing::info!("model unloaded (pool + KV caches released with last reference)");
    }

    fn detect_template(name: &str) -> &'static str { super::detect_template(name) }
    fn build_prompt(messages: &[Message], model_name: &str) -> String { super::build_prompt(messages, model_name) }

    /// A4: render the prompt through the model's own GGUF chat template via
    /// llama.cpp's template engine. Returns `None` (→ caller falls back to
    /// the filename heuristic) when the model has no template, the engine
    /// doesn't support it, or rendering produces nothing usable.
    fn build_prompt_gguf(state: &LoadedState, messages: &[Message]) -> Option<String> {
        let tmpl = state.chat_template.as_ref()?;
        let augmented = super::augment_messages(messages);
        let chat: Vec<LlamaChatMessage> = augmented
            .into_iter()
            .filter_map(|m| LlamaChatMessage::new(m.role, m.content).ok())
            .collect();
        if chat.is_empty() {
            return None;
        }
        match state.model.apply_chat_template(tmpl, &chat, true) {
            Ok(p) if !p.trim().is_empty() => Some(p),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "gguf chat template failed to render; falling back to filename heuristic"
                );
                None
            }
        }
    }

    /// P3: token count with the loaded model's real tokenizer. Serves the
    /// `/tokenize` endpoint in api.rs.
    pub fn count_tokens(text: &str) -> Result<usize> {
        let state: Arc<LoadedState> = STATE
            .lock()
            .clone()
            .ok_or_else(|| anyhow!("no model loaded"))?;
        let tokens = state
            .model
            .str_to_token(text, AddBos::Never)
            .map_err(|e| anyhow!("tokenize: {}", e))?;
        Ok(tokens.len())
    }

    pub fn generate(
        messages: Vec<Message>,
        params: InferParams,
        stop: Arc<AtomicBool>,
        on_start: Option<Box<dyn Fn(u32) + Send + 'static>>,
    ) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel(256);
        tokio::task::spawn_blocking(move || {
            // P6: the global STATE lock is held only long enough to clone
            // the Arc — never across the generation. Each call then checks
            // a context out of the pool (creating one lazily up to the cap)
            // and decodes in parallel with any other in-flight call.
            // `run_inference` performs the R1 explicit prefix reuse against
            // that context's own cached tokens — raw llama_decode has no
            // automatic prefix matching.
            let result: Result<()> = (|| -> Result<()> {
                let state: Arc<LoadedState> = STATE
                    .lock()
                    .clone()
                    .ok_or_else(|| anyhow!("no model loaded"))?;
                // Blocks only when `max_contexts()` generations are already
                // running — the one serialization point left by design.
                let mut pctx = state.pool.acquire(&state.model, state.ctx_len)?;
                let result = run_inference(
                    &state,
                    &mut pctx,
                    &messages,
                    &params,
                    &tx,
                    &stop,
                    on_start.as_deref(),
                );
                // Return the context even on error: run_inference empties
                // `cached_tokens` up front and only restores it on success,
                // so an errored context re-enters the pool in the safe
                // "cache unknown → clear + full re-prefill" state.
                state.pool.release(pctx);
                result
            })();
            if let Err(e) = result {
                tracing::error!("inference: {}", e);
                let _ = tx.blocking_send(format!("\n[Error: {}]", e));
            }
        });
        rx
    }

        /// Run one inference call against a pooled context.
        ///
        /// P1: KV-cache reuse is explicit and per-context: the new prompt's
        /// tokens are diffed against `pctx.cached_tokens` (what THIS
        /// context's cache actually holds from its previous call), the
        /// divergent suffix is evicted via `clear_kv_cache_seq`, and
        /// prefill starts at the first divergent position instead of 0.
        /// When the agent loop's cache-friendly prompt assembly keeps the
        /// static prefix stable — and the pool routes the session back to
        /// the same context — only the new tail is recomputed; when prompts
        /// diverge early (a different session, or a different context), the
        /// cache is cleared and fully re-prefilled — slower, but always
        /// correct.
        fn run_inference(
            state: &LoadedState,
            pctx: &mut PooledContext,
            messages: &[Message],
            params: &InferParams,
            tx: &mpsc::Sender<String>,
            stop: &Arc<AtomicBool>,
            on_start: Option<&(dyn Fn(u32) + Send)>,
        ) -> Result<()> {
            // ── Phase 1: tokenize + build sampler (model only) ──
            let model: &LlamaModel = &state.model;
            // A4: the GGUF-declared template wins; the filename heuristic is
            // only a fallback for models that don't ship one (or whose
            // template the llama.cpp engine can't render).
            let gguf_prompt = build_prompt_gguf(state, messages);
            let used_gguf = gguf_prompt.is_some();
            let prompt = gguf_prompt.unwrap_or_else(|| build_prompt(messages, &state.name));
            let extra_stop_tokens: Vec<LlamaToken> = if used_gguf {
                // Template family is unknown here, so take the union of the
                // common end-of-turn markers — but only those this model's
                // vocab encodes as a SINGLE (special) token. A marker that
                // splits into several ordinary tokens would make each piece
                // a stop token and truncate normal prose.
                ["<|eot_id|>", "<|end_of_text|>", "</s>", "<end_of_turn>", "<|im_end|>", "<|endoftext|>"]
                    .iter()
                    .filter_map(|s| {
                        match model.str_to_token(s, AddBos::Never) {
                            Ok(toks) if toks.len() == 1 => Some(toks[0]),
                            _ => None,
                        }
                    })
                    .collect()
            } else {
                let stop_strs: &[&str] = match detect_template(&state.name) {
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

            // Build the sampler chain. Grammar sampling needs the model
            // (for vocabulary-aware trigger matching). The chain is then
            // consumed entirely inside the sample loop (phase 3).
            let mut samplers: Vec<LlamaSampler> = Vec::with_capacity(6);
            if let Some(g) = params.grammar.as_deref() {
                let built = match params.grammar_triggers.as_deref() {
                    Some(trigs) if !trigs.is_empty() => LlamaSampler::grammar_lazy(
                        model,
                        g,
                        "root",
                        trigs.iter().map(String::as_str),
                        &[],
                    ),
                    _ => LlamaSampler::grammar(model, g, "root"),
                };
                match built {
                    Ok(s) => samplers.push(s),
                    Err(e) => tracing::warn!(?e, "grammar sampler init failed; sampling unconstrained"),
                }
            }
            let seed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(1234);
            samplers.push(LlamaSampler::penalties(64, params.repeat_penalty, 0.0, 0.0));
            samplers.push(LlamaSampler::top_k(40));
            samplers.push(LlamaSampler::top_p(params.top_p, 1));
            samplers.push(LlamaSampler::temp(params.temperature));
            samplers.push(LlamaSampler::dist(seed));
            let mut sampler = LlamaSampler::chain_simple(samplers);

            // ── Phase 2: KV-cache prefix reuse + prefill (this context only) ──
            //
            // R1 fix: raw `llama_decode` does NOT prefix-match against the
            // cache (that is llama-server logic). Re-decoding positions that
            // already hold KV cells for seq 0 would add duplicate cells —
            // attention would see stale and new entries simultaneously
            // (corrupted output) and the cache would leak slots until decode
            // fails. So we manage the cache explicitly:
            //
            //   1. Diff the new prompt against `cached_tokens` (what the
            //      cache holds from this context's previous call: its
            //      prompt + its generated tokens).
            //   2. Evict everything from the first divergent position on.
            //   3. Prefill only the divergent tail.
            //
            // `cached_tokens` is taken (emptied) up front so any error path
            // (`?`) leaves the context in the safe "cache unknown → clear
            // and fully re-prefill next call" state; it is repopulated only
            // at the successful end of this call.
            let prev_tokens = std::mem::take(&mut pctx.cached_tokens);
            let mut reuse = prev_tokens
                .iter()
                .zip(tokens.iter())
                .take_while(|(a, b)| a == b)
                .count();
            // The sampler needs fresh logits, which only a decode produces —
            // always re-decode at least the final prompt token.
            if reuse >= n_prompt {
                reuse = n_prompt - 1;
            }
            let ctx = &mut pctx.context;
            if reuse == 0 {
                ctx.clear_kv_cache();
            } else {
                // Drop cells at positions [reuse, ∞) for seq 0. On any
                // failure fall back to a full clear + full re-prefill —
                // never decode into an uncertain cache.
                match ctx.clear_kv_cache_seq(Some(0), Some(reuse as u32), None) {
                    Ok(true) => {
                        tracing::debug!(reuse, n_prompt, "kv cache: reusing prefix");
                    }
                    _ => {
                        ctx.clear_kv_cache();
                        reuse = 0;
                    }
                }
            }

            // Prefill in chunks. A single decode of all prompt tokens trips
            // `GGML_ASSERT(n_tokens_all <= cparams.n_batch)` (default n_batch = 2048)
            // for long prompts — notably agent runs whose tool-calling system prompt
            // can exceed 2048 tokens. Chunking keeps every decode within n_batch and
            // bounds the compute buffer regardless of prompt length.
            const PREFILL_CHUNK: usize = 512;
            let mut batch = LlamaBatch::new(PREFILL_CHUNK, 1);
            let mut start = reuse;
            while start < n_prompt {
                let end = (start + PREFILL_CHUNK).min(n_prompt);
                batch.clear();
                #[allow(clippy::needless_range_loop)]
                for i in start..end {
                    let want_logits = i == n_prompt - 1;
                    batch
                        .add(tokens[i], i as i32, &[0], want_logits)
                        .map_err(|e| anyhow!("batch add (prefill): {}", e))?;
                }
                ctx.decode(&mut batch)
                    .map_err(|e| anyhow!("decode prefill: {}", e))?;
                start = end;
            }

            // ── Phase 3: sample loop ──
            // `model` (shared, read-only) and `ctx` (exclusive to this
            // generation) are separate objects now — no borrow gymnastics.
            let mut n_cur = n_prompt as i32;
            let max_new = params.max_tokens as i32;
            let mut piece_decoder = UTF_8.new_decoder();
            // R1: running record of every token materialized in the KV cache
            // by this call — the full prompt plus each generated token we
            // decode below. Saved back to `self.cached_tokens` on success so
            // the next call can diff against the true cache contents.
            let mut session_tokens = tokens.clone();

            loop {
                if stop.load(Ordering::Relaxed) { break; }

                let token = sampler.sample(ctx, -1);
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
                // Only tokens that were actually decoded live in the cache;
                // the break-triggering EOG/stop token above never gets here.
                session_tokens.push(token);
                n_cur += 1;
            }

            // R1: record this context's cache contents for the next call's
            // prefix diff.
            pctx.cached_tokens = session_tokens;

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
        Message { role: role.into(), content: content.into(), images: None }
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
        // P1: session_id defaults to None (one-shot callers don't need it).
        assert!(p.session_id.is_none());
    }

    // ── ModelManager state ────────────────────────────────────────────────────

    #[test]
    fn model_manager_starts_empty() {
        let m = ModelManager::new();
        assert!(m.current().is_none());
    }

    #[test]
    fn model_manager_name_extraction() {
        let path = std::path::PathBuf::from("/models/Ministral-3-3B.Q6_K.gguf");
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("model").to_string();
        assert_eq!(name, "Ministral-3-3B.Q6_K.gguf");
    }
}
