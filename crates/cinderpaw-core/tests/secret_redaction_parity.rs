//! Parity between the two credential redactors.
//!
//! Credentials are redacted twice, by two separate implementations in two
//! separate processes: `redactSecrets` in the sidecar
//! (`CinderpawAgent/src/memory/privacy.ts`) keeps them out of memory, and
//! `secret_redact::redact_secrets` here keeps them out of the saved
//! conversation.
//!
//! A format that one catches and the other misses is still a leaked
//! secret — it just leaks into the other store. Two hand-maintained
//! lists in two languages drift by default, so both are tested against
//! the SAME fixture file. Add a format there first and the side that has
//! not learned it yet fails.

use cinderpaw_core::secret_redact::redact_secrets;
use std::path::PathBuf;

fn fixture() -> serde_json::Value {
    // The workspace root is two levels up from this crate.
    let path: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../CinderpawAgent/tests/fixtures/secret-redaction-cases.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "shared redaction fixture missing at {}: {e}. \
             It is shared with the sidecar's test suite — do not delete it, and \
             do not move it without updating both readers.",
            path.display()
        )
    });
    serde_json::from_str(&raw).expect("fixture must be valid JSON")
}

#[test]
fn every_shared_secret_is_redacted_here_too() {
    let fx = fixture();
    let cases = fx["secrets"].as_array().expect("secrets array");
    assert!(!cases.is_empty(), "fixture has no secrets to check");

    for case in cases {
        let text = case["text"].as_str().unwrap();
        let kind = case["kind"].as_str().unwrap();
        let note = case["note"].as_str().unwrap_or("");

        // In isolation, and in a sentence — a value only redacted when it
        // stands alone would miss every real paste.
        for input in [text.to_string(), format!("here it is: {text} — use it")] {
            let r = redact_secrets(&input);
            assert!(
                !r.text.contains(text),
                "{note}: the secret survived redaction.\n  in:  {input}\n  out: {}",
                r.text
            );
            assert!(
                r.text.contains(&format!("[REDACTED:{kind}]")),
                "{note}: expected kind '{kind}'.\n  out: {}",
                r.text
            );
        }
    }
}

#[test]
fn nothing_innocent_is_touched() {
    // A redactor that mangles ordinary text is one that gets turned off,
    // and then it protects nothing at all.
    let fx = fixture();
    for case in fx["innocent"].as_array().expect("innocent array") {
        let text = case["text"].as_str().unwrap();
        let note = case["note"].as_str().unwrap_or("");
        let r = redact_secrets(text);
        assert_eq!(
            r.redactions, 0,
            "{note}: ordinary text was redacted.\n  in:  {text}\n  out: {}",
            r.text
        );
        assert_eq!(r.text, text, "{note}: ordinary text was altered");
    }
}

#[test]
fn a_transcript_keeps_everything_except_the_secret() {
    // What the saved conversation should look like after a user pastes a
    // token: readable, with one hole in it.
    let conversation = "me: here is the bot token\n\
                        xoxb-123456789012-abcdefghijklmno\n\
                        agent: saved it to your keychain";
    let r = redact_secrets(conversation);
    assert_eq!(r.redactions, 1);
    assert!(r.text.contains("me: here is the bot token"));
    assert!(r.text.contains("agent: saved it to your keychain"));
    assert!(r.text.contains("[REDACTED:slack_token]"));
    assert!(!r.text.contains("xoxb-"));
    // Line structure survives, so the transcript still reads as a
    // conversation rather than one long smear.
    assert_eq!(r.text.lines().count(), 3);
}
