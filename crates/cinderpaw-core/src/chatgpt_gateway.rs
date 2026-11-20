//! A ChatGPT plan, spent through the engine's ordinary model calls.
//!
//! The engine speaks chat/completions. A ChatGPT plan is spent only through
//! the Responses API, with a bearer token that lasts an hour, and only within
//! its rules (developers.openai.com/siwc/token-sharing-open-source,
//! models-and-inference and preview-limitations, read 1 Nov 2026): `store`
//! off, streamed, system text as `instructions`, no sampling fields. This sits
//! on the local API between the two: the engine points at
//! `http://127.0.0.1:<port>/chatgpt` like at any OpenAI-compatible server, and
//! the token never leaves this process.
//!
//! The engine sends history as plain text (tool results are user text, tool
//! calls are written into the assistant's text), so only the current answer's
//! tool calls are native, and only those are translated.

use serde_json::{json, Map, Value};
use std::collections::VecDeque;

pub const RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
pub const MODELS_URL: &str = "https://api.openai.com/v1/models";
/// Where a person sees and limits what Cinderpaw spends of their plan.
pub const MANAGE_USAGE: &str = "https://chatgpt.com/settings/usage";

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// A chat/completions request as the Responses request plan usage accepts.
/// Fields it refuses (temperature, max_tokens, ...) are simply not carried.
pub fn to_responses(chat: &Value) -> Value {
    let mut instructions = Vec::new();
    let mut input = Vec::new();
    for m in chat["messages"].as_array().into_iter().flatten() {
        match m["role"].as_str().unwrap_or("user") {
            // System items are rejected on this route.
            "system" | "developer" => instructions.push(text_of(&m["content"])),
            "assistant" => {
                let text = text_of(&m["content"]);
                if !text.is_empty() {
                    input.push(json!({ "role": "assistant", "content": text }));
                }
            }
            _ => {
                let content = match &m["content"] {
                    Value::Array(parts) => Value::Array(
                        parts
                            .iter()
                            .filter_map(|p| match p["type"].as_str() {
                                Some("text") => Some(json!({ "type": "input_text", "text": p["text"] })),
                                Some("image_url") => Some(json!({ "type": "input_image", "image_url": p["image_url"]["url"] })),
                                _ => None,
                            })
                            .collect(),
                    ),
                    other => Value::String(text_of(other)),
                };
                input.push(json!({ "role": "user", "content": content }));
            }
        }
    }
    let mut body = json!({ "model": chat["model"], "input": input, "store": false, "stream": true });
    let instructions = instructions.join("\n\n");
    if !instructions.is_empty() {
        body["instructions"] = json!(instructions);
    }
    if let Some(tools) = chat["tools"].as_array() {
        let tools: Vec<Value> = tools
            .iter()
            .filter_map(|t| {
                let f = &t["function"];
                let mut tool = Map::new();
                tool.insert("type".into(), json!("function"));
                tool.insert("name".into(), json!(f["name"].as_str()?));
                for key in ["description", "parameters"] {
                    if !f[key].is_null() {
                        tool.insert(key.into(), f[key].clone());
                    }
                }
                Some(Value::Object(tool))
            })
            .collect();
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools);
            if let Some(choice) = chat["tool_choice"].as_str() {
                body["tool_choice"] = json!(choice);
            }
        }
    }
    if let Some(effort) = chat["reasoning"]["effort"].as_str() {
        // The summary is what the chat shows as thinking.
        body["reasoning"] = json!({ "effort": effort, "summary": "auto" });
    }
    body
}

/// Responses stream events, one at a time, as chat/completions chunks.
pub struct Translator {
    model: String,
    /// The item id of each function call; its place here is its index.
    calls: Vec<String>,
    /// Whether a call's arguments already went out in pieces.
    streamed: Vec<bool>,
}

impl Translator {
    pub fn new(model: &str) -> Self {
        Self { model: model.to_string(), calls: Vec::new(), streamed: Vec::new() }
    }

