//! Sign in with OpenRouter instead of pasting a key (OAuth PKCE), for the
//! desktop button and the browser app alike.
//!
//! A stranger's first five minutes used to be: find a provider, make an
//! account, find the keys page, copy a secret, paste it. This is one button:
//! the browser opens OpenRouter's consent page, OpenRouter sends it back to a
//! one-shot listener on localhost with a code, and the code is exchanged for a
//! key that goes straight to the keychain. The key never passes through a page.
//!
//! Flow per https://openrouter.ai/docs/use-cases/oauth-pkce: localhost
//! callbacks are allowed on any port (127.0.0.1 is not documented, so the
//! callback says `localhost`), codes are single-use and expire in 10 minutes,
//! exchange is `POST /api/v1/auth/keys {code, code_verifier,
//! code_challenge_method}` -> `{key}`.

use std::future::Future;
use std::pin::Pin;

use base64::Engine as _;
use sha2::Digest as _;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

pub type Finish = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;

/// Start a sign-in. Returns the URL to open and a future that resolves when the
/// browser comes back: the key is then saved and the model that will answer is
/// returned. With `return_to`, the browser is sent there once the key is saved
/// (the browser app reloads itself); without it, it is told to close the tab.
pub async fn start(return_to: Option<String>) -> Result<(String, Finish), String> {
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw).map_err(|e| format!("Could not start sign-in: {e}"))?;
    let verifier = b64.encode(raw);
    let challenge = b64.encode(sha2::Sha256::digest(verifier.as_bytes()));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not start sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let callback = format!("http://localhost:{port}/callback");
    let auth_url = format!(
        "https://openrouter.ai/auth?callback_url={}&code_challenge={}&code_challenge_method=S256&key_label=Cinderpaw",
        urlencoding::encode(&callback),
        challenge
    );
    Ok((auth_url, Box::pin(finish(listener, verifier, return_to))))
}

/// Where the browser may be sent after sign-in: a page on this machine, and
/// nothing that could break out of the `Location` header or the HTML link.
pub fn is_local_page(to: &str) -> bool {
    (to.starts_with("http://127.0.0.1:") || to.starts_with("http://localhost:"))
        && !to.contains(|c: char| c.is_control() || matches!(c, '"' | '<' | '>' | ' '))
}

async fn finish(listener: tokio::net::TcpListener, verifier: String, return_to: Option<String>) -> Result<String, String> {
    // One request is all this listener ever serves. Anything that is not the
    // callback (a favicon probe) is answered and skipped. Ten minutes matches
    // the code's own lifetime; after that the person has walked away.
    let (mut sock, code) = tokio::time::timeout(std::time::Duration::from_secs(600), async {
        loop {
            let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
            let code = reqwest::Url::parse(&format!("http://localhost{path}"))
                .ok()
                .filter(|u| u.path() == "/callback")
                .and_then(|u| u.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.to_string()));
            match code {
                Some(c) => return Ok::<_, String>((sock, c)),
                None => reply(&mut sock, "<h2>Waiting for OpenRouter...</h2>").await,
            }
        }
    })
    .await
    .map_err(|_| "Sign-in timed out. Press the button again when you're ready.".to_string())??;

    // The browser waits on this request while the key is fetched and saved,
    // so the page it lands on next already finds it.
    let saved = exchange_and_save(&code, &verifier).await;
    match (&saved, &return_to) {
        (Ok(_), Some(to)) => {
            let head = format!("HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = sock.write_all(head.as_bytes()).await;
        }
        (Ok(_), None) => reply(&mut sock, "<h2>Signed in. You can close this tab and go back to Cinderpaw.</h2>").await,
        (Err(e), _) => {
            let back = return_to.as_deref().map(|to| format!("<p><a href=\"{to}\">Go back to Cinderpaw</a></p>")).unwrap_or_default();
            reply(&mut sock, &format!("<h2>Sign-in did not finish.</h2><p>{e}</p>{back}")).await;
        }
    }
    saved
}

async fn reply(sock: &mut tokio::net::TcpStream, body: &str) {
    let page = format!("<div style=\"font-family:system-ui;max-width:32rem;margin:4rem auto\">{body}</div>");
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        page.len()
    );
    let _ = sock.write_all(head.as_bytes()).await;
    let _ = sock.write_all(page.as_bytes()).await;
}

async fn exchange_and_save(code: &str, verifier: &str) -> Result<String, String> {
    let resp = reqwest::Client::new()
        .post("https://openrouter.ai/api/v1/auth/keys")
        .json(&serde_json::json!({ "code": code, "code_verifier": verifier, "code_challenge_method": "S256" }))
        .send()
        .await
        .map_err(|e| format!("Could not reach OpenRouter: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let key = body
        .get("key")
        .and_then(|k| k.as_str())
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| format!("OpenRouter did not return a key (HTTP {}). Try again.", status.as_u16()))?
        .to_string();

    // No model named: the save keeps one the person already chose, and a blank
    // one gets the catalogue default, the same model a pasted key gets.
    let config = crate::byok::ProviderConfig { enabled: true, api_key: key, base_url: None, default_model: None };
    crate::byok::save_provider("openrouter", config).map_err(|e| e.to_string())?;
    Ok(crate::byok::load(&crate::settings::load())
        .providers
        .get("openrouter")
        .and_then(|c| c.default_model.clone())
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_browser_is_only_sent_back_to_a_page_on_this_machine() {
        assert!(is_local_page("http://127.0.0.1:11435/"));
        assert!(is_local_page("http://localhost:11435/app"));
        assert!(!is_local_page("https://evil.example/"));
        assert!(!is_local_page("http://127.0.0.1.evil.example/"));
        assert!(!is_local_page("http://127.0.0.1:11435/\r\nSet-Cookie: x=1"));
        assert!(!is_local_page("http://127.0.0.1:11435/\"><script>"));
    }
}
