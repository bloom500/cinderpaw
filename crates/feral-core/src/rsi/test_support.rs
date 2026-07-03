//! Hermetic test harness for the RSI substrate.
//!
//! Every RSI path resolves under `crate::paths::feral_dir()`, which reads
//! the `FERAL_HOME` env var (see `paths::feral_dir`). The RSI tests must
//! never write into the developer's real `~/.feral/rsi`, so they run
//! inside `with_temp_feral_home`, which:
//!
//! 1. serialises all path-touching tests behind a single global mutex
//!    (env vars are process-global, so two tests setting `FERAL_HOME`
//!    concurrently would clobber each other), and
//! 2. points `FERAL_HOME` at a fresh `TempDir` for the duration of the
//!    closure, restoring the previous value (if any) afterward — even on
//!    panic, via a drop guard.
//!
//! The previous design wrote bounds + audit rows straight into the real
//! `~/.feral/rsi`, which polluted production state (a stray `$50` cost cap
//! with reason "user raised cap" was a test artifact, not a user action).

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use tempfile::TempDir;

/// Serialises all tests that mutate `FERAL_HOME` / touch the RSI dir.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Restores the prior `FERAL_HOME` (or removes it) when dropped, so a
/// panicking test can't leak the override into the next one.
struct EnvGuard {
    prev: Option<std::ffi::OsString>,
    _lock: MutexGuard<'static, ()>,
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match self.prev.take() {
            Some(v) => std::env::set_var("FERAL_HOME", v),
            None => std::env::remove_var("FERAL_HOME"),
        }
    }
}

/// Run `f` with `FERAL_HOME` pointed at a fresh temp dir. The temp dir
/// (and the env override) live only for the duration of the call. The
/// closure receives the temp root so it can assert on the on-disk layout.
pub fn with_temp_feral_home<R>(f: impl FnOnce(&Path) -> R) -> R {
    // Recover from a poisoned lock: a prior test panicking inside the
    // closure is exactly the case the drop guard handles, and we still
    // want subsequent tests to run.
    let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let prev = std::env::var_os("FERAL_HOME");
    let tmp = TempDir::new().expect("create temp FERAL_HOME");
    std::env::set_var("FERAL_HOME", tmp.path());
    let _guard = EnvGuard { prev, _lock: lock };
    f(tmp.path())
}
