//! The Gemini Live API wire protocol: speech in, speech out, tools in between.
//!
//! This is the message layer only — no socket, no session, no audio device. It
//! exists on its own because the wire format is the part that has to be exactly
//! right and is the cheapest to get wrong: a misspelled camelCase key does not
//! fail loudly, it makes the server ignore a field and the call behave subtly
//! wrong an hour later.
//!
//! Why this engine is not another TTS provider: picking Gemini replaces the
//! whole `STT → LLM → TTS` chain with one bidirectional session. The model hears
//! the microphone, decides when the turn ended, and answers in audio. Turn
//! detection, barge-in and synthesis stop being ours.
//!
//! Two things line up with what this app already does, which is why the seams
//! are small: the model emits **24 kHz mono 16-bit little-endian PCM**, byte for
//! byte the contract every other engine here already speaks, and it wants
//! **16 kHz PCM** in, which is what the microphone path already produces for
//! Whisper. Nothing converts in either direction.
//!
//! Verified against <https://ai.google.dev/api/live> (Preview). Where that
//! reference does not define a field, this module says so rather than guessing.

use serde::{Deserialize, Serialize};

pub mod bridge;
pub mod briefing;
pub mod session;
pub use briefing::{system_instruction, Briefing};
pub use session::{connect, LiveCommand, LiveEvent, LiveHandle, SessionConfig};

/// Live sessions are a WebSocket, not REST — a different host and path from the
/// usual `generativelanguage` REST calls, so it is spelled out here in full.
pub const LIVE_WS_URL: &str =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/// What the microphone must produce. Not a preference — the server reads raw
/// PCM at this rate and there is no field to tell it otherwise.
pub const AUDIO_IN_HZ: u32 = 16_000;
pub const AUDIO_IN_MIME: &str = "audio/pcm;rate=16000";

/// What comes back. Already this app's one audio contract, so the bridge hands
/// these bytes to the player untouched.
pub const AUDIO_OUT_HZ: u32 = 24_000;

/// A tool the model may call, in Gemini's shape.
///
/// `parameters` is a JSON Schema object and is passed through as-is: every tool
/// source here (built-ins, custom tools, MCP) already describes itself that way,
/// and re-encoding a schema is how a required field quietly becomes optional.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FunctionDeclaration {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
    /// `NON_BLOCKING` lets the model keep talking while the tool runs, which is
    /// the whole reason a search does not need a spoken "one moment" to cover it.
    ///
    /// ponytail: left `None` by default and omitted from the JSON. The Live API
    /// reference does not define this field — it lives in the generate-content
    /// docs — so its exact placement is unverified here. Set it once it has been
    /// confirmed against a live session, rather than shipping a plausible guess
    /// the server would silently ignore.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behavior: Option<String>,
}

