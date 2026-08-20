//! The device authorization grant (RFC 8628), as a state machine.
//!
//! Why this flow and not the ordinary redirect one: Cinderpaw is a desktop app and
//! a headless gateway. It cannot hold a client secret (anything shipped to a
//! user's machine is public the moment it ships) and it cannot rely on being
//! able to open a local HTTP server to catch a redirect. The device grant needs
//! neither: Cinderpaw shows a short code, the person types it on the provider's own
//! site, Cinderpaw polls until they are done.
//!
//! Everything here takes `now` and an injected HTTP client, so the tests need
//! neither a clock nor a network — and neither does the machine running them.

use crate::connectors::DeviceFlowDef;

/// What the person is asked to do, and what we poll with afterwards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCode {
    /// The short code the person types. Shown to them, never sent anywhere
    /// except by their own hands.
    pub user_code: String,
    /// The page they type it on.
    pub verification_uri: String,
    /// Our half of the handshake. Not shown — it is a credential.
    pub device_code: String,
    /// How long to wait between polls, per the provider.
    pub interval_secs: u64,
    /// Unix seconds. Past this the code is dead and the person starts again.
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tokens {
    pub access: String,
    /// Providers that issue one. Twitch's are SINGLE USE — see [`refresh`].
    pub refresh: Option<String>,
    /// Unix seconds.
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    /// They have not finished yet. Keep waiting; this is the normal answer.
    Pending,
    /// We polled too fast. Back off — the provider will start refusing.
    SlowDown,
    Granted(Tokens),
    /// They said no. A decision, not a failure.
    Denied,
    /// The code timed out. Different from `Denied`: nobody refused anything,
    /// so the honest thing on screen is "that took too long, try again".
    Expired,
    /// Something else went wrong (network, provider outage, malformed reply).
    /// Carried rather than swallowed so the screen can say what happened.
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshError {
    /// The provider will never honour this token again. The person has to
    /// reconnect; retrying is pure noise.
    Revoked,
    /// A hiccup. Retrying is exactly right, and telling the person their
    /// account was revoked would be a lie.
    Transient(String),
}

/// The one HTTP shape this module needs. Injected so the state machine can be
/// tested exhaustively without a network.
pub trait TokenHttp {
    fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<(u16, String), String>;
}

const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// RFC 8628 section 3.5: an absent `interval` means 5 seconds.
const DEFAULT_INTERVAL_SECS: u64 = 5;

pub fn start_device_flow(
    http: &dyn TokenHttp,
    def: &DeviceFlowDef,
    now: i64,
) -> Result<DeviceCode, String> {
    if def.client_id.trim().is_empty() {
        // A connector whose application was never registered would otherwise
        // fail deep inside the provider with a message nobody can act on.
        return Err("this connector has no registered application yet".to_string());
    }
    let scope = def.scopes.join(" ");
    let (status, body) = http.post_form(
        &def.device_url,
        &[("client_id", def.client_id.as_str()), ("scope", scope.as_str())],
    )?;
    if !(200..300).contains(&status) {
        return Err(format!("the provider refused to start pairing (HTTP {status})"));
    }
    let v: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("unreadable reply from the provider: {e}"))?;

    let user_code = str_field(&v, "user_code").ok_or("the provider sent no code to show")?;
    let device_code = str_field(&v, "device_code").ok_or("the provider sent no device code")?;
    // `verification_uri_complete` already contains the code, which saves the
    // person typing it. Prefer it, fall back to the plain one.
    let verification_uri = str_field(&v, "verification_uri_complete")
        .or_else(|| str_field(&v, "verification_uri"))
        .or_else(|| str_field(&v, "verification_url"))
        .ok_or("the provider sent nowhere to enter the code")?;
    let expires_in = v.get("expires_in").and_then(|x| x.as_i64()).unwrap_or(900);
    let interval_secs = v
        .get("interval")
        .and_then(|x| x.as_u64())
        .unwrap_or(DEFAULT_INTERVAL_SECS);

    Ok(DeviceCode {
        user_code,
        verification_uri,
        device_code,
        interval_secs,
        expires_at: now + expires_in,
    })
}

pub fn poll_once(
    http: &dyn TokenHttp,
    def: &DeviceFlowDef,
    code: &DeviceCode,
    now: i64,
) -> PollOutcome {
    // Checked before the request: a dead code cannot come back to life, and
    // polling on regardless is how a "waiting..." spinner runs forever.
    if now >= code.expires_at {
        return PollOutcome::Expired;
    }
    let (status, body) = match http.post_form(
        &def.token_url,
        &[
            ("client_id", def.client_id.as_str()),
            ("device_code", code.device_code.as_str()),
            ("grant_type", DEVICE_GRANT),
        ],
    ) {
        Ok(r) => r,
        Err(e) => return PollOutcome::Error(e),
    };

    let v: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return PollOutcome::Error(format!("unreadable reply from the provider: {e}")),
    };

    if (200..300).contains(&status) {
        return match tokens_from(&v, now) {
            Some(t) => PollOutcome::Granted(t),
            None => PollOutcome::Error("the provider granted access without a token".to_string()),
        };
    }

    match str_field(&v, "error").unwrap_or_default().as_str() {
        "authorization_pending" => PollOutcome::Pending,
        "slow_down" => PollOutcome::SlowDown,
        "access_denied" => PollOutcome::Denied,
        "expired_token" => PollOutcome::Expired,
        other if other.is_empty() => PollOutcome::Error(format!("provider error (HTTP {status})")),
        other => PollOutcome::Error(other.to_string()),
    }
}

/// Exchange a refresh token for a fresh access token.
///
/// The returned `Tokens.refresh` is what must be stored. Twitch (and every
/// other provider that rotates them) issues SINGLE-USE refresh tokens: keeping
/// the old one means the next refresh fails, and the person is told their
/// account was revoked when nobody revoked anything.
pub fn refresh(
    http: &dyn TokenHttp,
    def: &DeviceFlowDef,
    refresh_token: &str,
    now: i64,
) -> Result<Tokens, RefreshError> {
    let (status, body) = http
        .post_form(
            &def.token_url,
            &[
                ("client_id", def.client_id.as_str()),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ],
        )
        .map_err(RefreshError::Transient)?;

    let v: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| RefreshError::Transient(format!("unreadable reply: {e}")))?;

    if (200..300).contains(&status) {
        return tokens_from(&v, now)
            .ok_or_else(|| RefreshError::Transient("no token in the reply".to_string()));
    }
    // `invalid_grant` is the provider saying this will never work again.
    // Anything else — a 5xx, a gateway, a rate limit — is worth retrying, and
    // must NOT be reported to the person as a revoked account.
    match str_field(&v, "error").unwrap_or_default().as_str() {
        "invalid_grant" => Err(RefreshError::Revoked),
        other if other.is_empty() => Err(RefreshError::Transient(format!("HTTP {status}"))),
        other => Err(RefreshError::Transient(other.to_string())),
    }
}

fn tokens_from(v: &serde_json::Value, now: i64) -> Option<Tokens> {
    let access = str_field(v, "access_token")?;
    let expires_in = v.get("expires_in").and_then(|x| x.as_i64()).unwrap_or(3600);
    Some(Tokens {
        access,
        refresh: str_field(v, "refresh_token"),
        expires_at: now + expires_in,
    })
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}
