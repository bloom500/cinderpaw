//! At-rest DB field key (H-1).
//!
//! A random 256-bit key kept in the OS keychain (Windows Credential Manager /
//! macOS Keychain / Linux Secret Service — same backend as BYOK in `byok.rs`)
//! and handed to the sidecar via the `CINDERPAW_DB_KEY` env var. The sidecar uses
//! it to encrypt the highest-density PII column (semantic memory values) with
//! AES-256-GCM, so a copy of the SQLite file alone — backed up, synced, or
//! leaked — does not reveal those facts. Episodic/conversation text stays
//! plaintext (it is FTS-indexed) and is covered by full-disk encryption instead.

use base64::Engine as _;

/// Keychain namespace for the DB key. Separate service from BYOK so the two
/// concerns never collide.
const SERVICE: &str = "ai.bloom.cinderpaw.dbkey";
const ACCOUNT: &str = "semantic";

fn entry() -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(SERVICE, ACCOUNT)
}

/// Return the base64-encoded 256-bit DB key, generating and persisting one in
/// the keychain on first use. Returns `None` if the keychain is unavailable —
/// the caller then runs without at-rest encryption (the sidecar stores
/// plaintext) rather than encrypting with a key it cannot persist (which would
/// make the data permanently unreadable after restart).
pub fn get_or_create() -> Option<String> {
    let e = entry().ok()?;
    if let Ok(existing) = e.get_password() {
        if !existing.is_empty() {
            return Some(existing);
        }
    }
    // Generate 32 cryptographically-random bytes from the OS RNG.
    let mut buf = [0u8; 32];
    if getrandom::getrandom(&mut buf).is_err() {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(buf);
    match e.set_password(&b64) {
        Ok(()) => Some(b64),
        Err(err) => {
            tracing::warn!(?err, "db_key: failed to persist key to keychain");
            None
        }
    }
}
