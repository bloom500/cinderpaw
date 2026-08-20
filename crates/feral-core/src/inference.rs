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
    /// Active context window the KV cache was sized to (clamped to n_ctx_train).
    pub ctx_len: u32,
    /// The model's real training context window — the max a user may select.
    /// The active `ctx_len` defaults conservatively below this; the Hardware
    /// UI uses it as the slider ceiling so a user can opt into the full window.
    pub n_ctx_train: u32,
    /// Where this model actually RAN — "GPU (vulkan, 24/32 layers)", "CPU (GPU
    /// build, but offload unavailable)", "CPU". Carried on the load payload
    /// because it is only knowable after the load: the GPU attempt may have
    /// failed and fallen back. The UI badges it so a user whose expensive card
    /// is idle finds out from the app, not from the app merely feeling slow.
    pub backend: String,
    /// Layers that landed on the GPU, and the model's total. `0 / n` = pure CPU.
    pub gpu_layers: u32,
    pub gpu_layers_total: u32,
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

/// `true` when a system message opts into `/no_think` AND the model is a
/// Qwen (the family that ships the soft switch but — in 3.5 — ignores it).
/// The caller enforces the switch with a `<think></think>` prefill.
pub(crate) fn wants_nothink_prefill(messages: &[Message], model_name: &str) -> bool {
    if !model_name.to_lowercase().contains("qwen") {
        return false;
    }
    messages
        .iter()
        .any(|m| m.role == "system" && m.content.contains("/no_think"))
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
    /// Serializes `load()` calls. Two concurrent loads (the API's lazy-load
    /// racing the UI's explicit load) otherwise allocate on the GPU at the
    /// same time — the second OOMs and silently lands on CPU.
    load_gate: Mutex<()>,
}

impl ModelManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Load a model. `max_context` (when `Some`) is the user-chosen context
    /// window from Hardware settings — the active context is clamped to the
    /// model's real `n_ctx_train`. `None` falls back to FERAL_MAX_CONTEXT / the
    /// conservative 8192 default (see `backend::load`).
    pub fn load(&self, path: PathBuf, n_gpu_layers: i32, max_context: Option<u32>) -> Result<LoadedModel> {
        // One load at a time (see `load_gate`). Callers already run on
        // blocking threads (spawn_blocking), so parking here is fine.
        let _gate = self.load_gate.lock();

        // Idempotence: a context-agnostic load (the API's lazy-load passes
        // `None`) that finds the same model already resident keeps it —
        // reloading would tear down the UI's explicitly-chosen context size
        // for nothing.
        if max_context.is_none() {
            if let Some(cur) = self.current.lock().clone() {
                if cur.path == path {
                    return Ok(cur);
                }
            }
        }

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("model")
            .to_string();

        // Release the previous model BEFORE allocating the new one. On an
        // 8 GB card two 4B models cannot be resident at once — without this,
        // every reload OOMed on VRAM and silently fell back to CPU. The
        // epoch bump inside unload() stops in-flight generations at their
        // next token; we then wait for them to drop their model Arcs so the
        // VRAM is actually free when the new allocation starts.
        if self.current.lock().is_some() {
            self.unload();
            #[cfg(feature = "inference")]
            {
                use std::sync::atomic::Ordering;
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
                while backend::ACTIVE_GENERATIONS.load(Ordering::SeqCst) > 0
                    && std::time::Instant::now() < deadline
                {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        }

        #[cfg(feature = "inference")]
        let (ctx_len, n_ctx_train) = backend::load(&path, n_gpu_layers, max_context)?;
        #[cfg(not(feature = "inference"))]
        let (ctx_len, n_ctx_train) = {
            let _ = n_gpu_layers; // only the real backend consumes this
            (max_context.unwrap_or(4096), 4096u32)
        };

        // Read AFTER the load — the GPU attempt may have fallen back, and the
        // whole point of these fields is to report what actually happened.
        let (gpu_layers, gpu_layers_total) = gpu_layer_split().unwrap_or((0, 0));
        let loaded = LoadedModel {
            path,
            name,
            ctx_len,
            n_ctx_train,
            backend: active_backend_label(),
            gpu_layers,
            gpu_layers_total,
        };
        *self.current.lock() = Some(loaded.clone());
        Ok(loaded)
    }

    pub fn unload(&self) {
        #[cfg(feature = "inference")]
        {
            // Stop in-flight generations at their next token — they hold
            // model Arcs that would otherwise keep the old weights resident.
            backend::bump_generation_epoch();
            backend::unload();
        }
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
                    yield Ok(word.to_string());
                }
            }
        }
    }
}

/// The GPU backend this binary was COMPILED with — NOT what the driver
/// reports. `gpu_detect` can say "Vulkan available" (the card supports it)
/// while this is "cpu" (the binary was built without `inference-vulkan`), in
/// which case llama.cpp silently ignores `n_gpu_layers` and runs on CPU. The
/// UI needs this to tell the user the truth about why inference is slow.
///
/// CUDA is checked first because on Linux/Windows dev boxes both `cuda` and
/// `vulkan` may be enabled (e.g. CI matrix parallelism) — in that case the
/// first matching `cfg!` wins. Pick at most one GPU feature per build (see
/// Cargo.toml comments).
pub fn compiled_backend() -> &'static str {
    if cfg!(feature = "inference-cuda") {
        "cuda"
    } else if cfg!(feature = "inference-vulkan") {
        "vulkan"
    } else if cfg!(feature = "inference-metal") {
        "metal"
    } else if cfg!(feature = "inference") {
        "cpu"
    } else {
        "stub"
    }
}

/// Whether the last model load actually offloaded to the GPU (vs. fell back to
/// CPU because the GPU build's KV cache didn't fit, or this is a CPU build).
pub fn gpu_active() -> bool {
    #[cfg(feature = "inference")]
    {
        backend::gpu_active()
    }
    #[cfg(not(feature = "inference"))]
    {
        false
    }
}

/// Faza 4 (L2 personal adaptation): stage a LoRA adapter (GGUF) to be applied
/// at the NEXT model load — pass `None` to clear. Staging does not touch the
/// currently loaded model; the caller reloads to make it effective (adapters
/// attach per context, and reloading also flushes KV caches decoded under the
/// previous adapter). Scale 1.0 = the adapter as trained.
pub fn set_lora_adapter(path: Option<std::path::PathBuf>, scale: f32) {
    #[cfg(feature = "inference")]
    {
        backend::set_lora(path, scale);
    }
    #[cfg(not(feature = "inference"))]
    {
        let _ = (path, scale);
    }
}

/// The LoRA adapter path loaded with the CURRENT model, if any. `None` when no
/// model is loaded, no adapter is active, or this is a stub build.
pub fn active_lora_adapter() -> Option<String> {
    #[cfg(feature = "inference")]
    {
        backend::active_lora()
    }
    #[cfg(not(feature = "inference"))]
    {
        None
    }
}

/// Human-readable backend status for the model-load UI. Distinguishes a real
/// GPU run from a GPU-capable build that silently fell back to CPU, and from a
/// plain CPU build — so a user with an expensive card can see whether it's
/// actually being used.
pub fn active_backend_label() -> String {
    match compiled_backend() {
        b @ ("cuda" | "vulkan" | "metal") => {
            if gpu_active() {
                // Name the split: a partial offload is a hybrid run, and calling
                // it a flat "GPU" would hide the reason it's slower than the card
                // should be. `n/total` is what LM Studio and Jan show, for the
                // same reason.
                match gpu_layer_split() {
                    Some((n, total)) if n < total => format!("GPU ({b}, {n}/{total} layers)"),
                    _ => format!("GPU ({b})"),
                }
            } else {
                "CPU (GPU build, but offload unavailable)".to_string()
            }
        }
        "cpu" => "CPU".to_string(),
        _ => "stub (no inference backend)".to_string(),
    }
}

