//! The Gemini Live call engine, from the webview's side.
//!
//! Picking this engine replaces the whole `STT → LLM → TTS` chain with one
//! session, so the webview's job shrinks to two things: push microphone bytes
//! in, play what comes back. Turn detection, interruption and synthesis all
//! happen on the far end.
//!
//! Tool calls never reach the webview. The model asks, Rust runs the tool and
//! answers, and the only trace upstream is that the reply mentions what it
//! found — which is the point: a round trip through the UI would add latency to
//! the one path that is supposed to be fast.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use base64::Engine as _;
use cinderpaw_core::live::{self, bridge, LiveCommand, LiveEvent as CoreEvent};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::{events, AppState};

/// How long a tool may take before the model is given a holding reply.
///
/// This is a budget for ANSWERING, not for working. It has to sit above a
/// normal round trip — a web search and a summary is comfortably inside ten
/// seconds — and well below the point where a caller decides the app is dead.
/// Twenty seconds is about the longest a person will hold a phone to their ear
/// hearing nothing at all.
const ASK_DEADLINE: std::time::Duration = std::time::Duration::from_secs(20);

/// Work that outlived its answer deadline and is still running.
///
/// Two jobs, both of them long-horizon problems that only appear on a call that
/// lasts. First, the model is free again the moment it gets a holding reply, and
/// the obvious thing for it to do is ask the same question again — which without
/// this starts a SECOND copy of an eighteen-minute job, then a third. Second, a
/// spoken "stop" needs something concrete to cancel; before this there was
/// nothing anywhere in the process that knew a job existed.
static IN_FLIGHT: std::sync::OnceLock<Mutex<Vec<InFlight>>> = std::sync::OnceLock::new();

struct InFlight {
    /// The request that started it, lowercased — the dedupe key.
    request: String,
    task: tokio::task::JoinHandle<()>,
}

fn in_flight() -> &'static Mutex<Vec<InFlight>> {
    IN_FLIGHT.get_or_init(|| Mutex::new(Vec::new()))
}

/// Cancel everything still running. Returns how many were stopped.
fn cancel_in_flight() -> usize {
    let jobs = std::mem::take(&mut *in_flight().lock());
    for job in &jobs {
        job.task.abort();
    }
    jobs.len()
}

/// Is this whole utterance a command to stop, rather than a sentence that
/// merely contains the word?
///
/// Matched HERE, in the transport, and deliberately not left to the model. When
/// a tool call is outstanding the model has no turn to take, so "stop it" could
/// not reach it at all — and once it did, it had no tool that stops anything, so
/// it answered "I'm stopping it now" and nothing happened. A stop the user can
/// say out loud has to work while everything else is jammed, which means it
/// cannot depend on the thing that is jammed.
///
/// Conservative on purpose: only a bare stop command counts, so "stop the docker
/// container" stays a normal request. Same rule as the typed stop word.
fn is_stop_command(utterance: &str) -> bool {
    let cleaned: String = utterance
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect();
    let words: Vec<&str> = cleaned.split_whitespace().collect();
    // Address prefixes, so "cinderpaw, stop" and "ok stop" still count.
    //
    // Both names are here on purpose. Someone who has been talking to this thing
    // for months will keep saying the old one for a while, and a stop command
    // that is not recognised is the worst one to lose: the person is asking it
    // to stop BECAUSE something is going wrong, and being ignored at that moment
    // is what makes them reach for the power button. Costs one word to accept.
    let body = match words.as_slice() {
        [first, rest @ ..]
            if !rest.is_empty()
                && matches!(*first, "cinderpaw" | "feral" | "hey" | "ok" | "okay") =>
        {
            rest
        }
        all => all,
    };
    matches!(
        body.join(" ").as_str(),
        // English and Romanian, because the call is bilingual in practice and a
        // stop word that only works in one of them is a stop word that fails at
        // the moment it is needed.
        "stop" | "stop it" | "stop that" | "stop please" | "please stop" | "cancel"
            | "cancel it" | "abort" | "never mind" | "nevermind" | "forget it"
            | "opreste" | "oprește" | "opreste te" | "oprește te" | "opreste l"
            | "oprește l" | "stai" | "gata" | "anuleaza" | "anulează" | "lasa" | "lasă"
    )
}

/// The provider id whose key this engine borrows.
///
/// The same AI Studio key already powers the OpenAI-compatible chat surface, so
/// there is no second key to enter, no second place to store one, and no way for
/// the two to disagree about which key is current.
const KEY_PROVIDER: &str = "google";

