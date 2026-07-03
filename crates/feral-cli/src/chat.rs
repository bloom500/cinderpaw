//! `feral chat` — the terminal face of the one brain (Faza 4.5, spec D6).
//!
//! A streaming chat REPL over the Public Runtime API: it POSTs each turn to
//! `/runtime/chat` and renders the SSE token stream live, in the Feral brand
//! palette (near-black + soft orange). Same session, same memory, same LoRA as
//! the desktop app and the connectors — this is just another window onto the
//! runtime, not a second brain.
//!
//! v1 is a linear styled REPL (robust, and how CLI agents actually read); a
//! full-screen paneled TUI with a live `/events` sidebar is a clean follow-up.

use std::io::Write;

use futures_util::StreamExt;

use crate::common::{self, Palette};

/// Entry point for `feral-cli chat`. Never returns — exits the process.
pub fn run() -> ! {
    // Auto-start the runtime if it isn't up. `feral chat` is the primary
    // entrypoint and must not require a manual `feral gateway start` first
    // (Docker Desktop / Ollama behavior). Advanced users still have
    // `feral gateway start` for services / connectors / debugging.
    //
    // Done here (sync, before the tokio runtime) so gateway_start's blocking
    // wait-for-bind doesn't stall the async reactor.
    let port = common::api_port();
    if !common::port_in_use(port) {
        let Palette { meta: META, reset: RESET, .. } = common::palette();
        println!("\n  {META}Runtime not running. Starting...{RESET}");
        let code = crate::admin::gateway_start();
        if code != 0 {
            eprintln!("feral: could not start the runtime — run `feral doctor` to diagnose.");
            std::process::exit(code);
        }
    }
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let code = rt.block_on(async_main());
    std::process::exit(code);
}

async fn async_main() -> i32 {
    let Palette { accent: ACCENT, bold: BOLD, meta: META, reset: RESET, .. } = common::palette();
    let base = common::base_url();
    let token = match common::read_token() {
        Some(t) => t,
        None => {
            eprintln!("feral: no API token found at ~/.feral/api-token — is the gateway running?");
            return 1;
        }
    };
    let client = reqwest::Client::new();

    banner();

    // Fetch status for the header; a failure here means no gateway is up.
    match fetch_status(&client, &base, &token).await {
        Ok(status) => print_status(&status),
        Err(_) => {
            // We tried to auto-start in run(); if we still can't reach it,
            // something else is wrong (port held by a non-Feral process, boot
            // failure). Point at doctor rather than a manual start.
            println!(
                "  {META}could not reach the runtime{RESET} — run {ACCENT}feral doctor{RESET}\n"
            );
            return 1;
        }
    }

    let session_id = "chat".to_string();
    loop {
        // Prompt and read a line. stdin is blocking, so read off the async
        // runtime to avoid stalling the reactor.
        print!("\n{ACCENT}{BOLD}›{RESET} ");
        let _ = std::io::stdout().flush();
        let line = match tokio::task::spawn_blocking(read_line).await {
            Ok(Some(l)) => l,
            _ => break, // EOF (Ctrl+D / closed pipe)
        };
        let msg = line.trim();
        if msg.is_empty() {
            continue;
        }
        if matches!(msg, "/exit" | "/quit" | ":q") {
            break;
        }

        // Assistant marker, then stream the reply beneath it.
        print!("\n{ACCENT}◆ feral{RESET}  ");
        let _ = std::io::stdout().flush();
        if let Err(e) = stream_reply(&client, &base, &token, &session_id, msg).await {
            print!("{META}[{e}]{RESET}");
        }
        println!();
    }

    println!("\n{META}stay feral. ↝{RESET}");
    0
}

fn read_line() -> Option<String> {
    let mut s = String::new();
    match std::io::stdin().read_line(&mut s) {
        Ok(0) => None, // EOF
        Ok(_) => Some(s),
        Err(_) => None,
    }
}

