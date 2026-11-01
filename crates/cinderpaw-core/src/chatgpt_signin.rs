//! Sign in with ChatGPT: a Plus or Pro subscriber pays for Cinderpaw's model
//! calls out of their ChatGPT plan, with no API key and no separate bill.
//!
//! Why it exists: an API key is the step a stranger is least likely to get
//! through. Plenty of people pay for ChatGPT; few have ever opened the API
//! platform, and the onboarding had to tell them their subscription "does not
//! cover API keys". OpenAI opened plan usage to open-source apps that run on
//! the user's own machine (July 2026, widened 29 Sep 2026).
//!
//! The protocol, from OpenAI's documentation for those apps
//! (developers.openai.com/siwc/token-sharing-open-source/sign-in, read 1 Nov
//! 2026): OAuth 2.0 authorization code with PKCE (S256) and an OIDC nonce
//! against auth.openai.com; the browser comes back to a listener on 127.0.0.1;
//! on the first sign-in the app registers itself (`dynamic_agent_client` plus
//! a name hint) and keeps the client id it is given; every request names this
//! install with an `ext_agent_host_id`. Access tokens last an hour, refresh
//! tokens 30 days and rotate. Model calls then go to the public Responses API
//! with the access token (`chatgpt_gateway`).
//!
//! Written from the protocol, not from OpenAI's devkit, whose code is licensed
//! for noncommercial use only.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const ISSUER: &str = "https://auth.openai.com";
/// Written down, not discovered: the documented pages, which are not the ones
/// the issuer's general OIDC configuration lists.
const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
/// This install, as OpenAI sees it: opaque, made once, kept. Not a secret.
const HOST_ENTRY: &str = "host-id";
/// The audience every token is asked for, and the API it is spent on.
pub const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPES: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// The scope that lets an app spend the person's plan. Sign-in can succeed
/// without it (the person may untick it), and then nothing can be spent.
pub const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
/// What a first sign-in sends as its client id; OpenAI answers with a real one.
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const APP_NAME: &str = "Cinderpaw";
const SERVICE: &str = "ai.bloom.cinderpaw.chatgpt";
/// The provider id the model picker and `byok.json` know it by. Its row in
/// `byok.json` exists only while signed in (no key is ever stored there).
pub const PROVIDER_ID: &str = "chatgpt";
pub const PROVIDER_NAME: &str = "OpenAI Subscription";

/// Where the engine sends model calls for it: this host's own API, which
/// holds the token (`chatgpt_gateway`). The engine adds `/v1/chat/completions`.
pub fn engine_base_url(api_port: u16) -> String {
    format!("http://127.0.0.1:{api_port}/chatgpt")
}
const ACCOUNT_ENTRY: &str = "account";
/// The registration, kept apart from the account and through sign-out: a new
/// sign-in reuses it rather than registering Cinderpaw a second time.
const CLIENT_ENTRY: &str = "client-id";
const CALLBACK_PATH: &str = "/auth/callback";
/// How long the browser has to come back. A person reading a consent page is
/// not a timeout; a tab closed and forgotten is.
const SIGN_IN_WINDOW: Duration = Duration::from_secs(10 * 60);
/// A token is renewed this long before its hour is up, so a request never
/// leaves with one that expires on the way.
const REFRESH_MARGIN_MS: i64 = 120_000;

/// What is kept between runs, in the OS keychain.
///
/// Small on purpose. Windows Credential Manager holds about 2.5 KB per entry,
/// and an access token alone can come close to that, so it stays in memory for
/// its hour (see `ACCESS`) and the first call after a restart refreshes one.
/// That also keeps a working credential off the disk.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Account {
    pub client_id: String,
    /// The OpenAI account behind it. A refresh that comes back as someone
    /// else is refused.
    pub subject: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub scopes: Vec<String>,
    pub refresh_token: String,
}