/// How many of a model's `n_layer` layers fit in `vram_mb`, alongside the KV
/// cache those layers need at `ctx_len`. Pure — the arithmetic half of
/// `backend::plan_gpu_layers`, split out so it is testable without a GPU.
///
/// Per layer:  weights (file_size / n_layer)  +  KV (2 tensors * 2 bytes f16 *
/// kv_dim * ctx / n_layer). `kv_dim` already accounts for GQA.
///
/// `HEADROOM_MB` is withheld for compute buffers, the driver, and whatever the
/// desktop already holds — reported VRAM is TOTAL, not free. Being greedy here
/// is precisely what makes a load fail and drop the whole model to CPU, so the
/// budget errs small: one layer too few costs a little speed, one too many costs
/// the entire GPU.
pub(crate) fn fit_gpu_layers(
    vram_mb: u64,
    weights_bytes: u64,
    kv_dim: u64,
    ctx_len: u32,
    n_layer: u32,
) -> u32 {
    const HEADROOM_MB: u64 = 1024;
    if n_layer == 0 || vram_mb == 0 {
        return 0;
    }
    let kv_bytes = 2 * 2 * kv_dim * u64::from(ctx_len) * u64::from(n_layer);
    let per_layer = (weights_bytes + kv_bytes) / u64::from(n_layer);
    if per_layer == 0 {
        return 0;
    }
    let usable = vram_mb
        .saturating_mul(1024 * 1024)
        .saturating_sub(HEADROOM_MB * 1024 * 1024);
    (usable / per_layer).min(u64::from(n_layer)) as u32
}

