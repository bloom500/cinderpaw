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
            let frame =
                frame.map_err(|e| anyhow!("live: {}", redact(&e.to_string(), &key)))?;
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
        Err(anyhow!("live: the socket closed before setup was accepted"))
    })
    .await;
    match accepted {
        Err(_) => return Err(anyhow!("live: no setupComplete within {SETUP_TIMEOUT:?}")),
        Ok(Err(e)) => return Err(e),
        Ok(Ok(())) => {}
    }

    let (event_tx, events) = mpsc::channel::<LiveEvent>(64);
    let (commands, mut command_rx) = mpsc::channel::<LiveCommand>(64);

    // Inbound: socket → events.
    {
        let key = key.clone();
        let event_tx = event_tx.clone();
        tokio::spawn(async move {
            let reason = loop {
                match read.next().await {
                    None => break "closed".to_string(),
                    Some(Err(e)) => break redact(&e.to_string(), &key),
                    Some(Ok(frame)) => {
                        let Some(msg) = parse(&frame) else { continue };
                        // A send failure means the caller stopped listening —
                        // the call is over, and pumping into a closed channel
                        // would spin.
                        if !emit(&event_tx, msg).await {
                            return;
                        }
                    }
                }
            };
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
            let Ok(json) = serde_json::to_string(&msg) else { continue };
            if write.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });

    Ok(LiveHandle { commands, events })
}

/// Server frames are JSON, as text or binary depending on the hop. Anything that
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
}
