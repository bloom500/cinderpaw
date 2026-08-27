//! File-backed fallback for BYOK API keys.
//!
//! On Linux without a running Secret Service (no `gnome-keyring-daemon` /
//! `kwalletd`, no D-Bus session reachable — typical on a headless VPS),
//! the `keyring` crate returns `Error::NoStorageAccess` or
//! `Error::PlatformFailure` and `byok::byok_set` would otherwise 500 the
//! `/runtime/setup/verify` route. This module is the targeted fallback for
//! exactly that case: an AES-256-GCM encrypted key/value store on disk under
//! `~/.cinderpaw/byok.keys`, chmod 0o600, that the keychain path delegates to
//! transparently when the OS keychain is unreachable.
//!
//! **Scope is Linux-only.** Windows ships Credential Manager and macOS
//! Keychain on every supported SKU; both are reliable and don't need this.
//! Gated with `#[cfg(target_os = "linux")]` so the macOS/Windows builds
//! don't pull in `aes-gcm` or grow a writeable secret store.
//!
//! **Threat model.** Protects against another non-root local user reading
//! the key file. Does NOT protect against an attacker with root, or one
//! who can rewrite `/etc/machine-id`. The on-disk key is bound to the
//! machine, not the user — moving the file to another box makes the
//! ciphertext undecryptable (HKDF changes its output). This matches the
//! trust level of `~/.ssh/known_hosts` or `~/.cache/anything-sensitive` —
//! not a hardware-bound secret, but not plaintext either.
//!
//! **Not used by Windows / macOS even if it builds there** — the
//! `#[cfg(target_os = "linux")]` gate covers both compile and runtime.

#![cfg(target_os = "linux")]

use std::collections::HashMap;
use std::path::PathBuf;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use hkdf::Hkdf;
use sha2::Sha256;

/// File name (lives at `~/.cinderpaw/byok.keys`). Kept distinct from `byok.json`
/// so a casual `cat ~/.cinderpaw/byok.json` never reveals a secret, even if
/// the caller forgets the encryption contract.
const FILE_NAME: &str = "byok.keys";

/// Compile-time salt for the HKDF. Bumping this invalidates every key
/// already on disk — intentional: a version bump on a security-sensitive
/// release forces a re-prompt for the user's keys rather than silently
/// reading old ciphertext under a new derivation context.
const APP_SECRET: &[u8] = b"feral-byok-file-fallback/v1/2026-07-19";

/// 32-byte master key derived from `HKDF-SHA-256(secret=machine_id, salt=APP_SECRET)`.
/// Falls back to a stable empty-string salt when `/etc/machine-id` (and the
/// dbus fallback) is missing — the keys still won't decrypt if the file is
/// moved to another machine (the attacker's box has its own machine-id), but
/// a single-machine attacker with root can still read them. Documented above.
fn master_key() -> [u8; 32] {
    let machine_id = read_machine_id().unwrap_or_default();
    let ikm = if machine_id.is_empty() {
        // No machine-id → fall back to a fixed but distinct sentinel so
        // keys written on this box can still be read back. NOT a defense
        // against a determined attacker; this branch is a "we still work
        // on weird images" fallback, not a security claim.
        b"cinderpaw-no-machine-id-sentinel".as_slice()
    } else {
        machine_id.as_bytes()
    };
    let hk = Hkdf::<Sha256>::new(Some(APP_SECRET), ikm);
    let mut okm = [0u8; 32];
    // unwrap: HKDF with a fixed-length 32-byte output never fails.
    hk.expand(b"byok-file-store", &mut okm)
        .expect("HKDF expand 32 bytes");
    okm
}