/// Everything the client can say. Exactly one variant per message: the server
/// rejects an object carrying two of these, so the enum shape IS the rule.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClientMessage {
    /// Must be the first message on the socket, and the only one until
    /// `setupComplete` comes back.
    Setup(Setup),
    /// Continuous microphone audio. Deliberately not `clientContent`: realtime
    /// input can be sent without interrupting generation, and end-of-turn is
    /// derived from speech rather than announced.
    RealtimeInput(RealtimeInput),
    ToolResponse(ToolResponse),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    /// Fully qualified — `models/{id}`, not the bare id.
    pub model: String,
    pub generation_config: GenerationConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_instruction: Option<Content>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<Tool>,
    /// Asking for both transcripts is what keeps a spoken call legible: without
    /// them the conversation leaves no text behind, so nothing can be shown on
    /// screen, logged, or written to memory afterwards.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_audio_transcription: Option<AudioTranscriptionConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_audio_transcription: Option<AudioTranscriptionConfig>,
    /// Sliding-window history compression. **Off by default — it appears to be
    /// the cause of the very failure it was added to fix.**
    ///
    /// The story, because it is the kind that repeats. An audio session is
    /// capped at fifteen minutes and the socket is torn down at about ten; the
    /// server reports that as "the audio content type (CONTENT_TYPE_AUDIO) is
    /// not supported for this model configuration", which reads as a setup
    /// error. Measured then: opened 12:26, dead 12:37. Compression is the
    /// documented remedy, so it went on by default.
    ///
    /// Measured after: opened, spoke, **dead 18 seconds later**, same message.
    /// Second call, 6 seconds. Thirty times sooner than the wall it was meant
    /// to clear. The reading that fits is that the message was always literal —
    /// audio content cannot be compressed, and "this model configuration" is
    /// the sliding window WE asked for. Audio burns tokens fast, so the
    /// server-chosen trigger is reached in seconds.
    ///
    /// The verification that let this through said the probe "sends the new
    /// setup and the server accepts it" — and that probe's own docstring warns
    /// that ACCEPTED does not mean SUPPORTED. Accepting a field and honouring
    /// it are different claims; only the weaker one was ever tested.
    ///
    /// `FERAL_LIVE_COMPRESS_HISTORY=true` puts it back. Dying at ten minutes is
    /// a better failure than dying at eighteen seconds, so that is the default
    /// until a long call is actually measured with it on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_compression: Option<ContextWindowCompression>,
    /// Ask for a resumption handle, or hand one back to continue an earlier call.
    ///
    /// This is the documented answer to the wall that actually exists. Measured:
    /// a call opened at 13:38 and the server closed it at 13:50 saying "The
    /// session duration limit was reached. Connection closed. You may reconnect
    /// and resume this session using your resumption handle." Nothing we send
    /// makes a session last longer — the remedy is to start a new one that
    /// remembers the old, which the user never sees.
    ///
    /// Empty object on a fresh call (please issue handles), populated on a
    /// reconnect.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_resumption: Option<SessionResumption>,
}

/// `{}` asks the server to start issuing handles; `{ handle }` resumes.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumption {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
}

/// Slide the oldest turns out instead of ending the call.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextWindowCompression {
    /// Present and empty: the field's presence selects the strategy.
    pub sliding_window: SlidingWindow,
    /// When to start compressing. Left to the server, which knows the model's
    /// window — a number invented here would be wrong the day the model changes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_tokens: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SlidingWindow {}

impl Setup {
    /// A spoken call: audio out, both transcripts on, tools declared.
    ///
    /// A constructor rather than `Default` + field assignment, because the two
    /// fields a caller is most likely to forget — `responseModalities` and the
    /// transcripts — are the two whose absence is silent rather than loud.
    pub fn spoken(model: &str, tools: Vec<FunctionDeclaration>) -> Self {
        Setup {
            model: if model.starts_with("models/") {
                model.to_string()
            } else {
                format!("models/{model}")
            },
            generation_config: GenerationConfig {
                response_modalities: vec!["AUDIO".to_string()],
                speech_config: None,
            },
            system_instruction: None,
            tools: if tools.is_empty() {
                Vec::new()
            } else {
                vec![Tool { function_declarations: tools }]
            },
            input_audio_transcription: Some(AudioTranscriptionConfig {}),
            output_audio_transcription: Some(AudioTranscriptionConfig {}),
            // Off unless asked for — see the field's docs. Opt-in rather than
            // deleted so the next person can re-measure it in one env var
            // instead of re-deriving the whole story from the error message.
            // Always requested. A handle costs nothing to be given and is the
            // only thing that makes the duration wall survivable.
            session_resumption: Some(SessionResumption::default()),
            context_window_compression: std::env::var("FERAL_LIVE_COMPRESS_HISTORY")
                .is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .then(|| ContextWindowCompression {
                    sliding_window: SlidingWindow {},
                    trigger_tokens: None,
                }),
        }
    }

    /// What the model should know before it says a word. This is where the
    /// pre-call memory lookup lands.
    pub fn with_system_instruction(mut self, text: impl Into<String>) -> Self {
        self.system_instruction = Some(Content::text(text));
        self
    }
}

