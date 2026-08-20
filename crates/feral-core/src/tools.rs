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
            Self::FileRead => "Read a UTF-8 file from inside the agent workspace (paths are confined to it).",
            Self::FileWrite => "Write text to a file inside the agent workspace (paths are confined to it).",
            Self::CodeExecute => "Execute Python code (disabled unless FERAL_ENABLE_CODE_EXEC=true; runs with a minimal env).",
            Self::HttpRequest => "HTTP GET/POST to a PUBLIC host (loopback/private/link-local addresses are blocked).",
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

    /// Every tool there is. Used by anything that has to advertise the whole set
    /// rather than answer about one — a vendor's tool list, a UI, a test that
    /// must fail when a tool is added and forgotten.
    pub const ALL: &'static [ToolType] = &[
        Self::WebSearch,
        Self::FileRead,
        Self::FileWrite,
        Self::CodeExecute,
        Self::HttpRequest,
    ];

    /// The JSON Schema for this tool's arguments, in one place.
    ///
    /// Every vendor wants the same schema in a different envelope: OpenAI nests
    /// it under `function.parameters`, Anthropic calls it `input_schema`, Gemini
    /// takes it bare. What none of them change is the schema itself, so it is
    /// written once here and wrapped below. It used to be copied per renderer,
    /// which meant a tool gaining an argument had to be edited in as many places
    /// as there were providers, and a missed one does not fail — it silently
    /// tells that provider the argument does not exist.
    pub fn parameters(&self) -> serde_json::Value {
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
            "type": "object",
            "properties": properties,
            "required": required
        })
    }

    #[allow(clippy::wrong_self_convention)] // reads `&self`; renaming would ripple to all callers
    pub fn to_openai_definition(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": self.parameters()
            }
        })
    }

    /// Anthropic Messages API tool definition. Unlike OpenAI, Anthropic
    /// wraps each tool as a flat `{name, description, input_schema}` object
    /// — no `type: "function"` envelope and `parameters` is renamed to
    /// `input_schema`. Same field semantics, different shape.
    #[allow(clippy::wrong_self_convention)] // reads `&self`; mirrors to_openai_definition
    pub fn to_anthropic_definition(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name(),
            "description": self.description(),
            "input_schema": self.parameters()
        })
    }

    /// Gemini's shape: name, description, and the schema bare under
    /// `parameters`. Typed rather than JSON because the Live setup message is
    /// typed, and this is the one renderer whose output goes into a struct.
    #[allow(clippy::wrong_self_convention)] // mirrors the two above
    pub fn to_gemini_declaration(&self) -> crate::live::FunctionDeclaration {
        crate::live::FunctionDeclaration {
            name: self.name().to_string(),
            description: self.description().to_string(),
            parameters: self.parameters(),
            behavior: None,
        }
    }
}

/// Parsed tool call. Retained for the in-progress local-model tool-calling path;
/// the cloud path uses the provider's native tool_calls instead.
#[allow(dead_code)]
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

// ── Agent file-tool confinement (C-2) ───────────────────────────────────────
//
// Unlike the webview-facing readers in lib.rs (which only add `deny_feral_private`),
// the LLM-driven file tools are confined to a single workspace root. The root
// lives OUTSIDE `~/.feral` proper (`~/.feral/workspace`), so the agent can never
// reach the api-token, byok.json or the agent DB — they are simply not under the
// root, and the `starts_with` check below rejects any path that escapes it
// (including via `..` or a symlink, because we canonicalize before comparing).

/// Root directory the agent's file tools are confined to. Defaults to
/// `~/.feral/workspace`; override with `FERAL_AGENT_WORKSPACE` (absolute path)
/// to widen access deliberately — opt-in, never default-on.
fn agent_workspace_root() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("FERAL_AGENT_WORKSPACE") {
        let pb = std::path::PathBuf::from(&p);
        if pb.is_absolute() {
            return pb;
        }
        tracing::warn!(path = %p, "FERAL_AGENT_WORKSPACE ignored: not an absolute path");
    }
    crate::paths::feral_agent_workspace_path()
}

