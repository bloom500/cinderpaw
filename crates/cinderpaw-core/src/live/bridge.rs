//! What the model may call, and what happens when it does.
//!
//! The two halves of tool use, kept together because they have to agree: a name
//! declared here must be answerable here, and the failure when they disagree is
//! not an error message but a call that hangs — the model waits for a response
//! that no branch produces.
//!
//! The model is given ONE function — `ask_feral` — rather than a catalogue.
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
pub const ASK_FERAL: &str = "ask_feral";

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
        name: ASK_FERAL.to_string(),
        // Written as a TRIGGER, not as an offer, and that rewrite was paid for.
        // It used to open "ask Cinderpaw to do something you cannot do yourself",
        // which asks the model to first conclude it cannot — and on "search the
        // web for ways to promote Cinderpaw" it concluded the opposite, answered
        // from memory, and called nothing. Measured 2026-08-15: the tool was
        // only reached when the user named it out loud.
        //
        // So the description states the absence of the capability as fact and
        // lists the words that mean "call me". A model that believes it can
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
            Cinderpaw is the local agent and has real tools: web search, files, \
            shell, memory. State the request in one sentence, the way you would \
            to a colleague. It may take a while; keep talking to the user while \
            you wait."
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
async fn ask_feral(
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
    let response = if call.name == ASK_FERAL {
        let request = call.args.get("request").and_then(|v| v.as_str()).unwrap_or("");
        match runtime {
            // Only a host that owns a sidecar can answer this. `None` is the
            // honest report rather than a panic: a call must survive being made
            // from somewhere the agent does not exist.
            None => serde_json::json!({ "ok": false, "output": "Cinderpaw is not reachable from here" }),
            Some(_) if request.trim().is_empty() => {
                serde_json::json!({ "ok": false, "output": "no request was given" })
            }
            Some(rt) => match ask_feral(rt, session_id, request).await {
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
                name == ASK_FERAL || ToolType::from_name(&name).is_some(),
                "{name} is declared but nothing answers it",
            );
        }
    }

    #[test]
    fn a_declaration_carries_a_usable_schema() {
        let ask = declarations().into_iter().find(|d| d.name == ASK_FERAL).unwrap();
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
        let ask = declarations().into_iter().find(|d| d.name == ASK_FERAL).unwrap();
        assert_eq!(ask.behavior.as_deref(), Some("NON_BLOCKING"));
    }

    #[test]
    fn rusts_own_tools_are_no_longer_offered() {
        // Deliberate: they are a subset of the agent's, and where they overlap
        // Rust's are weaker — its web_search answers HTTP 429 while the
        // sidecar's works. Declaring both let the model pick the broken one.
        let names: Vec<_> = declarations().into_iter().map(|d| d.name).collect();
        assert_eq!(names, vec![ASK_FERAL.to_string()]);
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

    #[tokio::test]
    async fn an_unknown_tool_still_gets_an_answer() {
        // The model blocks on this id. Silence is the one response that ends the
        // conversation instead of continuing it.
        let call = FunctionCall {
            id: "call-9".into(),
            name: "definitely_not_a_tool".into(),
            args: serde_json::json!({}),
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
        };
        let response = answer(&call, None, "s1").await;
        assert_eq!(response.id, "call-1");
        assert_eq!(response.response["ok"], false);
        assert!(response.response["output"].is_string());
    }
}