/// Function calling is **sequential only** on the 3.x live models; asynchronous
/// `NON_BLOCKING` calls are a 2.5-native-audio feature. For a call that runs
/// tools the newer model is the weaker one, so this is the default until
/// measured otherwise.
///
/// **Copy this string, never compose it.** The first version here was
/// `gemini-2.5-flash-live-preview`, assembled from the way the 3.x id is spelled,
/// and no such model exists. A live setup naming an unknown model is not
/// answered with an error — the server drops the socket, which surfaces as
/// rustls reporting a TLS stream that ended without `close_notify`. So the whole
/// failure reads as a network fault and points nowhere near the typo. The two
/// real ids are `gemini-3.1-flash-live-preview` and this one.
///
/// `-latest` rather than the `-preview-12-2025` snapshot, changed while chasing
/// a call that dies seconds in with "the audio content type is not supported".
/// A pinned preview id is a snapshot the vendor can change or retire under you,
/// which fits a call that worked one day and not the next; `-latest` at least
/// fails the same way for everyone. Both are live-capable on this key —
/// `probe_what_the_live_api_accepts` lists them and both accept the full setup.
///
/// This is a suspect being eliminated, not a diagnosis. If the call still dies,
/// the model id was innocent.
const DEFAULT_MODEL: &str = "gemini-2.5-flash-native-audio-latest";

/// One call at a time — you cannot be in two conversations at once, and a map
/// keyed by session would imply otherwise.
pub type LiveCallSlot = Arc<Mutex<Option<mpsc::Sender<LiveCommand>>>>;

/// Build a fresh Live session without optional provider-specific voice fields.
///
/// Some Live models accept `speechConfig` during setup and reject it only after
/// the call has been running for several minutes.  Because setup completion
/// cannot prove support, optional voice pinning must be explicitly enabled by a
/// future capability check rather than optimistically sent on every provider.
fn fresh_session_config(
    api_key: String,
    model: String,
    voice: Option<String>,
    system_instruction: Option<String>,
) -> live::SessionConfig {
    live::SessionConfig {
        api_key,
        model,
        system_instruction,
        tools: bridge::declarations(),
        resume: None,
        voice,
        pin_voice: false,
    }
}

/// Start a call. Returns once the model has accepted the session, so a caller
/// that gets `Ok` can open the microphone immediately.
///
/// Errors: "live-no-key" | anything else is a message worth showing.
#[tauri::command]
#[specta::specta]
pub(crate) async fn start_live_call(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    model: Option<String>,
    voice: Option<String>,
    current_task: Option<String>,
    workspace: Option<String>,
    context: Option<String>,
) -> Result<(), String> {
    let Some(api_key) = cinderpaw_core::byok::byok_get(KEY_PROVIDER) else {
        return Err("live-no-key".into());
    };

    // Everything the model gets to know, said once. The session is stateful, so
    // it is not re-sent per turn.
    let brief = live::Briefing { current_task, workspace, context };
    let cfg = fresh_session_config(
        api_key,
        model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        voice,
        Some(live::system_instruction(&brief)),
    );
    let handle = live::connect(cfg.clone()).await.map_err(|e| e.to_string())?;

    // Replacing a live slot ends the previous call: dropping its sender closes
    // that socket. Leaving both open would put two models on one microphone.
    let previous = state.live_call.lock().replace(handle.commands.clone());
    drop(previous);

    tokio::spawn(supervise(app, session_id, cfg, handle));
    Ok(())
}

/// Turn the vendor's close sentence into something the caller can act on.
///
/// A WebSocket close reason is capped at 123 bytes by the protocol, so a long
/// vendor message arrives amputated — the quota one ends mid-URL, literally
/// "head to: h". That is what the user was being shown. Worse, it points at
/// billing, and the person reading it has just checked AI Studio and seen
/// plenty of quota left: the Live API meters audio MINUTES against its own
/// allowance, which is not the token quota on that dashboard, and a call spends
/// them for as long as it is open.
///
/// Unrecognised reasons pass through untouched. Inventing a friendlier sentence
/// for a message nobody has read yet is how a real cause gets hidden.
fn explain(reason: &str) -> String {
    if reason.contains("exceeded your current quota") || reason.contains("RESOURCE_EXHAUSTED") {
        return "Google's live-voice allowance for this key is used up. It is metered in \
                minutes of call, separately from the token quota shown in AI Studio, and it \
                refills on its own timetable. Another key, or a wait, is what fixes it."
            .to_string();
    }
    if reason.contains("prepayment credits are depleted") {
        return "This Google project has a billing account with no balance, which blocks the \
                free tier as well. A key from a project with no billing attached will work."
            .to_string();
    }
    if reason.contains("API key not valid") || reason.contains("API_KEY_INVALID") {
        return "Google refused the API key. Paste it again on the call screen.".to_string();
    }
    reason.to_string()
}

/// Is this close the server objecting to the SETUP, rather than to the key,
/// the quota or the network?
///
/// It matters because the two need opposite handling. A refused key or a
/// depleted balance is final: reconnecting spends money to be told the same
/// thing. A setup the model will not take is worth exactly one more attempt
/// with the suspect field dropped, and that attempt is the only way to learn
/// which field it was — the server names none of them.
///
/// Matched on the sentence because that is all the server gives us. There is no
/// code, no field name, and the same wording has now been produced by two
/// different fields (`contextWindowCompression`, then the pinned voice), so a
/// narrower match would silently stop catching the next one.
fn is_configuration_kill(reason: &str) -> bool {
    reason.contains("CONTENT_TYPE_AUDIO") || reason.contains("not supported for this model configuration")
}