/// Reads the systemd/dbus machine-id. Returns `None` when neither path
/// exists or both are empty — caller treats that as "use sentinel".
fn read_machine_id() -> Option<String> {
    for path in &["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(raw) = std::fs::read_to_string(path) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn file_path() -> PathBuf {
    crate::paths::cinderpaw_dir().join(FILE_NAME)
}

/// Loads the in-memory map from disk. A missing or unparseable file is
/// treated as empty (not an error) so the first-write path is friction-free.
fn load_store() -> HashMap<String, String> {
    let raw = match std::fs::read(file_path()) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    serde_json::from_slice(&raw).unwrap_or_default()
}

/// Atomic write: serialise → tmp file → chmod 0600 → rename. The tmp file
/// lives next to the target so the rename is on the same filesystem and
/// can never leave a half-written key file behind.
fn save_store(store: &HashMap<String, String>) -> anyhow::Result<()> {
    crate::paths::ensure_dirs()?;
    let path = file_path();
    let tmp = path.with_extension("keys.tmp");
    let bytes = serde_json::to_vec(store)?;
    std::fs::write(&tmp, &bytes)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn encrypt(plaintext: &[u8]) -> anyhow::Result<String> {
    let mk = master_key();
    let key = Key::<Aes256Gcm>::from_slice(&mk);
    let cipher = Aes256Gcm::new(key);
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes)
        .map_err(|e| anyhow::anyhow!("byok file-store: OS RNG failed: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| anyhow::anyhow!("byok file-store: encryption failed"))?;
    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);
    Ok(B64.encode(&combined))
}

fn decrypt(encoded: &str) -> Option<String> {
    let combined = B64.decode(encoded).ok()?;
    if combined.len() < 12 {
        return None;
    }
    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let mk = master_key();
    let key = Key::<Aes256Gcm>::from_slice(&mk);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher.decrypt(nonce, ciphertext).ok()?;
    String::from_utf8(plaintext).ok()
}

/// Persist a provider key to the encrypted file store. Errors out only on
/// I/O or serialisation failure — encryption failure means the OS RNG
/// refused, which is unrecoverable.
pub fn file_set(provider_id: &str, key: &str) -> anyhow::Result<()> {
    let mut store = load_store();
    store.insert(provider_id.to_string(), encrypt(key.as_bytes())?);
    save_store(&store)
}

/// Read a provider key, or `None` if absent / decrypt fails (corrupt file,
/// moved between machines, version bumped).
pub fn file_get(provider_id: &str) -> Option<String> {
    let store = load_store();
    store.get(provider_id).and_then(|enc| decrypt(enc))
}

/// Remove a provider key. A missing entry is success (matches
/// `keyring::Error::NoEntry` semantics upstream).
pub fn file_clear(provider_id: &str) -> anyhow::Result<()> {
    let mut store = load_store();
    store.remove(provider_id);
    save_store(&store)
}

/// True when this fallback has ever been used on this machine — i.e. at
/// least one key was written through the file path. Surfaced in
/// `cinderpaw doctor` so the operator sees "your keys are at-rest-encrypted on
/// disk, not in the OS keychain" without having to `ls ~/.cinderpaw/`.
pub fn file_store_used() -> bool {
    file_path().exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `CINDERPAW_HOME` is process-global and every test module in this crate's lib
    /// binary shares it, so the lock that serialises them has to be shared too.
    /// This module used to keep its OWN mutex and its own guard — a copy that
    /// looked identical and locked nothing the RSI tests respected. Both halves
    /// ran in parallel threads of the same process, each pointing `CINDERPAW_HOME`
    /// somewhere else: the byok tests read keys back out of a directory the RSI
    /// tests had just swapped away, and the RSI tests fell through to the real
    /// `~/.cinderpaw` and failed to find a repo there on any machine that didn't
    /// already have one. Green on a developer box with a populated `~/.cinderpaw`,
    /// red on a fresh CI runner.
    ///
    /// There is exactly one such lock now, in `rsi::test_support`.
    fn with_temp_home<R>(f: impl FnOnce() -> R) -> R {
        crate::rsi::test_support::with_temp_cinderpaw_home(|_| f())
    }

    #[test]
    fn roundtrip_single_provider() {
        with_temp_home(|| {
            file_set("anthropic", "sk-ant-test-1234").expect("set");
            assert_eq!(file_get("anthropic").as_deref(), Some("sk-ant-test-1234"));
        });
    }

    #[test]
    fn roundtrip_multiple_providers_independent() {
        with_temp_home(|| {
            file_set("anthropic", "sk-ant-1").unwrap();
            file_set("openai", "sk-2").unwrap();
            file_set("minimax", "sk-cp-3").unwrap();
            assert_eq!(file_get("anthropic").as_deref(), Some("sk-ant-1"));
            assert_eq!(file_get("openai").as_deref(), Some("sk-2"));
            assert_eq!(file_get("minimax").as_deref(), Some("sk-cp-3"));
        });
    }

    #[test]
    fn overwriting_replaces_value() {
        with_temp_home(|| {
            file_set("p", "old").unwrap();
            file_set("p", "new").unwrap();
            assert_eq!(file_get("p").as_deref(), Some("new"));
        });
    }

    #[test]
    fn missing_provider_returns_none() {
        with_temp_home(|| {
            assert!(file_get("nope").is_none());
        });
    }

    #[test]
    fn clear_removes_entry_but_keeps_others() {
        with_temp_home(|| {
            file_set("a", "1").unwrap();
            file_set("b", "2").unwrap();
            file_clear("a").unwrap();
            assert!(file_get("a").is_none());
            assert_eq!(file_get("b").as_deref(), Some("2"));
        });
    }

    #[test]
    fn file_store_used_reflects_writes() {
        with_temp_home(|| {
            assert!(!file_store_used());
            file_set("x", "y").unwrap();
            assert!(file_store_used());
            file_clear("x").unwrap();
            // Clearing leaves the file present (empty JSON map), so the
            // "used" flag stays true — intentional: operator sees that the
            // fallback was used at some point and shouldn't trust the OS
            // keychain as the only place their keys live.
            assert!(file_store_used());
        });
    }

    #[test]
    fn on_disk_file_has_0600_permissions() {
        with_temp_home(|| {
            file_set("p", "secret").unwrap();
            let path = file_path();
            let meta = std::fs::metadata(&path).expect("metadata");
            // Same scoped import `save_store` uses. Easy to miss: this whole
            // module is #[cfg(target_os = "linux")], so a Windows dev box
            // never compiles it and only the Linux CI job catches the gap.
            use std::os::unix::fs::PermissionsExt;
            let mode = meta.permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "expected 0600, got {:o}", mode);
        });
    }

    #[test]
    fn ciphertext_does_not_contain_plaintext() {
        with_temp_home(|| {
            let secret = "sk-ant-very-unique-secret-key-for-this-test";
            file_set("p", secret).unwrap();
            let raw = std::fs::read_to_string(file_path()).unwrap();
            assert!(
                !raw.contains(secret),
                "plaintext leaked into the on-disk file"
            );
            assert!(
                !raw.contains("sk-ant-very-unique"),
                "secret prefix leaked into the on-disk file"
            );
        });
    }

    #[test]
    fn decrypt_rejects_truncated_blob() {
        let s = decrypt("AAAA");
        assert!(s.is_none());
    }

    #[test]
    fn decrypt_rejects_garbage_b64() {
        let s = decrypt("!!!not-base64!!!");
        assert!(s.is_none());
    }
}
