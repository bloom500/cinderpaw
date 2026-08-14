//! One live call: a socket, two channels, and the rule that setup goes first.
//!
//! The shape is deliberately the same one the TTS engines use — bytes over an
//! `mpsc` channel, dropping the receiver means stop — so the call loop upstream
//! does not have to learn a second idiom for "audio is arriving".
//!
//! What is different is that this direction runs both ways at once. A turn is
//! not request-then-response: the microphone keeps sending while the model is
//! answering, because that is how the user interrupts it.

use anyhow::{anyhow, Result};
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::{
    audio_chunk, ClientMessage, FunctionCall, FunctionDeclaration, FunctionResponse, RealtimeInput,
    ServerMessage, Setup, ToolResponse, LIVE_WS_URL,
};

/// How long to wait for the server to accept the setup message before giving up.
/// Long enough for a slow link, short enough that a wrong key or a bad model id
/// surfaces as an error instead of a call that never starts.
const SETUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// What a session that dies during setup almost always means.
///
/// The model id is named first because it is the one that fails silently: a key
/// this far along has already passed the HTTP handshake, so it is rarely the
/// cause by the time the socket is open and the setup has gone out.
const REJECTED: &str =
    "live: the server rejected the session — check the model id, then the API key";

/// What the runtime hears from the model.
#[derive(Debug, Clone)]
pub enum LiveEvent {
    /// 24 kHz mono 16-bit LE PCM, ready for the player as-is.
    Audio(Vec<u8>),
    /// The user talked over the answer. The reference is explicit about the
    /// response: stop playing and empty the queue. This is barge-in, and unlike
    /// ours it is the model's own judgement rather than a loudness threshold.
    Interrupted,
    TurnComplete,
    /// What the user was heard saying, and what the model said back. The only
    /// text a spoken call produces — without these there is nothing to show on
    /// screen or hand to memory afterwards.
    InputTranscript(String),
    OutputTranscript(String),
    ToolCall(Vec<FunctionCall>),
    /// These calls were interrupted and must not be answered. Any that already
    /// ran may need undoing — the server cannot know what they touched.
    ToolCallCancelled(Vec<String>),
    /// The socket ended. Carries the reason, already stripped of the API key.
    Closed(String),
}

/// What the runtime says to the model.
#[derive(Debug, Clone)]
pub enum LiveCommand {
    /// A slice of microphone PCM at [`super::AUDIO_IN_HZ`].
    Audio(Vec<u8>),
    /// The microphone closed. Only meaningful while the server is doing its own
    /// activity detection, which is the default and the entire point here.
    AudioStreamEnd,
    ToolResponse(Vec<FunctionResponse>),
}

pub struct SessionConfig {
    pub api_key: String,
    /// Bare id or `models/…`; both work.
    pub model: String,
    /// Injected into the setup message. Where the pre-call memory lookup lands.
    pub system_instruction: Option<String>,
    pub tools: Vec<FunctionDeclaration>,
}

/// A live call in progress. Dropping `commands` closes the session.
pub struct LiveHandle {
    pub commands: mpsc::Sender<LiveCommand>,
    pub events: mpsc::Receiver<LiveEvent>,
}

/// The API key travels as a query parameter, which makes the connection URL a
/// secret. It reaches error strings, logs and the UI unless something removes
/// it first, and a key pasted into a bug report is a key that has to be rotated.
///
/// Everything user-visible goes through here.
pub(crate) fn redact(text: &str, key: &str) -> String {
    if key.is_empty() {
        return text.to_string();
    }
    text.replace(key, "…")
}