/// Keep the call alive across the server's own session limit.
///
/// Measured: a call opened at 13:38 was closed at 13:50 by the server, which
/// said in as many words that the duration limit was reached and that the
/// conversation could be resumed with a handle. Nothing we send makes one
/// session last longer — the fix is to open the next one already knowing what
/// was said, which is what the handle is for.
///
/// The webview is never told. It holds no socket: the microphone calls
/// `send_live_audio`, which reads whatever sender is in the slot, so swapping
/// the slot swaps the call underneath a page that has no idea. From the user's
/// side the conversation simply does not end.
///
/// Only a close that HAS a handle is retried, and only a few times. A refused
/// key, a depleted quota or a model that does not exist all close the socket
/// too, and reconnecting into those is a loop that spends money on the same
/// error — those arrive without a handle and end the call as before.
async fn supervise(
    app: AppHandle,
    session_id: String,
    cfg: live::SessionConfig,
    first: live::LiveHandle,
) {
    // A count was the wrong shape. Eight resumptions sounded generous until the
    // target was named: a three-hour call, on a session the server ends every
    // twenty-five to fifty seconds, needs a couple of hundred of them. A budget
    // that runs out mid-afternoon is the same failure as no budget at all.
    //
    // So the guard is a RATE, not a total. Resuming for hours is exactly what
    // this is for; resuming five times inside ten seconds is a crash loop, and
    // that is the only thing worth refusing — it burns money and never
    // recovers. Long calls are unlimited; a tight loop stops.
    const LOOP_WINDOW: std::time::Duration = std::time::Duration::from_secs(10);
    const LOOP_LIMIT: usize = 5;
    let mut recent: std::collections::VecDeque<std::time::Instant> = Default::default();
    let mut handle = first;
    let mut total = 0u32;
    let mut pin_voice = true;
    // Spent once a handle-less reconnect has been made.
    let mut config_retry_used = false;

    loop {
        let ended = pump(app.clone(), session_id.clone(), handle.commands.clone(), handle.events).await;
        let Some((token, reason)) = ended else { return };

        // The server's way of saying "a field you asked for is not supported
        // here" is to kill the audio stream rather than refuse the setup.
        // Measured 2026-08-15: a call with `speechConfig` ran twenty seconds and
        // closed with "The audio content type (CONTENT_TYPE_AUDIO) is not
        // supported for this model configuration", the same sentence
        // `contextWindowCompression` produced before it was removed. So the
        // voice pin is dropped for the rest of this call rather than dying every
        // twenty seconds in the right voice.
        //
        // This branch could not run until the close below started arriving here.
        // The kill carries NO resumption handle, `pump` only reported closes
        // that had one, and so the function returned before ever reaching these
        // four lines: a remedy written for a path the error never takes. It is
        // the reason the same error was still being reported hours after it was
        // "fixed" — measured again 2026-08-15 13:52, seven seconds into a tool
        // call, with the answer arriving nine seconds after the socket was gone.
        if pin_voice && reason.contains("CONTENT_TYPE_AUDIO") {
            tracing::warn!(
                "live: the model refused the pinned voice, continuing in the server's default",
            );
            pin_voice = false;
        }

        // A handle-less reconnect is a GUESS: nothing is carried over, and the
        // only reason to make it is to find out whether the field we just
        // dropped was the one the server objected to. One guess, then stop.
        // Repeating it would be a session every twenty seconds, forever, each
        // one billed and each one dying the same way — and the rate guard below
        // would not catch it, because twenty seconds apart is not a tight loop.
        if token.is_none() {
            if config_retry_used {
                tracing::warn!("live: the setup is still refused with the voice unpinned");
                emit_status(&app, &session_id, CoreEvent::Closed {
                    reason: format!("the model refused this call's setup: {reason}"),
                    resume: None,
                });
                return;
            }
            config_retry_used = true;
        }

        let now = std::time::Instant::now();
        while recent.front().is_some_and(|t| now.duration_since(*t) > LOOP_WINDOW) {
            recent.pop_front();
        }
        if recent.len() >= LOOP_LIMIT {
            tracing::warn!(
                "live: {LOOP_LIMIT} resumptions inside {}s — treating this as a loop, not a long call",
                LOOP_WINDOW.as_secs(),
            );
            emit_status(&app, &session_id, CoreEvent::Closed {
                reason: "the call kept dropping and could not be kept open".into(),
                resume: None,
            });
            return;
        }
        recent.push_back(now);
        total += 1;
        tracing::info!("live: resuming session (#{total})");

        let mut next_cfg = cfg.clone();
        // `None` is a FRESH session, not a resumed one: the kill that brings us
        // down that path issues no handle to carry the conversation over.
        next_cfg.resume = token;
        next_cfg.pin_voice = pin_voice;
        match live::connect(next_cfg).await {
            Ok(next) => {
                // The slot is what the microphone writes into. Swapping it here
                // is the whole trick — the old sender drops, its socket closes,
                // and the next frame of audio goes to the new one.
                let state = app.state::<AppState>();
                let previous = state.live_call.lock().replace(next.commands.clone());
                drop(previous);
                handle = next;
            }
            Err(e) => {
                tracing::warn!(error = %e, "live: resume failed");
                emit_status(&app, &session_id, CoreEvent::Closed {
                    reason: explain(&e.to_string()),
                    resume: None,
                });
                return;
            }
        }
    }
}

