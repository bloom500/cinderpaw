use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::inference::{InferParams, Message, ModelManager};
use crate::paths;
use crate::tools::{self, ToolType};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AgentConfig {
    #[serde(default = "new_id")]
    pub id: String,
    pub name: String,
    pub system_prompt: String,
    pub model_id: String,
    pub tools: Vec<ToolType>,
    #[serde(default)]
    pub params: Option<InferParams>,
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

/// Validate that an agent id is safe for use as a filename component.
/// Accepts only `[a-zA-Z0-9_-]`, 1–64 chars. Rejects empty, dots, slashes,
/// backslashes, spaces, or any other character that could form a path traversal.
pub fn validate_agent_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 64 {
        return Err(anyhow::anyhow!(
            "agent id must be 1–64 characters; got {}",
            id.len()
        ));
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(anyhow::anyhow!(
            "agent id contains invalid characters (only a-z, A-Z, 0-9, '-', '_' allowed)"
        ));
    }
    Ok(())
}

pub fn save(cfg: &AgentConfig) -> Result<()> {
    validate_agent_id(&cfg.id)?;
    paths::ensure_dirs()?;
    let path = paths::agents_dir().join(format!("{}.json", cfg.id));
    std::fs::write(path, serde_json::to_vec_pretty(cfg)?)?;
    Ok(())
}

pub fn list() -> Result<Vec<AgentConfig>> {
    paths::ensure_dirs()?;
    let mut out = Vec::new();
    let dir = paths::agents_dir();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let bytes = std::fs::read(entry.path())?;
        if let Ok(cfg) = serde_json::from_slice::<AgentConfig>(&bytes) {
            out.push(cfg);
        }
    }
    Ok(out)
}

pub fn delete(id: &str) -> Result<()> {
    validate_agent_id(id)?;
    let path = paths::agents_dir().join(format!("{}.json", id));
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

/// Preset agent templates surfaced by the frontend.
pub fn presets() -> Vec<AgentConfig> {
    vec![
        AgentConfig {
            id: new_id(),
            name: "Research Assistant".into(),
            system_prompt: "You are a research assistant. Use web_search liberally and cite sources.".into(),
            model_id: String::new(),
            tools: vec![ToolType::WebSearch, ToolType::HttpRequest],
            params: None,
        },
        AgentConfig {
            id: new_id(),
            name: "Code Helper".into(),
            system_prompt: "You are a senior engineer. Read files, propose edits, run snippets to verify.".into(),
            model_id: String::new(),
            tools: vec![ToolType::FileRead, ToolType::FileWrite, ToolType::CodeExecute],
            params: None,
        },
        AgentConfig {
            id: new_id(),
            name: "File Organizer".into(),
            system_prompt: "You organize files by reading and renaming them based on content.".into(),
            model_id: String::new(),
            tools: vec![ToolType::FileRead, ToolType::FileWrite],
            params: None,
        },
        AgentConfig {
            id: new_id(),
            name: "Web Scraper".into(),
            system_prompt: "You scrape and summarize web content.".into(),
            model_id: String::new(),
            tools: vec![ToolType::HttpRequest, ToolType::WebSearch],
            params: None,
        },
    ]
}

/// Runner emits a stream of `AgentEvent` records (serialized as JSON lines).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
    Token { text: String },
    ToolCall { name: String, args: serde_json::Value },
    ToolResult { name: String, ok: bool, output: String },
    Final { text: String },
    Error { message: String },
}

pub fn tool_calling_system_prompt(cfg: &AgentConfig) -> String {
    let mut s = String::new();
    s.push_str(&cfg.system_prompt);
    s.push_str("\n\nYou have access to the following tools. To call a tool, emit a single JSON object on its own line:\n");
    s.push_str("{\"tool\":\"<name>\",\"args\":{...}}\n\nAvailable tools:\n");
    for t in &cfg.tools {
        s.push_str(&format!("- {}: {}\n", t.name(), t.description()));
    }
    s.push_str("\nWhen finished, emit: {\"final\":\"<your answer>\"}\n");
    s
}