/// `(layers_on_gpu, total_layers)` for the loaded model, or None when nothing is
/// loaded / this is not a GPU build.
pub fn gpu_layer_split() -> Option<(u32, u32)> {
    #[cfg(feature = "inference")]
    {
        backend::gpu_layer_split()
    }
    #[cfg(not(feature = "inference"))]
    {
        None
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
        model::{
            params::LlamaModelParams, AddBos, LlamaChatMessage, LlamaChatTemplate,
            LlamaLoraAdapter, LlamaModel,
        },
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

    // ── Faza 4: personal LoRA adapter (L2) ─────────────────────────────────
    //
    // The champion adapter (chosen by the TS-side LoraRegistry through the
    // human gate) is applied at MODEL LOAD, not per request: llama.cpp
    // attaches adapters per context, and every pooled context must carry
    // the same adapter or two requests would answer from different models.
    // `set_lora_adapter` therefore only stages the path; the next `load()`
    // initializes the adapter against the freshly loaded weights and every
    // context created for that model (eager first + lazy pool growth) gets
    // it set. Changing champions ⇒ stage + reload, which also flushes the
    // per-context KV caches (prefixes decoded under another adapter would
    // otherwise be silently reused).

    /// Adapter staged for the next load: (GGUF LoRA path, scale).
    static PENDING_LORA: Lazy<Mutex<Option<(PathBuf, f32)>>> = Lazy::new(|| Mutex::new(None));

    pub(super) fn set_lora(path: Option<PathBuf>, scale: f32) {
        *PENDING_LORA.lock() = path.map(|p| (p, scale));
    }

    /// The adapter actually loaded with the CURRENT model (observability —
    /// a stale/missing adapter file loads the model bare, and the UI must
    /// be able to tell). `None` when no model or no adapter is active.
    pub(super) fn active_lora() -> Option<String> {
        let state = STATE.lock();
        state
            .as_ref()
            .and_then(|s| s.lora.as_ref())
            .map(|l| l.path.display().to_string())
    }

    /// The adapter + the model it was initialized against. `adapter` is a
    /// llama.cpp object owned by the model (freed with `llama_model_free`,
    /// no separate free in this crate version) — LoadedState holds both, so
    /// the adapter can never outlive its model.
    pub(super) struct LoraState {
        path: PathBuf,
        scale: f32,
        /// `lora_adapter_set` wants `&mut` — the Mutex provides it. The set
        /// call mutates the CONTEXT, not the adapter; the lock just
        /// serializes the API's conservative signature.
        adapter: Mutex<LlamaLoraAdapter>,
    }
    // SAFETY: the raw adapter pointer is only dereferenced by llama.cpp
    // calls made while holding the Mutex, and the referent is kept alive by
    // the LoadedState that owns both this and the model Arc (same
    // discipline as PooledContext).
    unsafe impl Send for LoraState {}
    unsafe impl Sync for LoraState {}

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
        fn acquire(
            &self,
            model: &Arc<LlamaModel>,
            ctx_len: u32,
            lora: Option<&LoraState>,
        ) -> Result<PooledContext> {
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
                    match create_context(model, ctx_len, lora) {
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
        /// Faza 4: personal LoRA adapter applied to every context of this
        /// model. `None` = bare foundation model.
        lora: Option<LoraState>,
    }

    static STATE: Lazy<Mutex<Option<Arc<LoadedState>>>> = Lazy::new(|| Mutex::new(None));

    /// Set by `load()` to whether the last load actually ran layers on the GPU
    /// (a GPU build whose GPU attempt succeeded) vs. fell back to CPU. Read via
    /// the module-level `inference::gpu_active()`.
    static GPU_ACTIVE: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

    /// `(layers_on_gpu, total_layers)` for the last load. Surfaced so the UI can
    /// say "GPU (vulkan, 24/32 layers)" instead of a bare "GPU", which would hide
    /// a mostly-CPU hybrid run.
    static GPU_LAYERS: Lazy<Mutex<(u32, u32)>> = Lazy::new(|| Mutex::new((0, 0)));

    pub(super) fn gpu_active() -> bool {
        *GPU_ACTIVE.lock()
    }

    pub(super) fn gpu_layer_split() -> Option<(u32, u32)> {
        let (n, total) = *GPU_LAYERS.lock();
        if total == 0 { None } else { Some((n, total)) }
    }

    /// How many of the model's layers fit on the GPU alongside their KV cache.
    ///
    /// The llama.cpp/LM Studio/Jan sizing, from the model's REAL geometry rather
    /// than a guess: mmap the file with 0 offloaded layers (cheap — no weights
    /// are read, and the OS page cache keeps the real load warm), read
    /// `n_layer` / `n_embd` / `n_head_kv`, then divide the VRAM budget by the
    /// per-layer cost.
    ///
    /// Per layer we must fit:
    ///   weights  ≈ file_size / n_layer        (quantized, whatever the quant is)
    ///   KV cache ≈ 2 (K and V) * kv_dim * ctx_len * 2 bytes (f16) / n_layer
    /// where kv_dim = n_embd * n_head_kv / n_head, which is what makes GQA models
    /// (most modern ones) far cheaper per token than the naive n_embd estimate.
    ///
    /// Returns `None` when we cannot size it (no VRAM reading, probe failed) —
    /// the caller then keeps the old "request everything" behaviour and lets the
    /// retry ladder sort it out.
    fn plan_gpu_layers(path: &Path, ctx_len: u32) -> Option<u32> {
        let gpu = crate::gpu_detect::detect();
        if gpu.vram_mb == 0 {
            return None; // unknown card — don't pretend to compute a budget
        }
        let backend = BACKEND.get().or_else(|| BACKEND.get())?;
        // Probe load: vocab_only, so llama.cpp stops after load_hparams /
        // load_vocab and never reaches load_tensors — i.e. it never MAPS the
        // weights. Everything read below (n_layer / n_embd / n_head /
        // n_head_kv) is hparams, populated before that return.
        //
        // This used to be a full load, which contradicted the note in
        // `attempt()` below explaining that an extra probe was removed
        // precisely because it "would leak a file handle and block Delete
        // until restart". The weights mapping is the expensive half of that:
        // ggml opens the GGUF through `_wfopen` (ggml.c), which never passes
        // FILE_SHARE_DELETE, so on Windows anything holding the file blocks
        // deletion. vocab_only also makes the probe near-instant on a large
        // model instead of a full mmap + metadata walk.
        let params = LlamaModelParams::default()
            .with_n_gpu_layers(0)
            .with_vocab_only(true);
        let probe = LlamaModel::load_from_file(backend, path, &params).ok()?;

        let n_layer = probe.n_layer();
        if n_layer == 0 {
            return None;
        }
        let n_embd = probe.n_embd().max(1) as u64;
        let n_head = probe.n_head().max(1) as u64;
        let n_head_kv = probe.n_head_kv().max(1) as u64;
        drop(probe);

        let weights_bytes = std::fs::metadata(path).ok()?.len();
        // kv_dim = n_embd * n_head_kv / n_head — GQA models share KV heads across
        // query heads, which is what makes their cache far cheaper than n_embd
        // would suggest. Using n_embd flat would badly under-offload them.
        let kv_dim = n_embd * n_head_kv / n_head;
        let fits = super::fit_gpu_layers(
            gpu.vram_mb,
            weights_bytes,
            kv_dim,
            ctx_len,
            n_layer,
        );

        tracing::info!(
            gpu = %gpu.name,
            vram_mb = gpu.vram_mb,
            n_layer,
            planned_layers = fits,
            "planned GPU offload"
        );
        Some(fits)
    }

    /// P6: pool cap. Each context allocates a full `n_ctx`-sized KV cache
    /// (potentially gigabytes for large-context models), so the default
    /// stays small; contexts beyond the first are only created when
    /// generations actually overlap. Override with FERAL_MAX_LOCAL_CONTEXTS.
    // TODO(inference): currently dead — no caller reads `max_contexts()`;
    // pool caps flow through `effective_pool_cap(_with_env)`. Pre-existing
    // (not introduced by Slice 2). Delete or wire up when the pool layer is
    // next refactored. Out of scope for Faza 4.5.
    #[allow(dead_code)]
    fn max_contexts() -> usize {
        max_contexts_env().unwrap_or(2)
    }

    /// Read FERAL_MAX_LOCAL_CONTEXTS without applying a default. Tests use
    /// this via `effective_pool_cap_with_env` so they don't race on the
    /// process-global env var. Production callers go through
    /// `effective_pool_cap`.
    fn max_contexts_env() -> Option<usize> {
        std::env::var("FERAL_MAX_LOCAL_CONTEXTS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|&n| n >= 1)
    }

    /// Effective pool cap for a freshly-loaded model. User override via
    /// `FERAL_MAX_LOCAL_CONTEXTS` always wins — power users with a beefy
    /// card (RTX 4090 24 GB) explicitly set 2 to overlap generations.
    ///
    /// Auto-cap when GPU is active: each pooled context allocates its own
    /// KV cache in VRAM, so a second context on an 8 GB card (an RX 580
    /// running Qwen3.5-4B-Q6_K at 8 K ctx) tries to allocate ~3.4 GB on top
    /// of the model and first context, already at ~6.7 GB, and explodes
    /// with `create context: null reference from llama.cpp`. There is no
    /// graceful GPU→CPU fallback for additional contexts (the model is
    /// already loaded with full GPU offload; switching backends means a
    /// full reload), so the safer default is 1 — generations serialize
    /// through the single context instead of OOM-ing. CPU builds keep the
    /// historical default of 2 since RAM is plentiful and two parallel
    /// decodes don't blow up.
    pub(super) fn effective_pool_cap(gpu_active: bool) -> usize {
        effective_pool_cap_with_env(gpu_active, max_contexts_env())
    }

    /// Pure-function variant for tests — no env-var read, so parallel-safe.
    pub(super) fn effective_pool_cap_with_env(gpu_active: bool, env_override: Option<usize>) -> usize {
        if let Some(n) = env_override {
            return n;
        }
        if gpu_active { 1 } else { 2 }
    }

    /// Allocate one pooled context for `model`, sized to `ctx_len`, with
    /// the model's LoRA adapter (if any) attached — EVERY context of a
    /// model must carry the same adapter (see the Faza 4 block comment).
    fn create_context(
        model: &Arc<LlamaModel>,
        ctx_len: u32,
        lora: Option<&LoraState>,
    ) -> Result<PooledContext> {
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
        if let Some(l) = lora {
            // Adapter attach failure is a hard error, not a warn-and-skip:
            // a pool where some contexts answer with the adapter and some
            // without is worse than a failed allocation.
            context
                .lora_adapter_set(&mut l.adapter.lock(), l.scale)
                .map_err(|e| anyhow!("set lora adapter {:?}: {}", l.path, e))?;
        }
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

    /// Per-SEQUENCE token window. BGE-M3 trains to 8192, but episodic memories
    /// are mostly short chat turns; 1024 captures longer tool outputs without
    /// the long-context tail while keeping embed-KV modest. Inputs are
    /// truncated to this. (KV ≈ n_seq_max × this × n_embd — see below.)
    const EMBED_CTX_LEN: u32 = 1024;
    /// How many texts are embedded in ONE `llama_decode` (the batch path).
    /// Short memories pack many per decode. Halved vs the bge-small era because
    /// M3 is a larger model with a wider window: 8 × 1024 keeps total embed-KV
    /// in the same ballpark as the old 16 × 512 instead of growing 4×.
    const EMBED_MAX_BATCH_SEQS: u32 = 8;
    /// Total context = per-sequence window × max sequences, so every packed
    /// sequence keeps its full 512-token window even under a strict per-seq KV
    /// split (n_ctx / n_seq_max == EMBED_CTX_LEN). bge KV at this size is tiny.
    const EMBED_CTX_TOTAL: u32 = EMBED_MAX_BATCH_SEQS * EMBED_CTX_LEN;
    /// Upper bound on tokens decoded in one call (the n_batch limit). A decode
    /// packs sequences until either this many tokens or EMBED_MAX_BATCH_SEQS
    /// sequences are queued, whichever comes first.
    const EMBED_BATCH_TOKENS: u32 = 2048;

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
        let candidate = crate::paths::embedding_model_path();
        if candidate.is_file() {
            Some(candidate)
        } else {
            None
        }
    }

    /// Load the embedding model + its pooled, embeddings-enabled context into
    /// EMBED. GPU-offloaded by default: bge-small is ~130 MB, so putting every
    /// layer on the GPU is cheap and turns ~2.8 s/text on CPU into milliseconds
    /// — the difference between a tree that never finishes building over
    /// thousands of memories and one that builds in a minute. Set
    /// `FERAL_EMBED_GPU_LAYERS=0` to force CPU (for anyone tight on VRAM); on a
    /// CPU-only build llama.cpp ignores the request and runs on CPU regardless.
    fn load_embedding(path: &Path) -> Result<()> {
        let backend = BACKEND.get_or_try_init(|| {
            LlamaBackend::init().map_err(|e| anyhow!("llama backend init: {}", e))
        })?;
        // Default 999 = "all layers" (bge has ~12; any GPU fits it whole).
        let gpu_layers: u32 = std::env::var("FERAL_EMBED_GPU_LAYERS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(999);
        let params = LlamaModelParams::default().with_n_gpu_layers(gpu_layers);
        let model = Arc::new(
            LlamaModel::load_from_file(backend, path, &params)
                .map_err(|e| anyhow!("load embedding weights {:?}: {}", path, e))?,
        );
        let n_embd = usize::try_from(model.n_embd())
            .map_err(|_| anyhow!("embedding model reports a negative n_embd"))?;
        if n_embd == 0 {
            return Err(anyhow!("embedding model reports n_embd = 0"));
        }
        // Size the context for BATCHED decoding: room for EMBED_MAX_BATCH_SEQS
        // sequences, each with a full EMBED_CTX_LEN window, and an n_batch large
        // enough to decode a packed batch in one call.
        let ctx_size =
            NonZeroU32::new(EMBED_CTX_TOTAL).ok_or_else(|| anyhow!("invalid embedding ctx len"))?;
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(Some(ctx_size))
            .with_n_batch(EMBED_BATCH_TOKENS)
            .with_n_ubatch(EMBED_BATCH_TOKENS)
            .with_n_seq_max(EMBED_MAX_BATCH_SEQS)
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
        // Lazy load, serialized behind its own lock. `load_embedding` takes the
        // EMBED lock itself, so the check could not simply hold it — which left
        // a window where two concurrent callers both saw None and both mmap'd
        // the model, the second silently discarding the first. Twice the RAM
        // and twice the load time, for one model.
        static EMBED_LOAD: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
        let _loading = EMBED_LOAD.lock();
        if EMBED.lock().is_none() {
            let path = embedding_model_path().ok_or_else(|| {
                anyhow!(
                    "no embedding model found — set FERAL_EMBED_MODEL or place the GGUF in {:?}",
                    crate::paths::models_dir()
                )
            })?;
            load_embedding(&path)?;
        }
        drop(_loading);

        let mut guard = EMBED.lock();
        let state = guard
            .as_mut()
            .ok_or_else(|| anyhow!("embedding model unavailable after load"))?;
        let n_embd = state.n_embd;

        // Tokenize everything up front (no `state.context` borrow held here, so
        // the decode loop below can borrow it mutably without conflict). Empty
        // inputs get a zero vector in place so result[i] lines up with texts[i].
        let mut out: Vec<Vec<f32>> = vec![Vec::new(); texts.len()];
        let mut pending: Vec<(usize, Vec<LlamaToken>)> = Vec::with_capacity(texts.len());
        for (idx, text) in texts.iter().enumerate() {
            let mut tokens = state
                .model
                .str_to_token(text, AddBos::Always)
                .map_err(|e| anyhow!("embedding tokenize: {}", e))?;
            if tokens.is_empty() {
                out[idx] = vec![0.0; n_embd]; // downstream cosine guards zeros
                continue;
            }
            // bge tops out at EMBED_CTX_LEN; truncate over-long inputs so each
            // sequence fits its per-seq window.
            if tokens.len() > EMBED_CTX_LEN as usize {
                tokens.truncate(EMBED_CTX_LEN as usize);
            }
            pending.push((idx, tokens));
        }

        // Greedily pack sequences into decodes: at most EMBED_MAX_BATCH_SEQS
        // sequences and EMBED_BATCH_TOKENS tokens per `llama_decode`. One decode
        // embeds many texts at once — that's what turns thousands of one-at-a-
        // time roundtrips into a handful of batched calls.
        let mut i = 0usize;
        while i < pending.len() {
            let mut batch =
                LlamaBatch::new(EMBED_BATCH_TOKENS as usize, EMBED_MAX_BATCH_SEQS as i32);
            let mut local: Vec<usize> = Vec::new(); // local seq id -> global index
            let mut tok_count = 0usize;
            while i < pending.len()
                && local.len() < EMBED_MAX_BATCH_SEQS as usize
                && tok_count + pending[i].1.len() <= EMBED_BATCH_TOKENS as usize
            {
                let item = &pending[i];
                let seq_id = local.len() as i32;
                batch
                    .add_sequence(&item.1, seq_id, false)
                    .map_err(|e| anyhow!("embedding batch add: {}", e))?;
                tok_count += item.1.len();
                local.push(item.0);
                i += 1;
            }

            // Fresh KV state per decode; pooled embeddings are read per seq id.
            state.context.clear_kv_cache();
            state
                .context
                .decode(&mut batch)
                .map_err(|e| anyhow!("embedding decode: {}", e))?;

            for (seq_id, &gidx) in local.iter().enumerate() {
                let emb = state
                    .context
                    .embeddings_seq_ith(seq_id as i32)
                    .map_err(|e| anyhow!("read pooled embedding: {}", e))?;
                let mut v: Vec<f32> = emb.to_vec();
                l2_normalize(&mut v);
                out[gidx] = v;
            }
        }
        Ok(out)
    }

    /// Bytes of KV cache one token costs, GQA-aware.
    ///
    /// `kv_dim = n_embd * n_head_kv / n_head` — grouped-query models share KV
    /// heads across query heads, which is exactly what makes their cache far
    /// cheaper than flat `n_embd` suggests (qwen2.5-coder-1.5b: 256, not 1536 —
    /// a 6x overestimate that would have pinned it to the conservative floor).
    /// Then: K and V (2), f16 (2 bytes), every layer.
    ///
    /// Pure arithmetic, split from `auto_context_cap` so it is testable without
    /// a loaded model.
    pub(crate) fn kv_bytes_per_token(n_layer: u64, n_embd: u64, n_head: u64, n_head_kv: u64) -> u64 {
        let kv_dim = (n_embd * n_head_kv.max(1) / n_head.max(1)).max(1);
        2 * kv_dim * 2 * n_layer
    }

    /// How many tokens of KV fit in `budget_bytes`, clamped to [floor, ceiling].
    /// Split out for the same reason as `kv_bytes_per_token`.
    pub(crate) fn context_for_budget(
        bytes_per_token: u64,
        budget_bytes: u64,
        floor: u32,
        ceiling: u32,
    ) -> u32 {
        if bytes_per_token == 0 {
            return floor;
        }
        let fits = (budget_bytes / bytes_per_token).min(u32::MAX as u64) as u32;
        fits.clamp(floor, ceiling)
    }

    /// Largest context window whose KV cache actually fits in memory, for a
    /// model the user gave no explicit window for.
    ///
    /// The KV cache is allocated EAGERLY at context creation, so this number is
    /// a real memory commitment, not a limit. Cost per token is
    ///     2 (K and V) * kv_dim * 2 bytes (f16) * n_layer
    /// with `kv_dim = n_embd * n_head_kv / n_head` — the GQA-aware form, same as
    /// `plan_gpu_layers`. Using flat `n_embd` would overestimate modern models
    /// several-fold and hand them back the conservative floor for no reason.
    ///
    /// Budget is a quarter of what is FREE (VRAM when layers are offloaded,
    /// system RAM otherwise): the weights, the OS, and any other context in the
    /// pool also need room, and being wrong here means an eager allocation
    /// failure rather than a slow reply.
    ///
    /// Bounded on both sides. The floor is the historical 8192, so a low-memory
    /// box behaves exactly as it did before. The ceiling is deliberate: past
    /// ~32K, prompt processing on CPU dominates the reply latency, and anyone
    /// who genuinely wants a 256K window can ask for it in Hardware settings and
    /// see the memory cost while doing so.
    fn auto_context_cap(model: &LlamaModel, gpu_offloaded: bool) -> u32 {
        const DEFAULT_MAX_CONTEXT: u32 = 8192;
        const AUTO_CONTEXT_CEILING: u32 = 32_768;

        let n_layer = model.n_layer() as u64;
        let n_embd = model.n_embd().max(1) as u64;
        let n_head = model.n_head().max(1) as u64;
        let n_head_kv = model.n_head_kv().max(1) as u64;
        if n_layer == 0 {
            return DEFAULT_MAX_CONTEXT;
        }
        let bytes_per_token = kv_bytes_per_token(n_layer, n_embd, n_head, n_head_kv);
        if bytes_per_token == 0 {
            return DEFAULT_MAX_CONTEXT;
        }

        // GPU is deliberately excluded for now. `plan_gpu_layers` decides how
        // many layers fit BEFORE the model is loaded, and it sizes that budget
        // from a context length — so if auto-sizing raised the window after the
        // planner had already committed, the planner and the allocator would
        // disagree about the KV size and the ladder would burn retries
        // discovering it. Making both agree means threading the auto value into
        // the planner's own probe; worth doing, not worth doing blind.
        // ponytail: CPU-only auto-sizing; extend to GPU when the planner and
        // this function share one context estimate.
        if gpu_offloaded {
            return DEFAULT_MAX_CONTEXT;
        }
        let info = crate::sysinfo_mod::collect();
        if info.ram_total_mb == 0 {
            return DEFAULT_MAX_CONTEXT; // unknown memory → today's behaviour
        }
        let free_mb: u64 = info.ram_total_mb.saturating_sub(info.ram_used_mb);

        let budget_bytes = (free_mb / 4).saturating_mul(1024 * 1024);
        let chosen = context_for_budget(
            bytes_per_token,
            budget_bytes,
            DEFAULT_MAX_CONTEXT,
            AUTO_CONTEXT_CEILING,
        );
        tracing::info!(
            kv_bytes_per_token = bytes_per_token,
            free_mb,
            gpu_offloaded,
            chosen_ctx = chosen,
            "auto-sizing context window to available memory"
        );
        chosen
    }

    /// Returns `(active_ctx_len, n_ctx_train)`. `max_context` (when `Some`) is
    /// the user's chosen window from Hardware settings; it takes precedence over
    /// the FERAL_MAX_CONTEXT env and the conservative 8192 default. The active
    /// context is always clamped to the model's real `n_ctx_train`.
    /// Turn llama.cpp's silence into a sentence someone can act on.
    ///
    /// The library reports a failed load as `null result from llama cpp`, which is
    /// what a user sees when a model will not open. It names no cause and offers no
    /// next step, so every one of the three real reasons — a truncated download, a
    /// file that is not a GGUF at all, and an architecture newer than this build
    /// can parse — arrives looking identical and looking like a broken app.
    ///
    /// The first two are cheap to tell apart from the bytes on disk. The third is
    /// what is left, and saying so plainly is more useful than saying "null".
    pub(super) fn explain_load_failure(path: &std::path::Path, raw: &str) -> String {
        use std::io::Read;

        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("the model");

        let meta = std::fs::metadata(path).ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        if size == 0 {
            return format!("{name} is empty — the download did not finish. Remove it and download it again.");
        }

        let mut magic = [0u8; 4];
        let read_ok = std::fs::File::open(path)
            .and_then(|mut f| f.read_exact(&mut magic))
            .is_ok();
        if !read_ok {
            return format!("{name} could not be read from disk ({raw}).");
        }
        if &magic != b"GGUF" {
            return format!(
                "{name} is not a GGUF model file — the download may have saved an error page              instead of the model. Remove it and download it again."
            );
        }

        // Beyond this point the file is a well-formed GGUF that the engine
        // still refused, and guessing which of the remaining reasons applies
        // would be exactly that — a guess. The first draft of this message
        // asserted "the architecture is newer than this build"; measurement
        // then disproved it. The file that prompted it declares `qwen35`, and
        // both the old engine and the new one register that architecture, and
        // the file is complete to the byte its own header asks for.
        //
        // So it names the real candidates and points at the log, which now
        // carries llama.cpp's own account of what went wrong.
        format!(
            "{name} is a complete GGUF file that the inference engine refused to open.              The usual causes are not enough free memory for a {gb:.1} GB model, or a              quantisation this build does not support. The engine's own reason is in the              application log (Settings → General → Open logs). (engine said: {raw})",
            gb = size as f64 / 1_073_741_824.0,
        )
    }

    pub fn load(path: &Path, n_gpu_layers: i32, max_context: Option<u32>) -> Result<(u32, u32)> {
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
        // the agent's compressed transcripts), clamped to the model's own max.
        // Precedence: explicit Hardware choice (`max_context`) > FERAL_MAX_CONTEXT
        // env > 8192. The eager-KV crash hazard above is why the DEFAULT stays
        // conservative: a user who opts into a bigger window does so knowingly
        // (the UI shows the memory cost), and the GPU→CPU fallback below catches
        // a VRAM-too-small allocation instead of crashing.
        //
        // 2026-07-24: the flat 8192 was ALSO the ceiling for models that could
        // comfortably do far more, and that quietly crippled long-horizon work.
        // The agent's transcript budget is `ctx - output_reserve - tool_schemas`
        // = 8192 - 2048 - 3072 = ~3072 tokens, so three tool results triggered
        // compaction on every single turn: the agent forgot what it had just
        // done and re-established context in prose. Observed on
        // qwen2.5-coder-1.5b, which trains at 32768 — 4x the window it was given
        // — for under 1 GB of KV.
        //
        // So: an explicit choice still wins outright (the user saw the memory
        // cost in the UI). With NO explicit choice we now size the window to
        // what memory can actually hold instead of guessing 8192, floored at
        // the old default so this can never regress, and ceilinged well below
        // the crash hazard above.
        const DEFAULT_MAX_CONTEXT: u32 = 8192;
        let explicit_cap = max_context
            .filter(|v| *v >= 512)
            .or_else(|| {
                std::env::var("FERAL_MAX_CONTEXT")
                    .ok()
                    .and_then(|v| v.trim().parse::<u32>().ok())
                    .filter(|v| *v >= 512)
            });


        // One load attempt at a given GPU-layer count: load weights, size the
        // context to the model (capped), and eagerly create the first pooled
        // context. The model is shared via Arc (read-only during inference; see
        // the PooledContext block comment). Returns model + ctx_len + the warm
        // first context, or an error if EITHER the weights or the KV allocation
        // failed.
        // Faza 4: adapter staged via `set_lora_adapter`. Initialized per
        // ATTEMPT — the adapter object belongs to the model instance it was
        // initialized against, so the CPU-fallback model needs its own. A
        // missing/corrupt adapter file fails the attempt loudly rather than
        // silently serving the bare model (see LoraState docblock).
        let staged_lora = PENDING_LORA.lock().clone();
        let attempt = |ngl: u32| -> Result<(Arc<LlamaModel>, u32, PooledContext, Option<LoraState>)> {
            // ngl == 0 is the CPU last resort, and it must be a TRUE CPU load:
            // with a GPU device still attached, llama.cpp routes buffers through
            // it even with zero layers offloaded, so a card that cannot allocate
            // (AMD Polaris on the proprietary Vulkan driver — no resizable BAR,
            // large allocations just fail) takes the CPU fallback down with it
            // and the model does not load AT ALL. Verified on an RX 580: a GPU
            // build failed every attempt including ngl=0, while the CPU build
            // loaded the same model fine. Detaching the device makes the
            // fallback as reliable as a CPU-only build.
            let params = LlamaModelParams::default().with_n_gpu_layers(ngl);
            let params = if ngl == 0 {
                params.with_devices(&[]).unwrap_or_else(|_| {
                    LlamaModelParams::default().with_n_gpu_layers(0)
                })
            } else {
                params
            };
            let model = Arc::new(
                LlamaModel::load_from_file(backend, path, &params)
                    .map_err(|e| anyhow!("{}", explain_load_failure(path, &e.to_string())))?,
            );
            let lora = staged_lora
                .as_ref()
                .map(|(p, scale)| -> Result<LoraState> {
                    let adapter = model
                        .lora_adapter_init(p)
                        .map_err(|e| anyhow!("init lora adapter {:?}: {}", p, e))?;
                    Ok(LoraState { path: p.clone(), scale: *scale, adapter: Mutex::new(adapter) })
                })
                .transpose()?;
            // The model is already loaded here, so its geometry is free — no
            // extra probe load (which, on a model llama.cpp cannot parse, would
            // leak a file handle and block Delete until restart).
            let cap = explicit_cap
                .unwrap_or_else(|| auto_context_cap(&model, requested > 0));
            let ctx_len = model.n_ctx_train().max(2048).min(cap);
            // create_context allocates the KV cache — on the GPU when layers are
            // offloaded, so this is the step that returns a null context when
            // VRAM is exhausted (a model/context too big for the card).
            let first = create_context(&model, ctx_len, lora.as_ref())?;
            Ok((model, ctx_len, first, lora))
        };

        let is_gpu_build = matches!(super::compiled_backend(), "cuda" | "vulkan" | "metal");

        // PARTIAL OFFLOAD (the llama.cpp / LM Studio / Jan behaviour).
        //
        // Offload used to be all-or-nothing: request every layer, and on ANY
        // failure — including "the KV cache doesn't fit in VRAM" — drop straight
        // to 0 layers, i.e. full CPU. A 6-8 GB card holding a model that misses
        // the cut by a few hundred MB therefore ran ENTIRELY on CPU, even though
        // it could have taken most of the layers. That is the single biggest
        // reason users see "why is this on CPU?".
        //
        // The standard fix is to fit as many layers as VRAM allows and leave the
        // rest on CPU. `plan_gpu_layers` sizes that from the model's real
        // geometry, and the ladder below still catches an over-estimate (VRAM
        // reported != VRAM free — another app may hold some) by retrying with
        // progressively fewer layers instead of collapsing to CPU.
        //
        // ponytail: `auto` (-1) plans; an explicit user layer count is honored
        // as-is (they overrode us on purpose) but still gets the ladder.
        let planned = if n_gpu_layers < 0 && is_gpu_build {
            // Planned against the same conservative window the GPU path
            // actually allocates (auto-sizing is CPU-only — see
            // `auto_context_cap`), so planner and allocator never disagree
            // about how big the KV cache will be.
            plan_gpu_layers(path, explicit_cap.unwrap_or(DEFAULT_MAX_CONTEXT))
                .unwrap_or(requested)
        } else {
            requested
        };

        // Descending attempts: planned → 3/4 → 1/2 → 1/4 → CPU. Each step is a
        // real load, so a clean VRAM failure costs one retry, not a crash.
        let mut ladder: Vec<u32> = Vec::new();
        if planned > 0 {
            for frac in [4u32, 3, 2, 1] {
                let n = planned * frac / 4;
                if n > 0 && ladder.last() != Some(&n) {
                    ladder.push(n);
                }
            }
        }
        ladder.push(0); // CPU — always the last resort, never the first.

        let mut offloaded_layers = 0u32;
        let mut last_err: Option<anyhow::Error> = None;
        let mut loaded: Option<(Arc<LlamaModel>, u32, PooledContext, Option<LoraState>)> = None;
        for ngl in ladder {
            match attempt(ngl) {
                Ok(v) => {
                    offloaded_layers = ngl;
                    loaded = Some(v);
                    break;
                }
                Err(e) => {
                    if ngl > 0 {
                        tracing::warn!(
                            error = %e,
                            gpu_layers = ngl,
                            "GPU load failed (weights or KV cache) — retrying with fewer layers"
                        );
                    }
                    last_err = Some(e);
                }
            }
        }
        let (model, ctx_len, first, lora) = loaded.ok_or_else(|| {
            anyhow!(
                "load {:?}: {}",
                path,
                last_err.map(|e| e.to_string()).unwrap_or_else(|| "unknown error".into())
            )
        })?;

        // GPU is genuinely active only when this is a GPU-compiled build AND at
        // least one layer actually stayed on the card. In a CPU-only build
        // llama.cpp ignores `n_gpu_layers`, so the count alone would lie.
        let gpu_active_now = is_gpu_build && offloaded_layers > 0;
        let total_layers = model.n_layer();
        // llama clamps a request above the model's layer count, so report what
        // actually landed on the card, not what we asked for.
        let on_gpu = if gpu_active_now { offloaded_layers.min(total_layers) } else { 0 };
        *GPU_ACTIVE.lock() = gpu_active_now;
        *GPU_LAYERS.lock() = (on_gpu, total_layers);
        if gpu_active_now {
            tracing::info!(gpu_layers = on_gpu, n_layer = total_layers, "GPU offload active");
        } else if is_gpu_build {
            tracing::warn!("model runs fully on CPU — GPU offload unavailable");
        }

        // The model's real training window — the ceiling the UI offers and the
        // value `ctx_len` was already clamped against inside `attempt`.
        let n_ctx_train = model.n_ctx_train();

        let name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        // A4: prefer the template the model itself declares over anything
        // guessed from the filename.
        let chat_template = model.chat_template(None).ok();
        let max = effective_pool_cap(gpu_active_now);
        if gpu_active_now && max == 1 && std::env::var_os("FERAL_MAX_LOCAL_CONTEXTS").is_none() {
            tracing::info!(
                "GPU offload active — capping context pool at 1 (each context = full KV cache in VRAM; \
                 set FERAL_MAX_LOCAL_CONTEXTS=N to override for cards with enough VRAM for parallel decodes)"
            );
        }
        tracing::info!(
            path = ?path,
            ctx_len,
            max_contexts = max,
            gguf_template = chat_template.is_some(),
            lora = lora.as_ref().map(|l| l.path.display().to_string()),
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
            lora,
        }));
        Ok((ctx_len, n_ctx_train))
    }

    pub fn unload() {
        // Drop our reference to the loaded state. Generations already in
        // flight hold their own Arc and finish undisturbed; the model and
        // every pooled context are freed when the last Arc drops (within
        // each PooledContext, the context drops before the model Arc by
        // field order).
        let state = STATE.lock().take();
        // Say what actually happened. `Arc::strong_count == 1` means ours was
        // the last reference and the weights + KV caches are freed by the time
        // this line runs. Anything higher means a generation is still in
        // flight holding its own Arc: the release is DEFERRED to whenever that
        // finishes, and on Windows the GGUF stays mapped (and undeletable)
        // until then. The previous unconditional "model unloaded" read as a
        // completed release and made the mmap-still-held case look impossible.
        match state.as_ref().map(Arc::strong_count) {
            None => tracing::info!("unload: no model was loaded"),
            Some(1) => tracing::info!("model unloaded (pool + KV caches released)"),
            Some(n) => tracing::warn!(
                in_flight = n - 1,
                "unload requested while {} generation(s) still hold the model — \
                 weights stay resident (and the GGUF stays memory-mapped) until they finish",
                n - 1
            ),
        }
        drop(state);
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

    /// Bumped by `unload()`. A generation captures the epoch at start and
    /// stops at the next token once it changes — an unload must actually
    /// release VRAM, and an in-flight generation holding the model Arc
    /// would otherwise keep the old weights resident (on an 8 GB card the
    /// follow-up load then OOMs and silently lands on CPU).
    static GENERATION_EPOCH: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(0);
    /// Live generation count — `ModelManager::load` waits for 0 after an
    /// unload so the old model's Arcs are really gone before allocating.
    pub static ACTIVE_GENERATIONS: std::sync::atomic::AtomicUsize =
        std::sync::atomic::AtomicUsize::new(0);

    pub fn bump_generation_epoch() {
        GENERATION_EPOCH.fetch_add(1, Ordering::SeqCst);
    }

    pub fn generate(
        messages: Vec<Message>,
        params: InferParams,
        stop: Arc<AtomicBool>,
        on_start: Option<Box<dyn Fn(u32) + Send + 'static>>,
    ) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel(256);
        let epoch = GENERATION_EPOCH.load(Ordering::SeqCst);
        tokio::task::spawn_blocking(move || {
            ACTIVE_GENERATIONS.fetch_add(1, Ordering::SeqCst);
            // Decrement on every exit path (including panics) so a stuck
            // counter can never wedge future loads.
            struct Guard;
            impl Drop for Guard {
                fn drop(&mut self) {
                    ACTIVE_GENERATIONS.fetch_sub(1, Ordering::SeqCst);
                }
            }
            let _guard = Guard;
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
                let mut pctx = state.pool.acquire(&state.model, state.ctx_len, state.lora.as_ref())?;
                let result = run_inference(
                    &state,
                    &mut pctx,
                    &messages,
                    &params,
                    &tx,
                    &stop,
                    epoch,
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
        // The decode loop's inputs: model state, context, prompt, sampling,
        // sink, stop flag, epoch, callback. All distinct, none removable.
        #[allow(clippy::too_many_arguments)]
        fn run_inference(
            state: &LoadedState,
            pctx: &mut PooledContext,
            messages: &[Message],
            params: &InferParams,
            tx: &mpsc::Sender<String>,
            stop: &Arc<AtomicBool>,
            epoch: u64,
            on_start: Option<&(dyn Fn(u32) + Send)>,
        ) -> Result<()> {
            // ── Phase 1: tokenize + build sampler (model only) ──
            let model: &LlamaModel = &state.model;
            // A4: the GGUF-declared template wins; the filename heuristic is
            // only a fallback for models that don't ship one (or whose
            // template the llama.cpp engine can't render).
            let gguf_prompt = build_prompt_gguf(state, messages);
            let used_gguf = gguf_prompt.is_some();
            let mut prompt = gguf_prompt.unwrap_or_else(|| build_prompt(messages, &state.name));
            // Tier 0 fix (thinking burn): Qwen3/3.5 IGNORE the `/no_think`
            // soft switch and burn the whole eval budget inside <think>,
            // truncating the graded answer. When a system message carries
            // the switch and this is a Qwen, enforce it at template level
            // by prefilling an empty think block — the same thing
            // llama.cpp's enable_thinking=false does.
            if super::wants_nothink_prefill(messages, &state.name)
                && prompt.ends_with("<|im_start|>assistant\n")
            {
                prompt.push_str("<think>\n\n</think>\n\n");
            }
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
                // Two stop reasons: the caller's flag, and a model unload
                // under our feet (epoch bump) — the generation must release
                // its Arc quickly so the next load gets the VRAM back.
                if stop.load(Ordering::Relaxed)
                    || GENERATION_EPOCH.load(Ordering::SeqCst) != epoch
                {
                    break;
                }

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
#[cfg(feature = "inference")]
mod load_failure_tests {
    use super::backend::explain_load_failure;
    use std::io::Write;

    /// Every one of these used to reach the user as "null result from llama cpp".
    #[test]
    fn explains_the_three_reasons_a_model_will_not_open() {
        let dir = std::env::temp_dir().join("feral-load-explain");
        std::fs::create_dir_all(&dir).unwrap();

        let empty = dir.join("empty.gguf");
        std::fs::File::create(&empty).unwrap();
        let msg = explain_load_failure(&empty, "null result from llama cpp");
        assert!(msg.contains("did not finish"), "{msg}");

        let html = dir.join("notamodel.gguf");
        std::fs::File::create(&html).unwrap().write_all(b"<!DOCTYPE html>").unwrap();
        let msg = explain_load_failure(&html, "null result from llama cpp");
        assert!(msg.contains("not a GGUF"), "{msg}");

        // A well-formed header that the engine still refuses: the remaining
        // cause is an architecture this build predates, and the message has to
        // say what to do about it rather than quoting a null.
        let good = dir.join("newarch.gguf");
        std::fs::File::create(&good).unwrap().write_all(b"GGUF   ").unwrap();
        let msg = explain_load_failure(&good, "null result from llama cpp");
        // Deliberately NOT asserting a cause. The first version of this
        // message blamed the architecture; the file that prompted it declares
        // `qwen35`, which both the old and the new engine support, and it is
        // complete to the byte. What the message must do is stop guessing and
        // point at the log that now carries llama.cpp's own reason.
        assert!(msg.contains("refused to open"), "{msg}");
        assert!(msg.contains("Open logs"), "{msg}");
        assert!(!msg.contains("newer than"), "the message must not invent a cause: {msg}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── fit_gpu_layers (partial offload sizing) ───────────────────────────────

    const MB: u64 = 1024 * 1024;
    const GB: u64 = 1024 * MB;

    #[test]
    fn offloads_every_layer_when_the_model_fits_comfortably() {
        // 8B Q4 (~4.5 GB) on a 24 GB card: everything goes on the GPU.
        let n = fit_gpu_layers(24 * 1024, 4_500 * MB, 1024, 8192, 32);
        assert_eq!(n, 32);
    }

    #[test]
    fn offloads_partially_instead_of_collapsing_to_cpu() {
        // THE case this exists for: a 7 GB model on an 8 GB card. It does NOT
        // fit whole — the old all-or-nothing path therefore ran the entire model
        // on CPU. It must now keep most layers on the GPU.
        let n = fit_gpu_layers(8 * 1024, 7 * GB, 1024, 8192, 32);
        assert!(n > 0, "must not collapse to CPU when the card can hold layers");
        assert!(n < 32, "must not claim the whole model fits");
    }

    #[test]
    fn keeps_headroom_so_the_load_does_not_fail() {
        // Model exactly the size of VRAM: without headroom this would "fit" and
        // then fail to allocate compute buffers, dropping to CPU.
        let n = fit_gpu_layers(8 * 1024, 8 * GB, 1024, 8192, 32);
        assert!(n < 32);
    }

    #[test]
    fn a_bigger_context_costs_layers() {
        // KV cache is per-layer and scales with the window, so a longer context
        // must offload fewer layers — not silently overcommit VRAM.
        let short = fit_gpu_layers(8 * 1024, 6 * GB, 1024, 4096, 32);
        let long = fit_gpu_layers(8 * 1024, 6 * GB, 1024, 65536, 32);
        assert!(long < short, "long context must reserve more KV and offload less");
    }

    #[test]
    fn gqa_model_offloads_more_than_a_wide_kv_one() {
        // Same weights, smaller KV head dim (GQA) → cheaper cache → more layers.
        let gqa = fit_gpu_layers(8 * 1024, 6 * GB, 512, 32768, 32);
        let mha = fit_gpu_layers(8 * 1024, 6 * GB, 4096, 32768, 32);
        assert!(gqa > mha);
    }

    #[test]
    fn unknown_vram_or_empty_model_plans_nothing() {
        assert_eq!(fit_gpu_layers(0, 4 * GB, 1024, 8192, 32), 0);
        assert_eq!(fit_gpu_layers(8 * 1024, 4 * GB, 1024, 8192, 0), 0);
    }

    #[test]
    fn a_tiny_card_takes_only_the_few_layers_it_can_hold() {
        // 2 GB card, 13 GB model: after headroom there is ~1 GB, and a layer
        // costs ~356 MB — so a couple of layers go to the GPU and the rest stay
        // on CPU. Small, but that IS the llama.cpp behaviour, and it never
        // overcommits: the count stays far below the model's 40 layers.
        let n = fit_gpu_layers(2 * 1024, 13 * GB, 1024, 8192, 40);
        assert!(n <= 3, "must not overcommit a small card, got {n}");
        assert!(n < 40);
    }

    #[test]
    fn no_vram_left_after_headroom_means_cpu() {
        // A 1 GB card: headroom alone consumes the budget → honest CPU.
        assert_eq!(fit_gpu_layers(1024, 4 * GB, 1024, 8192, 32), 0);
    }

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
        assert!(!"ministral".contains("mistral"), "substring check changed");
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
    fn nothink_prefill_gated_on_qwen_and_system_switch() {
        let with_switch = vec![msg("system", "Do the eval. /no_think"), msg("user", "Q")];
        let without = vec![msg("system", "Do the eval."), msg("user", "Q")];
        assert!(wants_nothink_prefill(&with_switch, "Qwen3.5-4B-Q8_0.gguf"));
        assert!(!wants_nothink_prefill(&without, "Qwen3.5-4B-Q8_0.gguf"));
        assert!(!wants_nothink_prefill(&with_switch, "Mistral-7B.gguf"));
        // /no_think in a USER message does not opt in (system-only switch).
        let user_only = vec![msg("user", "hello /no_think")];
        assert!(!wants_nothink_prefill(&user_only, "qwen3.5"));
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

    // ── effective_pool_cap ───────────────────────────────────────────────────
    // The pool cap dictates how many KV caches are kept warm simultaneously.
    // On GPU each context = full KV in VRAM, so 2 contexts on an 8 GB card
    // blows up mid-generation with `create context: null reference`. The
    // user override (FERAL_MAX_LOCAL_CONTEXTS) must always win — power users
    // with 24 GB cards want 2 for overlapping generations.

    #[cfg(feature = "inference")]
    #[test]
    fn pool_cap_gpu_default_is_one() {
        // No env override, GPU active → 1 (each context = full KV cache in VRAM).
        assert_eq!(backend::effective_pool_cap_with_env(true, None), 1);
    }

    #[cfg(feature = "inference")]
    #[test]
    fn pool_cap_cpu_default_is_two() {
        // No env override, CPU only → 2 (RAM is plentiful, parallel decodes fine).
        assert_eq!(backend::effective_pool_cap_with_env(false, None), 2);
    }

    #[cfg(feature = "inference")]
    #[test]
    fn pool_cap_env_override_wins_on_gpu() {
        // Power user with 24 GB card opts into 2 parallel decodes.
        assert_eq!(backend::effective_pool_cap_with_env(true, Some(2)), 2);
    }

    #[cfg(feature = "inference")]
    #[test]
    fn pool_cap_env_override_wins_on_cpu() {
        // Single-context user (laptop, RAM-tight) overrides to 1.
        assert_eq!(backend::effective_pool_cap_with_env(false, Some(1)), 1);
    }

    #[cfg(feature = "inference")]
    #[test]
    fn pool_cap_env_override_higher_than_two_works() {
        // RTX 3090/4090 user with plenty of VRAM opts into 3 — passes through.
        assert_eq!(backend::effective_pool_cap_with_env(true, Some(3)), 3);
    }

    // ── Real-GGUF load smoke ─────────────────────────────────────────────
    // Gated on `FERAL_SMOKE_GGUF=/path/to/file.gguf` so CI without a model
    // file on disk stays green. When set, this test loads the GGUF through
    // the real `backend::load` path (CPU, n_gpu_layers=0) and asserts the
    // three guarantees the user-noted ctx-window changes promise:
    //   1. ctx_len > 0
    //   2. ctx_len <= n_ctx_train      (no eager-KV overflow crash)
    //   3. ctx_len >= 2048             (the floor)
    // Runs in `cargo test --features inference --lib -- --nocapture
    // load_smoke_real_gguf`. Skipped otherwise.

    #[test]
    fn load_smoke_real_gguf() {
        let path = match std::env::var("FERAL_SMOKE_GGUF").ok() {
            Some(p) if !p.is_empty() => std::path::PathBuf::from(p),
            _ => {
                eprintln!("[load_smoke_real_gguf] FERAL_SMOKE_GGUF not set — skipping");
                return;
            }
        };
        if !path.exists() {
            eprintln!(
                "[load_smoke_real_gguf] GGUF not present at {} — skipping",
                path.display()
            );
            return;
        }
        let manager = ModelManager::new();
        let loaded = manager
            .load(path.clone(), 0, None)
            .expect("real-GGUF load via ModelManager::load");
        assert!(loaded.ctx_len > 0, "ctx_len must be > 0 (got {})", loaded.ctx_len);
        assert!(
            loaded.ctx_len <= loaded.n_ctx_train,
            "ctx_len ({}) must be <= n_ctx_train ({})",
            loaded.ctx_len,
            loaded.n_ctx_train
        );
        assert!(
            loaded.ctx_len >= 2048,
            "ctx_len ({}) must be >= 2048 floor",
            loaded.ctx_len
        );
        eprintln!(
            "[load_smoke_real_gguf] {} loaded: ctx_len={} n_ctx_train={}",
            loaded.name, loaded.ctx_len, loaded.n_ctx_train
        );
    }
}

#[cfg(all(test, feature = "inference"))]
mod auto_context_tests {
    use super::backend::{context_for_budget, kv_bytes_per_token};

    /// qwen2.5-coder-1.5b — the model that exposed this. 28 layers, n_embd
    /// 1536, 12 heads, 2 KV heads (GQA). Loaded at a flat 8192 while training
    /// at 32768, which left the agent ~3k tokens of transcript and made it
    /// compact on every turn.
    const QWEN_25_CODER_1_5B: (u64, u64, u64, u64) = (28, 1536, 12, 2);

    #[test]
    fn gqa_is_honored_not_flat_n_embd() {
        let (l, e, h, hkv) = QWEN_25_CODER_1_5B;
        // kv_dim = 1536 * 2 / 12 = 256 → 2 * 256 * 2 * 28 = 28_672 B/token.
        assert_eq!(kv_bytes_per_token(l, e, h, hkv), 28_672);
        // Flat n_embd would say 172_032 — 6x too expensive, which is how a
        // cheap model gets pinned to the conservative floor for no reason.
        assert!(kv_bytes_per_token(l, e, h, h) > kv_bytes_per_token(l, e, h, hkv));
    }

    #[test]
    fn qwen_reaches_its_full_trained_context_on_a_normal_box() {
        let bpt = kv_bytes_per_token(QWEN_25_CODER_1_5B.0, QWEN_25_CODER_1_5B.1, QWEN_25_CODER_1_5B.2, QWEN_25_CODER_1_5B.3);
        // 8 GB free / 4 = 2 GB budget. 32768 tokens costs ~940 MB, so it fits.
        let budget = 2u64 * 1024 * 1024 * 1024;
        assert_eq!(context_for_budget(bpt, budget, 8192, 32_768), 32_768);
    }

    #[test]
    fn a_low_memory_box_never_regresses_below_the_old_default() {
        let bpt = kv_bytes_per_token(QWEN_25_CODER_1_5B.0, QWEN_25_CODER_1_5B.1, QWEN_25_CODER_1_5B.2, QWEN_25_CODER_1_5B.3);
        assert_eq!(context_for_budget(bpt, 0, 8192, 32_768), 8192);
        assert_eq!(context_for_budget(bpt, 1024 * 1024, 8192, 32_768), 8192);
    }

    #[test]
    fn a_huge_box_still_respects_the_ceiling() {
        let bpt = kv_bytes_per_token(QWEN_25_CODER_1_5B.0, QWEN_25_CODER_1_5B.1, QWEN_25_CODER_1_5B.2, QWEN_25_CODER_1_5B.3);
        let budget = 512u64 * 1024 * 1024 * 1024; // 512 GB
        assert_eq!(context_for_budget(bpt, budget, 8192, 32_768), 32_768);
    }

    #[test]
    fn a_fat_model_is_sized_down_not_up() {
        // 70B-class geometry: 80 layers, n_embd 8192, MHA (no GQA saving).
        let bpt = kv_bytes_per_token(80, 8192, 64, 64);
        // 2 GB budget cannot hold much of that — floor applies, not the ceiling.
        let budget = 2u64 * 1024 * 1024 * 1024;
        assert_eq!(context_for_budget(bpt, budget, 8192, 32_768), 8192);
    }

    #[test]
    fn degenerate_geometry_falls_back_to_the_floor() {
        assert_eq!(context_for_budget(0, 1 << 30, 8192, 32_768), 8192);
        assert_eq!(kv_bytes_per_token(28, 1536, 0, 0), 2 * 1536 * 2 * 28);
    }
}
