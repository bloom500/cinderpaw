//! OpenClaw awareness — read-only detection + diagnostics for an external
//! agent gateway / runtime.
//!
//! Scope (intentionally narrow):
//!   * Locate the `openclaw` binary in PATH.
//!   * Run read-only diagnostic commands (`openclaw --version`,
//!     `openclaw status --all`, `openclaw gateway status`,
//!     `openclaw health --json`).
//!   * Redact anything that resembles a token / secret before returning output
//!     to the UI.
//!   * Open the install docs in the OS default browser.
//!
//! Explicit non-goals (Phase 2):
//!   * No chat routing, no streaming, no model picker integration.
//!   * No writes to `~/.openclaw/openclaw.json` or any other OpenClaw file.
//!   * No reads of `~/.openclaw/openclaw.json` — config is opaque here.
//!   * No auto-start, no daemon supervision, no kill / restart.

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

// reqwest is used only for the test-message HTTP call.
// All other probing uses subprocess (openclaw CLI).
#[allow(unused_imports)]
use reqwest;

/// Hard cap on every spawned probe. OpenClaw is supposed to be a local CLI
/// that returns in milliseconds; anything past 5 s is treated as failure and
/// the child is killed.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Install / getting-started docs — the only URL we ever open.
const DOCS_URL: &str = "https://docs.openclaw.ai/start/getting-started";

/// Read-only diagnostic commands. Run in order; each is independent and
/// failure of any one does not block the rest. `--all`, `--json` are best
/// guesses at flag names; if a flag is unsupported on a given OpenClaw build,
/// the command will fail and be surfaced as a non-ok diagnostic — no panic.
const DIAG_COMMANDS: &[(&str, &[&str])] = &[
    ("status",  &["status", "--all"]),
    ("gateway", &["gateway", "status"]),
    ("health",  &["health", "--json"]),
];