/// Forward everything the model says to the webview, and answer its tool calls
/// here rather than there.
/// Returns the resumption handle when the socket ended in a way that can be
/// continued, and `None` when the call is genuinely over. The caller decides
/// what to do with that — pump itself never reconnects, so the decision lives
/// in one place instead of being tangled with the event loop.
async fn pump(
    app: AppHandle,
    session_id: String,
    commands: mpsc::Sender<LiveCommand>,
    mut events_rx: mpsc::Receiver<CoreEvent>,
) -> Option<(Option<String>, String)> {
    // The turn being spoken, from both sides, until the model says it is done.
    let mut heard = String::new();
    let mut said = String::new();
    // Cadence of the input transcript, per turn. See the InputTranscript arm.
    let mut heard_pieces = 0usize;
    let mut heard_first_at: Option<std::time::Instant> = None;
    let mut heard_last_at: Option<std::time::Instant> = None;
    while let Some(event) = events_rx.recv().await {
        match event {
            CoreEvent::Audio(pcm) => {
                // Rides the same event as every other engine's audio, at the
                // rate that travels with it — so the existing player needs to
                // know nothing about this one.
                let _ = app.emit(
                    "cinderpaw://tts-chunk",
                    events::TtsChunkEvent {
                        session_id: session_id.clone(),
                        pcm: base64::engine::general_purpose::STANDARD.encode(&pcm),
                        sample_rate: live::AUDIO_OUT_HZ,
                    },
                );
            }
            CoreEvent::ToolCall(calls) => {
                // Answered off the event loop: a slow tool must not stall the
                // audio still arriving behind it.
                let commands = commands.clone();
                let app = app.clone();
                let session_id = session_id.clone();
                tokio::spawn(async move {
                    let mut answers = Vec::with_capacity(calls.len());
                    for call in &calls {
                        // Logged on both sides of the await, and that is not
                        // noise. Nothing on this path said anything, so a call
                        // where the model asked for a tool and got a failure was
                        // indistinguishable from one where it never asked — the
                        // user reports "it could not search" and there is no way
                        // to tell which half is broken. These two lines answer it.
                        tracing::info!(tool = %call.name, args = %call.args, "live: tool call");
                        // Tell the screen too, not only the terminal.
                        //
                        // This call is resolved entirely in Rust and used to
                        // leave no trace upstream at all — so a turn where the
                        // agent answered from what it already knew, calling no
                        // tool of its own, showed the user a blank panel for the
                        // whole wait. That is the COMMON case, and it was the one
                        // with no feedback: the widgets only ever saw the
                        // sidecar's own tools.
                        let _ = app.emit(
                            "cinderpaw://live-status",
                            events::LiveStatusEvent {
                                session_id: session_id.clone(),
                                kind: "toolCall".to_string(),
                                text: call
                                    .args
                                    .get("request")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(&call.name)
                                    .to_string(),
                            },
                        );
                        // The runtime is what makes `ask_cinder` answerable: it
                        // holds the sidecar's stdin and the event bus its reply
                        // comes back on. Fetched per call rather than captured,
                        // because the sidecar can restart mid-conversation and a
                        // captured sender would then be pointing at a dead pipe.
                        let state = app.state::<AppState>();
                        let mic_before = MIC_FRAMES.load(Ordering::Relaxed);
                        let blocked_before = MIC_BLOCKED_MS.load(Ordering::Relaxed);
                        let started = std::time::Instant::now();
                        // A tool call must not be allowed to freeze the call.
                        //
                        // This was a bare `.await`, and a measured one ran for
                        // 1069.9 SECONDS. While a function call is outstanding
                        // the model cannot take another turn, so for eighteen
                        // minutes the caller could speak and hear nothing back —
                        // and every symptom the user reported comes from that one
                        // fact: replies arriving late, the delay growing the
                        // longer the call went on, and "stop it" being answered
                        // with "I'm stopping it now" by a model that had no turn
                        // in which to do anything about it.
                        //
                        // So the work gets a deadline for ANSWERING, not for
                        // running. Past it the model is handed a truthful holding
                        // reply and the conversation resumes; the work continues
                        // and delivers itself into the session when it lands.
                        // Nothing is cancelled and no result is dropped — the
                        // promise made to the user is the one that gets kept.
                        let key = call
                            .args
                            .get("request")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_lowercase();
                        // Already running? Say so instead of starting it twice.
                        let duplicate = !key.is_empty()
                            && in_flight().lock().iter().any(|j| j.request == key);
                        if duplicate {
                            tracing::info!(request = %key, "live: same work already running — not starting a second");
                            answers.push(live::FunctionResponse {
                                id: call.id.clone(),
                                name: call.name.clone(),
                                response: serde_json::json!({
                                    "ok": true,
                                    "output": "STILL RUNNING — this is the same job you already \
                                               started, not a new one. It has not finished yet. \
                                               Do not start it again and do not invent a result; \
                                               say you are still waiting and talk about something else.",
                                }),
                            });
                            continue;
                        }

                        let owned_call = call.clone();
                        let rt = state.runtime.clone();
                        let sid = session_id.clone();
                        let late_cmds = commands.clone();
                        let late_rt = state.runtime.clone();
                        let late_sid = session_id.clone();
                        let key_for_task = key.clone();
                        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
                        let task = tokio::spawn(async move {
                            let finished = bridge::answer(&owned_call, Some(&rt), &sid).await;
                            in_flight().lock().retain(|j| j.request != key_for_task);
                            // `send` fails only when the receiver is gone, which
                            // here means exactly one thing: the deadline passed
                            // and the model was promised a follow-up.
                            if let Err(late) = done_tx.send(finished) {
                                let text = late
                                    .response
                                    .get("output")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let spoken = late_cmds
                                    .send(LiveCommand::Text(format!(
                                        "The work you started earlier has finished. \
                                         Tell the user the result now, briefly: {text}"
                                    )))
                                    .await
                                    .is_ok();
                                // The call may well be over by now — that is the
                                // normal end of a job that took this long. The
                                // result must not evaporate with the socket: file
                                // it as a turn so it is in the conversation, `recall`
                                // finds it, and the next call opens knowing it.
                                if !spoken {
                                    record_turn(&late_rt, &late_sid, &key_for_task, &text);
                                }
                                tracing::info!(
                                    chars = text.len(),
                                    delivered = if spoken { "spoken" } else { "filed (call had ended)" },
                                    "live: late tool answer"
                                );
                            }
                        });
                        if !key.is_empty() {
                            in_flight().lock().push(InFlight { request: key, task });
                        }
                        let answer = match tokio::time::timeout(ASK_DEADLINE, done_rx).await {
                            Ok(Ok(a)) => a,
                            // The worker vanished — say so rather than leaving
                            // the model waiting on a response that never comes.
                            Ok(Err(_)) => live::FunctionResponse {
                                id: call.id.clone(),
                                name: call.name.clone(),
                                response: serde_json::json!({
                                    "ok": false,
                                    "output": "that stopped before it could answer",
                                }),
                            },
                            Err(_) => {
                                tracing::info!(
                                    tool = %call.name,
                                    "live: past the answer deadline — handing back a holding reply, work continues"
                                );
                                live::FunctionResponse {
                                    id: call.id.clone(),
                                    name: call.name.clone(),
                                    response: serde_json::json!({
                                        "ok": true,
                                        "output": "STILL RUNNING. This is not the result — \
                                                   it is genuinely still working. Say briefly that \
                                                   it is taking a while and you will report back, \
                                                   then carry on the conversation normally. Do NOT \
                                                   claim it finished, and do NOT invent a result; \
                                                   the real answer will arrive on its own.",
                                    }),
                                }
                            }
                        };
                        // The measurement this exists for. ~8 frames a second is
                        // a microphone that never stopped; near zero means the
                        // audio never reached us and the stall is on our side of
                        // the wire.
                        let secs = started.elapsed().as_secs_f32().max(0.001);
                        let frames = MIC_FRAMES.load(Ordering::Relaxed) - mic_before;
                        tracing::info!(
                            "live: tool ran {:.1}s — {} mic frames in ({:.1}/s), {} ms blocked on a full channel",
                            secs,
                            frames,
                            frames as f32 / secs,
                            MIC_BLOCKED_MS.load(Ordering::Relaxed) - blocked_before,
                        );
                        // The ANSWER, not just its verdict. `ok=true` says the
                        // round trip completed; it does not say whether the agent
                        // found anything, and those need opposite fixes — one is
                        // a retrieval problem, the other is the model summarising
                        // a good answer badly. Truncated, because a tool result
                        // can be a whole web page and the terminal is for
                        // deciding which of the two this is.
                        let preview = answer
                            .response
                            .get("output")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        tracing::info!(
                            tool = %call.name,
                            ok = %answer.response.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
                            chars = preview.len(),
                            answer = %preview.chars().take(400).collect::<String>(),
                            "live: tool answered",
                        );
                        let ok = answer
                            .response
                            .get("ok")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        let _ = app.emit(
                            "cinderpaw://live-status",
                            events::LiveStatusEvent {
                                session_id: session_id.clone(),
                                kind: "toolResult".to_string(),
                                // The verdict, and the reason when there is one.
                                // An empty string here means success, which the
                                // panel reads as "no error to show".
                                text: if ok { String::new() } else { preview.chars().take(160).collect() },
                            },
                        );
                        answers.push(answer);
                    }
                    let _ = commands.send(LiveCommand::ToolResponse(answers)).await;
                });
            }
            CoreEvent::ToolCallCancelled(_) => {
                // Nothing to undo yet: the tools Rust runs here are reads and
                // fetches. This arm exists so a tool with side effects cannot be
                // added later without someone reading this comment.
            }
            // Both transcripts accumulate until the model finishes, then the
            // pair is filed as one turn.
            //
            // This is the whole of a Live call's memory. Gemini conducts the
            // conversation, so nothing here ever passes through the agent loop —
            // and without this the call left no trace at all: ten minutes of
            // talk, hung up, and the session had never heard of it. The next
            // call opened blind and `recall` could not find a word of it.
            //
            // Filed per TURN rather than at hang-up, because a call that crashes
            // or drops has still happened, and a record written only at the end
            // is the one that is never written.
            CoreEvent::InputTranscript(ref t) => {
                // WHEN the pieces arrive, not just that they do.
                //
                // "I speak a sentence and wait half a minute to see my own words"
                // has two causes that look identical from the screen and need
                // opposite fixes. Either the server streams the transcript while
                // the user talks and something downstream of here holds it — ours
                // to fix — or the server withholds the whole thing until it
                // commits the turn, in which case no amount of frontend work will
                // make a word appear sooner and the answer is a different design.
                //
                // A span tells the two apart with no new plumbing: pieces spread
                // over the length of a spoken sentence mean streaming; a whole
                // sentence arriving inside a few hundred milliseconds means the
                // server sat on it.
                let now = std::time::Instant::now();
                if heard_pieces == 0 {
                    heard_first_at = Some(now);
                }
                heard_pieces += 1;
                heard_last_at = Some(now);
                heard.push_str(t);
                // A spoken stop, acted on here rather than passed along.
                //
                // Checked on every piece instead of at turn end, because waiting
                // for the turn to close is waiting for the exact thing the user
                // is trying to interrupt. Fires at most once per turn — the
                // registry is empty afterwards, so a second piece finds nothing
                // to cancel.
                if is_stop_command(&heard) {
                    let stopped = cancel_in_flight();
                    if stopped > 0 {
                        tracing::info!(stopped, "live: spoken stop — cancelled work in flight");
                        // Tell the model what just happened, or it will answer
                        // the user's "stop" out of its own imagination — which
                        // is how it came to say "I'm stopping it now" about a job
                        // it had no way to touch.
                        let _ = commands
                            .send(LiveCommand::Text(format!(
                                "SYSTEM: the user said stop, and {stopped} running job(s) were \
                                 cancelled just now. This already happened — confirm it in one \
                                 short sentence. Do not offer to stop anything else."
                            )))
                            .await;
                    }
                }
                emit_status(&app, &session_id, event);
            }
            CoreEvent::OutputTranscript(ref t) => {
                said.push_str(t);
                emit_status(&app, &session_id, event);
            }
            CoreEvent::TurnComplete => {
                if let (Some(first), Some(last)) = (heard_first_at, heard_last_at) {
                    tracing::info!(
                        "live: input transcript {} piece(s) over {:.1}s, last one {:.1}s before the turn closed",
                        heard_pieces,
                        last.duration_since(first).as_secs_f32(),
                        last.elapsed().as_secs_f32(),
                    );
                }
                heard_pieces = 0;
                heard_first_at = None;
                heard_last_at = None;
                let turn = (std::mem::take(&mut heard), std::mem::take(&mut said));
                if !turn.0.trim().is_empty() || !turn.1.trim().is_empty() {
                    let state = app.state::<AppState>();
                    record_turn(&state.runtime, &session_id, &turn.0, &turn.1);
                }
                emit_status(&app, &session_id, CoreEvent::TurnComplete);
            }
            // A close that carries a handle is NOT reported to the webview: the
            // conversation is about to continue on a new socket, and telling the
            // screen the call ended would put the pre-call panel up for a second
            // in the middle of a sentence.
            CoreEvent::Closed { reason, resume: Some(token) } => {
                tracing::info!(reason = %reason, "live: socket ended, resuming");
                return Some((Some(token), reason));
            }
            // A close with NO handle, but whose reason is the server objecting
            // to the setup rather than to the key or the quota. It is reported
            // the same way, because the caller can still do something about it:
            // reconnect fresh with the suspect field dropped. Before this, every
            // handle-less close ended the call here, which is why the remedy for
            // exactly this error sat in `supervise` unreachable.
            CoreEvent::Closed { reason, resume: None } if is_configuration_kill(&reason) => {
                tracing::warn!(reason = %reason, "live: socket killed by the setup, no handle to resume with");
                return Some((None, reason));
            }
            // Every other close the webview is told about, with the vendor's
            // amputated sentence turned into one the reader can act on.
            CoreEvent::Closed { reason, resume } => emit_status(
                &app,
                &session_id,
                CoreEvent::Closed { reason: explain(&reason), resume },
            ),
            other => emit_status(&app, &session_id, other),
        }
    }
    None
}