    fn chunk(&self, delta: Value, finish: Option<&str>) -> Value {
        json!({
            "id": "chatcmpl-chatgpt",
            "object": "chat.completion.chunk",
            "model": self.model,
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }],
        })
    }

    /// A line of text added to the answer: what the person reads when the
    /// plan stops it half way.
    pub fn note(&self, text: &str) -> Value {
        self.chunk(json!({ "content": text }), None)
    }

    pub fn event(&mut self, ev: &Value) -> Vec<Value> {
        let call_index = |calls: &[String], id: &Value| id.as_str().and_then(|id| calls.iter().position(|c| c == id));
        match ev["type"].as_str().unwrap_or("") {
            "response.output_text.delta" => vec![self.chunk(json!({ "content": ev["delta"] }), None)],
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                vec![self.chunk(json!({ "reasoning_content": ev["delta"] }), None)]
            }
            "response.output_item.added" if ev["item"]["type"] == "function_call" => {
                let item = &ev["item"];
                let index = self.calls.len();
                self.calls.push(item["id"].as_str().unwrap_or_default().to_string());
                self.streamed.push(false);
                vec![self.chunk(
                    json!({ "tool_calls": [{ "index": index, "id": item["call_id"], "type": "function",
                        "function": { "name": item["name"], "arguments": "" } }] }),
                    None,
                )]
            }
            "response.function_call_arguments.delta" => {
                let Some(index) = call_index(&self.calls, &ev["item_id"]) else { return Vec::new() };
                self.streamed[index] = true;
                vec![self.chunk(json!({ "tool_calls": [{ "index": index, "function": { "arguments": ev["delta"] } }] }), None)]
            }
            // Arguments that came whole, at the end, and never in pieces.
            "response.output_item.done" if ev["item"]["type"] == "function_call" => {
                let Some(index) = call_index(&self.calls, &ev["item"]["id"]) else { return Vec::new() };
                if std::mem::replace(&mut self.streamed[index], true) {
                    return Vec::new();
                }
                vec![self.chunk(json!({ "tool_calls": [{ "index": index, "function": { "arguments": ev["item"]["arguments"] } }] }), None)]
            }
            kind @ ("response.completed" | "response.incomplete") => {
                let finish = match (kind, self.calls.is_empty()) {
                    ("response.incomplete", _) => "length",
                    (_, true) => "stop",
                    (_, false) => "tool_calls",
                };
                let mut last = self.chunk(json!({}), Some(finish));
                let u = &ev["response"]["usage"];
                if u.is_object() {
                    let (i, o) = (u["input_tokens"].as_u64().unwrap_or(0), u["output_tokens"].as_u64().unwrap_or(0));
                    last["usage"] = json!({
                        "prompt_tokens": i, "completion_tokens": o, "total_tokens": i + o,
                        "prompt_tokens_details": { "cached_tokens": u["input_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0) },
                    });
                }
                vec![last]
            }
            _ => Vec::new(),
        }
    }
}

/// An OpenAI error as a status and a sentence a person can act on.
pub fn explain(err: &Value, status: u16) -> (u16, String) {
    match err["code"].as_str().unwrap_or("") {
        "subscription_sharing_usage_limit_exceeded" => {
            (429, format!("Your ChatGPT plan has no Cinderpaw usage left for now. See or change it in Manage usage: {MANAGE_USAGE}"))
        }
        "subscription_sharing_usage_unavailable" => {
            (403, format!("Your ChatGPT plan cannot be used in Cinderpaw right now. See why in Manage usage: {MANAGE_USAGE}"))
        }
        code => {
            let said = err["message"].as_str().filter(|m| !m.is_empty()).unwrap_or(code);
            let said: String = said.chars().take(200).collect();
            (status, if said.is_empty() { "ChatGPT could not answer. Try again.".into() } else { format!("ChatGPT could not answer: {said}") })
        }
    }
}

/// A stream event that ends the answer with an error.
pub fn failure(ev: &Value) -> Option<(u16, String)> {
    match ev["type"].as_str()? {
        "response.failed" => Some(explain(&ev["response"]["error"], 502)),
        "error" => Some(explain(ev.get("error").filter(|e| e.is_object()).unwrap_or(ev), 502)),
        _ => None,
    }
}

/// The chunks of a whole answer folded into one chat.completion, for a caller
/// that did not ask for a stream (plan usage is always streamed upstream).
#[derive(Default)]
pub struct Collected {
    content: String,
    calls: Vec<(String, String, String)>,
    finish: Option<String>,
    usage: Value,
}

impl Collected {
    pub fn add(&mut self, chunk: &Value) {
        let c = &chunk["choices"][0];
        if let Some(t) = c["delta"]["content"].as_str() {
            self.content.push_str(t);
        }
        for tc in c["delta"]["tool_calls"].as_array().into_iter().flatten() {
            let i = tc["index"].as_u64().unwrap_or(0) as usize;
            if self.calls.len() <= i {
                self.calls.resize(i + 1, Default::default());
            }
            if let Some(id) = tc["id"].as_str() {
                self.calls[i].0 = id.into();
            }
            if let Some(n) = tc["function"]["name"].as_str() {
                self.calls[i].1 = n.into();
            }
            if let Some(a) = tc["function"]["arguments"].as_str() {
                self.calls[i].2.push_str(a);
            }
        }
        if let Some(f) = c["finish_reason"].as_str() {
            self.finish = Some(f.into());
        }
        if chunk["usage"].is_object() {
            self.usage = chunk["usage"].clone();
        }
    }

