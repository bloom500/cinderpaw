//! Reading configuration from the environment, across the rename.
//!
//! Every `FERAL_*` variable is becoming `CINDERPAW_*`. A person who set one in
//! a shell profile, a systemd unit or a CI job months ago must not have their
//! setup silently stop working because the app changed its name — a variable
//! that is read under a name nobody set is indistinguishable from a variable
//! nobody set, and the failure shows up as "the setting I configured does
//! nothing" with no error anywhere.
//!
//! So both names are read: the new one wins, the old one still works and says
//! once that it is deprecated.
//!
//! ponytail: each variable is resolved ONCE and cached. That is not only about
//! speed — `std::env::var` racing with `std::env::set_var` is undefined
//! behaviour in a multi-threaded process, and this crate still calls `set_var`
//! in ~40 places (a separate piece of work). Reading each name a single time
//! shrinks the window rather than widening it, which a dual-read would
//! otherwise do by doubling the number of reads.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The `CINDERPAW_`-prefixed name for a legacy `FERAL_`-prefixed one.
fn modern_name(legacy: &str) -> String {
    match legacy.strip_prefix("FERAL_") {
        Some(rest) => format!("CINDERPAW_{rest}"),
        None => legacy.to_string(),
    }
}

/// Read `FERAL_X`, preferring `CINDERPAW_X`. Pass the legacy name.
///
/// Cached: a change to the process environment after the first read for a given
/// name is not observed. Nothing in this codebase expects it to be — the
/// variables are configuration, read at startup.
pub fn env_var(legacy_name: &str) -> Option<String> {
    let mut guard = cache().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(hit) = guard.get(legacy_name) {
        return hit.clone();
    }
    let modern = modern_name(legacy_name);
    let resolved = match std::env::var(&modern) {
        Ok(v) => Some(v),
        Err(_) => match std::env::var(legacy_name) {
            Ok(v) => {
                tracing::warn!(
                    "{legacy_name} is the old name for {modern} and still works, but it \
                     will stop working in a future release — rename it when convenient."
                );
                Some(v)
            }
            Err(_) => None,
        },
    };
    guard.insert(legacy_name.to_string(), resolved.clone());
    resolved
}

/// `env_var` without the cache, for a value that is genuinely read per call
/// rather than once at startup.
///
/// `FERAL_AGENT_WORKSPACE` is the reason this exists: it bounds which files the
/// agent's tools may touch, it is consulted on every file operation, and a
/// cached answer would mean a change to it is not observed until the process
/// restarts. A security boundary that lags behind its own setting is worse than
/// one that costs an environment read.
pub fn env_var_uncached(legacy_name: &str) -> Option<String> {
    let modern = modern_name(legacy_name);
    match std::env::var(&modern) {
        Ok(v) => Some(v),
        Err(_) => match std::env::var(legacy_name) {
            Ok(v) => {
                tracing::warn!(
                    "{legacy_name} is the old name for {modern} and still works, but it \
                     will stop working in a future release — rename it when convenient."
                );
                Some(v)
            }
            Err(_) => None,
        },
    }
}

/// `env_var`, as an `OsString`, for values that are paths.
pub fn env_var_os(legacy_name: &str) -> Option<std::ffi::OsString> {
    let modern = modern_name(legacy_name);
    if let Some(v) = std::env::var_os(&modern) {
        if !v.is_empty() {
            return Some(v);
        }
    }
    match std::env::var_os(legacy_name) {
        Some(v) if !v.is_empty() => {
            tracing::warn!("{legacy_name} is the old name for {modern} — rename it when convenient.");
            Some(v)
        }
        _ => None,
    }
}

/// Clear the cache. Tests only: they set variables and expect to see them.
pub fn reset_cache_for_tests() {
    cache().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_modern_name_is_the_legacy_one_with_the_prefix_swapped() {
        assert_eq!(modern_name("FERAL_HOME"), "CINDERPAW_HOME");
        assert_eq!(modern_name("FERAL_RSI_ALLOW_CLOUD"), "CINDERPAW_RSI_ALLOW_CLOUD");
        // Anything not ours is left exactly as it is.
        assert_eq!(modern_name("PATH"), "PATH");
        assert_eq!(modern_name("OPENAI_API_KEY"), "OPENAI_API_KEY");
    }
}