/// Hand one spoken exchange to the agent's memory, without asking for a reply.
///
/// Fire and forget: the sidecar either takes it or it does not, and a memory
/// write must never be able to interrupt a call in progress. A failure here
/// costs the record of one turn; blocking the pump on it would cost the audio.
fn record_turn(
    runtime: &std::sync::Arc<cinderpaw_core::runtime::RuntimeState>,
    session_id: &str,
    user: &str,
    assistant: &str,
) {
    let Some(tx) = runtime.cinderpaw_agent_tx.lock().as_ref().cloned() else { return };
    let line = serde_json::json!({
        "type": "record_turn",
        "sessionId": session_id,
        "content": user,
        "assistantContent": assistant,
    })
    .to_string();
    tokio::spawn(async move {
        if tx.send(line).await.is_err() {
            tracing::warn!("live: could not file the turn — the sidecar stopped listening");
        }
    });
}

fn emit_status(app: &AppHandle, session_id: &str, event: CoreEvent) {
    // The one status worth a line in the terminal. A call that dies mid-session
    // reports its reason to the webview and nowhere else, so the only record of
    // WHY was whatever the user managed to copy off the screen.
    if let CoreEvent::Closed { reason, .. } = &event {
        tracing::warn!(reason = %reason, "live: session closed");
    }
    // The CADENCE of the input transcript, which is the only way to tell a
    // server that sends rare fat chunks from a UI that drops thin ones. The
    // screen shows the same words either way; the timestamps do not.
    // Answered, and so demoted: measured 13 Aug, the server sends 1–6 characters
    // every 130–200 ms, which is exactly the cadence live typing needs. Whatever
    // makes it look choppy is downstream of here, so this is `debug` — at `info`
    // it is one line per two characters for the whole call.
    if let CoreEvent::InputTranscript(t) = &event {
        tracing::debug!(chars = t.len(), text = %t, "live: input transcript piece");
    }
    let (kind, text) = match event {
        CoreEvent::Interrupted => ("interrupted", String::new()),
        CoreEvent::TurnComplete => ("turnComplete", String::new()),
        CoreEvent::InputTranscript(t) => ("inputTranscript", t),
        CoreEvent::OutputTranscript(t) => ("outputTranscript", t),
        CoreEvent::Closed { reason, .. } => ("closed", reason),
        // Audio and tool calls are handled before this is reached.
        CoreEvent::Audio(_) | CoreEvent::ToolCall(_) | CoreEvent::ToolCallCancelled(_) => return,
    };
    let _ = app.emit(
        "cinderpaw://live-status",
        events::LiveStatusEvent {
            session_id: session_id.to_string(),
            kind: kind.to_string(),
            text,
        },
    );
}

