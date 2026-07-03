//! Shared boot sequence — the runtime services every Feral host starts.
//!
//! Both the Tauri desktop entry point (`src-tauri/src/lib.rs`) and the
//! headless `feral-cli` gateway build the same runtime via this module.
//! Slice 2 of Faza 4.5 extracts the once-inline setup logic from the
//! Tauri `setup` closure into two host-agnostic functions:
//!
//!   * [`build_runtime`] — pure construction. No I/O beyond persisting the
//!     per-launch API token and ensuring the profile dirs exist. Returns
//!     an `Arc<RuntimeState>` ready to be shared by every host.
//!
//!   * [`start`] — service wiring. Pushes runtime state into motion:
//!     fragile-AMD GPU guard (Vulkan builds), RSI substrate bootstrap,
//!     settings env exports, the API server, and the supervised sidecar
//!     (via `feral_core::feral_agent::supervise`). Non-blocking: every
//!     long-running task is spawned on the host's tokio runtime.
//!
//! **Order matters.** The order of `start()`'s sections reproduces the
//! pre-extraction Tauri `setup` closure exactly — do not reshuffle without
//! checking the comment trail in each section.
//!
//! Invariants this module respects (see `docs/runtime-invariants.md`):
//!   * **#1 runtime owns state** — neither `build_runtime` nor `start`
//!     writes to anything outside `RuntimeState`, settings on disk, and
//!     the env vars the sidecar reads.
//!   * **#7 transports replaceable** — no `app.emit`, no Tauri `State`,
//!     no host-specific paths. Every event the runtime produces flows
//!     through `HostEvents`.
//!   * **#8 inference stack unique** — exactly one `ModelManager`; the
//!     headless host builds the same one the desktop app does.
//!   * **#12 runtime owns scheduling** — Dream/eval/training are not
//!     kicked off here; they wait for a `RequestDream` (or equivalent)
//!     from a client.

use std::path::PathBuf;
use std::sync::Arc;

use crate::api;
use crate::feral_agent;
use crate::host::{DesktopControlHandler, HostEvents};
use crate::inference::ModelManager;
use crate::paths;
use crate::rsi::{self, audit::SandboxBoundsAudit, sandbox_bounds::SandboxBounds};
use crate::runtime::RuntimeState;
use crate::settings::{self, Settings};

/// Build the runtime: ensure profile dirs exist, generate + persist the
/// per-launch API token, load settings (forcing `api_server_enabled` on
/// because the supervised sidecar unconditionally points at the local
/// API), and wrap a `ModelManager` + the loaded settings + the token
/// into a `RuntimeState`.
///
/// Returns `Arc<RuntimeState>` — clone it freely into whichever long-lived
/// subsystems need a handle (commands, spawned tasks, the supervisor).
///
/// This function does NOT spawn any tasks or open any sockets. The
/// `start()` function below does that.
pub fn build_runtime() -> Arc<RuntimeState> {
    let _ = paths::ensure_dirs();

    let settings = build_settings();
    let manager = Arc::new(ModelManager::new());
    let local_api_token = build_and_persist_api_token();

    Arc::new(RuntimeState::new(manager, settings, local_api_token))
}

/// Start the runtime services. Non-blocking: every long-running task is
/// spawned on the current tokio runtime. Order of the sections matches
/// the pre-extraction Tauri `setup` closure exactly.
///
/// `events` is the host-specific event sink (Tauri's webview today, the
/// headless SSE stream tomorrow). `desktop_control` is `Some` on the
/// desktop host (forwards to `crate::desktop_control`) and `None` on the
/// headless gateway, where every `desktop_control_request` line is
/// answered with `ok:false, error:"not available"`. `extra_bin_dirs` is
/// the host-supplied binary search path (Tauri passes its `resource_dir`).
pub fn start(
    runtime: Arc<RuntimeState>,
    events: Arc<dyn HostEvents>,
    desktop_control: Option<DesktopControlHandler>,
    extra_bin_dirs: Vec<PathBuf>,
) {
    fragile_amd_embed_guard();
    bootstrap_rsi_substrate(&runtime);
    export_settings_env(&runtime.settings);
    spawn_api_server_if_enabled(&runtime);
    feral_agent::supervise(runtime, events, desktop_control, extra_bin_dirs);
}

// ── Section helpers ───────────────────────────────────────────────────────

