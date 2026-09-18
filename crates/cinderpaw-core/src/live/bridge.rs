//! What the model may call, and what happens when it does.
//!
//! The two halves of tool use, kept together because they have to agree: a name
//! declared here must be answerable here, and the failure when they disagree is
//! not an error message but a call that hangs — the model waits for a response
//! that no branch produces.
//!
//! The model is given ONE function — `ask_cinder` — rather than a catalogue.
//! Everything it might want is already behind Cinderpaw's agent, and the round trip
//! to reach it is the same one `/runtime/chat` makes, so a door costs one
//! declaration where a toolbox cost forty-three ports. `answer` still handles
//! the Rust-native tools, because nothing stops a caller from asking for one and
//! an unanswered name hangs the conversation.

use std::sync::Arc;

use super::{FunctionCall, FunctionDeclaration, FunctionResponse};
use crate::runtime::RuntimeState;
use crate::tools::{execute, ToolType};

/// The one thing the model can ask for.
pub const ASK_CINDER: &str = "ask_cinder";

/// ...and the one thing it can call off.
///
/// Its own tool rather than a sentence inside `ask_cinder`, because stopping is
/// not a request the agent can serve: a stop is a protocol line to the sidecar,
/// which aborts the in-flight generation and the tool signal for that session.
/// Asked through the door instead, the agent answered "stopped" in words and
/// nothing stopped — measured 16 Sep: the caller said "stop the searches and the
/// agent", the voice said "done, it is stopped", and the `ask_cinder` card went
/// on spinning because the search it described was still running. The card was
/// right. The only thing broken was that the model had no lever to pull.
pub const STOP_CINDER: &str = "stop_cinder";

/// The conversation on screen, so that what the voice call DOES lands there.
///
/// `ask_cinder` used to run in a session of its own, `voice-<pid>`. Everything
/// the agent did on a call — the search, the file, the setting it changed —
/// happened in a conversation nobody was looking at and nobody could open
/// afterwards, so the only evidence the work was real was the sentence the
/// model said out loud about it. Asked to stop something, it stopped it, and
/// the window went on showing the old state.
///
/// Set by the host when a call starts and cleared when it ends, rather than
/// baked into the worker's environment at boot: the warm worker is booted
/// before the person has necessarily settled on a conversation, and a value
/// that can change without a reboot must not be part of what a reboot decides.
///
/// `None` means nobody told us, which is a real state on a headless host — the
/// caller's own `voice-<pid>` is then still the honest answer.
static CHAT_SESSION: std::sync::OnceLock<parking_lot::RwLock<Option<String>>> =
    std::sync::OnceLock::new();

fn chat_session_cell() -> &'static parking_lot::RwLock<Option<String>> {
    CHAT_SESSION.get_or_init(|| parking_lot::RwLock::new(None))
}

/// Point voice tool calls at this conversation. `None` sends them back to their
/// own session.
pub fn set_chat_session(id: Option<String>) {
    *chat_session_cell().write() = id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
}

/// The conversation a voice tool call should run in.
pub fn chat_session() -> Option<String> {
    chat_session_cell().read().clone()
}

