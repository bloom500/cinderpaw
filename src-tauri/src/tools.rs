use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ToolType {
    WebSearch,
    FileRead,
    FileWrite,
    CodeExecute,
    HttpRequest,
}

impl ToolType {
    pub fn name(&self) -> &'static str {
        match self {
            Self::WebSearch => "web_search",
            Self::FileRead => "file_read",
            Self::FileWrite => "file_write",
            Self::CodeExecute => "code_execute",
            Self::HttpRequest => "http_request",
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            Self::WebSearch => "Search the web via DuckDuckGo. Args: { \"query\": string }",
            Self::FileRead => "Read a UTF-8 file from disk. Args: { \"path\": string }",
            Self::FileWrite => "Write a UTF-8 file. Args: { \"path\": string, \"content\": string }",
            Self::CodeExecute => "Execute Python or shell code. Args: { \"lang\": \"python\"|\"shell\", \"code\": string }",
            Self::HttpRequest => "HTTP GET/POST. Args: { \"method\": string, \"url\": string, \"body\"?: string }",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub name: String,
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub name: String,
    pub ok: bool,
    pub output: String,
}

pub async fn execute(tool: ToolType, args: Value) -> ToolResult {
    let name = tool.name().to_string();
    let res: Result<String> = match tool {
        ToolType::WebSearch => web_search(args).await,
        ToolType::FileRead => file_read(args),
        ToolType::FileWrite => file_write(args),
        ToolType::CodeExecute => code_execute(args).await,
        ToolType::HttpRequest => http_request(args).await,
    };
    match res {
        Ok(output) => ToolResult { name, ok: true, output },
        Err(e) => ToolResult { name, ok: false, output: e.to_string() },
    }
}

async fn web_search(args: Value) -> Result<String> {
    let q = args.get("query").and_then(|v| v.as_str()).ok_or_else(|| anyhow!("missing query"))?;
    let url = format!("https://api.duckduckgo.com/?q={}&format=json&no_redirect=1", urlencoding(q));
    let resp = reqwest::get(&url).await?.text().await?;
    Ok(resp)
}

fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

fn file_read(args: Value) -> Result<String> {
    let path = args.get("path").and_then(|v| v.as_str()).ok_or_else(|| anyhow!("missing path"))?;
    Ok(std::fs::read_to_string(path)?)
}

fn file_write(args: Value) -> Result<String> {
    let path = args.get("path").and_then(|v| v.as_str()).ok_or_else(|| anyhow!("missing path"))?;
    let content = args.get("content").and_then(|v| v.as_str()).ok_or_else(|| anyhow!("missing content"))?;
    std::fs::write(path, content)?;
    Ok(format!("wrote {} bytes to {}", content.len(), path))
}

async fn code_execute(args: Value) -> Result<String> {
    let lang = args.get("lang").and_then(|v| v.as_str()).unwrap_or("python");
    if lang != "python" {
        return Err(anyhow!("only 'python' is supported for code execution"));
    }
    let code = args.get("code").and_then(|v| v.as_str()).ok_or_else(|| anyhow!("missing code"))?;
    let output = tokio::task::spawn_blocking({
        let code = code.to_string();
        move || -> Result<String> {
            let out = std::process::Command::new("python")
                .args(["-c", &code])
                .output()?;
            let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
            if !out.stderr.is_empty() {
                s.push_str("\n[stderr]\n");
                s.push_str(&String::from_utf8_lossy(&out.stderr));
            }
            Ok(s)
        }
    })
    .await??;
    Ok(output)
}

async fn http_request(args: Value) -> Result<String> {
    let method = args.get("method").and_then(|v| v.as_str()).unwrap_or("GET").to_uppercase();
    let url = args.get("url").and_then(|v| v.as_str()).ok_or_else(|| anyhow!("missing url"))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let req = match method.as_str() {
        "POST" => {
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
            client.post(url).body(body.to_string())
        }
        _ => client.get(url),
    };
    let resp = req.send().await?.text().await?;
    Ok(resp)
}