/// Canonicalize the workspace root once, creating it if missing so confinement
/// has a stable anchor even on first run.
fn canonical_workspace_root() -> Result<std::path::PathBuf> {
    let root = agent_workspace_root();
    if !root.exists() {
        std::fs::create_dir_all(&root)?;
    }
    root.canonicalize()
        .map_err(|e| anyhow!("agent workspace root unavailable: {e}"))
}

/// Resolve a caller-supplied path and prove it stays inside the workspace root.
/// Relative paths resolve against the root (never the process cwd). For writes
/// (`must_exist = false`) a not-yet-existing target is allowed, but its parent
/// must already resolve inside the root — and if the target itself exists as a
/// symlink, it is fully resolved so it can't point outside.
fn confine_path(path: &str, must_exist: bool) -> Result<std::path::PathBuf> {
    let root = canonical_workspace_root()?;
    let requested = std::path::Path::new(path);
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };

    let canonical = match joined.canonicalize() {
        Ok(c) => c,
        Err(_) if !must_exist => {
            // Target doesn't exist yet — canonicalize the parent and re-attach
            // the final component so a `..` in the parent can't escape.
            let parent = joined
                .parent()
                .ok_or_else(|| anyhow!("path has no parent directory"))?;
            let file_name = joined
                .file_name()
                .ok_or_else(|| anyhow!("path has no file name"))?;
            parent
                .canonicalize()
                .map_err(|e| anyhow!("invalid parent directory: {e}"))?
                .join(file_name)
        }
        Err(e) => return Err(anyhow!("invalid path: {e}")),
    };

    if !canonical.starts_with(&root) {
        return Err(anyhow!(
            "access denied: path escapes the agent workspace ({}). \
             Set FERAL_AGENT_WORKSPACE to an absolute path to widen access.",
            root.display()
        ));
    }
    Ok(canonical)
}

fn file_read(args: Value) -> Result<String> {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing path"))?;
    let canonical = confine_path(path, true)?;
    let meta = std::fs::metadata(&canonical)?;
    const MAX: u64 = 10 * 1024 * 1024;
    if meta.len() > MAX {
        return Err(anyhow!("file too large (max 10 MB)"));
    }
    Ok(std::fs::read_to_string(&canonical)?)
}

fn file_write(args: Value) -> Result<String> {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing path"))?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing content"))?;
    let canonical = confine_path(path, false)?;

    // Atomic write: stage into a temp file in the same directory, then rename
    // so a crash mid-write can't leave a half-written file in place.
    let dir = canonical
        .parent()
        .ok_or_else(|| anyhow!("target has no parent directory"))?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".feral-write-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, content)?;
    if let Err(e) = std::fs::rename(&tmp, &canonical) {
        let _ = std::fs::remove_file(&tmp);
        return Err(anyhow!("write failed: {e}"));
    }
    Ok(format!(
        "wrote {} bytes to {}",
        content.len(),
        canonical.display()
    ))
}

/// `code_execute` runs arbitrary host code, so it is opt-in: it stays disabled
/// unless `FERAL_ENABLE_CODE_EXEC` is `true`/`1`. Mirrors the sidecar's
/// `FERAL_ENABLE_SHELL_EXEC` gate — a generic code runner is never default-on.
fn code_exec_enabled() -> bool {
    matches!(
        std::env::var("FERAL_ENABLE_CODE_EXEC").as_deref(),
        Ok("true") | Ok("1")
    )
}