/// Push microphone audio: base64 of 16 kHz mono 16-bit LE PCM.
///
/// Base64 for the same reason the audio coming back uses it — a `Vec<u8>` over
/// Tauri's IPC is serialised as a JSON array of numbers, several times the size.
#[tauri::command]
#[specta::specta]
pub(crate) async fn send_live_audio(state: State<'_, AppState>, pcm: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pcm.as_bytes())
        .map_err(|_| "live-bad-audio".to_string())?;
    let sender = state.live_call.lock().clone();
    let Some(sender) = sender else { return Err("live-not-started".into()) };
    MIC_FRAMES.fetch_add(1, Ordering::Relaxed);
    // Timed, because "my voice waits in a queue while a tool runs" has two
    // opposite causes and they look identical from the outside: either the
    // frames stop reaching us (the webview or the bridge is stalled), or they
    // arrive fine and the SERVER is holding the conversation while it waits for
    // the tool answer. One is ours to fix and the other is not, and guessing
    // wrong costs an afternoon — this counts frames and how long the handoff
    // took, so the tool-call log line below can report both.
    let at = std::time::Instant::now();
    let r = sender.send(LiveCommand::Audio(bytes)).await.map_err(|_| "live-closed".to_string());
    let waited = at.elapsed().as_millis() as u64;
    if waited > 50 {
        MIC_BLOCKED_MS.fetch_add(waited, Ordering::Relaxed);
    }
    r
}

