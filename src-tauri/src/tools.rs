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
            Self::WebSearch => "Search the web via DuckDuckGo.",
            Self::FileRead => "Read a UTF-8 file from disk.",
            Self::FileWrite => "Write text content to a UTF-8 file.",
            Self::CodeExecute => "Execute Python code and return its stdout/stderr.",
            Self::HttpRequest => "Make an HTTP GET or POST request and return the response body.",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "web_search"   => Some(Self::WebSearch),
            "file_read"    => Some(Self::FileRead),
            "file_write"   => Some(Self::FileWrite),
            "code_execute" => Some(Self::CodeExecute),
            "http_request" => Some(Self::HttpRequest),
            _ => None,
        }
    }

    pub fn to_openai_definition(&self) -> serde_json::Value {
        let (properties, required) = match self {
            Self::WebSearch => (
                serde_json::json!({ "query": { "type": "string", "description": "The search query" } }),
                serde_json::json!(["query"]),
            ),
            Self::FileRead => (
                serde_json::json!({ "path": { "type": "string", "description": "Absolute or relative file path" } }),
                serde_json::json!(["path"]),
            ),
            Self::FileWrite => (
                serde_json::json!({
                    "path":    { "type": "string", "description": "File path to write" },
                    "content": { "type": "string", "description": "Text content to write" }
                }),
                serde_json::json!(["path", "content"]),
            ),
            Self::CodeExecute => (
                serde_json::json!({
                    "lang": { "type": "string", "enum": ["python"], "description": "Language (only python supported)" },
                    "code": { "type": "string", "description": "Code to execute" }
                }),
                serde_json::json!(["lang", "code"]),
            ),
            Self::HttpRequest => (
                serde_json::json!({
                    "method": { "type": "string", "enum": ["GET", "POST"], "description": "HTTP method" },
                    "url":    { "type": "string", "description": "Full URL" },
                    "body":   { "type": "string", "description": "Request body for POST" }
                }),
                serde_json::json!(["method", "url"]),
            ),
        };
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required
                }
            }
        })
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

// Public SearXNG instances — open-source metasearch with a clean JSON API.
// Tried in order; first successful response with results wins.
const SEARXNG_INSTANCES: &[&str] = &[
    "https://searx.be",
    "https://paulgo.io",
    "https://search.mdosch.de",
    "https://searxng.site",
    "https://priv.au",
];

async fn web_search(args: Value) -> Result<String> {
    let q = args.get("query").and_then(|v| v.as_str()).ok_or_else(|| anyhow!("missing query"))?;

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; FeralAI/0.1; +https://github.com/feral)")
        .timeout(std::time::Duration::from_secs(12))
        .build()?;

    let mut last_err = String::from("all search instances failed");

    for base in SEARXNG_INSTANCES {
        let url = format!(
            "{}/search?q={}&format=json&categories=general&language=all&safesearch=0",
            base,
            urlencoding(q)
        );

        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => { last_err = e.to_string(); continue; }
        };

        if !resp.status().is_success() {
            last_err = format!("HTTP {}", resp.status().as_u16());
            continue;
        }

        let json: Value = match resp.json().await {
            Ok(j) => j,
            Err(e) => { last_err = e.to_string(); continue; }
        };

        let Some(results_arr) = json.get("results").and_then(|r| r.as_array()) else {
            continue;
        };

        if results_arr.is_empty() { continue; }

        let items: Vec<String> = results_arr
            .iter()
            .take(6)
            .filter_map(|r| {
                let title   = r.get("title").and_then(|v| v.as_str())?;
                let url     = r.get("url").and_then(|v| v.as_str())?;
                let content = r.get("content").and_then(|v| v.as_str()).unwrap_or("");
                Some(format!("**{}**\n{}\n{}", title.trim(), url, content.trim()))
            })
            .collect();

        if items.is_empty() { continue; }

        return Ok(format!("Search results for \"{}\":\n\n{}", q, items.join("\n\n---\n\n")));
    }

    Err(anyhow!("Web search failed ({}). Try http_request on a specific URL instead.", last_err))
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
    let url    = args.get("url").and_then(|v| v.as_str()).ok_or_else(|| anyhow!("missing url"))?;

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; FeralAI/0.1)")
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let req = match method.as_str() {
        "POST" => {
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
            client.post(url).body(body.to_string())
        }
        _ => client.get(url),
    };

    let resp = req.send().await?;
    let status = resp.status().as_u16();
    let content_type = resp.headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let raw = resp.text().await?;

    // Strip HTML to readable text so the model isn't overwhelmed by markup
    let text = if content_type.contains("html") || raw.trim_start().starts_with('<') {
        strip_html(&raw)
    } else {
        raw
    };

    // Truncate to ~8 KB — enough context for most pages without filling the model's window
    const MAX: usize = 8_192;
    let truncated = if text.len() > MAX {
        format!("{}\n\n[... truncated — {} total chars]", &text[..MAX], text.len())
    } else {
        text
    };

    Ok(format!("HTTP {} from {}\n\n{}", status, url, truncated))
}

fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    let mut in_script = false;
    let mut in_style = false;
    let mut prev_space = true;

    let lower = html.to_lowercase();
    let bytes = html.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        // Detect <script> / <style> blocks to skip entirely
        if !in_tag && i + 7 < bytes.len() {
            let frag = &lower[i..];
            if frag.starts_with("<script") { in_script = true; in_tag = true; }
            else if frag.starts_with("<style")  { in_style  = true; in_tag = true; }
            else if in_script && frag.starts_with("</script>") { in_script = false; i += 9; continue; }
            else if in_style  && frag.starts_with("</style>")  { in_style  = false; i += 8; continue; }
        }

        let ch = bytes[i] as char;
        if ch == '<' { in_tag = true; }
        else if ch == '>' { in_tag = false; }
        else if !in_tag && !in_script && !in_style {
            if ch.is_whitespace() {
                if !prev_space { out.push(' '); prev_space = true; }
            } else {
                // Decode common HTML entities inline
                if ch == '&' {
                    let rest = &html[i..];
                    let entity_end = rest.find(';').unwrap_or(0);
                    if entity_end > 0 && entity_end < 8 {
                        let entity = &rest[..=entity_end];
                        let decoded = match entity {
                            "&amp;"  => "&",  "&lt;"   => "<", "&gt;"  => ">",
                            "&quot;" => "\"", "&apos;" => "'", "&nbsp;" => " ",
                            _ => "",
                        };
                        if !decoded.is_empty() {
                            out.push_str(decoded);
                            i += entity.len();
                            prev_space = false;
                            continue;
                        }
                    }
                }
                out.push(ch);
                prev_space = false;
            }
        }
        i += 1;
    }
    out
}