fn banner() {
    // A restrained wordmark — the brand is the color, not ASCII fireworks.
    let Palette { accent: ACCENT, bold: BOLD, text: TEXT, meta: META, reset: RESET, .. } =
        common::palette();
    println!();
    println!("  {ACCENT}{BOLD}feral{RESET} {ACCENT}▸{RESET} {TEXT}chat{RESET}");
    println!("  {META}the terminal face of your local brain{RESET}");
}

fn print_status(s: &StatusLine) {
    let Palette { text: TEXT, meta: META, dim: DIM, ok: OK, reset: RESET, .. } = common::palette();
    let lora = s.lora.as_deref().unwrap_or("none");
    let dot = if s.sidecar_alive { OK } else { META };
    let state = if s.sidecar_alive { "online" } else { "no sidecar" };
    println!(
        "  {META}model{RESET} {TEXT}{}{RESET}   {META}lora{RESET} {TEXT}{}{RESET}   \
         {META}backend{RESET} {TEXT}{}{RESET}   {dot}●{RESET} {dot}{state}{RESET}",
        s.model.as_deref().unwrap_or("—"),
        lora,
        s.backend,
    );
    println!("  {DIM}{META}type a message · /exit to leave{RESET}");
}

struct StatusLine {
    model: Option<String>,
    lora: Option<String>,
    backend: String,
    sidecar_alive: bool,
}

async fn fetch_status(
    client: &reqwest::Client,
    base: &str,
    token: &str,
) -> Result<StatusLine, String> {
    let v: serde_json::Value = client
        .get(format!("{base}/runtime/status"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(StatusLine {
        // Prefer the sidecar's real model (`agent_model` — set for both local
        // and cloud); fall back to the local engine's loaded model name.
        model: v
            .get("agent_model")
            .and_then(|m| m.as_str())
            .map(String::from)
            .or_else(|| {
                v.get("model")
                    .and_then(|m| m.get("name"))
                    .and_then(|n| n.as_str())
                    .map(String::from)
            }),
        lora: v.get("lora").and_then(|l| l.as_str()).map(String::from),
        backend: v.get("backend").and_then(|b| b.as_str()).unwrap_or("—").to_string(),
        sidecar_alive: v.get("sidecar_alive").and_then(|b| b.as_bool()).unwrap_or(false),
    })
}

/// POST /runtime/chat and print the streamed reply live. Reasoning inside
/// `<think>…</think>` (some models emit it) is dimmed rather than hidden —
/// Feral shows its work — while the answer prints in full text color.
async fn stream_reply(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    session_id: &str,
    content: &str,
) -> Result<(), String> {
    let resp = client
        .post(format!("{base}/runtime/chat"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "content": content, "session_id": session_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let Palette { meta: META, reset: RESET, .. } = common::palette();
    let mut stream = resp.bytes_stream();
    let mut sse = SseBuffer::default();
    let mut think = ThinkRenderer::new(common::palette());
    let out = std::io::stdout();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        for data in sse.push(&bytes) {
            if data == "[DONE]" {
                think.flush(&mut out.lock());
                return Ok(());
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
                if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                    print!("{META}[{err}]{RESET}");
                    let _ = out.lock().flush();
                    return Ok(());
                }
                if let Some(tok) = v
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("content"))
                    .and_then(|t| t.as_str())
                {
                    think.render(tok, &mut out.lock());
                }
            }
        }
    }
    think.flush(&mut out.lock());
    Ok(())
}

/// Accumulates raw response bytes and yields the payload of each complete SSE
/// `data:` line. SSE frames are separated by newlines; a frame can be split
/// across network chunks, so we buffer until we see a line terminator.
#[derive(Default)]
struct SseBuffer {
    buf: String,
}

impl SseBuffer {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.push_str(&String::from_utf8_lossy(bytes));
        let mut out = Vec::new();
        while let Some(nl) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=nl).collect();
            let line = line.trim_end();
            if let Some(data) = line.strip_prefix("data:") {
                out.push(data.trim().to_string());
            }
        }
        out
    }
}