/// Everything the model is told it can do — which is one thing, on purpose.
///
/// It used to be the five tools Rust owns, and that was wrong twice over. They
/// are a strict subset of what the agent has (five against forty-three), and
/// where the two overlap Rust's copy is the weaker one: its `web_search` goes to
/// public SearXNG instances and answers HTTP 429, while the sidecar's DuckDuckGo
/// backend works. Declaring both let the model pick the broken one, which is
/// exactly what happened on the first call that tried to search.
///
/// So the model gets a door instead of a toolbox. Behind it the agent brings its
/// own forty-three tools, fractal memory and the self-improvement substrate —
/// none of which could ever be declared here, because memory and substrate are
/// not functions with arguments.
pub fn declarations() -> Vec<FunctionDeclaration> {
    vec![FunctionDeclaration {
        name: ASK_CINDER.to_string(),
        // Written as a TRIGGER, not as an offer, and that rewrite was paid for.
        // It used to open "ask Cinderpaw to do something you cannot do yourself",
        // which asks the model to first conclude it cannot — and on "search the
        // web for ways to promote Cinderpaw" it concluded the opposite, answered
        // from memory, and called nothing. Measured 2026-08-15: the tool was
        // only reached when the user named it out loud.
        //
        // So the description states the absence of the capability as fact and
        // lists the words that mean "call me".
        //
        // It also used to say "state the request in one sentence", and the
        // model summarised the HOW away: 18 Sep, "deschide browserul si cauta
        // vremea" arrived as "Search for the current weather in Bucharest",
        // the agent ran a background web_search, and the browser never opened. A model that believes it can
        // already search will never reach a door labelled "for things you
        // cannot do".
        description: "The ONLY way you can reach the internet, this computer, or \
            anything that happened before this call. You have no web access, no \
            files and no memory of your own — without this call you are guessing \
            from training data that may be years old.\n\n\
            Call it whenever the user asks you to search, look up, check, find \
            out, google, read, open, run, remember or recall anything — those \
            words are instructions to call this tool, not topics to talk about. \
            Call it too when they mention anything from an earlier conversation, \
            anything on their machine, or any fact that could have changed since \
            you were trained.\n\n\
            Cinderpaw is the local agent and has real tools: web search, a \
            built-in browser the user can watch, files, shell, memory. Pass the \
            request on in the user's own terms: if they named a place or a tool \
            (the browser, a site, a file, an app), that name goes in the request, \
            because it decides HOW the work is done. \"Open the browser and look \
            up the weather\" is not \"search for the weather\". It may take a \
            while; keep talking to the user while you wait."
            .to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "request": {
                    "type": "string",
                    "description": "What Cinderpaw should do, in plain language.",
                },
            },
            "required": ["request"],
        }),
        // Lets the model keep listening and talking while the agent works. The
        // agent's median turn is 25 seconds, and blocking on that is the whole
        // failure this call was built to avoid. Only 2.5-native-audio honours it
        // — 3.1 runs every call sequentially, so a call on 3.1 goes silent for
        // the length of the request.
        behavior: Some("NON_BLOCKING".to_string()),
    },
    FunctionDeclaration {
        name: STOP_CINDER.to_string(),
        // A trigger, like the door above, and for the same measured reason: a
        // description that offers a capability gets discussed, one that names
        // the words meaning "do it" gets called.
        // Written as one joined list rather than a continued literal: a
        // backslash-continued string here becomes a run of invisible spaces in
        // the middle of a sentence the model reads.
        description: [
            "Stop whatever Cinderpaw is doing right now: a search, a download,",
            "a file being written, a running agent turn.",
            "Call this the moment the user says stop, cancel, abort, leave it,",
            "forget it or that is enough, or tells you to halt anything in",
            "progress: those words are instructions to call this tool, not",
            "something to agree with. Saying you have stopped it does not stop",
            "it; only this call does. It takes effect immediately and needs no",
            "arguments.",
        ]
        .join(" "),
        // No arguments on purpose. "Stop what?" is a question the caller has
        // already answered by saying stop, and an argument here would be one
        // more thing for the model to get wrong while the user waits.
        parameters: serde_json::json!({ "type": "object", "properties": {} }),
        // Blocking: it returns as fast as a line on a pipe, and NON_BLOCKING
        // on a call this short only widens the window in which the model
        // answers before the work has actually been called off.
        behavior: None,
    }]
}

/// Put a request to the agent and wait for its answer.
///
/// The same round trip `/runtime/chat` makes, and deliberately not a new message
/// type: `message` already means "answer this", which is what is wanted here —
/// unlike post-turn memory, where the agent must record without replying.
///
/// `surface: "voice"` matters. Without it the agent answers with the desktop's
/// full markdown, and Gemini reads the asterisks out loud.
async fn ask_cinder(
    runtime: &Arc<RuntimeState>,
    session_id: &str,
    request: &str,
) -> Result<String, String> {
    let tx = runtime
        .cinderpaw_agent_tx
        .lock()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Cinderpaw's agent is not running right now".to_string())?;

    let msg_id = uuid::Uuid::new_v4().to_string();
    // Subscribed before the send, or a fast reply lands before anyone is
    // listening for it.
    let rx = runtime.events_tx.subscribe();
    let outbound = serde_json::json!({
        "type": "message",
        "id": msg_id,
        "content": request,
        "sessionId": session_id,
        "surface": "voice",
    })
    .to_string();
    tx.send(outbound)
        .await
        .map_err(|_| "Cinderpaw's agent stopped accepting messages".to_string())?;

    crate::api::await_agent_reply(rx, &msg_id).await
}