/// Drive an agent loop. Returns a receiver that yields JSON-encoded `AgentEvent`s.
pub fn run(
    cfg: AgentConfig,
    user_prompt: String,
    manager: Arc<ModelManager>,
) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel::<String>(64);

    tokio::spawn(async move {
        let send = |tx: &mpsc::Sender<String>, ev: AgentEvent| {
            let json = serde_json::to_string(&ev).unwrap_or_default();
            let tx = tx.clone();
            async move { let _ = tx.send(json).await; }
        };

        let mut messages = vec![
            Message { role: "system".into(), content: tool_calling_system_prompt(&cfg) },
            Message { role: "user".into(), content: user_prompt },
        ];

        let params = cfg.params.clone().unwrap_or_default();
        let max_steps = 6;

        for _step in 0..max_steps {
            let mut buffer = String::new();
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let mut stream = Box::pin(manager.stream_chat(messages.clone(), params.clone(), stop));
            use futures::StreamExt;
            while let Some(tok) = stream.next().await {
                match tok {
                    Ok(t) => {
                        buffer.push_str(&t);
                        send(&tx, AgentEvent::Token { text: t }).await;
                    }
                    Err(e) => {
                        send(&tx, AgentEvent::Error { message: e.to_string() }).await;
                        return;
                    }
                }
            }

            // Parse last JSON-looking line for tool call or final answer.
            if let Some(final_text) = extract_final(&buffer) {
                send(&tx, AgentEvent::Final { text: final_text }).await;
                return;
            }
            if let Some(call) = extract_tool_call(&buffer) {
                let tool_type = cfg.tools.iter().find(|t| t.name() == call.name).copied();
                match tool_type {
                    Some(t) => {
                        send(&tx, AgentEvent::ToolCall {
                            name: call.name.clone(),
                            args: call.args.clone(),
                        }).await;
                        let result = tools::execute(t, call.args).await;
                        send(&tx, AgentEvent::ToolResult {
                            name: result.name.clone(),
                            ok: result.ok,
                            output: result.output.clone(),
                        }).await;
                        messages.push(Message { role: "assistant".into(), content: buffer });
                        messages.push(Message {
                            role: "user".into(),
                            content: format!("[tool:{}] {}", result.name, result.output),
                        });
                        continue;
                    }
                    None => {
                        send(&tx, AgentEvent::Error {
                            message: format!("unknown or disabled tool: {}", call.name),
                        }).await;
                        return;
                    }
                }
            }
            // No tool call, no final marker — treat the buffer as the answer.
            send(&tx, AgentEvent::Final { text: buffer }).await;
            return;
        }

        send(&tx, AgentEvent::Error { message: "max agent steps reached".into() }).await;
    });

    rx
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── agent ID validation ──────────────────────────────────────────────────

    #[test]
    fn valid_uuid_id_is_accepted() {
        assert!(validate_agent_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
    }

    #[test]
    fn valid_slug_id_is_accepted() {
        assert!(validate_agent_id("my-agent_1").is_ok());
    }

    #[test]
    fn empty_id_is_rejected() {
        assert!(validate_agent_id("").is_err());
    }

    #[test]
    fn id_too_long_is_rejected() {
        assert!(validate_agent_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn path_traversal_id_is_rejected() {
        assert!(validate_agent_id("../passwd").is_err());
        assert!(validate_agent_id("..").is_err());
        assert!(validate_agent_id(".").is_err());
    }

    #[test]
    fn slash_in_id_is_rejected() {
        assert!(validate_agent_id("foo/bar").is_err());
    }

    #[test]
    fn backslash_in_id_is_rejected() {
        assert!(validate_agent_id("foo\\bar").is_err());
    }

    #[test]
    fn space_in_id_is_rejected() {
        assert!(validate_agent_id("foo bar").is_err());
    }

    #[test]
    fn dot_in_id_is_rejected() {
        assert!(validate_agent_id("foo.bar").is_err());
    }
}

#[derive(Debug)]
struct ParsedCall {
    name: String,
    args: serde_json::Value,
}

fn extract_final(s: &str) -> Option<String> {
    for line in s.lines().rev() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) {
            if let Some(f) = v.get("final").and_then(|x| x.as_str()) {
                return Some(f.to_string());
            }
        }
    }
    None
}

fn extract_tool_call(s: &str) -> Option<ParsedCall> {
    for line in s.lines().rev() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) {
            if let (Some(name), Some(args)) = (
                v.get("tool").and_then(|x| x.as_str()),
                v.get("args").cloned(),
            ) {
                return Some(ParsedCall { name: name.to_string(), args });
            }
        }
    }
    None
}