async fn code_execute(args: Value) -> Result<String> {
    if !code_exec_enabled() {
        return Err(anyhow!(
            "code_execute is disabled. It runs arbitrary code on the host; \
             set FERAL_ENABLE_CODE_EXEC=true to enable it explicitly."
        ));
    }
    let lang = args.get("lang").and_then(|v| v.as_str()).unwrap_or("python");
    if lang != "python" {
        return Err(anyhow!("only 'python' is supported for code execution"));
    }
    let code = args
        .get("code")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing code"))?
        .to_string();

    // Build a child with a MINIMAL environment. The parent env is never
    // inherited wholesale — it carries FERAL_API_KEY (the local API bearer
    // token) and any provider secrets, which arbitrary code must not see.
    let mut cmd = tokio::process::Command::new("python");
    cmd.args(["-c", &code]);
    cmd.env_clear();
    if let Ok(p) = std::env::var("PATH") {
        cmd.env("PATH", p);
    }
    cmd.env("PYTHONIOENCODING", "utf-8");
    #[cfg(windows)]
    {
        // Windows' python needs these to locate its runtime / DLLs.
        for k in ["SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "TEMP", "TMP"] {
            if let Ok(v) = std::env::var(k) {
                cmd.env(k, v);
            }
        }
    }
    #[cfg(unix)]
    {
        if let Ok(v) = std::env::var("HOME") {
            cmd.env("HOME", v);
        }
    }
    // Kill the child if the future is dropped (e.g. on timeout) so a runaway
    // process can't outlive the call.
    cmd.kill_on_drop(true);

    let out = match tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output()).await {
        Ok(res) => res?,
        Err(_) => return Err(anyhow!("code execution timed out after 30s")),
    };

    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.stderr.is_empty() {
        s.push_str("\n[stderr]\n");
        s.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    Ok(s)
}

// ── SSRF guard for the Rust http_request tool (C-3 / H-4) ────────────────────
//
// Ports the egress-proxy's host guard to the native tool path, which otherwise
// reached localhost/LAN/metadata endpoints with no checks at all. Every URL —
// and every redirect hop — is validated by hostname string AND by every
// resolved IP (anti-DNS-rebinding), including IPv4-mapped IPv6 (::ffff:127.0.0.1).

fn is_blocked_v4(a: std::net::Ipv4Addr) -> bool {
    let o = a.octets();
    a.is_loopback()        // 127.0.0.0/8
        || a.is_private()  // 10/8, 172.16/12, 192.168/16
        || a.is_link_local() // 169.254/16
        || a.is_unspecified() // 0.0.0.0
        || a.is_broadcast()
        || o[0] == 0 // "this" network
        // 100.64.0.0/10 — carrier-grade NAT. `is_private` does not cover it,
        // and it is exactly where an ISP's and a corporate LAN's internal
        // machines live, so a domain resolving here was a way through the SSRF
        // guard to somewhere that felt "public" only on paper.
        || (o[0] == 100 && (64..=127).contains(&o[1]))
        // Documentation/test ranges: never a legitimate destination.
        || (o[0] == 192 && o[1] == 0 && o[2] == 2)
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
        // 198.18.0.0/15 — benchmarking range.
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
        // 240.0.0.0/4 — reserved.
        || o[0] >= 240
}

fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_blocked_v4(v4),
        std::net::IpAddr::V6(v6) => {
            // IPv4-mapped (::ffff:a.b.c.d) and the deprecated v4-compatible form
            // must be unwrapped, or `::ffff:127.0.0.1` slips straight through.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_blocked_v4(mapped);
            }
            if let Some(v4) = v6.to_ipv4() {
                return is_blocked_v4(v4);
            }
            let seg0 = v6.segments()[0];
            v6.is_loopback()              // ::1
                || v6.is_unspecified()    // ::
                || (seg0 & 0xfe00) == 0xfc00 // ULA  fc00::/7
                || (seg0 & 0xffc0) == 0xfe80 // link-local fe80::/10
        }
    }
}

/// Validate a single URL hop: scheme, host-string SSRF guard, and resolved-IP
/// SSRF guard. Returns the parsed URL so the caller can follow redirects.
/// `assert_public_url` off the async worker.
///
/// It resolves DNS with the blocking `to_socket_addrs`, and it is called from
/// an async tool handler — so a slow or dead resolver parks a whole tokio
/// worker thread for the length of the lookup, and every unrelated request
/// that happens to sit on that worker times out with it. The check itself is
/// right; only the thread it ran on was wrong.
async fn assert_public_url_async(raw: &str) -> Result<reqwest::Url> {
    let raw = raw.to_string();
    tokio::task::spawn_blocking(move || assert_public_url(&raw))
        .await
        .map_err(|e| anyhow!("url validation task failed: {e}"))?
}