/// Call off whatever is running in this conversation.
///
/// The same line the Stop button sends, `{"type":"stop","sessionId":...}`, so
/// there is one definition of what stopping means. The agent loop aborts the
/// router fetch and the per-session tool signal and emits its `done` with
/// `stopped: true` — which is what closes the tool card in the window, because
/// the request that was waiting on that turn finally gets an answer.
///
/// Scoped to the session, not `stopAll`: since the voice call works in the
/// conversation on screen, that session IS the work the caller means. Stopping
/// everything would also kill a cron job or a dream cycle the caller never
/// mentioned.
async fn stop_cinder(runtime: &Arc<RuntimeState>, session_id: &str) -> Result<(), String> {
    let tx = runtime
        .cinderpaw_agent_tx
        .lock()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Cinderpaw's agent is not running right now".to_string())?;
    tx.send(
        serde_json::json!({ "type": "stop", "sessionId": session_id }).to_string(),
    )
    .await
    .map_err(|_| "Cinderpaw's agent stopped accepting messages".to_string())
}

/// Run one call and produce the response that must go back.
///
/// Always returns a response, including for a tool that does not exist. The
/// model blocks on the `id` it asked about, so "we do not have that tool" has to
/// travel as an answer — staying silent reads as a tool that never finished, and
/// the conversation stops rather than recovering.
pub async fn answer(
    call: &FunctionCall,
    runtime: Option<&Arc<RuntimeState>>,
    session_id: &str,
) -> FunctionResponse {
    let response = if call.name == STOP_CINDER {
        match runtime {
            None => serde_json::json!({ "ok": false, "output": "Cinderpaw is not reachable from here" }),
            Some(rt) => match stop_cinder(rt, session_id).await {
                // Said plainly so the model has a true sentence to say out
                // loud. It used to invent one.
                Ok(()) => serde_json::json!({ "ok": true, "output": "Stopped." }),
                Err(e) => serde_json::json!({ "ok": false, "output": e }),
            },
        }
    } else if call.name == ASK_CINDER {
        let request = call.args.get("request").and_then(|v| v.as_str()).unwrap_or("");
        match runtime {
            // Only a host that owns a sidecar can answer this. `None` is the
            // honest report rather than a panic: a call must survive being made
            // from somewhere the agent does not exist.
            None => serde_json::json!({ "ok": false, "output": "Cinderpaw is not reachable from here" }),
            Some(_) if request.trim().is_empty() => {
                serde_json::json!({ "ok": false, "output": "no request was given" })
            }
            Some(rt) => match ask_cinder(rt, session_id, request).await {
                Ok(text) => serde_json::json!({ "ok": true, "output": text }),
                Err(e) => serde_json::json!({ "ok": false, "output": e }),
            },
        }
    } else {
        match ToolType::from_name(&call.name) {
            None => serde_json::json!({
                "error": format!("no such tool: {}", call.name),
            }),
            Some(tool) => {
                let result = execute(tool, call.args.clone()).await;
                // A tool that failed is reported as a failure, not as an error on
                // the call: the model can say "that did not work" and carry on, but
                // only if it is told in a field it reads rather than in prose.
                serde_json::json!({ "ok": result.ok, "output": result.output })
            }
        }
    };
    FunctionResponse {
        id: call.id.clone(),
        name: call.name.clone(),
        response,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test, not three: this is process-wide state and `cargo test` runs
    /// threads in parallel, so three tests setting and clearing one cell race
    /// each other and the failure reads as a broken feature.
    #[test]
    fn the_call_can_be_pointed_at_the_conversation_on_screen() {
        set_chat_session(None);
        assert_eq!(chat_session(), None, "nobody told us, and that is a real state");
        set_chat_session(Some("  chat-7  ".into()));
        assert_eq!(chat_session().as_deref(), Some("chat-7"), "the id was not trimmed");
        // A window that hands over a blank id is telling us nothing, not
        // telling us the session is called "". Treated as nothing, the voice
        // call keeps its own session; treated as an id, every call would file
        // its work under a conversation that cannot be opened.
        set_chat_session(Some("   ".into()));
        assert_eq!(chat_session(), None);
    }

    #[test]
    fn every_declared_name_is_answerable() {
        // The invariant this module exists to hold. A name declared but not
        // answerable does not error — the model waits forever on an id no
        // branch produces.
        let mut names: Vec<_> = declarations().iter().map(|d| d.name.clone()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), declarations().len(), "two tools share a name");
        for name in names {
            assert!(
                name == ASK_CINDER || name == STOP_CINDER || ToolType::from_name(&name).is_some(),
                "{name} is declared but nothing answers it",
            );
        }
    }

    #[test]
    fn a_declaration_carries_a_usable_schema() {
        let ask = declarations().into_iter().find(|d| d.name == ASK_CINDER).unwrap();
        assert!(!ask.description.is_empty());
        assert_eq!(ask.parameters["type"], "object");
        assert_eq!(ask.parameters["properties"]["request"]["type"], "string");
        assert_eq!(ask.parameters["required"][0], "request");
    }

    #[test]
    fn the_door_is_non_blocking_or_the_call_goes_silent() {
        // Without this the model waits, mute, for the whole agent turn — a
        // median of 25 seconds. It is the single field that makes putting an
        // agent behind a voice call viable, so it is worth a test of its own.
        let ask = declarations().into_iter().find(|d| d.name == ASK_CINDER).unwrap();
        assert_eq!(ask.behavior.as_deref(), Some("NON_BLOCKING"));
    }

    #[test]
    fn rusts_own_tools_are_no_longer_offered() {
        // Deliberate: they are a subset of the agent's, and where they overlap
        // Rust's are weaker — its web_search answers HTTP 429 while the
        // sidecar's works. Declaring both let the model pick the broken one.
        let names: Vec<_> = declarations().into_iter().map(|d| d.name).collect();
        assert_eq!(names, vec![ASK_CINDER.to_string(), STOP_CINDER.to_string()]);
    }

    #[test]
    fn every_vendor_shape_wraps_the_same_schema() {
        // The reason `parameters()` exists. If these ever disagree, one provider
        // has been told a different set of arguments than the others.
        for tool in ToolType::ALL {
            let schema = tool.parameters();
            assert_eq!(tool.to_openai_definition()["function"]["parameters"], schema);
            assert_eq!(tool.to_anthropic_definition()["input_schema"], schema);
            assert_eq!(tool.to_gemini_declaration().parameters, schema);
        }
    }

    #[test]
    fn stopping_is_its_own_tool_and_takes_no_arguments() {
        // Argument-free on purpose: "stop what?" is a question the caller
        // already answered by saying stop. And blocking, unlike the door: the
        // whole complaint was a model that said "it is stopped" before
        // anything was, and NON_BLOCKING on a call this short only widens that
        // window.
        let stop = declarations().into_iter().find(|d| d.name == STOP_CINDER).unwrap();
        assert_eq!(stop.parameters["properties"], serde_json::json!({}));
        assert_eq!(stop.behavior, None);
        // It has to read as an instruction, not as an offer. A description that
        // offers a capability gets discussed instead of called.
        assert!(stop.description.contains("the moment the user says stop"));
        assert!(stop.description.contains("does not stop it"));
    }

    #[tokio::test]
    async fn a_stop_with_no_agent_says_so_instead_of_claiming_success() {
        // The one answer that must never be optimistic: the model reads `ok`
        // and says it out loud. On a host with no sidecar there is nothing to
        // stop, and "Stopped." would be the same lie this tool exists to end.
        let call = FunctionCall {
            id: "call-stop".into(),
            name: STOP_CINDER.into(),
            args: serde_json::json!({}),
            session: "voice-1".into(),
        };
        let response = answer(&call, None, "s1").await;
        assert_eq!(response.response["ok"], false);
        assert!(response.response["output"].as_str().unwrap().contains("not reachable"));
    }

    #[tokio::test]
    async fn an_unknown_tool_still_gets_an_answer() {
        // The model blocks on this id. Silence is the one response that ends the
        // conversation instead of continuing it.
        let call = FunctionCall {
            id: "call-9".into(),
            name: "definitely_not_a_tool".into(),
            args: serde_json::json!({}),
            session: "voice-1".into(),
        };
        let response = answer(&call, None, "s1").await;
        assert_eq!(response.id, "call-9");
        assert_eq!(response.name, "definitely_not_a_tool");
        assert!(response.response["error"].as_str().unwrap().contains("no such tool"));
    }

    #[tokio::test]
    async fn a_failing_tool_reports_failure_rather_than_vanishing() {
        // file_read on a path that cannot exist: the tool runs, refuses, and the
        // refusal has to reach the model as a normal answer.
        let call = FunctionCall {
            id: "call-1".into(),
            name: "file_read".into(),
            args: serde_json::json!({ "path": "../../etc/nope-not-here" }),
            session: "voice-1".into(),
        };
        let response = answer(&call, None, "s1").await;
        assert_eq!(response.id, "call-1");
        assert_eq!(response.response["ok"], false);
        assert!(response.response["output"].is_string());
    }
}