// ── Public result types (specta-exported) ────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OpenClawDetectResult {
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OpenClawDiagnostic {
    /// Human-readable command line, e.g. `openclaw gateway status`.
    pub command: String,
    pub ok: bool,
    pub exit_code: Option<i32>,
    /// Stdout with any token-like substring replaced by `<redacted>`.
    pub stdout_redacted: String,
    /// Stderr with any token-like substring replaced by `<redacted>`.
    pub stderr_redacted: String,
    /// Set when the child failed to spawn or the probe timed out.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OpenClawStatusResult {
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub gateway_running: bool,
    pub health_ok: bool,
    pub health_summary: Option<String>,
    pub diagnostics: Vec<OpenClawDiagnostic>,
    /// Short next-step message for the UI to surface.
    pub recommended_action: String,
    /// Capabilities confirmed by read-only probing (e.g. "gateway", "health_check").
    /// An empty vec means nothing could be verified.
    pub capabilities: Vec<String>,
    /// Gateway listen address extracted from `gateway status` output, loopback only.
    /// `None` if not detectable or gateway is not running.
    pub gateway_endpoint: Option<String>,
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn openclaw_detect() -> Result<OpenClawDetectResult, String> {
    let path = locate_openclaw().await;
    let version = match path.as_deref() {
        Some(p) => run_version(p).await,
        None => None,
    };
    Ok(OpenClawDetectResult {
        installed: path.is_some(),
        binary_path: path,
        version,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn openclaw_status() -> Result<OpenClawStatusResult, String> {
    let path = locate_openclaw().await;
    let version = match path.as_deref() {
        Some(p) => run_version(p).await,
        None => None,
    };

    let mut diagnostics: Vec<OpenClawDiagnostic> = Vec::new();
    let mut gateway_running = false;
    let mut health_ok = false;
    let mut health_summary: Option<String> = None;
    let mut gateway_endpoint: Option<String> = None;

    if let Some(p) = &path {
        for (label, args) in DIAG_COMMANDS {
            let diag = run_diagnostic(p, label, args).await;
            if diag.ok {
                match *label {
                    "gateway" => {
                        gateway_running = parse_gateway_running(&diag.stdout_redacted);
                        if gateway_running && gateway_endpoint.is_none() {
                            gateway_endpoint = parse_gateway_endpoint(&diag.stdout_redacted);
                        }
                    }
                    "health" => {
                        health_ok = true;
                        health_summary = summarize_health(&diag.stdout_redacted);
                    }
                    _ => {}
                }
            }
            diagnostics.push(diag);
        }
    }

    let capabilities = detect_capabilities(gateway_running, health_ok);
    let recommended_action = recommend_action(path.is_some(), gateway_running, health_ok);

    Ok(OpenClawStatusResult {
        installed: path.is_some(),
        binary_path: path,
        version,
        gateway_running,
        health_ok,
        health_summary,
        diagnostics,
        recommended_action,
        capabilities,
        gateway_endpoint,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn openclaw_open_docs() -> Result<(), String> {
    open_in_browser(DOCS_URL).map_err(|e| e.to_string())
}

// ── Probes ───────────────────────────────────────────────────────────────────

/// Locate the `openclaw` binary. Returns the first hit on PATH.
async fn locate_openclaw() -> Option<String> {
    // Use the platform's own lookup command so we don't take on a `which`
    // dependency. `where` on Windows, `which` on Unix.
    let (program, args): (&str, &[&str]) = if cfg!(windows) {
        ("where", &["openclaw"])
    } else {
        ("which", &["openclaw"])
    };
    match run_capture(program, args).await {
        Ok((stdout, _, Some(0))) => stdout
            .lines()
            .next()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        _ => None,
    }
}

async fn run_version(path: &str) -> Option<String> {
    match run_capture(path, &["--version"]).await {
        Ok((stdout, _, Some(0))) => {
            let trimmed = stdout.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

async fn run_diagnostic(path: &str, _label: &str, args: &[&str]) -> OpenClawDiagnostic {
    let cmd_str = format!("openclaw {}", args.join(" "));
    match run_capture(path, args).await {
        Ok((stdout, stderr, code)) => {
            let ok = code == Some(0);
            OpenClawDiagnostic {
                command: cmd_str,
                ok,
                exit_code: code,
                stdout_redacted: redact_secrets(&stdout),
                stderr_redacted: redact_secrets(&stderr),
                error: None,
            }
        }
        Err(e) => OpenClawDiagnostic {
            command: cmd_str,
            ok: false,
            exit_code: None,
            stdout_redacted: String::new(),
            stderr_redacted: String::new(),
            error: Some(format!("probe failed: {}", e)),
        },
    }
}

/// Spawn a child, wait up to `PROBE_TIMEOUT`, kill on timeout, return
/// `(stdout, stderr, exit_code)`. Any spawn error is propagated.
async fn run_capture(
    program: &str,
    args: &[&str],
) -> std::io::Result<(String, String, Option<i32>)> {
    // We must own stdout/stderr before passing the child to wait_with_output,
    // which consumes `self`. We capture them into a Vec and let the child
    // drop close the pipes naturally.
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;

    // Take ownership of the stdio handles up front. If the wait times out,
    // the child is dropped (kill_on_drop) and the handles close, which
    // unblocks any read task.
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let read_stdout = async {
        let mut buf = Vec::new();
        if let Some(s) = stdout.as_mut() {
            let _ = tokio::io::copy(s, &mut buf).await;
        }
        buf
    };
    let read_stderr = async {
        let mut buf = Vec::new();
        if let Some(s) = stderr.as_mut() {
            let _ = tokio::io::copy(s, &mut buf).await;
        }
        buf
    };

    let wait_and_collect = async {
        let (status, out, err) = tokio::join!(child.wait(), read_stdout, read_stderr);
        let status = status?;
        Ok::<_, std::io::Error>((out, err, status.code()))
    };

    match tokio::time::timeout(PROBE_TIMEOUT, wait_and_collect).await {
        Ok(Ok((out, err, code))) => Ok((
            String::from_utf8_lossy(&out).into_owned(),
            String::from_utf8_lossy(&err).into_owned(),
            code,
        )),
        Ok(Err(e)) => Err(e),
        Err(_elapsed) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("probe exceeded {:?}", PROBE_TIMEOUT),
        )),
    }
}

// ── Output interpretation (tolerant, best-effort) ────────────────────────────

/// Look for positive indicators in a `gateway status` payload. We do not
/// assume a specific schema — any of these markers counts as "running".
fn parse_gateway_running(stdout: &str) -> bool {
    let low = stdout.to_lowercase();
    low.lines().any(|line| {
        (line.contains("state") || line.contains("status"))
            && (line.contains("running") || line.contains("active") || line.contains("up"))
    }) || low.contains("gateway running") || low.contains("gateway: running")
}

/// First non-empty line of a health payload, truncated. Returns `None` if the
/// payload is empty after trimming — the UI then shows a generic "OK".
fn summarize_health(stdout: &str) -> Option<String> {
    let first = stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())?;
    let truncated: String = first.chars().take(160).collect();
    Some(truncated)
}

fn recommend_action(installed: bool, gateway_running: bool, health_ok: bool) -> String {
    match (installed, gateway_running, health_ok) {
        (false, _, _) => "Install OpenClaw to enable agent capabilities.".to_string(),
        (true, false, _) => "OpenClaw is installed but the gateway is not running. \
                             Start it from your terminal, then refresh."
            .to_string(),
        (true, true, false) => "OpenClaw gateway is up but health checks are failing. \
                                Review the diagnostics below."
            .to_string(),
        (true, true, true) => "OpenClaw is installed, the gateway is running, \
                               and health checks pass."
            .to_string(),
    }
}

// ── Secret redaction ─────────────────────────────────────────────────────────
//
// Hand-rolled, no regex dependency. We compose three independent passes:
//
//   1. Key/value patterns — `key=value`, `key: value`, with the key being a
//      known sensitive word (Authorization, token, secret, password, …). The
//      value is replaced with `<redacted>`. Case-insensitive on the key.
//
//   2. Bare API-key prefixes — `sk-…`, `sk_live_…`, `ghp_…`, etc. with a
//      required minimum tail length so common words are not over-redacted.
//
//   3. Long token-char blobs of 32+ chars preceded by `=`, `:`, or
//      whitespace. Catches JWTs, base64 digests, etc.
//
// Each pass is intentionally simple and auditable; any change to the rules
// must add or update a test in the test module below.

/// Sensitive keys that, when seen as `key=value` / `key: value`, cause the
/// value to be replaced.
const SENSITIVE_KV_KEYS: &[&str] = &[
    "authorization",
    "x-api-key",
    "x-auth-token",
    "api-key",
    "token",
    "key",
    "secret",
    "password",
    "passwd",
    "apikey",
];

/// Bare API-key prefixes — match the prefix then at least this many
/// additional token characters before the next non-token char.
const PREFIX_RULES: &[(&str, usize)] = &[
    ("sk-",        12),
    ("sk_live_",   12),
    ("sk_test_",   12),
    ("ghp_",       12),
    ("gho_",       12),
    ("xoxb-",      12),
    ("xoxp-",      12),
    ("OC-",        12),
    ("oc_",        12),
];

/// Minimum length of a token-char blob to be considered for redaction.
const BLOB_MIN_LEN: usize = 32;

pub fn redact_secrets(input: &str) -> String {
    let mut out = input.to_string();
    out = redact_kv(&out);
    out = redact_prefixes(&out);
    out = redact_blobs(&out);
    out
}

/// Replace `key=value` / `key: value` (case-insensitive on the key) with
/// `key=<redacted>`. The value runs until whitespace, comma, closing brace,
/// or a matching quote. Also handles JSON-style quoted keys: `"key": value`.
fn redact_kv(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let lower = input.to_lowercase();
    let bytes = input.as_bytes();
    let lower_bytes = lower.as_bytes();
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        // Optional opening quote for JSON-style keys.
        let mut after_open_quote = false;
        if bytes[i] == b'"' || bytes[i] == b'\'' {
            // Look ahead for `key<close>:|=` to confirm this is a quoted key.
            if let Some(key_match_end) = try_quoted_key(lower_bytes, bytes, i) {
                // i is the opening quote, key_match_end is the position of the
                // closing quote + 1.
                out.push(bytes[i] as char); // emit opening quote
                i += 1;
                // Emit the (case-preserved) key text.
                let key_end = key_match_end - 1; // position of closing quote
                out.push_str(&input[i..key_end]);
                // Emit the closing quote.
                out.push(input.as_bytes()[key_end] as char);
                i = key_match_end;
                after_open_quote = true;
            }
        }

        if !after_open_quote {
            if let Some((key_end, _key_lc)) = match_any_key(lower_bytes, i, SENSITIVE_KV_KEYS) {
                // Boundary check: key must not be in the middle of an identifier.
                let preceded_ok =
                    i == 0 || !is_ident_cont(bytes[i - 1]);
                let followed_ok = key_end < n && !is_ident_cont(bytes[key_end]);
                if preceded_ok && followed_ok {
                    out.push_str(&input[i..key_end]);
                    i = key_end;
                } else {
                    out.push(bytes[i] as char);
                    i += 1;
                    continue;
                }
            } else {
                out.push(bytes[i] as char);
                i += 1;
                continue;
            }
        }

        // Skip whitespace between key and separator.
        while i < n && (bytes[i] as char).is_whitespace() {
            out.push(bytes[i] as char);
            i += 1;
        }
        // Expect `:` or `=`.
        if i < n && (bytes[i] == b':' || bytes[i] == b'=') {
            out.push(bytes[i] as char);
            i += 1;
            // Skip whitespace.
            while i < n && (bytes[i] as char).is_whitespace() {
                out.push(bytes[i] as char);
                i += 1;
            }
            // Optional opening quote on the value.
            let mut value_quoted = false;
            if i < n && (bytes[i] == b'"' || bytes[i] == b'\'') {
                out.push(bytes[i] as char);
                i += 1;
                value_quoted = true;
            }
            // Skip the value (any char that is not a terminator).
            let value_start = i;
            while i < n {
                let c = bytes[i] as char;
                let stop = c.is_whitespace()
                    || c == ','
                    || c == '}'
                    || c == '"'
                    || c == '\'';
                if stop {
                    break;
                }
                i += 1;
            }
            if i > value_start {
                out.push_str("<redacted>");
            } else {
                out.push_str(&input[value_start..i]);
            }
            // Optional closing quote.
            if value_quoted && i < n && (bytes[i] == b'"' || bytes[i] == b'\'') {
                out.push(bytes[i] as char);
                i += 1;
            }
            continue;
        }
        // No separator after the key — fall through to normal iteration.
        // Guard required: the whitespace loop above can advance i to n.
        if i < n {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

/// If the input at `start` is `<quote>key<quote>` followed by `:` or `=`
/// (allowing whitespace), return the position just past the closing quote.
fn try_quoted_key(lower: &[u8], bytes: &[u8], start: usize) -> Option<usize> {
    let n = bytes.len();
    if start + 2 >= n {
        return None;
    }
    let q = bytes[start];
    if q != b'"' && q != b'\'' {
        return None;
    }
    // Find the matching close quote.
    let body_start = start + 1;
    let close_rel = bytes[body_start..]
        .iter()
        .position(|&b| b == q)?;
    let body_end = body_start + close_rel;
    // Body must be all lowercase letters / digits / `-` / `_` and match one
    // of our sensitive keys (case-insensitive).
    let body = &lower[body_start..body_end];
    let body_str = match std::str::from_utf8(body) {
        Ok(s) => s,
        Err(_) => return None,
    };
    if !SENSITIVE_KV_KEYS.contains(&body_str) {
        return None;
    }
    // After the closing quote we expect optional whitespace then `:` or `=`.
    let mut k = body_end + 1;
    while k < n && (bytes[k] as char).is_whitespace() {
        k += 1;
    }
    if k < n && (bytes[k] == b':' || bytes[k] == b'=') {
        Some(body_end + 1)
    } else {
        None
    }
}

fn match_any_key(lower: &[u8], start: usize, keys: &[&str]) -> Option<(usize, String)> {
    for k in keys {
        let kb = k.as_bytes();
        if start + kb.len() > lower.len() {
            continue;
        }
        if &lower[start..start + kb.len()] == kb {
            return Some((start + kb.len(), k.to_string()));
        }
    }
    None
}

fn is_ident_cont(b: u8) -> bool {
    (b as char).is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// Replace `prefix<token-chars>…` with `<redacted>` for any matching rule,
/// provided the tail is at least the rule's minimum length.
fn redact_prefixes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        if let Some(rule) = find_prefix_rule(bytes, i) {
            let (prefix_len, min_tail) = rule;
            let token_end = scan_token_end(bytes, i + prefix_len);
            let tail_len = token_end - (i + prefix_len);
            if tail_len >= min_tail {
                out.push_str("<redacted>");
                i = token_end;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn find_prefix_rule(bytes: &[u8], start: usize) -> Option<(usize, usize)> {
    for (prefix, min_tail) in PREFIX_RULES {
        let pb = prefix.as_bytes();
        if start + pb.len() > bytes.len() {
            continue;
        }
        if &bytes[start..start + pb.len()] != pb {
            continue;
        }
        // Word boundary before.
        if start > 0 && is_ident_cont(bytes[start - 1]) {
            continue;
        }
        return Some((pb.len(), *min_tail));
    }
    None
}

fn scan_token_end(bytes: &[u8], start: usize) -> usize {
    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            i += 1;
        } else {
            break;
        }
    }
    i
}

/// Replace 32+ char runs of token-like characters that follow `=`, `:`, or
/// whitespace. Insert `<redacted>` after the trigger.
fn redact_blobs(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        let c = bytes[i] as char;
        if c == '=' || c == ':' || c.is_whitespace() {
            out.push(c);
            i += 1;
            let end = scan_blob_end(bytes, i);
            if end - i >= BLOB_MIN_LEN {
                out.push_str("<redacted>");
                i = end;
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

fn scan_blob_end(bytes: &[u8], start: usize) -> usize {
    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=' || c == '_' || c == '-' {
            i += 1;
        } else {
            break;
        }
    }
    i
}

// ── Connection layer helpers ──────────────────────────────────────────────────

/// Derive capability labels from observed status booleans.
/// Labels are intentionally conservative — they only reflect what Feral has
/// been able to confirm via read-only probes, not what OpenClaw claims.
pub fn detect_capabilities(gateway_running: bool, health_ok: bool) -> Vec<String> {
    let mut caps = Vec::new();
    if gateway_running {
        caps.push("gateway".to_string());
    }
    if health_ok {
        caps.push("health_check".to_string());
    }
    caps
}

/// Extract a gateway listen address from `gateway status` stdout.
/// Accepts only loopback addresses (localhost, 127.x, 0.0.0.0, ::1) so that
/// external URLs from diagnostics are never accidentally surfaced.
pub fn parse_gateway_endpoint(output: &str) -> Option<String> {
    for prefix in &["https://", "http://"] {
        if let Some(pos) = output.find(prefix) {
            let rest = &output[pos..];
            let end = rest
                .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ','))
                .unwrap_or(rest.len());
            let url = &rest[..end];
            let host = &rest[prefix.len()..end];
            let is_local = host.starts_with("localhost")
                || host.starts_with("127.")
                || host.starts_with("0.0.0.0")
                || host.starts_with("[::1]");
            if is_local {
                return Some(url.to_string());
            }
        }
    }
    None
}

// ── Test-message layer ───────────────────────────────────────────────────────
//
// Sends ONE explicit user-triggered message to an already-detected, already-
// healthy OpenClaw gateway. Only loopback endpoints are accepted. The two
// well-known API paths tried in order are:
//
//   POST /v1/chat/completions   (OpenAI-compatible — most common)
//   POST /api/chat              (Ollama-compatible)
//
// If neither returns 2xx, the result kind is `Unsupported` with a clear note
// about what API paths were tried. No OpenClaw config is written.

/// Paths tried in order when sending a test message.
const CHAT_API_PATHS: &[&str] = &["/v1/chat/completions", "/api/chat"];

/// Timeout for the HTTP test-message request. Longer than probe timeout to
/// allow a first-token delay from a cold model.
const TEST_MESSAGE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TestMessageKind {
    /// Message sent and a text response was received.
    Ok,
    /// No response within `TEST_MESSAGE_TIMEOUT`.
    Timeout,
    /// Gateway is running but no compatible API path was found.
    Unsupported,
    /// Gateway or health capability is missing — cannot attempt.
    CapabilityMissing,
    /// An unexpected error occurred (network, parse, etc.).
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OpenClawTestMessageResult {
    pub kind: TestMessageKind,
    /// Response text from OpenClaw (only present when `kind == Ok`).
    pub response_text: Option<String>,
    /// Redacted diagnostic / error message.
    pub error_message: Option<String>,
    /// The URL (scheme + host + path) that was last attempted.
    pub endpoint_tried: Option<String>,
}

// ── Tauri command ─────────────────────────────────────────────────────────────

/// Send a single explicit test message to the OpenClaw gateway.
///
/// The `endpoint` must be the loopback URL already returned by
/// `openclaw_status`. It is re-validated server-side before any HTTP call.
/// The `prompt` is sent as-is; the caller is responsible for choosing a safe
/// default (the UI provides one).
#[tauri::command]
#[specta::specta]
pub async fn openclaw_test_message(
    prompt: String,
    endpoint: Option<String>,
) -> Result<OpenClawTestMessageResult, String> {
    let ep = match endpoint {
        Some(ep) => ep,
        None => return Ok(OpenClawTestMessageResult {
            kind: TestMessageKind::CapabilityMissing,
            response_text: None,
            error_message: Some(
                "No gateway endpoint provided. Run a status refresh first, then retry."
                    .to_string(),
            ),
            endpoint_tried: None,
        }),
    };

    if !is_loopback_url(&ep) {
        return Ok(OpenClawTestMessageResult {
            kind: TestMessageKind::Error,
            response_text: None,
            error_message: Some(
                "Endpoint is not a loopback address. Feral only contacts local gateways."
                    .to_string(),
            ),
            endpoint_tried: Some(ep),
        });
    }

    Ok(send_test_message(&ep, &prompt).await)
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async fn send_test_message(endpoint: &str, prompt: &str) -> OpenClawTestMessageResult {
    let client = match reqwest::Client::builder()
        .timeout(TEST_MESSAGE_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => return OpenClawTestMessageResult {
            kind: TestMessageKind::Error,
            response_text: None,
            error_message: Some(redact_secrets(&format!("Failed to build HTTP client: {e}"))),
            endpoint_tried: Some(endpoint.to_string()),
        },
    };

    let body = serde_json::json!({
        "model": "default",
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": 150,
        "stream": false
    });

    for path in CHAT_API_PATHS {
        let url = format!("{}{}", endpoint.trim_end_matches('/'), path);

        match client.post(&url).json(&body).send().await {
            Ok(resp) if resp.status().is_success() => {
                let raw = resp.text().await.unwrap_or_default();
                let text = parse_chat_response(&raw).or_else(|| {
                    // Surface the raw body (redacted) when parsing fails but HTTP succeeded.
                    let r = redact_secrets(&raw);
                    if r.is_empty() { None } else { Some(r) }
                });
                return OpenClawTestMessageResult {
                    kind: TestMessageKind::Ok,
                    response_text: text,
                    error_message: None,
                    endpoint_tried: Some(url),
                };
            }
            // 404 / 405 → this path doesn't exist, try next
            Ok(resp) if resp.status() == 404 || resp.status() == 405 => continue,
            Ok(resp) => {
                return OpenClawTestMessageResult {
                    kind: TestMessageKind::Error,
                    response_text: None,
                    error_message: Some(format!("HTTP {}", resp.status())),
                    endpoint_tried: Some(url),
                };
            }
            Err(e) if e.is_timeout() => {
                return OpenClawTestMessageResult {
                    kind: TestMessageKind::Timeout,
                    response_text: None,
                    error_message: Some(format!(
                        "No response within {}s.",
                        TEST_MESSAGE_TIMEOUT.as_secs()
                    )),
                    endpoint_tried: Some(url),
                };
            }
            Err(e) => {
                return OpenClawTestMessageResult {
                    kind: TestMessageKind::Error,
                    response_text: None,
                    error_message: Some(redact_secrets(&e.to_string())),
                    endpoint_tried: Some(url),
                };
            }
        }
    }

    // All known paths returned 404/405.
    OpenClawTestMessageResult {
        kind: TestMessageKind::Unsupported,
        response_text: None,
        error_message: Some(format!(
            "Gateway is running at {endpoint} but none of the known API paths responded: {}. \
             To enable this test, the OpenClaw gateway must expose one of those paths.",
            CHAT_API_PATHS.join(", ")
        )),
        endpoint_tried: Some(endpoint.to_string()),
    }
}

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/// Returns `true` when `url` uses http/https and the host is a loopback address.
/// Anything else — external hosts, IPs, non-HTTP schemes — returns `false`.
pub fn is_loopback_url(url: &str) -> bool {
    let rest = if let Some(r) = url.strip_prefix("https://") {
        r
    } else if let Some(r) = url.strip_prefix("http://") {
        r
    } else {
        return false;
    };
    // IPv6 bracketed address — must start with [::1]
    if rest.starts_with('[') {
        return rest.starts_with("[::1]");
    }
    // The host ends at the first ':' (port separator) or '/' (path start).
    let host = rest.split(&[':', '/'][..]).next().unwrap_or("");
    host == "localhost"
        || host == "0.0.0.0"
        || (host.starts_with("127.") && host.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

/// Extract the first human-readable text from a chat API JSON body.
/// Tries OpenAI-compatible, then Ollama-compatible, then generic top-level keys.
pub fn parse_chat_response(body: &str) -> Option<String> {
    if body.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(body).ok()?;

    // OpenAI: choices[0].message.content
    if let Some(c) = v["choices"][0]["message"]["content"].as_str() {
        let t = c.trim();
        if !t.is_empty() { return Some(t.to_string()); }
    }
    // Ollama: message.content
    if let Some(c) = v["message"]["content"].as_str() {
        let t = c.trim();
        if !t.is_empty() { return Some(t.to_string()); }
    }
    // Generic top-level string keys
    for key in &["response", "text", "content", "answer"] {
        if let Some(c) = v[key].as_str() {
            let t = c.trim();
            if !t.is_empty() { return Some(t.to_string()); }
        }
    }
    None
}

// ── URL opener (platform-specific) ───────────────────────────────────────────

/// Open `url` in the OS default browser. We deliberately do NOT shell out
/// via `xdg-open` / `open` / `cmd /c start` here as an unguarded vector —
/// the input is hard-coded to a single docs URL above, never user-supplied.
fn open_in_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        // `cmd /c start "" <url>` — the empty `""` is a placeholder for the
        // window title that `start` insists on.
        Command::new("cmd")
            .args(&["/C", "start", "", url])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .map(|_| ())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .map(|_| ())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .map(|_| ())
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── redaction: key/value ─────────────────────────────────────────────────

    #[test]
    fn redacts_bearer_authorization_header() {
        let s = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456";
        let r = redact_secrets(s);
        assert!(r.contains("<redacted>"), "got: {}", r);
        assert!(!r.contains("abcdefghijklmnopqrstuvwxyz123456"), "leak: {}", r);
    }

    #[test]
    fn redacts_x_api_key_header() {
        let s = "x-api-key: super-secret-key-value-here-1234";
        let r = redact_secrets(s);
        assert!(r.contains("<redacted>"), "got: {}", r);
        assert!(!r.contains("super-secret-key-value-here-1234"), "got: {}", r);
    }

    #[test]
    fn redacts_token_equals_pair() {
        let s = "token=mySuperSecretTokenValue1234567890 extra";
        let r = redact_secrets(s);
        assert!(r.contains("token=<redacted>"), "got: {}", r);
    }

    #[test]
    fn redacts_quoted_secret_value() {
        let s = r#"config = { "secret": "p@ssw0rd!hidden" }"#;
        let r = redact_secrets(s);
        assert!(!r.contains("p@ssw0rd!hidden"), "leak: {}", r);
        assert!(r.contains("<redacted>"), "got: {}", r);
    }

    #[test]
    fn kv_redaction_skips_inside_identifier() {
        // The substring "token" inside a longer identifier (e.g. "mytoken=")
        // must NOT be treated as a key — boundary check.
        let s = "mytoken=public-value-here";
        let r = redact_secrets(s);
        assert_eq!(r, s, "should not redact when 'token' is mid-identifier");
    }

    // ── redaction: bare prefixes ─────────────────────────────────────────────

    #[test]
    fn redacts_sk_prefix_token() {
        let s = "OPENAI_KEY=sk-projabc123def456ghi789jkl012mno345pqrstu";
        let r = redact_secrets(s);
        assert!(r.contains("<redacted>"), "got: {}", r);
        assert!(!r.contains("sk-projabc123def456ghi789jkl012mno345pqrstu"), "leak: {}", r);
    }

    #[test]
    fn redacts_github_pat() {
        let s = "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        let r = redact_secrets(s);
        assert!(r.contains("<redacted>"), "got: {}", r);
        assert!(!r.contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "leak: {}", r);
    }

    #[test]
    fn does_not_redact_short_prefix() {
        // A short `sk-` followed by fewer than 12 token chars is not
        // treated as a key — avoids false positives on `sk-` style slugs.
        let s = "branch=sk-123";
        let r = redact_secrets(s);
        assert!(!r.contains("<redacted>"), "false positive: {}", r);
    }

    // ── redaction: long blobs ────────────────────────────────────────────────

    #[test]
    fn redacts_long_hex_blob_after_equals() {
        let s = "sha=0123456789abcdef0123456789abcdef0123456789abcdef";
        let r = redact_secrets(s);
        assert!(r.contains("sha=<redacted>"), "got: {}", r);
    }

    #[test]
    fn does_not_redact_short_run() {
        // 32+ char trigger must be a real threshold.
        let s = "v=abcdef0123456789abcdef012345678";
        let r = redact_secrets(s);
        assert!(!r.contains("<redacted>"), "false positive: {}", r);
    }

    // ── redaction: prose ─────────────────────────────────────────────────────

    #[test]
    fn kv_does_not_panic_when_sensitive_key_at_end_without_separator() {
        // A sensitive keyword followed only by whitespace/EOL (no ':' or '=')
        // must not panic. The redact_kv fall-through reads bytes[i] after the
        // whitespace loop can advance i to n.
        assert_eq!(redact_secrets("token\n"), "token\n");
        assert_eq!(redact_secrets("Auth token\n"), "Auth token\n");
        assert_eq!(redact_secrets("token"), "token");
    }

    #[test]
    fn does_not_redact_unrelated_text() {
        let s = "OpenClaw gateway status: running, 3 agents attached.";
        let r = redact_secrets(s);
        assert_eq!(r, s, "should leave ordinary prose alone");
    }

    // ── parsers ──────────────────────────────────────────────────────────────

    #[test]
    fn gateway_running_parses_positive_markers() {
        assert!(parse_gateway_running("state: running\n"));
        assert!(parse_gateway_running("Status: active\n"));
        assert!(parse_gateway_running("gateway running\n"));
        assert!(parse_gateway_running("gateway: running\n"));
        assert!(!parse_gateway_running("state: stopped\n"));
        assert!(!parse_gateway_running(""));
    }

    #[test]
    fn summarize_health_takes_first_nonempty_line() {
        let s = "\n\n  ok 3 agents  \n  detail line  \n";
        assert_eq!(summarize_health(s).as_deref(), Some("ok 3 agents"));
    }

    #[test]
    fn summarize_health_truncates_long_lines() {
        let long: String = "x".repeat(500);
        let s = summarize_health(&long).unwrap();
        assert_eq!(s.chars().count(), 160);
    }

    #[test]
    fn summarize_health_returns_none_for_blank() {
        assert!(summarize_health("").is_none());
        assert!(summarize_health("   \n\n  ").is_none());
    }

    // ── connection layer: capabilities ───────────────────────────────────────

    #[test]
    fn capabilities_empty_when_nothing_running() {
        assert!(detect_capabilities(false, false).is_empty());
    }

    #[test]
    fn capabilities_includes_gateway_when_running() {
        let caps = detect_capabilities(true, false);
        assert!(caps.contains(&"gateway".to_string()));
        assert!(!caps.contains(&"health_check".to_string()));
    }

    #[test]
    fn capabilities_includes_health_check_when_ok() {
        let caps = detect_capabilities(false, true);
        assert!(caps.contains(&"health_check".to_string()));
    }

    #[test]
    fn capabilities_includes_both_when_all_green() {
        let caps = detect_capabilities(true, true);
        assert!(caps.contains(&"gateway".to_string()));
        assert!(caps.contains(&"health_check".to_string()));
    }

    // ── connection layer: gateway endpoint ───────────────────────────────────

    #[test]
    fn extracts_localhost_http_endpoint() {
        let output = "gateway running at http://localhost:8888\nstatus: active";
        assert_eq!(
            parse_gateway_endpoint(output).as_deref(),
            Some("http://localhost:8888"),
        );
    }

    #[test]
    fn extracts_loopback_ip_endpoint() {
        let output = "endpoint: https://127.0.0.1:9443/api";
        assert_eq!(
            parse_gateway_endpoint(output).as_deref(),
            Some("https://127.0.0.1:9443/api"),
        );
    }

    #[test]
    fn returns_none_when_no_endpoint_in_output() {
        assert!(parse_gateway_endpoint("state: running\nhealth: ok").is_none());
    }

    #[test]
    fn ignores_external_urls_for_safety() {
        let output = "connected to https://api.example.com:443";
        assert!(parse_gateway_endpoint(output).is_none());
    }

    // ── recommendation ───────────────────────────────────────────────────────

    #[test]
    fn recommend_not_installed() {
        let s = recommend_action(false, false, false);
        assert!(s.contains("Install OpenClaw"), "got: {}", s);
    }

    #[test]
    fn recommend_installed_but_not_running() {
        let s = recommend_action(true, false, false);
        assert!(s.contains("gateway is not running"), "got: {}", s);
    }

    #[test]
    fn recommend_gateway_up_health_failing() {
        let s = recommend_action(true, true, false);
        assert!(s.contains("health checks are failing"), "got: {}", s);
    }

    #[test]
    fn recommend_all_green() {
        let s = recommend_action(true, true, true);
        assert!(s.contains("pass"), "got: {}", s);
    }

    // ── test message: loopback guard ─────────────────────────────────────────

    #[test]
    fn loopback_localhost_is_accepted() {
        assert!(is_loopback_url("http://localhost:8888"));
        assert!(is_loopback_url("https://localhost:9000"));
    }

    #[test]
    fn loopback_127_is_accepted() {
        assert!(is_loopback_url("http://127.0.0.1:9000"));
        assert!(is_loopback_url("https://127.0.0.2:443"));
    }

    #[test]
    fn loopback_zero_zero_is_accepted() {
        assert!(is_loopback_url("http://0.0.0.0:8080"));
    }

    #[test]
    fn loopback_ipv6_is_accepted() {
        assert!(is_loopback_url("http://[::1]:8888"));
    }

    #[test]
    fn external_hostname_is_rejected() {
        assert!(!is_loopback_url("http://api.example.com:443"));
        assert!(!is_loopback_url("https://openclaw.example.com/api"));
    }

    #[test]
    fn external_ip_is_rejected() {
        assert!(!is_loopback_url("http://192.168.1.1:8888"));
        assert!(!is_loopback_url("http://10.0.0.5:8080"));
    }

    #[test]
    fn non_http_scheme_is_rejected() {
        assert!(!is_loopback_url("ws://localhost:8888"));
        assert!(!is_loopback_url("ftp://localhost/path"));
        assert!(!is_loopback_url("localhost:8888"));
    }

    // ── test message: response parsing ───────────────────────────────────────

    #[test]
    fn parses_openai_chat_completions_response() {
        let body = r#"{"choices":[{"message":{"content":"Hello from OpenClaw!"},"index":0}]}"#;
        assert_eq!(
            parse_chat_response(body).as_deref(),
            Some("Hello from OpenClaw!"),
        );
    }

    #[test]
    fn parses_ollama_style_message_content() {
        let body = r#"{"message":{"content":"Ollama says hi"},"done":true}"#;
        assert_eq!(
            parse_chat_response(body).as_deref(),
            Some("Ollama says hi"),
        );
    }

    #[test]
    fn parses_generic_response_key() {
        let body = r#"{"response":"Generic response text"}"#;
        assert_eq!(
            parse_chat_response(body).as_deref(),
            Some("Generic response text"),
        );
    }

    #[test]
    fn returns_none_for_empty_body() {
        assert!(parse_chat_response("").is_none());
    }

    #[test]
    fn returns_none_for_unrecognized_json() {
        assert!(parse_chat_response(r#"{"status":"ok","running":true}"#).is_none());
    }

    #[test]
    fn trims_whitespace_from_response() {
        let body = r#"{"choices":[{"message":{"content":"  trimmed  "}}]}"#;
        assert_eq!(
            parse_chat_response(body).as_deref(),
            Some("trimmed"),
        );
    }
}