/// Generation settings. Only the parts a voice call needs are modelled.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationConfig {
    /// `["AUDIO"]`. Without it the model answers in text and the call is silent.
    ///
    /// It belongs **here**, inside `generationConfig`, not at the top of `setup`
    /// — the WebSocket quickstart shows it flattened one level up, which is the
    /// kind of example that works for its author and produces a mute call for
    /// everyone who copies it. The type reference is the authority.
    pub response_modalities: Vec<String>,
    /// Voice and language selection. Passed through as JSON: its shape is
    /// documented outside the Live reference, and inventing it here would put a
    /// guess on the wire.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speech_config: Option<serde_json::Value>,
}

/// No fields today; present because the server distinguishes "absent" from
/// "requested with defaults", and absent means no transcript at all.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AudioTranscriptionConfig {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub function_declarations: Vec<FunctionDeclaration>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Content {
    pub parts: Vec<Part>,
}

impl Content {
    /// System instructions must be text-only parts, per the reference.
    pub fn text(s: impl Into<String>) -> Self {
        Content { parts: vec![Part { text: Some(s.into()), inline_data: None }] }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Where the model's audio arrives: base64 PCM at [`AUDIO_OUT_HZ`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_data: Option<Blob>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Blob {
    pub mime_type: String,
    /// Base64. The one place bytes are not passed through raw.
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<Blob>,
    /// Sent when the microphone closes. Only valid while automatic activity
    /// detection is on, which is the default and what we want — server-side VAD
    /// is precisely the part being handed over.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_stream_end: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResponse {
    pub function_responses: Vec<FunctionResponse>,
}

/// Matched to its call by `id`, never by name — the model may have two calls to
/// the same tool in flight, and answering by name pairs them at random.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FunctionResponse {
    pub id: String,
    pub name: String,
    pub response: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct FunctionCall {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

/// Anything the server may send.
///
/// Every field is optional and unknown ones are ignored rather than refused.
/// That is deliberate and the opposite of how this codebase treats its own data:
/// this is a Preview API that adds message types between releases, and a strict
/// parse would turn "Google shipped a new field" into "the call drops".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMessage {
    pub setup_complete: Option<serde_json::Value>,
    pub server_content: Option<ServerContent>,
    pub tool_call: Option<ToolCall>,
    pub tool_call_cancellation: Option<ToolCallCancellation>,
    pub go_away: Option<serde_json::Value>,
    /// A fresh handle for resuming this conversation after the socket ends.
    /// Sent repeatedly through a call; only the latest one is worth keeping.
    pub session_resumption_update: Option<SessionResumptionUpdate>,
}

/// The server's offer to let this conversation continue on a new socket.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumptionUpdate {
    pub new_handle: Option<String>,
    /// False while the server is mid-turn — resuming from a handle it has not
    /// finished writing would replay a half-formed state.
    #[serde(default)]
    pub resumable: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerContent {
    pub model_turn: Option<Content>,
    /// The user started talking over the answer. The reference is explicit about
    /// what to do: stop and empty the playback queue. Barge-in, for free.
    #[serde(default)]
    pub interrupted: bool,
    #[serde(default)]
    pub turn_complete: bool,
    #[serde(default)]
    pub generation_complete: bool,
    pub input_transcription: Option<Transcription>,
    pub output_transcription: Option<Transcription>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct Transcription {
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    #[serde(default)]
    pub function_calls: Vec<FunctionCall>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ToolCallCancellation {
    #[serde(default)]
    pub ids: Vec<String>,
}

/// The audio the model produced in this message, decoded and concatenated.
///
/// A turn arrives as several parts, and a part may carry text instead of audio,
/// so "the audio" is a filter and a join rather than `parts[0]`.
impl ServerContent {
    pub fn audio(&self) -> Vec<u8> {
        use base64::Engine;
        let Some(turn) = &self.model_turn else { return Vec::new() };
        let mut pcm = Vec::new();
        for part in &turn.parts {
            if let Some(blob) = &part.inline_data {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&blob.data) {
                    pcm.extend_from_slice(&bytes);
                }
            }
        }
        pcm
    }
}

/// Microphone bytes → the message that carries them.
pub fn audio_chunk(pcm: &[u8]) -> ClientMessage {
    use base64::Engine;
    ClientMessage::RealtimeInput(RealtimeInput {
        audio: Some(Blob {
            mime_type: AUDIO_IN_MIME.to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(pcm),
        }),
        audio_stream_end: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decl(name: &str) -> FunctionDeclaration {
        FunctionDeclaration {
            name: name.to_string(),
            description: "does a thing".into(),
            parameters: json!({"type": "object", "properties": {}}),
            behavior: None,
        }
    }

    #[test]
    fn a_client_message_is_one_camel_case_key() {
        // The server rejects a message carrying two of these, and reads none of
        // them if the key is snake_case.
        let v = serde_json::to_value(ClientMessage::Setup(Setup::spoken("x", vec![]))).unwrap();
        assert_eq!(v.as_object().unwrap().len(), 1);
        assert!(v.get("setup").is_some());
        // A bare id is qualified for us; an already-qualified one is left alone.
        assert_eq!(v["setup"]["model"], "models/x");
        assert_eq!(
            serde_json::to_value(ClientMessage::Setup(Setup::spoken("models/y", vec![]))).unwrap()
                ["setup"]["model"],
            "models/y"
        );
        // Empty tools and an absent instruction must not go out as nulls.
        assert!(v["setup"].get("tools").is_none());
        assert!(v["setup"].get("systemInstruction").is_none());
    }

    #[test]
    fn a_spoken_setup_asks_for_audio_inside_generation_config() {
        // The failure this guards is silent: ask in the wrong place and the model
        // replies in text, so the call connects, works, and says nothing.
        let v = serde_json::to_value(ClientMessage::Setup(Setup::spoken("x", vec![]))).unwrap();
        assert_eq!(v["setup"]["generationConfig"]["responseModalities"][0], "AUDIO");
        assert!(v["setup"].get("responseModalities").is_none());
        // Both transcripts, or a spoken call leaves no text behind.
        assert!(v["setup"]["inputAudioTranscription"].is_object());
        assert!(v["setup"]["outputAudioTranscription"].is_object());
        // Compression is NOT here by default any more, and the inversion is the
        // point: sending it appears to end the call in seconds rather than
        // extend it past ten minutes. See the field's docs. This assertion used
        // to demand the opposite, which is how a fix that reproduced its own
        // symptom stayed in — the test pinned the remedy, never the outcome.
        assert!(
            v["setup"].get("contextWindowCompression").is_none(),
            "compression is opt-in via FERAL_LIVE_COMPRESS_HISTORY",
        );
    }

    #[test]
    fn a_call_always_asks_for_a_resumption_handle() {
        // Without this the server issues none, and a call that hits the duration
        // limit — measured at twelve minutes — has nothing to reconnect with.
        // Asking costs nothing and is the only thing that makes the wall
        // survivable, so it is unconditional rather than a setting.
        let v = serde_json::to_value(ClientMessage::Setup(Setup::spoken("x", vec![]))).unwrap();
        assert!(
            v["setup"]["sessionResumption"].is_object(),
            "the call did not ask for a handle",
        );
        assert!(
            v["setup"]["sessionResumption"].get("handle").is_none(),
            "a fresh call must not claim to be resuming one",
        );
    }

    #[test]
    fn a_resumed_call_sends_the_handle_back() {
        let mut setup = Setup::spoken("x", vec![]);
        setup.session_resumption = Some(SessionResumption { handle: Some("abc123".into()) });
        let v = serde_json::to_value(ClientMessage::Setup(setup)).unwrap();
        assert_eq!(v["setup"]["sessionResumption"]["handle"], "abc123");
    }

    #[test]
    fn an_unresumable_update_is_read_but_not_trusted() {
        // The server sends handles mid-turn with `resumable: false`. Resuming
        // from one of those replays a half-written state, so the flag is the
        // whole point of parsing this message rather than just taking the id.
        let msg: ServerMessage = serde_json::from_str(
            r#"{"sessionResumptionUpdate":{"newHandle":"h1","resumable":false}}"#,
        )
        .unwrap();
        let u = msg.session_resumption_update.expect("parsed");
        assert_eq!(u.new_handle.as_deref(), Some("h1"));
        assert!(!u.resumable);
    }

    #[test]
    fn compression_can_be_put_back_with_one_env_var() {
        // Kept reachable rather than deleted: whoever re-measures the ten-minute
        // wall should not have to rebuild the whole story from an error message.
        // SAFETY: single-threaded test process; no other thread reads the env.
        unsafe { std::env::set_var("FERAL_LIVE_COMPRESS_HISTORY", "true") };
        let v = serde_json::to_value(ClientMessage::Setup(Setup::spoken("x", vec![]))).unwrap();
        unsafe { std::env::remove_var("FERAL_LIVE_COMPRESS_HISTORY") };
        assert!(v["setup"]["contextWindowCompression"]["slidingWindow"].is_object());
    }

    #[test]
    fn setup_serialises_tools_and_instruction_in_camel_case() {
        let v = serde_json::to_value(ClientMessage::Setup(
            Setup::spoken("x", vec![decl("web_search")]).with_system_instruction("be brief"),
        ))
        .unwrap();
        assert_eq!(v["setup"]["tools"][0]["functionDeclarations"][0]["name"], "web_search");
        assert_eq!(v["setup"]["systemInstruction"]["parts"][0]["text"], "be brief");
        // Unverified field stays out of the wire until someone confirms it.
        assert!(v["setup"]["tools"][0]["functionDeclarations"][0].get("behavior").is_none());
    }

    #[test]
    fn audio_goes_out_as_base64_at_the_rate_the_server_expects() {
        let v = serde_json::to_value(audio_chunk(&[0x01, 0x02, 0x03])).unwrap();
        assert_eq!(v["realtimeInput"]["audio"]["mimeType"], AUDIO_IN_MIME);
        assert_eq!(v["realtimeInput"]["audio"]["data"], "AQID");
        assert!(v["realtimeInput"].get("audioStreamEnd").is_none());
    }

    #[test]
    fn a_tool_response_is_matched_by_id_not_by_name() {
        let v = serde_json::to_value(ClientMessage::ToolResponse(ToolResponse {
            function_responses: vec![FunctionResponse {
                id: "call-2".into(),
                name: "web_search".into(),
                response: json!({"output": "ok"}),
            }],
        }))
        .unwrap();
        assert_eq!(v["toolResponse"]["functionResponses"][0]["id"], "call-2");
    }

    #[test]
    fn model_audio_is_decoded_and_joined_across_parts() {
        let msg: ServerMessage = serde_json::from_value(json!({
            "serverContent": {
                "modelTurn": {"parts": [
                    {"text": "hello"},
                    {"inlineData": {"mimeType": "audio/pcm", "data": "AQI="}},
                    {"inlineData": {"mimeType": "audio/pcm", "data": "Aw=="}}
                ]}
            }
        }))
        .unwrap();
        assert_eq!(msg.server_content.unwrap().audio(), vec![0x01, 0x02, 0x03]);
    }

    #[test]
    fn an_unknown_server_message_parses_instead_of_dropping_the_call() {
        // A Preview API adds message types. Refusing them would end a call over
        // a field we do not even read.
        let msg: ServerMessage =
            serde_json::from_value(json!({"somethingNewIn2027": {"x": 1}})).unwrap();
        assert!(msg.server_content.is_none());
        assert!(msg.tool_call.is_none());
    }

    #[test]
    fn interruption_and_tool_calls_are_read_off_the_wire() {
        let msg: ServerMessage = serde_json::from_value(json!({
            "serverContent": {"interrupted": true, "turnComplete": true}
        }))
        .unwrap();
        let content = msg.server_content.unwrap();
        assert!(content.interrupted && content.turn_complete);
        assert!(content.audio().is_empty());

        let msg: ServerMessage = serde_json::from_value(json!({
            "toolCall": {"functionCalls": [{"id": "c1", "name": "web_search", "args": {"q": "x"}}]}
        }))
        .unwrap();
        let calls = msg.tool_call.unwrap().function_calls;
        assert_eq!(calls[0].id, "c1");
        assert_eq!(calls[0].args["q"], "x");
    }
}