fn assert_public_url(raw: &str) -> Result<reqwest::Url> {
    use std::net::ToSocketAddrs;
    let parsed = reqwest::Url::parse(raw).map_err(|e| anyhow!("malformed URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(anyhow!("disallowed scheme: {other}")),
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow!("URL has no host"))?
        .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return Err(anyhow!("destination is loopback: {host}"));
    }
    // `host_str()` returns an IPv6 literal WITH its brackets (`[::1]`), and
    // `IpAddr::from_str` rejects the bracketed form — so this check silently
    // never ran for IPv6, and `http://[::1]/` walked straight through the guard
    // on any platform whose resolver also declined the bracketed host (Linux).
    // Strip them so an IPv6 literal is checked like any other address.
    let host_ip = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host.as_str());
    if let Ok(ip) = host_ip.parse::<std::net::IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(anyhow!(
                "destination is loopback/private/link-local: {host}"
            ));
        }
    }
    // Resolve every A/AAAA and reject if any points into a blocked range.
    let port = parsed.port_or_known_default().unwrap_or(443);
    if let Ok(addrs) = (host_ip, port).to_socket_addrs() {
        for addr in addrs {
            if is_blocked_ip(addr.ip()) {
                return Err(anyhow!(
                    "host \"{host}\" resolves to a blocked address: {}",
                    addr.ip()
                ));
            }
        }
    }
    // DNS failure: fall through — the request itself will surface the error,
    // mirroring the sidecar egress proxy's behaviour.
    Ok(parsed)
}

async fn http_request(args: Value) -> Result<String> {
    let method = args.get("method").and_then(|v| v.as_str()).unwrap_or("GET").to_uppercase();
    let url    = args.get("url").and_then(|v| v.as_str()).ok_or_else(|| anyhow!("missing url"))?;
    let body   = args.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Follow redirects MANUALLY so every hop is re-validated — `reqwest`'s
    // automatic follow would chase a 3xx into a private address unchecked.
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; FeralAI/0.1)")
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    const MAX_REDIRECTS: usize = 5;
    let mut current = assert_public_url_async(url).await?;
    let mut cur_method = method;
    let mut cur_body = body;

    let (status, content_type, raw) = {
        let mut hop = 0usize;
        loop {
            let req = match cur_method.as_str() {
                "POST" => client.post(current.clone()).body(cur_body.clone()),
                _ => client.get(current.clone()),
            };
            let resp = req.send().await?;
            let st = resp.status();
            if st.is_redirection() {
                if let Some(loc) = resp.headers().get("location").and_then(|v| v.to_str().ok()) {
                    if hop >= MAX_REDIRECTS {
                        return Err(anyhow!("too many redirects (> {MAX_REDIRECTS}) starting at {url}"));
                    }
                    let next = current
                        .join(loc)
                        .map_err(|e| anyhow!("bad redirect location: {e}"))?;
                    // 303, or 301/302 on an unsafe method → downgrade to GET, drop body.
                    let code = st.as_u16();
                    if code == 303
                        || ((code == 301 || code == 302) && cur_method != "GET" && cur_method != "HEAD")
                    {
                        cur_method = "GET".into();
                        cur_body = String::new();
                    }
                    current = assert_public_url_async(next.as_str()).await?;
                    hop += 1;
                    continue;
                }
            }
            let status = st.as_u16();
            let content_type = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let raw = resp.text().await?;
            break (status, content_type, raw);
        }
    };

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

#[cfg(test)]
mod security_tests {
    use super::*;
    use std::net::IpAddr;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn blocks_loopback_and_private_v4() {
        assert!(is_blocked_ip(ip("127.0.0.1")));
        assert!(is_blocked_ip(ip("10.1.2.3")));
        assert!(is_blocked_ip(ip("172.16.0.1")));
        assert!(is_blocked_ip(ip("192.168.1.1")));
        assert!(is_blocked_ip(ip("169.254.169.254"))); // link-local / cloud metadata
        assert!(is_blocked_ip(ip("0.0.0.0")));
    }

    #[test]
    fn blocks_ipv6_loopback_and_ula() {
        assert!(is_blocked_ip(ip("::1")));
        assert!(is_blocked_ip(ip("fc00::1"))); // ULA
        assert!(is_blocked_ip(ip("fe80::1"))); // link-local
    }