    pub fn into_completion(self, model: &str) -> Value {
        let mut message = json!({ "role": "assistant", "content": self.content });
        if !self.calls.is_empty() {
            message["tool_calls"] = self
                .calls
                .into_iter()
                .map(|(id, name, args)| json!({ "id": id, "type": "function", "function": { "name": name, "arguments": args } }))
                .collect();
        }
        json!({
            "id": "chatcmpl-chatgpt",
            "object": "chat.completion",
            "model": model,
            "choices": [{ "index": 0, "message": message, "finish_reason": self.finish.unwrap_or_else(|| "stop".into()) }],
            "usage": self.usage,
        })
    }
}

/// The JSON events of a server-sent event stream, one per `data:` line.
///
/// Bytes are kept until a whole line is in: a chunk can end in the middle of
/// a letter, and decoding each chunk on its own broke Romanian diacritics.
pub struct Events<S> {
    inner: S,
    buf: Vec<u8>,
    ready: VecDeque<Value>,
}

impl<S, B, E> Events<S>
where
    S: futures::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
{
    pub fn new(inner: S) -> Self {
        Self { inner, buf: Vec::new(), ready: VecDeque::new() }
    }

    pub async fn next(&mut self) -> Option<Value> {
        loop {
            if let Some(v) = self.ready.pop_front() {
                return Some(v);
            }
            let chunk = futures::StreamExt::next(&mut self.inner).await?.ok()?;
            self.buf.extend_from_slice(chunk.as_ref());
            while let Some(end) = self.buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = self.buf.drain(..=end).collect();
                let line = String::from_utf8_lossy(&line);
                if let Some(data) = line.trim().strip_prefix("data:") {
                    if let Ok(v) = serde_json::from_str(data.trim()) {
                        self.ready.push_back(v);
                    }
                }
            }
        }
    }
}

