use cinderpaw_core::connector_accounts::*;
use std::collections::HashMap;

fn sample() -> ConnectorAccount {
    ConnectorAccount {
        connector_id: "twitch".into(),
        display_name: Some("feral_bot".into()),
        status: AccountStatus::Connected,
        metadata: HashMap::new(),
        auth_state: None,
        secret_ref: Some("connector:twitch:TWITCH_ACCESS".into()),
        expires_at: None,
    }
}

#[test]
fn an_account_never_serialises_a_secret_value() {
    let mut a = sample();
    a.metadata
        .insert("scopes".to_string(), "chat:read".to_string());
    a.expires_at = Some(1_800_000_000);
    let json = serde_json::to_string(&a).unwrap();
    assert!(json.contains("connector:twitch:TWITCH_ACCESS"));
    assert!(
        !json.contains("oauth2:"),
        "a token shape reached the account record"
    );
}

#[test]
fn a_non_secret_setting_has_a_home_outside_the_vault() {
    // MATRIX_HOMESERVER is required but public; before `metadata` existed the
    // only place to put it was the `secrets` map, i.e. the OS keychain.
    let mut a = sample();
    a.connector_id = "matrix".into();
    a.metadata.insert(
        "MATRIX_HOMESERVER".into(),
        "https://matrix.org".to_string(),
    );
    let back: ConnectorAccount = serde_json::from_str(&serde_json::to_string(&a).unwrap()).unwrap();
    assert_eq!(
        back.metadata.get("MATRIX_HOMESERVER").map(String::as_str),
        Some("https://matrix.org")
    );
}

#[test]
fn a_pairing_in_flight_carries_what_to_type_and_never_the_device_code() {
    let mut a = sample();
    a.status = AccountStatus::Pairing;
    a.auth_state = Some(AuthState::WaitingForUser {
        user_code: "ABCD-1234".into(),
        verification_uri: "https://twitch.tv/activate".into(),
        expires_at: 1_800_001_800,
    });
    let json = serde_json::to_string(&a).unwrap();
    // The frontend switches on `kind`.
    assert!(json.contains("\"kind\":\"waiting_for_user\""), "{json}");
    assert!(json.contains("ABCD-1234"));
    // The device code is OUR half of the handshake — a credential. There is
    // no field for it here, and this pins that there never is one.
    assert!(!json.contains("device_code"), "a credential reached the account record");

    let back: ConnectorAccount = serde_json::from_str(&json).unwrap();
    assert_eq!(back.auth_state, a.auth_state);
}

#[test]
fn an_expired_credential_reports_expired_not_connected() {
    let now = 1_800_000_000_i64;
    let a = ConnectorAccount {
        expires_at: Some(now - 1),
        status: AccountStatus::Connected,
        ..sample()
    };
    assert!(matches!(effective_status(&a, now), AccountStatus::Expired));
}

#[test]
fn a_credential_expiring_later_is_still_connected() {
    let now = 1_800_000_000_i64;
    let a = ConnectorAccount {
        expires_at: Some(now + 60),
        status: AccountStatus::Connected,
        ..sample()
    };
    assert!(matches!(effective_status(&a, now), AccountStatus::Connected));
}

#[test]
fn revoked_stays_revoked_even_with_a_future_expiry() {
    let now = 1_800_000_000_i64;
    let a = ConnectorAccount {
        expires_at: Some(now + 9_999),
        status: AccountStatus::Revoked,
        ..sample()
    };
    assert!(matches!(effective_status(&a, now), AccountStatus::Revoked));
}

#[test]
fn an_error_keeps_its_words_and_outranks_the_clock() {
    let now = 1_800_000_000_i64;
    let a = ConnectorAccount {
        expires_at: Some(now - 1),
        status: AccountStatus::Error("homeserver refused the login".into()),
        ..sample()
    };
    match effective_status(&a, now) {
        AccountStatus::Error(msg) => assert_eq!(msg, "homeserver refused the login"),
        other => panic!("the reason the user needs was dropped: {other:?}"),
    }
}

/// One test owns the disk, because `FERAL_HOME` is process-global and cargo
/// runs tests in parallel threads.
#[test]
fn a_machine_that_never_paired_anything_answers_disconnected_then_roundtrips() {
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("FERAL_HOME", tmp.path());

    // First run: no file at all.
    assert!(load_accounts().is_empty());
    assert!(matches!(
        status_for("twitch", 1_800_000_000),
        AccountStatus::Disconnected
    ));

    save_account(&sample()).unwrap();
    assert!(matches!(
        status_for("twitch", 1_800_000_000),
        AccountStatus::Connected
    ));

    // Upsert replaces, it does not duplicate.
    let mut revoked = sample();
    revoked.status = AccountStatus::Revoked;
    save_account(&revoked).unwrap();
    assert_eq!(load_accounts().len(), 1);
    assert!(matches!(
        status_for("twitch", 1_800_000_000),
        AccountStatus::Revoked
    ));

    // A file full of garbage reads as "nothing paired", not a crash.
    std::fs::write(tmp.path().join("connector-accounts.json"), "{ not json").unwrap();
    assert!(load_accounts().is_empty());

    std::env::remove_var("FERAL_HOME");
}