/// Open a session and wait until the server has accepted it.
///
/// Returns only after `setupComplete`. Callers therefore cannot send audio into
/// a socket that is not ready — a rule the API states and that would otherwise
/// have to be remembered at every call site.
pub async fn connect(cfg: SessionConfig) -> Result<LiveHandle> {
    let url = format!("{LIVE_WS_URL}?key={}", cfg.api_key);
    let key = cfg.api_key.clone();

    let (stream, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| anyhow!("live: connect failed: {}", redact(&e.to_string(), &key)))?;
    let (mut write, mut read) = stream.split();

    let mut setup = Setup::spoken(&cfg.model, cfg.tools);
    if let Some(instruction) = cfg.system_instruction {
        setup = setup.with_system_instruction(instruction);
    }
    let setup_json = serde_json::to_string(&ClientMessage::Setup(setup))?;
    write
        .send(Message::Text(setup_json.into()))
        .await
        .map_err(|e| anyhow!("live: setup send failed: {}", redact(&e.to_string(), &key)))?;

    // Nothing else may go out until the server answers. A server that never
    // answers is the failure mode a timeout exists for: without it a wrong model
    // id waits forever with the microphone open.
    let accepted = tokio::time::timeout(SETUP_TIMEOUT, async {
        while let Some(frame) = read.next().await {
            // A setup the server will not accept is not answered — the socket is
            // simply dropped, and the transport reports whatever it saw, which
            // for TLS is a stream that ended without `close_notify`. Passed
            // through verbatim that reads as a network fault and sends whoever
            // is debugging it to the wrong layer entirely. The cause is on this
            // side of the wire every time, so the message says so and keeps the
            // transport detail after it.
            let frame = frame.map_err(|e| anyhow!("{REJECTED}: {}", redact(&e.to_string(), &key)))?;
            // The server says WHY here, and nowhere else. This arm was missing,
            // and its absence cost an afternoon: a refused session was reported
            // as a truncated TLS stream — true, useless, and pointing at the
            // network — while the close frame sitting one match arm away read
            // "Your prepayment credits are depleted". Never guess when the peer
            // has already answered.
            if let Message::Close(reason) = &frame {
                return Err(match reason {
                    Some(c) => anyhow!("live: {}", redact(&c.reason, &key)),
                    None => anyhow!("{REJECTED}"),
                });
            }
            if let Some(msg) = parse(&frame) {
                if msg.setup_complete.is_some() {
                    return Ok(());
                }
                // The server reports a rejected setup by closing, not by
                // replying, so anything else this early is worth surfacing.
                if let Some(content) = &msg.server_content {
                    if content.turn_complete {
                        return Err(anyhow!("live: the server answered before accepting setup"));
                    }
                }
            }
        }
        Err(anyhow!("{REJECTED}: the socket closed before setup was accepted"))
    })
    .await;
    match accepted {
        Err(_) => return Err(anyhow!("live: no setupComplete within {SETUP_TIMEOUT:?}")),
        Ok(Err(e)) => return Err(e),
        Ok(Ok(())) => {}
    }

    let (event_tx, events) = mpsc::channel::<LiveEvent>(64);
    let (commands, mut command_rx) = mpsc::channel::<LiveCommand>(64);

    // Shared so the close frame can be logged next to what preceded it — the
    // two halves of the answer live in different tasks.
    let journal = std::sync::Arc::new(parking_lot::Mutex::new(Journal::default()));

    // Inbound: socket → events.
    {
        let key = key.clone();
        let event_tx = event_tx.clone();
        let journal = journal.clone();
        tokio::spawn(async move {
            let reason = loop {
                match read.next().await {
                    None => break "closed".to_string(),
                    Some(Err(e)) => break redact(&e.to_string(), &key),
                    // Same reason as during setup: a call dropped mid-conversation
                    // (quota spent, session length exceeded) is explained in the
                    // close frame and nowhere else.
                    Some(Ok(Message::Close(reason))) => {
                        break match reason {
                            Some(c) => redact(&c.reason, &key),
                            None => "closed".to_string(),
                        }
                    }
                    Some(Ok(frame)) => {
                        let Some(msg) = parse(&frame) else { continue };
                        journal.lock().note(false, inbound_kind(&msg), frame.len());
                        // A send failure means the caller stopped listening —
                        // the call is over, and pumping into a closed channel
                        // would spin.
                        if !emit(&event_tx, msg).await {
                            return;
                        }
                    }
                }
            };
            // The whole point of the journal: printed WITH the reason, so the
            // two are read together instead of the reason being read alone and
            // taken at face value.
            tracing::warn!("live: closed — {reason}\n  {}", journal.lock().render());
            let _ = event_tx.send(LiveEvent::Closed(reason)).await;
        });
    }

    // Outbound: commands → socket. Ends when the sender is dropped, which is how
    // hanging up is expressed.
    tokio::spawn(async move {
        while let Some(cmd) = command_rx.recv().await {
            let msg = match cmd {
                LiveCommand::Audio(pcm) => audio_chunk(&pcm),
                LiveCommand::AudioStreamEnd => ClientMessage::RealtimeInput(RealtimeInput {
                    audio: None,
                    audio_stream_end: Some(true),
                }),
                LiveCommand::ToolResponse(responses) => {
                    ClientMessage::ToolResponse(ToolResponse { function_responses: responses })
                }
            };
            let kind = match &msg {
                ClientMessage::RealtimeInput(r) if r.audio_stream_end.is_some() => "audioStreamEnd",
                ClientMessage::RealtimeInput(_) => "audio",
                ClientMessage::ToolResponse(_) => "toolResponse",
                ClientMessage::Setup(_) => "setup",
            };
            let Ok(json) = serde_json::to_string(&msg) else { continue };
            journal.lock().note(true, kind, json.len());
            if write.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });

    Ok(LiveHandle { commands, events })
}

/// Server frames are JSON, as text or binary depending on the hop. Anything that
/// What crossed the wire just before the call ended.
///
/// A close frame on its own says WHY the server hung up but never WHAT it was
/// answering, and two afternoons went into guessing that from the message text.
/// This keeps the immediate history so the reason can be read in context: a
/// death right after a `toolResponse` and a death in the middle of an audio run
/// are different bugs that produce the identical sentence.
///
/// Consecutive same-kind frames are COUNTED, not listed. Audio arrives tens of
/// times a second, so a plain ring buffer holds about two seconds and can never
/// contain the tool call that preceded a death by a minute — which is exactly
/// the case worth seeing. Runs collapse to one line, so sixty entries cover a
/// whole call.
///
/// Sizes only, never payloads: this goes to a log file, and the audio is the
/// user's voice.
#[derive(Default)]
pub(crate) struct Journal {
    entries: std::collections::VecDeque<JournalEntry>,
}

struct JournalEntry {
    at: Option<std::time::Instant>,
    outbound: bool,
    kind: &'static str,
    count: u32,
    bytes: usize,
}

/// Enough to cover a call once runs are collapsed; small enough to log whole.
const JOURNAL_MAX: usize = 60;

impl Journal {
    fn note(&mut self, outbound: bool, kind: &'static str, bytes: usize) {
        if let Some(last) = self.entries.back_mut() {
            if last.outbound == outbound && last.kind == kind {
                last.count += 1;
                last.bytes += bytes;
                return;
            }
        }
        self.entries.push_back(JournalEntry {
            at: Some(std::time::Instant::now()),
            outbound,
            kind,
            count: 1,
            bytes,
        });
        if self.entries.len() > JOURNAL_MAX {
            self.entries.pop_front();
        }
    }

    /// One line per run, oldest first, with seconds since the run began.
    fn render(&self) -> String {
        let now = std::time::Instant::now();
        self.entries
            .iter()
            .map(|e| {
                let ago = e.at.map(|t| now.saturating_duration_since(t).as_secs_f32()).unwrap_or(0.0);
                let arrow = if e.outbound { "→" } else { "←" };
                if e.count > 1 {
                    format!("-{ago:.1}s {arrow} {}×{} {}B", e.kind, e.count, e.bytes)
                } else {
                    format!("-{ago:.1}s {arrow} {} {}B", e.kind, e.bytes)
                }
            })
            .collect::<Vec<_>>()
            .join("\n  ")
    }
}

/// The shape of a server message, for the journal. Cheap: reads flags that are
/// already parsed, never the payload.
fn inbound_kind(msg: &ServerMessage) -> &'static str {
    if msg.setup_complete.is_some() {
        return "setupComplete";
    }
    if msg.tool_call.is_some() {
        return "toolCall";
    }
    if msg.tool_call_cancellation.is_some() {
        return "toolCallCancellation";
    }
    match &msg.server_content {
        Some(c) if c.interrupted => "interrupted",
        Some(c) if c.turn_complete => "turnComplete",
        Some(c) if !c.audio().is_empty() => "audio",
        Some(c) if c.output_transcription.is_some() => "outTranscript",
        Some(c) if c.input_transcription.is_some() => "inTranscript",
        Some(_) => "serverContent",
        None => "other",
    }
}

