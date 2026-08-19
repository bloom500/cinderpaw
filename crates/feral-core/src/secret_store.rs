//! Secret storage: OS keychain first, encrypted file store as the Linux
//! fallback. Extracted from `byok.rs`, which had this logic inline and
//! duplicated; connectors need the same behaviour under their own service
//! name, and a third copy is how two of them drift.

/// True when the failure is the kind that justifies the file fallback:
/// no Secret Service, no D-Bus session — a headless Linux box. Other
/// errors (`NoEntry`, `Invalid`, `TooLong`) are real problems and bubble up.
pub fn is_unavailable(err: &keyring::Error) -> bool {
    matches!(
        err,
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_)
    )
}

/// File-store key. Namespaced by service so two services can hold the same
/// entry name; `byok` keeps its historical un-namespaced keys (see `byok.rs`).
fn file_key(service: &str, entry: &str) -> String {
    format!("{service}:{entry}")
}

/// Store `value` under `service`/`entry` in the OS keychain, falling back
/// (Linux only) to the encrypted file store under `file_key`. Most callers
/// want [`set`], which namespaces the file key by service; `byok` calls this
/// directly with its historical un-namespaced provider id so existing
/// `~/.feral/byok.keys` entries keep working.
pub fn set_with_file_key(service: &str, entry: &str, file_key: &str, value: &str) -> anyhow::Result<()> {
    match keyring::Entry::new(service, entry) {
        Ok(e) => match e.set_password(value) {
            Ok(()) => {
                #[cfg(target_os = "linux")]
                let _ = crate::byok_file_store::file_clear(file_key);
                Ok(())
            }
            Err(err) if is_unavailable(&err) => fallback_set(service, entry, file_key, value),
            Err(err) => Err(err.into()),
        },
        Err(err) if is_unavailable(&err) => fallback_set(service, entry, file_key, value),
        Err(err) => Err(err.into()),
    }
}

/// Read the value stored under `service`/`entry`, falling back (Linux only)
/// to the encrypted file store under `file_key`. See [`set_with_file_key`].
pub fn get_with_file_key(service: &str, entry: &str, file_key: &str) -> Option<String> {
    match keyring::Entry::new(service, entry) {
        Ok(e) => match e.get_password() {
            Ok(v) => Some(v),
            Err(keyring::Error::NoEntry) => None,
            Err(err) if is_unavailable(&err) => fallback_get(service, entry, file_key),
            Err(_) => None,
        },
        Err(err) if is_unavailable(&err) => fallback_get(service, entry, file_key),
        Err(_) => None,
    }
}

/// Remove the value stored under `service`/`entry`, and clear the (Linux
/// only) file-store entry under `file_key`. See [`set_with_file_key`].
pub fn clear_with_file_key(service: &str, entry: &str, file_key: &str) -> anyhow::Result<()> {
    if let Ok(e) = keyring::Entry::new(service, entry) {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(err) if !is_unavailable(&err) => return Err(err.into()),
            Err(_) => {}
        }
    }
    #[cfg(target_os = "linux")]
    crate::byok_file_store::file_clear(file_key)?;
    #[cfg(not(target_os = "linux"))]
    let _ = file_key;
    Ok(())
}

/// Store `value` under `service`/`entry`. The file-store fallback key is
/// namespaced by service (`"{service}:{entry}"`) so two services can use the
/// same entry name without colliding on disk.
pub fn set(service: &str, entry: &str, value: &str) -> anyhow::Result<()> {
    set_with_file_key(service, entry, &file_key(service, entry), value)
}

/// Read the value stored under `service`/`entry`.
pub fn get(service: &str, entry: &str) -> Option<String> {
    get_with_file_key(service, entry, &file_key(service, entry))
}

/// Remove the value stored under `service`/`entry`.
pub fn clear(service: &str, entry: &str) -> anyhow::Result<()> {
    clear_with_file_key(service, entry, &file_key(service, entry))
}

#[cfg(target_os = "linux")]
fn fallback_set(service: &str, entry: &str, file_key: &str, value: &str) -> anyhow::Result<()> {
    tracing::warn!(service, entry, "secret_store: keychain unavailable; using encrypted file store");
    crate::byok_file_store::file_set(file_key, value)
}

#[cfg(not(target_os = "linux"))]
fn fallback_set(_service: &str, _entry: &str, _file_key: &str, _value: &str) -> anyhow::Result<()> {
    Err(anyhow::anyhow!("keychain unavailable and the file fallback is Linux-only"))
}

#[cfg(target_os = "linux")]
fn fallback_get(_service: &str, _entry: &str, file_key: &str) -> Option<String> {
    crate::byok_file_store::file_get(file_key)
}

#[cfg(not(target_os = "linux"))]
fn fallback_get(_service: &str, _entry: &str, _file_key: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A round-trip through whatever backend this machine has. Skipped when
    /// the machine has neither a keychain nor (on Linux) a writable home —
    /// CI containers are exactly that, and a storage test that fails there
    /// teaches people to ignore red.
    #[test]
    fn set_then_get_returns_the_value() {
        let service = "ai.bloom.feral.test";
        let entry = "secret-store-roundtrip";
        if set(service, entry, "hunter2").is_err() {
            eprintln!("no secret backend available; skipping");
            return;
        }
        assert_eq!(get(service, entry).as_deref(), Some("hunter2"));
        clear(service, entry).expect("clear");
        assert_eq!(get(service, entry), None);
    }
}