impl Account {
    /// Whether this sign-in may spend the person's plan.
    pub fn plan_usage(&self) -> bool {
        self.scopes.iter().any(|s| s == PLAN_SCOPE)
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Access {
    token: String,
    expires_at_ms: i64,
}

static ACCESS: parking_lot::Mutex<Option<Access>> = parking_lot::Mutex::new(None);

/// One refresh at a time. Refresh tokens rotate: two refreshes at once would
/// spend the same one twice, the second is refused as reused, and the person
/// is signed out for nothing.
static REFRESHING: std::sync::LazyLock<tokio::sync::Mutex<()>> = std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

struct Endpoints {
    jwks: String,
    revocation: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 32 random bytes as base64url: two v4 uuids, 244 random bits.
fn random_value() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    b64url(&bytes)
}

fn challenge(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

/// Where OpenAI's signing keys and sign-out live, asked of OpenAI and refused
/// unless they are on the issuer: a configuration that points somewhere else
/// is not one to follow.
async fn discover(http: &reqwest::Client) -> Result<Endpoints, String> {
    let unavailable = || "ChatGPT sign-in is not reachable right now. Check that you are online and try again.".to_string();
    let doc: Value = http
        .get(format!("{ISSUER}/.well-known/openid-configuration"))
        .send()
        .await
        .map_err(|_| unavailable())?
        .json()
        .await
        .map_err(|_| unavailable())?;
    if doc["issuer"] != ISSUER {
        return Err(unavailable());
    }
    let on_issuer = |key: &str| {
        doc[key].as_str().filter(|u| u.starts_with(&format!("{ISSUER}/"))).map(str::to_string)
    };
    Ok(Endpoints {
        jwks: on_issuer("jwks_uri").ok_or_else(unavailable)?,
        revocation: on_issuer("revocation_endpoint"),
    })
}

/// The id this install signs in under, made the first time and kept.
fn host_id() -> String {
    if let Some(id) = crate::secret_store::get(SERVICE, HOST_ENTRY).filter(|s| s.starts_with("urn:uuid:")) {
        return id;
    }
    let id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
    let _ = crate::secret_store::set(SERVICE, HOST_ENTRY, &id);
    id
}

/// The page the browser opens. A first sign-in registers Cinderpaw under its
/// name; a later one reuses the client id it was given.
pub fn authorize_url(
    host: &str,
    saved_client: Option<&str>,
    redirect: &str,
    state: &str,
    nonce: &str,
    code_challenge: &str,
) -> String {
    let mut params = vec![
        ("client_id", saved_client.unwrap_or(DYNAMIC_CLIENT)),
        ("ext_agent_host_id", host),
        ("response_type", "code"),
        ("redirect_uri", redirect),
        ("scope", SCOPES),
        ("resource", RESOURCE),
        ("state", state),
        ("nonce", nonce),
        ("code_challenge_method", "S256"),
        ("code_challenge", code_challenge),
    ];
    if saved_client.is_none() {
        params.push(("agent_name_hint", APP_NAME));
    }
    let query: Vec<String> =
        params.iter().map(|(k, v)| format!("{k}={}", urlencoding::encode(v))).collect();
    format!("{AUTHORIZE}?{}", query.join("&"))
}

/// What the browser brought back.
#[derive(Debug, PartialEq)]
pub struct Callback {
    pub code: String,
    pub client_id: String,
}

/// Read the callback's query, refusing anything that is not the answer to
/// THIS sign-in: a state that does not match is another tab, or someone else.
pub fn parse_callback(query: &str, state: &str, saved_client: Option<&str>) -> Result<Callback, String> {
    let url = reqwest::Url::parse(&format!("http://127.0.0.1/?{query}"))
        .map_err(|_| "ChatGPT sent back an unreadable answer. Try signing in again.".to_string())?;
    let all = |key: &str| url.query_pairs().filter(|(k, _)| k == key).map(|(_, v)| v.into_owned()).collect::<Vec<_>>();
    let states = all("state");
    if states.len() != 1 || states[0] != state {
        return Err("This answer belongs to a different sign-in. Start again from Cinderpaw.".into());
    }
    if let Some(error) = all("error").first() {
        return Err(if error == "access_denied" {
            "Sign-in was cancelled. You can try again when you are ready.".into()
        } else {
            format!("ChatGPT sign-in did not finish ({error}). Try again.")
        });
    }
    let codes = all("code");
    let returned = all("client_id");
    let client_id = returned.first().map(String::as_str).or(saved_client).unwrap_or_default().to_string();
    let well_formed = !client_id.is_empty()
        && client_id.len() <= 200
        && client_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && client_id != DYNAMIC_CLIENT;
    let registration_moved = matches!((saved_client, returned.first()), (Some(s), Some(r)) if s != r.as_str());
    if codes.len() != 1 || returned.len() > 1 || !well_formed || registration_moved {
        return Err("ChatGPT did not finish registering Cinderpaw. Try signing in again.".into());
    }
    Ok(Callback { code: codes[0].clone(), client_id })
}

/// Whether OpenAI signed this ID token, with a key from its published set.
///
/// OIDC would let TLS stand in for this on a token that came straight from
/// the token endpoint (Core 3.1.3.7), but OpenAI's page for these apps asks
/// for the signature, so it is checked. RS256 only: a token that names any
/// other algorithm, or a key that is not in the set, is refused.
pub fn signature_ok(id_token: &str, jwks: &Value) -> bool {
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let mut parts = id_token.split('.');
    let (Some(head), Some(body), Some(sig), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let Some(header) = b64.decode(head).ok().and_then(|h| serde_json::from_slice::<Value>(&h).ok()) else {
        return false;
    };
    if header["alg"] != "RS256" {
        return false;
    }
    let kid = header["kid"].as_str();
    let Some(key) = jwks["keys"].as_array().and_then(|keys| {
        keys.iter().find(|k| k["kty"] == "RSA" && (kid.is_none() || k["kid"].as_str() == kid))
    }) else {
        return false;
    };
    let (Some(n), Some(e), Ok(sig)) = (
        key["n"].as_str().and_then(|n| b64.decode(n).ok()),
        key["e"].as_str().and_then(|e| b64.decode(e).ok()),
        b64.decode(sig),
    ) else {
        return false;
    };
    ring::signature::RsaPublicKeyComponents { n, e }
        .verify(&ring::signature::RSA_PKCS1_2048_8192_SHA256, format!("{head}.{body}").as_bytes(), &sig)
        .is_ok()
}

/// OpenAI's signing keys, then the check, for an answer that carries an ID token.
async fn verify_answer(http: &reqwest::Client, answer: &Value) -> Result<(), String> {
    let Some(id_token) = answer["id_token"].as_str() else { return Ok(()) };
    let refused = || "ChatGPT returned an identity Cinderpaw could not confirm. Sign in again.".to_string();
    let endpoints = discover(http).await?;
    let jwks: Value = http.get(&endpoints.jwks).send().await.map_err(|_| refused())?.json().await.map_err(|_| refused())?;
    if signature_ok(id_token, &jwks) { Ok(()) } else { Err(refused()) }
}

/// What a signed ID token must also say: who issued it, for whom, and that it
/// is still good (a minute of clock drift allowed).
fn claims_ok(claims: &Value, client_id: &str, now_ms: i64) -> bool {
    let for_us = match &claims["aud"] {
        Value::String(a) => a == client_id,
        Value::Array(a) => a.iter().any(|x| x == client_id),
        _ => false,
    };
    claims["iss"] == ISSUER && for_us && claims["exp"].as_i64().is_some_and(|exp| exp * 1000 > now_ms - 60_000)
}

/// The claims of an ID token, read after `signature_ok` has passed.
fn id_claims(id_token: &str) -> Result<Value, String> {
    let bad = || "ChatGPT returned an identity Cinderpaw could not read. Sign in again.".to_string();
    let payload = id_token.split('.').nth(1).ok_or_else(bad)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|_| bad())?;
    serde_json::from_slice(&bytes).map_err(|_| bad())
}

/// An account and an access token out of a token-endpoint answer, for a
/// sign-in (`previous` is None, `nonce` is this sign-in's) or a refresh.
fn account_from_tokens(
    json: &Value,
    client_id: &str,
    nonce: Option<&str>,
    previous: Option<&Account>,
    now: i64,
) -> Result<(Account, Access), String> {
    let again = "ChatGPT returned incomplete sign-in details. Sign in again.".to_string();
    // A refresh may leave the scope out when it did not change.
    let scopes: Vec<String> = match json["scope"].as_str() {
        Some(s) => s.split_whitespace().map(str::to_string).collect(),
        None => previous.map(|p| p.scopes.clone()).ok_or_else(|| again.clone())?,
    };
    let access_token = json["access_token"].as_str().filter(|t| !t.is_empty()).ok_or_else(|| again.clone())?;
    let bearer = json["token_type"].as_str().is_some_and(|t| t.eq_ignore_ascii_case("bearer"));
    let expires_in = json["expires_in"].as_i64().filter(|s| *s > 0).ok_or_else(|| again.clone())?;
    // Rotation: every answer carries the next refresh token, and the last one
    // is spent. Without it the person would be signed out in an hour.
    let refresh_token = json["refresh_token"].as_str().filter(|t| !t.is_empty()).ok_or_else(|| again.clone())?;
    if !bearer {
        return Err(again);
    }
    let claims = match json["id_token"].as_str() {
        Some(t) => Some(id_claims(t)?),
        None if previous.is_some() => None,
        None => return Err(again),
    };
    if let Some(c) = &claims {
        if !claims_ok(c, client_id, now) || nonce.is_some_and(|n| c["nonce"].as_str() != Some(n)) {
            return Err("This sign-in could not be confirmed. Sign in again.".into());
        }
    }
    let subject = match (&claims, previous) {
        (Some(c), _) => c["sub"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| again.clone())?.to_string(),
        (None, Some(p)) => p.subject.clone(),
        (None, None) => return Err(again),
    };
    if previous.is_some_and(|p| p.subject != subject) {
        return Err("ChatGPT answered for a different account. Sign in again with the account you connected.".into());
    }
    let claim = |key: &str| claims.as_ref().and_then(|c| c[key].as_str()).map(str::to_string);
    let account = Account {
        client_id: client_id.to_string(),
        subject,
        email: claim("email").or_else(|| previous.and_then(|p| p.email.clone())),
        name: claim("name").or_else(|| previous.and_then(|p| p.name.clone())),
        scopes,
        refresh_token: refresh_token.to_string(),
    };
    Ok((account, Access { token: access_token.to_string(), expires_at_ms: now + expires_in * 1000 }))
}

/// The OAuth error code in an answer, whichever of the two shapes it uses.
fn error_code(json: &Value) -> String {
    json["error"]["code"]
        .as_str()
        .or_else(|| json["error"].as_str())
        .unwrap_or("unknown_error")
        .to_string()
}

/// A refresh token that can no longer be spent: the person has to sign in.
fn signed_out(code: &str) -> bool {
    matches!(
        code,
        "invalid_grant" | "invalid_refresh_token" | "token_expired" | "refresh_token_expired"
            | "refresh_token_invalidated" | "refresh_token_reused"
    )
}

async fn post_form(http: &reqwest::Client, url: &str, form: &[(&str, &str)]) -> Result<(bool, Value), String> {
    let response = http
        .post(url)
        .header("accept", "application/json")
        .form(form)
        .send()
        .await
        .map_err(|_| "ChatGPT is not reachable right now. Check that you are online and try again.".to_string())?;
    let ok = response.status().is_success();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    Ok((ok, body))
}

fn save_account(account: &Account) -> Result<(), String> {
    let json = serde_json::to_string(account).map_err(|e| e.to_string())?;
    crate::secret_store::set(SERVICE, ACCOUNT_ENTRY, &json)
        .map_err(|e| format!("Signed in, but Cinderpaw could not save it to this computer's keychain ({e})."))
}

/// The connected account, if there is one.
pub fn account() -> Option<Account> {
    crate::secret_store::get(SERVICE, ACCOUNT_ENTRY).and_then(|s| serde_json::from_str(&s).ok())
}

/// Start a sign-in: the page to open in the browser, and the work that
/// finishes once the browser comes back.
pub async fn start() -> Result<(String, impl std::future::Future<Output = Result<Account, String>>), String> {
    let http = reqwest::Client::new();
    let saved_client = crate::secret_store::get(SERVICE, CLIENT_ENTRY);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Cinderpaw could not open its sign-in listener ({e})."))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let (state, nonce, verifier) = (random_value(), random_value(), random_value());
    let url = authorize_url(&host_id(), saved_client.as_deref(), &redirect, &state, &nonce, &challenge(&verifier));
    let finish = async move {
        let callback = tokio::time::timeout(SIGN_IN_WINDOW, wait_for_callback(&listener, port, &state, saved_client.as_deref()))
            .await
            .map_err(|_| "Sign-in timed out. Start it again from Cinderpaw.".to_string())??;
        // Kept before the one-time code is spent: if the exchange fails, the
        // next attempt reuses this registration instead of making another.
        let _ = crate::secret_store::set(SERVICE, CLIENT_ENTRY, &callback.client_id);
        let (ok, body) = post_form(&http, TOKEN, &[
            ("grant_type", "authorization_code"),
            ("client_id", callback.client_id.as_str()),
            ("code", callback.code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("resource", RESOURCE),
        ])
        .await?;
        if !ok {
            return Err(format!("ChatGPT did not accept the sign-in ({}). Try again.", error_code(&body)));
        }
        verify_answer(&http, &body).await?;
        let (account, access) = account_from_tokens(&body, &callback.client_id, Some(&nonce), None, now_ms())?;
        // Signed in, but the box for the plan was unticked: nothing could be
        // spent, and a "connected" card that never answers is worse than this.
        if !account.plan_usage() {
            return Err("You signed in, but Cinderpaw was not allowed to use your ChatGPT plan. Sign in again and leave \"Use your ChatGPT plan\" on.".into());
        }
        save_account(&account)?;
        *ACCESS.lock() = Some(access);
        Ok(account)
    };
    Ok((url, finish))
}

/// Answer requests on the listener until the real callback arrives. Anything
/// else that finds the port (a favicon probe, a stray tab) gets a 404 and the
/// sign-in keeps waiting.
async fn wait_for_callback(
    listener: &tokio::net::TcpListener,
    port: u16,
    state: &str,
    saved_client: Option<&str>,
) -> Result<Callback, String> {
    loop {
        let Ok((mut sock, _)) = listener.accept().await else { continue };
        let mut buf = vec![0u8; 8192];
        let mut read = 0;
        while read < buf.len() {
            match sock.read(&mut buf[read..]).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    read += n;
                    if buf[..read].windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
            }
        }
        let request = String::from_utf8_lossy(&buf[..read]);
        let target = request.lines().next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split(' ').next()).unwrap_or("");
        // The Host header too: a page elsewhere cannot make the browser call
        // this listener under another name and have it believed.
        let host_ok = request.lines().any(|l| l.eq_ignore_ascii_case(&format!("host: 127.0.0.1:{port}")));
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        if path != CALLBACK_PATH || !host_ok {
            let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let result = parse_callback(query, state, saved_client);
        let page = match &result {
            Ok(_) => "<h1>Back to Cinderpaw</h1><p>Cinderpaw is finishing the connection to ChatGPT. You can close this tab.</p>".to_string(),
            Err(e) => format!("<h1>Not connected</h1><p>{}</p>", e.replace('<', "&lt;")),
        };
        let html = format!(
            "<!doctype html><meta charset=utf-8><title>Cinderpaw</title><body style=\"font:17px system-ui;max-width:32rem;margin:18vh auto;padding:24px\">{page}</body>"
        );
        let _ = sock
            .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len()).as_bytes())
            .await;
        // A request for another sign-in's state is answered but does not end
        // this one; anything else that reached the right path does.
        if !matches!(&result, Err(e) if e.contains("different sign-in")) {
            return result;
        }
    }
}

/// A working access token, renewed when its hour is nearly up.
pub async fn access_token() -> Result<String, String> {
    let fresh = |a: &Option<Access>| a.as_ref().filter(|a| a.expires_at_ms - now_ms() > REFRESH_MARGIN_MS).map(|a| a.token.clone());
    if let Some(t) = fresh(&ACCESS.lock()) {
        return Ok(t);
    }
    let _one_at_a_time = REFRESHING.lock().await;
    if let Some(t) = fresh(&ACCESS.lock()) {
        return Ok(t);
    }
    let previous = account().ok_or_else(|| "Cinderpaw is not signed in with ChatGPT.".to_string())?;
    let http = reqwest::Client::new();
    let (ok, body) = post_form(&http, TOKEN, &[
        ("grant_type", "refresh_token"),
        ("client_id", previous.client_id.as_str()),
        ("refresh_token", previous.refresh_token.as_str()),
        ("resource", RESOURCE),
    ])
    .await?;
    if !ok {
        let code = error_code(&body);
        if signed_out(&code) {
            let _ = crate::secret_store::clear(SERVICE, ACCOUNT_ENTRY);
            return Err("Your ChatGPT sign-in has expired. Sign in with ChatGPT again.".into());
        }
        return Err(format!("ChatGPT could not renew the sign-in right now ({code}). Try again in a moment."));
    }
    verify_answer(&http, &body).await?;
    let (account, access) = account_from_tokens(&body, &previous.client_id, None, Some(&previous), now_ms())?;
    // Saved before use: the old refresh token is spent the moment this
    // answer exists, so losing the new one would sign the person out.
    save_account(&account)?;
    let token = access.token.clone();
    *ACCESS.lock() = Some(access);
    Ok(token)
}

/// Sign out here and ask OpenAI to forget the session. The registration is
/// kept, so signing in again does not add Cinderpaw to ChatGPT twice.
///
/// `Err` means the local sign-out happened but OpenAI's could not be
/// confirmed, and says where to finish it.
pub async fn disconnect() -> Result<(), String> {
    *ACCESS.lock() = None;
    let Some(account) = account() else { return Ok(()) };
    let _ = crate::secret_store::clear(SERVICE, ACCOUNT_ENTRY);
    let unconfirmed = "Signed out on this computer. To be sure, also remove Cinderpaw in ChatGPT under Settings, Apps.".to_string();
    let http = reqwest::Client::new();
    let Ok(endpoints) = discover(&http).await else { return Err(unconfirmed) };
    let Some(revocation) = endpoints.revocation else { return Err(unconfirmed) };
    match post_form(&http, &revocation, &[
        ("token", account.refresh_token.as_str()),
        ("token_type_hint", "refresh_token"),
        ("client_id", account.client_id.as_str()),
    ])
    .await
    {
        Ok((true, _)) => Ok(()),
        _ => Err(unconfirmed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn id_token(claims: Value) -> String {
        format!("e30.{}.sig", b64url(claims.to_string().as_bytes()))
    }

    #[test]
    fn a_first_sign_in_registers_cinderpaw_and_a_later_one_reuses_the_registration() {
        let first = authorize_url("urn:uuid:H", None, "http://127.0.0.1:5000/auth/callback", "S", "N", "C");
        assert!(first.starts_with("https://auth.openai.com/api/accounts/authorize?"), "{first}");
        for part in [
            "client_id=dynamic_agent_client", "response_type=code", "code_challenge_method=S256", "code_challenge=C",
            "state=S", "nonce=N", "agent_name_hint=Cinderpaw", "resource=https%3A%2F%2Fapi.openai.com%2Fv1",
            "ext_agent_host_id=urn%3Auuid%3AH",
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fauth%2Fcallback",
            "scope=openid%20profile%20email%20offline_access%20resource.invoke%20chatgpt.tokens.use.direct",
        ] {
            assert!(first.contains(part), "{part} missing from {first}");
        }
        let later = authorize_url("urn:uuid:H", Some("app_123"), "r", "S", "N", "C");
        assert!(later.contains("client_id=app_123") && !later.contains("agent_name_hint"));
        assert!(later.contains("ext_agent_host_id=urn%3Auuid%3AH"), "the same install every time");
    }

    #[test]
    fn pkce_challenge_is_the_s256_of_the_verifier() {
        // RFC 7636, appendix B.
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn only_the_answer_to_this_sign_in_is_believed() {
        let ok = parse_callback("code=abc&state=S&client_id=app_1", "S", None).unwrap();
        assert_eq!(ok, Callback { code: "abc".into(), client_id: "app_1".into() });
        assert!(parse_callback("code=abc&state=OTHER&client_id=app_1", "S", None).unwrap_err().contains("different sign-in"));
        assert!(parse_callback("code=abc&client_id=app_1", "S", None).is_err());
        assert!(parse_callback("error=access_denied&state=S", "S", None).unwrap_err().contains("cancelled"));
        // Registration must have happened: no client id, or the placeholder, is not one.
        assert!(parse_callback("code=abc&state=S", "S", None).is_err());
        assert!(parse_callback("code=abc&state=S&client_id=dynamic_agent_client", "S", None).is_err());
        // A saved registration is used when the answer does not repeat it, and
        // an answer that names a different one is refused.
        assert_eq!(parse_callback("code=abc&state=S", "S", Some("app_1")).unwrap().client_id, "app_1");
        assert!(parse_callback("code=abc&state=S&client_id=app_2", "S", Some("app_1")).is_err());
        assert!(parse_callback("code=a&code=b&state=S&client_id=app_1", "S", None).is_err());
    }

    fn sign_in_answer() -> Value {
        json!({
            "access_token": "AT1", "refresh_token": "RT1", "token_type": "Bearer", "expires_in": 3600,
            "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            "id_token": id_token(json!({
                "iss": "https://auth.openai.com", "aud": "app_1", "exp": 4_000_000_000i64,
                "sub": "user-1", "nonce": "N", "email": "d@example.com", "name": "Darius",
            })),
        })
    }

    #[test]
    fn a_sign_in_keeps_the_account_and_an_hour_of_access() {
        let (account, access) = account_from_tokens(&sign_in_answer(), "app_1", Some("N"), None, 1_000).unwrap();
        assert_eq!(account.subject, "user-1");
        assert_eq!(account.email.as_deref(), Some("d@example.com"));
        assert_eq!(account.refresh_token, "RT1");
        assert!(account.plan_usage());
        assert_eq!(access, Access { token: "AT1".into(), expires_at_ms: 1_000 + 3_600_000 });
    }

    #[test]
    fn a_sign_in_that_is_not_ours_or_is_incomplete_is_refused() {
        // Another sign-in's nonce.
        assert!(account_from_tokens(&sign_in_answer(), "app_1", Some("OTHER"), None, 0).is_err());
        // No refresh token: the person would be signed out in an hour.
        let mut answer = sign_in_answer();
        answer.as_object_mut().unwrap().remove("refresh_token");
        assert!(account_from_tokens(&answer, "app_1", Some("N"), None, 0).is_err());
        // No identity on a first sign-in.
        let mut answer = sign_in_answer();
        answer.as_object_mut().unwrap().remove("id_token");
        assert!(account_from_tokens(&answer, "app_1", Some("N"), None, 0).is_err());
    }

    #[test]
    fn plan_usage_needs_its_own_scope() {
        let mut answer = sign_in_answer();
        answer["scope"] = json!("openid profile email offline_access");
        let (account, _) = account_from_tokens(&answer, "app_1", Some("N"), None, 0).unwrap();
        assert!(!account.plan_usage());
    }

    #[test]
    fn a_refresh_rotates_the_token_and_must_be_the_same_account() {
        let (before, _) = account_from_tokens(&sign_in_answer(), "app_1", Some("N"), None, 0).unwrap();
        // Scope may be left out on a refresh; the identity may be too.
        let refresh = json!({ "access_token": "AT2", "refresh_token": "RT2", "token_type": "bearer", "expires_in": 3600 });
        let (after, access) = account_from_tokens(&refresh, "app_1", None, Some(&before), 5_000).unwrap();
        assert_eq!(after.refresh_token, "RT2");
        assert_eq!(after.scopes, before.scopes);
        assert_eq!(after.email, before.email);
        assert_eq!(access.token, "AT2");
        let someone_else = json!({
            "access_token": "AT3", "refresh_token": "RT3", "token_type": "bearer", "expires_in": 3600,
            "id_token": id_token(json!({ "iss": "https://auth.openai.com", "aud": "app_1", "exp": 4_000_000_000i64, "sub": "user-2" })),
        });
        assert!(account_from_tokens(&someone_else, "app_1", None, Some(&before), 0).unwrap_err().contains("different account"));
    }

    #[test]
    fn a_spent_refresh_token_means_signing_in_again_and_an_outage_does_not() {
        assert!(signed_out("refresh_token_reused") && signed_out("invalid_grant"));
        assert!(!signed_out("server_error") && !signed_out("temporarily_unavailable"));
        assert_eq!(error_code(&json!({ "error": "invalid_grant" })), "invalid_grant");
        assert_eq!(error_code(&json!({ "error": { "code": "refresh_token_expired" } })), "refresh_token_expired");
    }

    #[test]
    fn an_identity_for_another_app_or_issuer_or_out_of_date_is_refused() {
        let good = json!({ "iss": "https://auth.openai.com", "aud": "app_1", "exp": 2_000 });
        assert!(claims_ok(&good, "app_1", 1_000_000));
        assert!(claims_ok(&json!({ "iss": "https://auth.openai.com", "aud": ["x", "app_1"], "exp": 2_000 }), "app_1", 1_000_000));
        assert!(!claims_ok(&good, "app_2", 1_000_000), "made for another app");
        assert!(!claims_ok(&json!({ "iss": "https://evil.example", "aud": "app_1", "exp": 2_000 }), "app_1", 1_000_000));
        assert!(!claims_ok(&good, "app_1", 2_100_000), "expired, past the minute of drift");
        let mut answer = sign_in_answer();
        answer["id_token"] = json!(id_token(json!({ "iss": "https://auth.openai.com", "aud": "someone_else", "exp": 4_000_000_000i64, "sub": "user-1", "nonce": "N" })));
        assert!(account_from_tokens(&answer, "app_1", Some("N"), None, 0).is_err());
    }

    #[test]
    fn a_token_not_signed_with_a_published_rsa_key_is_refused() {
        let b = |v: Value| b64url(v.to_string().as_bytes());
        let jwks = json!({ "keys": [{ "kty": "RSA", "kid": "k1", "n": b64url(&[0xc3; 256]), "e": "AQAB" }] });
        let body = b(json!({ "sub": "user-1" }));
        // The right shape and key, but a signature that is not OpenAI's.
        assert!(!signature_ok(&format!("{}.{body}.{}", b(json!({ "alg": "RS256", "kid": "k1" })), b64url(&[7; 256])), &jwks));
        // "none", a symmetric algorithm, or a key that is not in the set.
        assert!(!signature_ok(&format!("{}.{body}.", b(json!({ "alg": "none" }))), &jwks));
        assert!(!signature_ok(&format!("{}.{body}.{}", b(json!({ "alg": "HS256", "kid": "k1" })), b64url(&[7; 32])), &jwks));
        assert!(!signature_ok(&format!("{}.{body}.{}", b(json!({ "alg": "RS256", "kid": "k9" })), b64url(&[7; 256])), &jwks));
        assert!(!signature_ok("not.a.jwt.at.all", &jwks));
    }
}
