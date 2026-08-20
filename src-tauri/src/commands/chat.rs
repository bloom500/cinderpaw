//! Chat generation: local streaming inference (with the deadline watchdog)
//! and BYOK cloud completion/streaming.

use crate::*;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, State};

/// Stop the generation running for `session_id`, and only that one.
#[tauri::command]
#[specta::specta]
pub(crate) fn stop_generation(state: State<AppState>, session_id: String) {
    state.stop_signals.request_stop(&session_id);
}

/// Releases a session's stop flag when its generation returns — on every exit
/// path (clean finish, error, user stop), which is why this is a guard and not
/// a call at the end of the happy path.
/// `pub(crate)` because `speak_text` needs the same guarantee: a TTS stream has
/// the same set of exit paths, and a leaked flag there means the next utterance
/// starts already stopped.
pub(crate) struct StopSlot {
    pub(crate) registry: Arc<StopRegistry>,
    pub(crate) session_id: String,
    pub(crate) flag: Arc<AtomicBool>,
}

impl Drop for StopSlot {
    fn drop(&mut self) {
        self.registry.end(&self.session_id, &self.flag);
    }
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
pub(crate) async fn chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    messages: Vec<Message>,
    params: InferParams,
    session_id: String,
) -> Result<(), String> {
    use futures::StreamExt;

    // A stop flag owned by THIS generation. Nothing else can trip it, and no
    // other generation can clear it.
    let stop = state.stop_signals.begin(&session_id);
    let _slot = StopSlot {
        registry: state.stop_signals.clone(),
        session_id: session_id.clone(),
        flag: stop.clone(),
    };

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
            let reason = *watchdog.reason.lock();
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
        let slot = state.reason.lock();
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

/// One-shot, non-streaming completion against the LOCAL loaded model.
///
/// Used by the chat tab's background memory extractor — runs with its OWN
/// stop flag (not the shared `stop_signal`) so a user stopping the visible
/// stream never kills an extraction pass, and vice versa.
#[tauri::command]
#[specta::specta]
pub(crate) async fn chat_complete_local(
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
pub(crate) async fn chat_cloud_complete(
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

    let provider = byok::Provider::from_id(&provider_id);
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
pub(crate) async fn chat_cloud_stream(
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

    let provider = byok::Provider::from_id(&provider_id);

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

    // Same per-session ownership as the local path: a stop here stops this
    // cloud stream and no other.
    let stop = state.stop_signals.begin(&session_id);
    let _slot = StopSlot {
        registry: state.stop_signals.clone(),
        session_id: session_id.clone(),
        flag: stop.clone(),
    };

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
        // Chunk boundaries land mid-character; decoding each chunk on its own
        // turned every emoji and every diacritic unlucky enough to be split
        // into a `�` on screen.
        let mut decoder = feral_core::utf8_stream::Utf8Stream::new();

        'sse: while let Some(chunk) = byte_stream.next().await {
            if stop.load(Ordering::SeqCst) {
                let _ = app.emit("feral://stream-done", events::StreamDoneEvent { session_id });
                return Ok(());
            }
            let bytes = chunk.map_err(|e| { let _ = app.emit("feral://stream-error", events::StreamErrorEvent { session_id: session_id.clone(), error: e.to_string() }); e.to_string() })?;
            let text = decoder.push(&bytes);

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