/// Streaming-safe renderer that dims `<think>…</think>` spans. Because the tags
/// can straddle token boundaries, it holds back the last few chars (a possible
/// partial tag) until it can decide, then flushes them at end of stream.
struct ThinkRenderer {
    in_think: bool,
    pending: String,
    started_color: bool,
    palette: Palette,
}

impl Default for ThinkRenderer {
    fn default() -> Self {
        Self::new(common::palette())
    }
}

impl ThinkRenderer {
    const OPEN: &'static str = "<think>";
    const CLOSE: &'static str = "</think>";

    fn new(palette: Palette) -> Self {
        Self { in_think: false, pending: String::new(), started_color: false, palette }
    }

    fn render<W: Write>(&mut self, tok: &str, w: &mut W) {
        self.pending.push_str(tok);
        // Emit everything except a trailing run that might be the start of a
        // tag. Longest tag is CLOSE (8 chars), so reserve up to 7.
        loop {
            let marker = if self.in_think { Self::CLOSE } else { Self::OPEN };
            if let Some(pos) = self.pending.find(marker) {
                let before: String = self.pending.drain(..pos).collect();
                self.emit(&before, w);
                self.pending.drain(..marker.len()); // consume the tag itself
                self.in_think = !self.in_think;
                continue;
            }
            // No full marker. Emit all but the last `reserve` chars in case a
            // partial tag is forming there.
            let reserve = max_partial_suffix(&self.pending, marker);
            if self.pending.len() > reserve {
                let take = self.pending.len() - reserve;
                let ready: String = self.pending.drain(..take).collect();
                self.emit(&ready, w);
            }
            break;
        }
        let _ = w.flush();
    }

    fn emit<W: Write>(&mut self, s: &str, w: &mut W) {
        if s.is_empty() {
            return;
        }
        let color = if self.in_think { self.palette.meta } else { self.palette.text };
        if !self.started_color {
            let _ = write!(w, "{color}");
            self.started_color = true;
        }
        // Re-assert the color each emit — cheap and robust across state flips.
        let _ = write!(w, "{color}{s}");
    }

    fn flush<W: Write>(&mut self, w: &mut W) {
        let leftover = std::mem::take(&mut self.pending);
        self.emit(&leftover, w);
        let _ = write!(w, "{}", self.palette.reset);
        let _ = w.flush();
    }
}

/// Length of the longest suffix of `s` that is a prefix of `marker` — i.e. how
/// many trailing chars we must hold back because they might grow into `marker`.
fn max_partial_suffix(s: &str, marker: &str) -> usize {
    let max = marker.len().saturating_sub(1).min(s.len());
    for len in (1..=max).rev() {
        if marker.as_bytes().starts_with(&s.as_bytes()[s.len() - len..]) {
            return len;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render_all(tokens: &[&str]) -> String {
        // Render with color codes stripped, to assert on visible text only.
        let mut tr = ThinkRenderer::default();
        let mut buf: Vec<u8> = Vec::new();
        for t in tokens {
            tr.render(t, &mut buf);
        }
        tr.flush(&mut buf);
        let raw = String::from_utf8(buf).unwrap();
        strip_ansi(&raw)
    }

    fn strip_ansi(s: &str) -> String {
        let mut out = String::new();
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\x1b' {
                // skip until 'm'
                for c2 in chars.by_ref() {
                    if c2 == 'm' {
                        break;
                    }
                }
            } else {
                out.push(c);
            }
        }
        out
    }

    #[test]
    fn plain_text_passes_through() {
        assert_eq!(render_all(&["hello ", "world"]), "hello world");
    }

    #[test]
    fn think_tags_are_kept_but_content_survives_and_answer_after() {
        // The visible text keeps both the (dimmed) reasoning and the answer;
        // the tags themselves are consumed.
        let out = render_all(&["<think>", "reason", "</think>", "answer"]);
        assert_eq!(out, "reasonanswer");
    }

    #[test]
    fn tag_split_across_tokens_is_still_detected() {
        // "<th" + "ink>" must be recognized as one open tag, not printed.
        let out = render_all(&["<th", "ink>", "hi", "</thi", "nk>", "done"]);
        assert_eq!(out, "hidone");
    }
}