/// Load settings from disk and force `api_server_enabled = true` because
/// the Feral Agent sidecar is hardcoded to point at the local API at
/// `127.0.0.1:{api_port}`; without the API up, every agent inference
/// fails with "connection refused". The bearer token in the runtime
/// already gates the only exposure `api_server_enabled` was guarding,
/// so forcing it on is safe even on hosts where the user wants the
/// API "off" — they can remove the sidecar's externalBin entry in
/// tauri.conf.json instead. (R4 fix in the original lib.rs.)
fn build_settings() -> Settings {
    let mut s = settings::load();
    s.api_server_enabled = true;
    s
}

/// V4: per-launch bearer token for the loopback HTTP API. Two uuids give
/// ~244 bits of randomness — far past brute-force for a token that also
/// rotates every launch. Persisted to `~/.feral/api-token` (inside the
/// already user-private profile dir) so external apps that want to
/// consume the local endpoint can read it; the in-app sidecar receives
/// it directly. On Unix, the persisted file is chmodded to 0o600 so
/// other local users on the box can't read it.
fn build_and_persist_api_token() -> Arc<str> {
    let token: Arc<str> = Arc::from(
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
        .as_str(),
    );

    let token_path = paths::feral_dir().join("api-token");
    if let Err(e) = std::fs::write(&token_path, token.as_bytes()) {
        tracing::warn!(?e, "failed to persist api-token (external API consumers won't have it)");
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600));
        }
    }

    token
}

/// On RX 580 / Polaris / early-Vega cards, llama.cpp's Vulkan embed
/// (bge-small) crashes at model load — a known llama.cpp × AMDVLK
/// driver bug that no Feral-side work-around fixes (see
/// `docs/agents-memory/project_local_models_gpu.md`). The chat
/// inference path on the same GPU is fine; only the embed path is
/// the problem. We set `FERAL_EMBED_GPU_LAYERS=0` BEFORE the embed
/// model is lazily loaded (`inference.rs::load_embedding` reads it via
/// `std::env` at first use), so the crash never happens. Only active
/// on a Vulkan build (`inference-vulkan` feature); a CPU build ignores
/// the env anyway. Honours an explicit user override (we never
/// overwrite a pre-set env var).
#[cfg(feature = "inference-vulkan")]
fn fragile_amd_embed_guard() {
    if std::env::var_os("FERAL_EMBED_GPU_LAYERS").is_none() {
        let info = crate::gpu_detect::detect();
        if crate::gpu_detect::looks_like_fragile_amd_gpu(&info) {
            std::env::set_var("FERAL_EMBED_GPU_LAYERS", "0");
            tracing::info!(
                gpu = %info.name,
                "fragile AMD GPU detected — forcing CPU offload for embeddings \
                 (FERAL_EMBED_GPU_LAYERS=0); chat inference still uses GPU"
            );
        }
    }
}

/// CPU-only stub for the guard above so non-Vulkan builds keep the same
/// call site in `start()`.
#[cfg(not(feature = "inference-vulkan"))]
fn fragile_amd_embed_guard() {
    // No-op on CPU/METAL/CUDA builds — only the Vulkan × AMD combo has
    // the bge-small embed crash.
}

/// Faza 0 — Keystone: bootstrap the RSI git substrate BEFORE the sidecar
/// spawns. The sidecar's `bootstrapOnce()` expects the git repo +
/// `PLAN.md` + `SandboxBounds` to already be on disk; without this the
/// sidecar would log a missing substrate and skip the `rsi_init` IPC
/// call (which is the documented ordering — see
/// `FeralAgent/src/rsi/mod.ts`).
///
/// Bootstrap is idempotent: if the repo exists, `repo::bootstrap`
/// returns its current tip; if the bounds file exists,
/// `bootstrap_with_audit` would create a duplicate genesis row, so we
/// use `SandboxBounds::load` instead when the file is present.
///
/// On success we mirror the bounds + audit sha into `runtime.rsi_state`
/// so the very first `rsi_init` call from the UI is a no-op and the
/// subsequent `rsi_status` returns the right values immediately.
fn bootstrap_rsi_substrate(runtime: &Arc<RuntimeState>) {
    match rsi::repo::bootstrap() {
        Ok(plan_commit) => {
            tracing::info!(plan_commit = %plan_commit, "rsi: git substrate bootstrapped");
        }
        Err(e) => {
            tracing::error!(error = %e, "rsi: git substrate bootstrap failed");
        }
    }

    let audit_path = paths::rsi_sandbox_bounds_audit_path();
    match SandboxBoundsAudit::open(&audit_path) {
        Ok(audit) => {
            let bounds_result = if paths::rsi_sandbox_bounds_path().exists() {
                SandboxBounds::load()
            } else {
                SandboxBounds::bootstrap_with_audit(&audit)
            };
            match bounds_result {
                Ok(bounds) => {
                    let sha = bounds.file_sha256().ok();
                    tracing::info!(
                        version = bounds.version,
                        bounds_sha256 = sha.as_deref().unwrap_or("?"),
                        "rsi: sandbox_bounds ready",
                    );
                    // Mirror the boot state into RuntimeState so the first
                    // rsi_init call from the UI is a no-op.
                    *runtime.rsi_state.bounds.lock() = Some(bounds);
                    *runtime.rsi_state.bounds_file_sha256.lock() = sha;
                    *runtime.rsi_state.initialized.lock() = true;
                }
                Err(e) => {
                    tracing::error!(error = %e, "rsi: sandbox_bounds bootstrap failed");
                }
            }
        }
        Err(e) => {
            tracing::error!(error = %e, "rsi: audit log open failed");
        }
    }
}