/// The models this account may use, as (slug, display name), in OpenAI's order.
pub fn list_models(body: &Value) -> Vec<(String, String)> {
    body["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["visibility"] == "list")
        .filter_map(|m| {
            let slug = m["slug"].as_str()?;
            Some((slug.to_string(), m["display_name"].as_str().unwrap_or(slug).to_string()))
        })
        .collect()
}

pub async fn models(token: &str) -> Result<Vec<(String, String)>, String> {
    let unreachable = || "ChatGPT is not reachable right now. Check that you are online and try again.".to_string();
    let response = reqwest::Client::new().get(MODELS_URL).bearer_auth(token).send().await.map_err(|_| unreachable())?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.map_err(|_| unreachable())?;
    if !(200..300).contains(&status) {
        return Err(explain(&body["error"], status).1);
    }
    Ok(list_models(&body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_text_becomes_instructions_and_nothing_the_plan_refuses_is_sent() {
        let chat = json!({
            "model": "gpt-6.1-sol", "temperature": 0.7, "max_tokens": 400, "stream": true,
            "stream_options": { "include_usage": true },
            "messages": [
                { "role": "system", "content": "Be brief." },
                { "role": "user", "content": "Salut" },
                { "role": "assistant", "content": "Bună!" },
                { "role": "user", "content": [
                    { "type": "text", "text": "Ce e aici?" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
                ] },
            ],
        });
        let r = to_responses(&chat);
        assert_eq!(r["instructions"], "Be brief.");
        assert_eq!(r["store"], false);
        assert_eq!(r["stream"], true);
        for refused in ["temperature", "max_tokens", "max_output_tokens", "messages", "stream_options", "previous_response_id"] {
            assert!(r.get(refused).is_none(), "{refused} must not be sent");
        }
        let input = r["input"].as_array().unwrap();
        assert!(input.iter().all(|m| m["role"] != "system"), "system items are rejected on this route");
        assert_eq!(input[0], json!({ "role": "user", "content": "Salut" }));
        assert_eq!(input[1], json!({ "role": "assistant", "content": "Bună!" }));
        assert_eq!(input[2]["content"][1], json!({ "type": "input_image", "image_url": "data:image/png;base64,AAAA" }));
    }

    #[test]
    fn tools_are_carried_flat_and_effort_asks_for_a_summary() {
        let chat = json!({
            "model": "m", "messages": [], "tool_choice": "auto", "reasoning": { "effort": "low" },
            "tools": [{ "type": "function", "function": { "name": "file_read", "description": "Read", "parameters": { "type": "object" } } }],
        });
        let r = to_responses(&chat);
        assert_eq!(r["tools"], json!([{ "type": "function", "name": "file_read", "description": "Read", "parameters": { "type": "object" } }]));
        assert_eq!(r["tool_choice"], "auto");
        assert_eq!(r["reasoning"], json!({ "effort": "low", "summary": "auto" }));
    }

    #[test]
    fn text_thinking_and_two_tool_calls_come_out_as_chat_chunks() {
        let mut t = Translator::new("m");
        let mut out = Vec::new();
        for ev in [
            json!({ "type": "response.reasoning_summary_text.delta", "delta": "hmm" }),
            json!({ "type": "response.output_text.delta", "delta": "Caut" }),
            json!({ "type": "response.output_item.added", "item": { "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "a" } }),
            json!({ "type": "response.output_item.added", "item": { "type": "function_call", "id": "fc_2", "call_id": "call_2", "name": "b" } }),
            json!({ "type": "response.function_call_arguments.delta", "item_id": "fc_2", "delta": "{\"x\":" }),
            json!({ "type": "response.function_call_arguments.delta", "item_id": "fc_2", "delta": "1}" }),
            // fc_1's arguments arrive whole, only at the end; fc_2's are not repeated.
            json!({ "type": "response.output_item.done", "item": { "type": "function_call", "id": "fc_1", "arguments": "{}" } }),
            json!({ "type": "response.output_item.done", "item": { "type": "function_call", "id": "fc_2", "arguments": "{\"x\":1}" } }),
            json!({ "type": "response.completed", "response": { "usage": { "input_tokens": 10, "output_tokens": 5, "input_tokens_details": { "cached_tokens": 4 } } } }),
        ] {
            out.extend(t.event(&ev));
        }
        let mut all = Collected::default();
        out.iter().for_each(|c| all.add(c));
        let done = all.into_completion("m");
        assert_eq!(out[0]["choices"][0]["delta"]["reasoning_content"], "hmm");
        assert_eq!(done["choices"][0]["message"]["content"], "Caut");
        assert_eq!(done["choices"][0]["finish_reason"], "tool_calls");
        let calls = done["choices"][0]["message"]["tool_calls"].as_array().unwrap();
        assert_eq!(calls[0]["id"], "call_1");
        assert_eq!(calls[0]["function"]["arguments"], "{}");
        assert_eq!((calls[1]["function"]["name"].as_str(), calls[1]["function"]["arguments"].as_str()), (Some("b"), Some("{\"x\":1}")));
        assert_eq!(done["usage"]["prompt_tokens"], 10);
        assert_eq!(done["usage"]["prompt_tokens_details"]["cached_tokens"], 4);
    }

    #[test]
    fn a_used_up_plan_says_where_to_look() {
        let ev = json!({ "type": "response.failed", "response": { "error": { "code": "subscription_sharing_usage_limit_exceeded" } } });
        let (status, said) = failure(&ev).unwrap();
        assert_eq!(status, 429);
        assert!(said.contains(MANAGE_USAGE));
        assert!(failure(&json!({ "type": "response.output_text.delta" })).is_none());
        assert_eq!(explain(&json!({ "code": "x", "message": "bad model" }), 400), (400, "ChatGPT could not answer: bad model".into()));
    }

    #[test]
    fn only_listed_models_are_offered() {
        let body = json!({ "models": [
            { "slug": "gpt-6.1-sol", "display_name": "GPT-6.1 Sol", "visibility": "list" },
            { "slug": "internal", "visibility": "hide" },
        ] });
        assert_eq!(list_models(&body), vec![("gpt-6.1-sol".to_string(), "GPT-6.1 Sol".to_string())]);
    }

    #[tokio::test]
    async fn events_survive_a_letter_split_across_two_chunks() {
        let line = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ă\"}\n\n".as_bytes();
        let cut = line.iter().position(|b| *b == 0xC4).unwrap() + 1; // inside the two bytes of "ă"
        let parts: Vec<Result<Vec<u8>, ()>> = vec![Ok(line[..cut].to_vec()), Ok(line[cut..].to_vec())];
        let mut events = Events::new(futures::stream::iter(parts));
        assert_eq!(events.next().await.unwrap()["delta"], "ă");
        assert!(events.next().await.is_none());
    }
}