/// Microphone frames handed to the session since the process started, and how
/// long `send` spent blocked on a full channel. Both are read as deltas around
/// a tool call; absolute values mean nothing.
static MIC_FRAMES: AtomicU64 = AtomicU64::new(0);
static MIC_BLOCKED_MS: AtomicU64 = AtomicU64::new(0);

/// Send a typed turn into the running call.
///
/// The way back to text for what dictation mangles — a URL, a name, an error
/// string. It goes on the session's own text channel rather than through the
/// agent: the model is conducting this conversation, so a line that bypassed it
/// would be answered twice, once by each side.
#[tauri::command]
#[specta::specta]
pub(crate) async fn send_live_text(
    state: State<'_, AppState>,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let sender = state.live_call.lock().clone();
    let Some(sender) = sender else { return Err("live-not-started".into()) };
    sender
        .send(LiveCommand::Text(text))
        .await
        .map_err(|_| "live-closed".to_string())
}

/// The voices a Live call can be pinned to, for the picker.
#[tauri::command]
#[specta::specta]
pub(crate) fn live_voices() -> Vec<String> {
    live::VOICES.iter().map(|v| v.to_string()).collect()
}

/// Hang up. Idempotent — hanging up twice is not an error, and a UI that has to
/// track whether it already did would get it wrong on the path that matters
/// (an error mid-call, where both the error handler and the user press stop).
#[tauri::command]
#[specta::specta]
pub(crate) async fn end_live_call(state: State<'_, AppState>) -> Result<(), String> {
    // Dropping the sender closes the socket, which ends both pump tasks.
    let sender = state.live_call.lock().take();
    drop(sender);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_sessions_do_not_send_optional_voice_configuration() {
        for model in [
            "gemini-2.5-flash-native-audio-latest",
            "gemini-3.1-flash-live-preview",
            "future-provider-live-model",
        ] {
            let cfg = fresh_session_config(
                "test-key".to_string(),
                model.to_string(),
                Some("Puck".to_string()),
                None,
            );

            assert!(
                !cfg.pin_voice,
                "optional voice configuration must be opt-in for {model}"
            );
        }
    }

    /// The bug this pins is not "does the string match" — it is that the close
    /// carrying this sentence arrives with NO resumption handle, and every
    /// handle-less close used to end the call before the remedy for it could
    /// run. Measured twice on 2026-08-15, hours apart, with the fix already in
    /// the binary and unreachable.
    #[test]
    fn the_setup_kill_is_told_apart_from_a_dead_key() {
        assert!(is_configuration_kill(
            "The audio content type (CONTENT_TYPE_AUDIO) is not supported for this model configuration."
        ));
        // The other field that produced the identical sentence, before it was
        // removed. A narrower match would have stopped catching this one.
        assert!(is_configuration_kill("contextWindowCompression is not supported for this model configuration"));

        // Final failures. Reconnecting into any of these spends money to be
        // told the same thing, so they must NOT come back here.
        assert!(!is_configuration_kill("1011 prepayment credits are depleted"));
        assert!(!is_configuration_kill("API key not valid. Please pass a valid API key."));
        assert!(!is_configuration_kill("The session duration limit was reached."));
    }

    #[test]
    fn the_default_model_is_the_one_that_can_run_tools_asynchronously() {
        // Guards a plausible "upgrade" to a newer live model, which would
        // silently downgrade function calling to sequential-only.
        assert!(DEFAULT_MODEL.contains("2.5"), "see the comment above DEFAULT_MODEL");
        // `native-audio`, not `live`. The earlier version of this assertion
        // demanded the substring "live" — which the real 2.5 id does not carry —
        // and so it PASSED for an id that does not exist while it would have
        // failed for the correct one. A guard that only accepts a typo is worse
        // than no guard.
        assert!(DEFAULT_MODEL.contains("native-audio"), "see the comment above DEFAULT_MODEL");
    }
}

