use cinderpaw_core::connectors::DeviceFlowDef;
use cinderpaw_core::oauth_device::*;
use std::cell::RefCell;

/// Returns queued `(status, body)` pairs in order, and records what was asked.
#[derive(Default)]
struct FakeHttp {
    queued: RefCell<Vec<(u16, String)>>,
    seen: RefCell<Vec<(String, Vec<(String, String)>)>>,
    /// Simulates the network being down rather than the provider saying no.
    offline: bool,
}

impl FakeHttp {
    fn with(pairs: &[(u16, &str)]) -> Self {
        Self {
            queued: RefCell::new(pairs.iter().rev().map(|(s, b)| (*s, b.to_string())).collect()),
            ..Default::default()
        }
    }
    fn field(&self, call: usize, key: &str) -> Option<String> {
        self.seen.borrow().get(call).and_then(|(_, form)| {
            form.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
        })
    }
}

impl TokenHttp for FakeHttp {
    fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<(u16, String), String> {
        self.seen.borrow_mut().push((
            url.to_string(),
            form.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        ));
        if self.offline {
            return Err("network unreachable".to_string());
        }
        self.queued
            .borrow_mut()
            .pop()
            .ok_or_else(|| "fake http ran out of replies".to_string())
    }
}

fn def() -> DeviceFlowDef {
    DeviceFlowDef {
        device_url: "https://id.twitch.tv/oauth2/device".to_string(),
        token_url: "https://id.twitch.tv/oauth2/token".to_string(),
        client_id: "d6y2kpx".to_string(),
        scopes: vec!["chat:read".to_string(), "chat:edit".to_string()],
    }
}

fn code(expires_at: i64) -> DeviceCode {
    DeviceCode {
        user_code: "ABCD-1234".to_string(),
        verification_uri: "https://twitch.tv/activate".to_string(),
        device_code: "dev-secret".to_string(),
        interval_secs: 5,
        expires_at,
    }
}

#[test]
fn the_users_code_and_url_are_carried_out_of_start() {
    let http = FakeHttp::with(&[(
        200,
        r#"{"device_code":"dev-secret","user_code":"ABCD-1234",
            "verification_uri":"https://twitch.tv/activate","expires_in":1800,"interval":5}"#,
    )]);
    let c = start_device_flow(&http, &def(), 1_800_000_000).unwrap();

    // What the person needs is what comes out — anything less and the screen
    // can only say "waiting".
    assert_eq!(c.user_code, "ABCD-1234");
    assert_eq!(c.verification_uri, "https://twitch.tv/activate");
    assert_eq!(c.expires_at, 1_800_000_000 + 1800);
    assert_eq!(c.interval_secs, 5);
    // Scopes go up space-separated, per the spec.
    assert_eq!(http.field(0, "scope").as_deref(), Some("chat:read chat:edit"));
}

#[test]
fn an_unregistered_connector_says_so_instead_of_failing_at_the_provider() {
    let mut d = def();
    d.client_id = String::new();
    let http = FakeHttp::default();
    let err = start_device_flow(&http, &d, 0).unwrap_err();
    assert!(err.contains("registered"), "{err}");
    // It never went near the network.
    assert!(http.seen.borrow().is_empty());
}

#[test]
fn pending_then_granted_walks_the_state_machine() {
    let http = FakeHttp::with(&[
        (400, r#"{"error":"authorization_pending"}"#),
        (
            200,
            r#"{"access_token":"acc","refresh_token":"ref","expires_in":14400}"#,
        ),
    ]);
    let d = def();
    let c = code(1_800_009_999);

    assert_eq!(poll_once(&http, &d, &c, 1_800_000_000), PollOutcome::Pending);
    match poll_once(&http, &d, &c, 1_800_000_010) {
        PollOutcome::Granted(t) => {
            assert_eq!(t.access, "acc");
            assert_eq!(t.refresh.as_deref(), Some("ref"));
            assert_eq!(t.expires_at, 1_800_000_010 + 14400);
        }
        other => panic!("expected a grant, got {other:?}"),
    }
}

#[test]
fn slow_down_backs_off_rather_than_hammering() {
    let http = FakeHttp::with(&[(400, r#"{"error":"slow_down"}"#)]);
    assert_eq!(
        poll_once(&http, &def(), &code(1_800_009_999), 1_800_000_000),
        PollOutcome::SlowDown
    );
}

#[test]
fn access_denied_is_denied_not_an_error() {
    // Somebody decided. That is an answer, and the screen should say so
    // plainly rather than showing a failure.
    let http = FakeHttp::with(&[(400, r#"{"error":"access_denied"}"#)]);
    assert_eq!(
        poll_once(&http, &def(), &code(1_800_009_999), 1_800_000_000),
        PollOutcome::Denied
    );
}

#[test]
fn a_flow_past_its_expiry_reports_expired_not_pending() {
    let http = FakeHttp::default();
    // Expired locally: no request is made at all, so a spinner cannot run on
    // forever against a code that is already dead.
    assert_eq!(
        poll_once(&http, &def(), &code(1_800_000_000), 1_800_000_001),
        PollOutcome::Expired
    );
    assert!(http.seen.borrow().is_empty());

    // …and the provider's own `expired_token` says the same thing.
    let http = FakeHttp::with(&[(400, r#"{"error":"expired_token"}"#)]);
    assert_eq!(
        poll_once(&http, &def(), &code(1_800_009_999), 1_800_000_000),
        PollOutcome::Expired
    );
}

#[test]
fn a_dead_network_is_an_error_not_a_refusal() {
    let http = FakeHttp {
        offline: true,
        ..Default::default()
    };
    match poll_once(&http, &def(), &code(1_800_009_999), 1_800_000_000) {
        PollOutcome::Error(e) => assert!(e.contains("unreachable"), "{e}"),
        other => panic!("a broken network must not read as a decision: {other:?}"),
    }
}

#[test]
fn refresh_stores_the_new_refresh_token() {
    // Twitch public-client refresh tokens are SINGLE USE. Keeping the old one
    // means the next refresh fails and the person is told they were revoked
    // when they were not.
    let http = FakeHttp::with(&[(
        200,
        r#"{"access_token":"acc2","refresh_token":"ref2","expires_in":14400}"#,
    )]);
    let t = refresh(&http, &def(), "ref1", 1_800_000_000).unwrap();
    assert_eq!(t.refresh.as_deref(), Some("ref2"), "the rotated token was dropped");
    assert_eq!(http.field(0, "refresh_token").as_deref(), Some("ref1"));
    assert_eq!(http.field(0, "grant_type").as_deref(), Some("refresh_token"));
}

#[test]
fn invalid_grant_is_revoked_and_a_500_is_transient() {
    // The difference decides whether the UI says "reconnect" or retries quietly.
    let http = FakeHttp::with(&[(400, r#"{"error":"invalid_grant"}"#)]);
    assert_eq!(
        refresh(&http, &def(), "ref1", 0).unwrap_err(),
        RefreshError::Revoked
    );

    let http = FakeHttp::with(&[(503, r#"{"error":"server_error"}"#)]);
    match refresh(&http, &def(), "ref1", 0).unwrap_err() {
        RefreshError::Transient(_) => {}
        RefreshError::Revoked => panic!("an outage must never read as a revoked account"),
    }
}