    #[test]
    fn blocks_ipv4_mapped_ipv6() {
        // H-4 regression: ::ffff:a.b.c.d must be unwrapped and blocked.
        assert!(is_blocked_ip(ip("::ffff:127.0.0.1")));
        assert!(is_blocked_ip(ip("::ffff:169.254.169.254")));
        assert!(is_blocked_ip(ip("::ffff:10.0.0.1")));
    }

    #[test]
    fn allows_public_addresses() {
        assert!(!is_blocked_ip(ip("8.8.8.8")));
        assert!(!is_blocked_ip(ip("1.1.1.1")));
        assert!(!is_blocked_ip(ip("2606:4700:4700::1111"))); // public IPv6
    }

    #[test]
    fn rejects_disallowed_schemes() {
        assert!(assert_public_url("file:///etc/passwd").is_err());
        assert!(assert_public_url("ftp://example.com/x").is_err());
        assert!(assert_public_url("not a url").is_err());
    }

    #[test]
    fn rejects_loopback_hosts() {
        assert!(assert_public_url("http://localhost/").is_err());
        assert!(assert_public_url("http://127.0.0.1:8080/").is_err());
        assert!(assert_public_url("http://[::1]/").is_err());
        // Literal public IP parses and passes (no network DNS for IP literals).
        assert!(assert_public_url("http://8.8.8.8/").is_ok());
    }

    /// `host_str()` hands back an IPv6 literal WITH brackets and
    /// `IpAddr::from_str` refuses that form, so the literal-IP check used to be
    /// skipped for every IPv6 URL — `http://[::1]/` reached the network on any
    /// platform whose resolver also declined the bracketed host. Loopback has
    /// more than one spelling; all of them have to be refused.
    #[test]
    fn rejects_every_spelling_of_an_ipv6_literal() {
        for url in [
            "http://[::1]/",              // canonical loopback
            "http://[0:0:0:0:0:0:0:1]/",  // same address, written out in full
            "http://[::ffff:127.0.0.1]/", // IPv4 loopback, mapped into IPv6
            "http://[::ffff:10.0.0.5]/",  // private IPv4, mapped into IPv6
            "http://[::]/",               // unspecified
            "http://[fc00::1]/",          // unique-local
            "http://[fe80::1]/",          // link-local
        ] {
            assert!(
                assert_public_url(url).is_err(),
                "SSRF guard let {url} through"
            );
        }
        // A genuinely public IPv6 host must still work.
        assert!(assert_public_url("http://[2606:4700:4700::1111]/").is_ok());
    }

    #[test]
    fn code_exec_disabled_by_default() {
        // The gate reads the env each call; with the var unset it must be off.
        std::env::remove_var("FERAL_ENABLE_CODE_EXEC");
        assert!(!code_exec_enabled());
    }

    #[test]
    fn confines_file_paths_to_workspace() {
        // Isolated workspace via the documented override. This is the only test
        // that touches FERAL_AGENT_WORKSPACE, so no cross-test env race.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        std::env::set_var("FERAL_AGENT_WORKSPACE", &root);

        // A file inside the workspace resolves fine (write path: must_exist=false).
        let inside = confine_path("notes.txt", false).unwrap();
        assert!(inside.starts_with(&root));

        // Escapes are rejected.
        assert!(confine_path("../escape.txt", false).is_err());
        #[cfg(windows)]
        assert!(confine_path(r"C:\Windows\System32\drivers\etc\hosts", true).is_err());
        #[cfg(unix)]
        assert!(confine_path("/etc/passwd", true).is_err());

        std::env::remove_var("FERAL_AGENT_WORKSPACE");
    }
}

#[cfg(test)]
mod live_search_probe {
    use super::*;

    /// Does the Rust-side `web_search` actually return anything?
    ///
    /// The Live call reaches THIS implementation, not the sidecar's — so the
    /// DuckDuckGo fix that made search work for the agent never applied here.
    /// Ignored by default: it goes to the network.
    #[tokio::test]
    #[ignore = "hits public search instances"]
    async fn probe_web_search() {
        let out = execute(ToolType::WebSearch, serde_json::json!({"query": "ce este Feral AI"})).await;
        println!("ok={} output={}", out.ok, &out.output[..out.output.len().min(600)]);
    }
}