#[cfg(test)]
mod stop_command_tests {
    use super::is_stop_command;

    #[test]
    fn a_bare_stop_is_a_stop() {
        for said in [
            "stop", "Stop.", "stop it", "please stop", "cancel", "abort",
            "never mind", "oprește", "opreste", "oprește-te", "gata", "anulează",
        ] {
            assert!(is_stop_command(said), "{said:?} should stop the work");
        }
    }

    #[test]
    fn an_address_prefix_still_counts() {
        // "cinderpaw, stop" and "ok stop" are how people actually say it out loud.
        for said in ["feral stop", "Cinderpaw, stop it", "ok stop", "hey stop"] {
            assert!(is_stop_command(said), "{said:?} should stop the work");
        }
    }

    #[test]
    fn a_sentence_that_merely_contains_stop_is_left_alone() {
        // The expensive direction to get wrong: cancelling an eighteen-minute
        // job because the user asked a question with "stop" in it.
        for said in [
            "stop the docker container",
            "how do I stop a running process",
            "don't stop until it works",
            "oprește serverul de test",
            "cancel my subscription please",
        ] {
            assert!(!is_stop_command(said), "{said:?} must NOT cancel anything");
        }
    }

    #[test]
    fn a_bare_address_is_not_a_command() {
        // Saying the assistant's name is not an instruction.
        for said in ["cinderpaw", "hey", "ok", ""] {
            assert!(!is_stop_command(said), "{said:?} must NOT cancel anything");
        }
    }
}
