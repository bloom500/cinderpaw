//! Ollama-compatible HTTP API on port 11435.
use axum::{
    extract::State,
    http::{HeaderValue, StatusCode},
    response::sse::{Event, Sse},
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use futures::stream::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::inference::{InferParams, Message, ModelManager};
use crate::models;

#[derive(Clone)]
pub struct ApiState {
    pub manager: Arc<ModelManager>,
}

pub fn router(state: ApiState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            origin.as_bytes().starts_with(b"http://localhost")
                || origin.as_bytes().starts_with(b"http://127.0.0.1")
        }))
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    Router::new()
        // Ollama-compatible
        .route("/api/tags", get(api_tags))
        .route("/api/show", post(api_show))
        .route("/api/generate", post(api_generate))
        .route("/api/chat", post(api_chat))
        .route("/api/delete", delete(api_delete))
        // OpenAI-compatible aliases
        .route("/v1/models", get(v1_models))
        .route("/v1/chat/completions", post(v1_chat_completions))
        .with_state(state)
        .layer(cors)
}

pub async fn serve(state: ApiState, port: u16) -> anyhow::Result<()> {
    let app = router(state);
    let addr = format!("0.0.0.0:{}", port);
    tracing::info!(%addr, "feral api listening");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn api_tags() -> impl IntoResponse {
    let models = models::scan_models_dir().unwrap_or_default();
    let items: Vec<Value> = models.into_iter().map(|m| {
        json!({
            "name": m.name,
            "model": m.id,
            "size": m.size_bytes,
            "details": {
                "quantization_level": m.quant,
                "format": "gguf",
            }
        })
    }).collect();
    Json(json!({ "models": items }))
}

#[derive(Deserialize)]
struct ShowReq { name: String }

async fn api_show(Json(req): Json<ShowReq>) -> impl IntoResponse {
    let models = models::scan_models_dir().unwrap_or_default();
    match models.into_iter().find(|m| m.name == req.name || m.id == req.name) {
        Some(m) => Json(json!({
            "model": m.name,
            "size": m.size_bytes,
            "quant": m.quant,
            "modelfile": m.modelfile,
        })).into_response(),
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

#[derive(Deserialize)]
struct DeleteReq { name: String }

async fn api_delete(Json(req): Json<DeleteReq>) -> impl IntoResponse {
    let path = crate::paths::models_dir().join(&req.name);
    match models::delete_model(&path) {
        Ok(_) => StatusCode::OK,
        Err(_) => StatusCode::NOT_FOUND,
    }
}

#[derive(Deserialize)]
struct GenerateReq {
    model: String,
    prompt: String,
    #[serde(default)]
    stream: Option<bool>,
    #[serde(default)]
    options: Option<Value>,
    #[serde(default)]
    max_tokens: Option<u32>,
}

async fn api_generate(
    State(state): State<ApiState>,
    Json(req): Json<GenerateReq>,
) -> impl IntoResponse {
    let messages = vec![Message { role: "user".into(), content: req.prompt }];
    let mut params = params_from_options(req.options.as_ref());
    apply_max_tokens(&mut params, req.max_tokens);

    if req.stream.unwrap_or(true) {
        sse_from_chat(state, req.model, messages, params, false).into_response()
    } else {
        let text = collect_chat(&state, messages, params).await;
        Json(json!({
            "model": req.model,
            "response": text,
            "done": true,
        })).into_response()
    }
}

/// OpenAI-compatible message content: either a plain string or an array of
/// content parts (`[{ "type": "text", "text": "..." }, ...]`). OpenAI-spec
/// clients send the array form; llama.cpp only needs the text.
#[derive(Deserialize)]
#[serde(untagged)]
enum FlexContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

#[derive(Deserialize)]
struct ContentPart {
    #[serde(default)]
    text: Option<String>,
}

impl FlexContent {
    /// Flatten to a single string. Array parts are concatenated; non-text
    /// parts (images, etc.) contribute nothing since llama.cpp is text-only.
    fn into_string(self) -> String {
        match self {
            FlexContent::Text(s) => s,
            FlexContent::Parts(parts) => parts
                .into_iter()
                .filter_map(|p| p.text)
                .collect::<Vec<_>>()
                .join(""),
        }
    }
}

#[derive(Deserialize)]
struct ApiMessage {
    role: String,
    #[serde(default)]
    content: Option<FlexContent>,
}

impl From<ApiMessage> for Message {
    fn from(m: ApiMessage) -> Self {
        Message {
            role: m.role,
            content: m.content.map(FlexContent::into_string).unwrap_or_default(),
        }
    }
}

#[derive(Deserialize)]
struct ChatReq {
    model: String,
    messages: Vec<ApiMessage>,
    #[serde(default)]
    stream: Option<bool>,
    #[serde(default)]
    options: Option<Value>,
    /// OpenAI-standard generation cap. OpenAI-spec clients send this at the
    /// top level (not nested under `options`). Without honoring it, every
    /// agent request fell back to the 1024-token default and ran for
    /// minutes of CPU inference, appearing to hang.
    #[serde(default)]
    max_tokens: Option<u32>,
}

impl ChatReq {
    /// Convert incoming OpenAI-style messages into Feral's internal `Message`.
    fn into_messages(self) -> Vec<Message> {
        self.messages.into_iter().map(Message::from).collect()
    }
}

async fn api_chat(
    State(state): State<ApiState>,
    Json(req): Json<ChatReq>,
) -> impl IntoResponse {
    let mut params = params_from_options(req.options.as_ref());
    apply_max_tokens(&mut params, req.max_tokens);
    let model = req.model.clone();
    let stream = req.stream.unwrap_or(true);
    let messages = req.into_messages();
    if stream {
        sse_from_chat(state, model, messages, params, false).into_response()
    } else {
        let text = collect_chat(&state, messages, params).await;
        Json(json!({
            "model": model,
            "message": { "role": "assistant", "content": text },
            "done": true,
        })).into_response()
    }
}

async fn v1_models() -> impl IntoResponse {
    let models = models::scan_models_dir().unwrap_or_default();
    let data: Vec<Value> = models.into_iter().map(|m| {
        json!({ "id": m.id, "object": "model", "owned_by": "feral" })
    }).collect();
    Json(json!({ "object": "list", "data": data }))
}

async fn v1_chat_completions(
    State(state): State<ApiState>,
    Json(req): Json<ChatReq>,
) -> impl IntoResponse {
    let mut params = params_from_options(req.options.as_ref());
    apply_max_tokens(&mut params, req.max_tokens);
    let model = req.model.clone();
    let stream = req.stream.unwrap_or(false);
    let messages = req.into_messages();
    if stream {
        sse_from_chat(state, model, messages, params, true).into_response()
    } else {
        let text = collect_chat(&state, messages, params).await;
        Json(json!({
            "id": format!("chatcmpl-{}", uuid::Uuid::new_v4()),
            "object": "chat.completion",
            "model": model,
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": text },
                "finish_reason": "stop",
            }],
        })).into_response()
    }
}

/// Apply the OpenAI-standard top-level `max_tokens` over whatever
/// `params_from_options` produced. A request that explicitly asks for fewer
/// tokens must win over the 1024-token default; `0` is ignored as a no-op.
fn apply_max_tokens(params: &mut InferParams, max_tokens: Option<u32>) {
    if let Some(mt) = max_tokens {
        if mt > 0 {
            params.max_tokens = mt;
        }
    }
}

fn params_from_options(opts: Option<&Value>) -> InferParams {
    let mut p = InferParams::default();
    if let Some(o) = opts {
        if let Some(v) = o.get("temperature").and_then(|v| v.as_f64()) { p.temperature = v as f32; }
        if let Some(v) = o.get("top_p").and_then(|v| v.as_f64()) { p.top_p = v as f32; }
        if let Some(v) = o.get("repeat_penalty").and_then(|v| v.as_f64()) { p.repeat_penalty = v as f32; }
        if let Some(v) = o.get("num_predict").and_then(|v| v.as_u64()) { p.max_tokens = v as u32; }
    }
    p
}

async fn collect_chat(state: &ApiState, messages: Vec<Message>, params: InferParams) -> String {
    use futures::StreamExt;
    let stop = Arc::new(AtomicBool::new(false));
    let mut out = String::new();
    let mut stream = Box::pin(state.manager.stream_chat(messages, params, stop));
    while let Some(tok) = stream.next().await {
        match tok {
            Ok(t) => out.push_str(&t),
            Err(e) => { tracing::warn!("token error: {}", e); break; }
        }
    }
    out
}

fn sse_from_chat(
    state: ApiState,
    model: String,
    messages: Vec<Message>,
    params: InferParams,
    openai_format: bool,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    use async_stream::stream;
    use futures::StreamExt;

    let s = stream! {
        let stop = Arc::new(AtomicBool::new(false));
        let mut chat = Box::pin(state.manager.stream_chat(messages, params, stop));
        while let Some(tok) = chat.next().await {
            let t = match tok { Ok(t) => t, Err(e) => { tracing::warn!("sse token error: {}", e); break; } };
            let payload = if openai_format {
                json!({
                    "id": "chatcmpl-stream",
                    "object": "chat.completion.chunk",
                    "model": model,
                    "choices": [{ "index": 0, "delta": { "content": t } }],
                })
            } else {
                json!({
                    "model": model,
                    "message": { "role": "assistant", "content": t },
                    "done": false,
                })
            };
            yield Ok::<_, Infallible>(Event::default().data(payload.to_string()));
        }
        let done = if openai_format {
            json!({
                "id": "chatcmpl-stream",
                "object": "chat.completion.chunk",
                "model": model,
                "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
            })
        } else {
            json!({ "model": model, "done": true })
        };
        yield Ok(Event::default().data(done.to_string()));

        // OpenAI streaming protocol terminates with `data: [DONE]`. The
        // SSE parser waits for this sentinel — without it the stream is treated
        // as an incomplete terminal response.
        if openai_format {
            yield Ok(Event::default().data("[DONE]"));
        }
    };
    Sse::new(s)
}