/// is neither — ping, pong, close — is not a message for us.
fn parse(frame: &Message) -> Option<ServerMessage> {
    let bytes = match frame {
        Message::Text(t) => t.as_bytes(),
        Message::Binary(b) => b.as_ref(),
        _ => return None,
    };
    serde_json::from_slice(bytes).ok()
}

/// Fan one server message out into the events it implies. Returns false once the
/// receiver is gone.
async fn emit(tx: &mpsc::Sender<LiveEvent>, msg: ServerMessage) -> bool {
    if let Some(call) = msg.tool_call {
        if !call.function_calls.is_empty() && tx.send(LiveEvent::ToolCall(call.function_calls)).await.is_err() {
            return false;
        }
    }
    if let Some(cancel) = msg.tool_call_cancellation {
        if !cancel.ids.is_empty() && tx.send(LiveEvent::ToolCallCancelled(cancel.ids)).await.is_err() {
            return false;
        }
    }
    if let Some(content) = msg.server_content {
        // Interruption first, and before any audio from the same message: it
        // tells the player to drop what it is holding, and running that after
        // the new audio would throw the new audio away with the old.
        if content.interrupted && tx.send(LiveEvent::Interrupted).await.is_err() {
            return false;
        }
        let audio = content.audio();
        if !audio.is_empty() && tx.send(LiveEvent::Audio(audio)).await.is_err() {
            return false;
        }
        if let Some(t) = &content.input_transcription {
            if !t.text.is_empty() && tx.send(LiveEvent::InputTranscript(t.text.clone())).await.is_err() {
                return false;
            }
        }
        if let Some(t) = &content.output_transcription {
            if !t.text.is_empty() && tx.send(LiveEvent::OutputTranscript(t.text.clone())).await.is_err() {
                return false;
            }
        }
        if content.turn_complete && tx.send(LiveEvent::TurnComplete).await.is_err() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_key_never_survives_into_a_message_a_user_can_read() {
        // Deliberately not shaped like a real Google key: a realistic-looking
        // literal here trips every secret scanner that ever reads this repo,
        // and `redact` matches by substring, so the shape proves nothing.
        let key = "test-key-placeholder";
        let err = format!("failed to connect to {LIVE_WS_URL}?key={key}: 403");
        let safe = redact(&err, key);
        assert!(!safe.contains(key));
        assert!(safe.contains("403"), "the useful part of the error must survive");
        // An empty key must not turn every string into ellipses.
        assert_eq!(redact("plain error", ""), "plain error");
    }

    #[tokio::test]
    async fn one_message_can_produce_several_events_in_a_usable_order() {
        let (tx, mut rx) = mpsc::channel(16);
        let msg: ServerMessage = serde_json::from_value(json!({
            "serverContent": {
                "interrupted": true,
                "modelTurn": {"parts": [{"inlineData": {"mimeType": "audio/pcm", "data": "AQI="}}]},
                "outputTranscription": {"text": "hi"},
                "turnComplete": true
            }
        }))
        .unwrap();
        assert!(emit(&tx, msg).await);
        drop(tx);

        let mut seen = Vec::new();
        while let Some(ev) = rx.recv().await {
            seen.push(ev);
        }
        // Interrupted must arrive before the audio, or the player drops the new
        // audio along with the old.
        assert!(matches!(seen[0], LiveEvent::Interrupted));
        assert!(matches!(&seen[1], LiveEvent::Audio(pcm) if pcm == &[0x01, 0x02]));
        assert!(matches!(&seen[2], LiveEvent::OutputTranscript(t) if t == "hi"));
        assert!(matches!(seen[3], LiveEvent::TurnComplete));
    }

    #[tokio::test]
    async fn a_message_with_nothing_in_it_produces_no_events() {
        let (tx, mut rx) = mpsc::channel(4);
        assert!(emit(&tx, ServerMessage::default()).await);
        // Empty transcripts and empty audio are not events either.
        let msg: ServerMessage = serde_json::from_value(json!({
            "serverContent": {"inputTranscription": {"text": ""}}
        }))
        .unwrap();
        assert!(emit(&tx, msg).await);
        drop(tx);
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn emit_stops_once_the_listener_is_gone() {
        let (tx, rx) = mpsc::channel(1);
        drop(rx);
        let msg: ServerMessage =
            serde_json::from_value(json!({"serverContent": {"turnComplete": true}})).unwrap();
        assert!(!emit(&tx, msg).await, "a hung-up call must not keep pumping");
    }

    #[test]
    fn non_json_frames_are_ignored_rather_than_fatal() {
        assert!(parse(&Message::Ping(vec![].into())).is_none());
        assert!(parse(&Message::Text("not json".into())).is_none());
        assert!(parse(&Message::Text(r#"{"setupComplete":{}}"#.into())).is_some());
    }

    /// Ask the API what it will accept, instead of guessing at it.
    ///
    /// Two model ids read out of the documentation were both refused, and the
    /// refusal carries no information — the server drops the socket and the
    /// transport reports a truncated TLS stream. Guessing a third time is how an
    /// afternoon disappears. This asks the two questions directly: which models
    /// this key can open a bidirectional session with, and which PART of the
    /// setup the server objects to, by sending progressively more of it.
    ///
    /// **ACCEPTED does not mean SUPPORTED**, and this probe cannot tell the
    /// difference — it reports whether the server took the setup, not whether the
    /// model honours it. Two cases proved it: `gemini-3.5-live-translate-preview`
    /// accepts tools and a system instruction and supports neither, and
    /// `gemini-3.1-flash-live-preview` accepts `behavior: NON_BLOCKING` while
    /// running every call sequentially. Both connect, work, and quietly do less.
    /// Whether a model HONOURS a field is answered by the docs, or by listening.
    ///
    /// Reads the key from the OS keychain, so it never has to be pasted anywhere.
    /// Ignored by default: it opens real sockets.
    ///
    ///     cargo test -p feral-core --lib probe_what_the_live_api_accepts \
    ///       -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "hits the live API with the stored Google key"]
    async fn probe_what_the_live_api_accepts() {
        let key = crate::byok::byok_get("google").expect("no `google` key in the keychain");

        // 1. Ground truth on ids. `bidiGenerateContent` is the method a live
        //    session needs; anything without it cannot be called at all.
        let list: serde_json::Value = reqwest::Client::new()
            .get(format!(
                "https://generativelanguage.googleapis.com/v1beta/models?key={key}&pageSize=1000"
            ))
            .send()
            .await
            .expect("models list")
            .json()
            .await
            .expect("models list json");
        let empty = Vec::new();
        let live_models: Vec<String> = list["models"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .filter(|m| {
                m["supportedGenerationMethods"]
                    .as_array()
                    .is_some_and(|ms| ms.iter().any(|v| v == "bidiGenerateContent"))
            })
            .map(|m| m["name"].as_str().unwrap_or_default().to_string())
            .collect();
        println!("\n=== models this key can open a live session with ===");
        for m in &live_models {
            println!("  {m}");
        }
        assert!(!live_models.is_empty(), "this key sees no live-capable model at all");

        // 2. Which part of the setup is refused, on the first id that works.
        //    Sent smallest first, so the first failure names the culprit.
        for model in &live_models {
            println!("\n=== {model} ===");
            let bare = Setup::spoken(model, Vec::new());
            let mut no_transcripts = bare.clone();
            no_transcripts.input_audio_transcription = None;
            no_transcripts.output_audio_transcription = None;

            for (label, setup) in [
                ("audio only", no_transcripts),
                ("+ transcripts", bare.clone()),
                ("+ system instruction", bare.clone().with_system_instruction("Say hello.")),
                ("+ tools (what the app sends)", Setup::spoken(model, super::super::bridge::declarations())),
                // `behavior: NON_BLOCKING` is what lets the model keep talking
                // while a slow tool runs — the whole reason a 25-second agent
                // turn can live inside a voice call. The docs say 3.1 does not
                // support it; what they do not say is whether it REJECTS the
                // field or ignores it, and those need different code.
                ("+ tools marked NON_BLOCKING", {
                    let mut decls = super::super::bridge::declarations();
                    for d in &mut decls {
                        d.behavior = Some("NON_BLOCKING".to_string());
                    }
                    Setup::spoken(model, decls)
                }),
            ] {
                match try_setup(&key, setup).await {
                    Ok(()) => println!("  {label}: ACCEPTED"),
                    Err(e) => {
                        println!("  {label}: REFUSED — {e}");
                        break; // everything after this is more of the same
                    }
                }
            }
        }
    }

    /// Open a socket, send one setup, report what came back.
    ///
    /// Prints every frame verbatim, including the close frame — which is the
    /// thing production drops on the floor. If the server explains itself at all,
    /// it does it there.
    #[cfg(test)]
    async fn try_setup(key: &str, setup: Setup) -> Result<(), String> {
        let url = format!("{LIVE_WS_URL}?key={key}");
        let (stream, _) = tokio_tungstenite::connect_async(&url)
            .await
            .map_err(|e| format!("handshake: {}", redact(&e.to_string(), key)))?;
        let (mut write, mut read) = stream.split();
        let json = serde_json::to_string(&ClientMessage::Setup(setup)).unwrap();
        write
            .send(Message::Text(json.into()))
            .await
            .map_err(|e| format!("send: {}", redact(&e.to_string(), key)))?;

        let waited = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            while let Some(frame) = read.next().await {
                match frame {
                    Err(e) => return Err(format!("io: {}", redact(&e.to_string(), key))),
                    Ok(Message::Close(reason)) => {
                        return Err(match reason {
                            Some(c) => format!("close {} {}", c.code, c.reason),
                            None => "close, no reason given".to_string(),
                        })
                    }
                    Ok(Message::Text(t)) => {
                        println!("    frame: {t}");
                        if parse(&Message::Text(t)).is_some_and(|m| m.setup_complete.is_some()) {
                            return Ok(());
                        }
                    }
                    Ok(Message::Binary(b)) => {
                        // The Live API answers over binary frames as often as text.
                        let text = String::from_utf8_lossy(&b).to_string();
                        println!("    binary frame: {}", &text[..text.len().min(400)]);
                        if parse(&Message::Binary(b)).is_some_and(|m| m.setup_complete.is_some()) {
                            return Ok(());
                        }
                    }
                    Ok(_) => {}
                }
            }
            Err("socket ended with no setupComplete".to_string())
        })
        .await;
        match waited {
            Err(_) => Err("timed out".to_string()),
            Ok(r) => r,
        }
    }
}

#[cfg(test)]
mod route_latency_probe {
    /// How long the configured chat route takes to its FIRST token, with and
    /// without a large prefix.
    ///
    /// A voice turn measured 25 seconds before the model produced anything, on a
    /// 25-character question with a 106-character answer, no tools and no
    /// reasoning. Two causes fit: the ~10k tokens of schema and system prompt
    /// re-sent every completion, or the route OpenRouter picks. They need
    /// different fixes, and only a side-by-side separates them.
    ///
    ///     cargo test -p feral-core --lib probe_route_latency -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "spends a few cents against the configured provider"]
    async fn probe_route_latency() {
        let key = crate::byok::byok_get("openrouter").expect("no openrouter key stored");
        let client = reqwest::Client::new();

        // Roughly the prefill a real turn carries, as filler the model must read
        // but cannot answer from.
        let bulk = "The quick brown fox jumps over the lazy dog. ".repeat(900);

        for (label, system) in [("bare", ""), ("~10k tokens of prefix", bulk.as_str())] {
            let started = std::time::Instant::now();
            let body = serde_json::json!({
                "model": "deepseek/deepseek-v4-flash",
                "max_tokens": 16,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": "Say OK."},
                ],
            });
            let res = client
                .post("https://openrouter.ai/api/v1/chat/completions")
                .header("Authorization", format!("Bearer {key}"))
                .json(&body)
                .send()
                .await;
            match res {
                Ok(r) => {
                    let status = r.status();
                    let text = r.text().await.unwrap_or_default();
                    println!(
                        "  {label}: {} ms, status {status}, {}",
                        started.elapsed().as_millis(),
                        text.chars().take(160).collect::<String>()
                    );
                }
                Err(e) => println!("  {label}: FAILED after {} ms — {e}", started.elapsed().as_millis()),
            }
        }
    }
}