/// Push the persisted settings to env vars the Feral Agent sidecar reads.
/// Order matters: every export happens BEFORE the supervisor's first
/// spawn so the child inherits the env on its very first read.
fn export_settings_env(settings: &Settings) {
    // Desktop control opt-in (persisted in Settings) → export the env
    // BEFORE the sidecar spawns so `feral_agent::spawn` forwards it and
    // the sidecar registers `control_app`. Same flag opens the Rust
    // command gate (`desktop_control.rs` reads it per request). Off by
    // default; the Settings toggle flips this and restarts the sidecar.
    if settings.desktop_control_enabled {
        std::env::set_var("FERAL_ENABLE_DESKTOP_CONTROL", "true");
    }
    // YOLO mode (no per-action confirmation) is read by the sidecar, so
    // export it before spawn too. Safe mode (default) leaves it unset.
    if settings.desktop_control_yolo {
        std::env::set_var("FERAL_DESKTOP_CONTROL_CONFIRM", "false");
    }
    // Token budget: always set the env so the sidecar picks it up.
    // None = unlimited (Infinity); Some(n) = hard cap at n tokens.
    match settings.token_budget_conversation {
        Some(n) => std::env::set_var("FERAL_BUDGET_CONVERSATION", n.to_string()),
        None => std::env::set_var("FERAL_BUDGET_CONVERSATION", "Infinity"),
    }
    // RSI background spend cap. Some(0.0)/default = local-only;
    // Some(n) = allow $n cloud spend; None = no cap (remove the var).
    match settings.rsi_max_cost_usd {
        Some(n) => std::env::set_var("FERAL_RSI_MAX_COST_USD", format!("{n}")),
        None => std::env::remove_var("FERAL_RSI_MAX_COST_USD"),
    }
}

/// Spawn the OpenAI-compatible API server on `runtime.settings.api_port`.
/// Forced on by `build_settings()` when the sidecar needs it; user-toggle
/// on hosts that don't run a sidecar at all.
fn spawn_api_server_if_enabled(runtime: &Arc<RuntimeState>) {
    if !runtime.settings.api_server_enabled {
        return;
    }
    let api_state = api::ApiState {
        manager: runtime.manager.clone(),
        token: runtime.local_api_token.clone(),
    };
    let port = runtime.settings.api_port;
    tokio::spawn(async move {
        if let Err(e) = api::serve(api_state, port).await {
            tracing::error!(?e, "api server stopped");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `build_runtime` must produce a runtime where `api_server_enabled`
    /// is forced on — the sidecar assumes the local API is up. Settings
    /// that explicitly disable it should still get flipped. Regression
    /// guard for the R4 fix.
    #[test]
    fn build_runtime_forces_api_server_enabled() {
        // We can't actually build a full runtime in the unit test env
        // (would touch the user's `~/.feral/`), so we just verify the
        // helper that build_runtime delegates to. If a future refactor
        // skips the override, this test will need a fs redactor.
        let settings = build_settings();
        assert!(settings.api_server_enabled,
            "build_runtime must force api_server_enabled on — \
             the Feral Agent sidecar hardcodes FERAL_BASE_URL=127.0.0.1:api_port");
    }
}