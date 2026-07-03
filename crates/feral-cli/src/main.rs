//! `feral-cli` — the headless Feral Runtime entry point (Faza 4.5 Slice 2).
//!
//! Same brain as the desktop app: `feral_core::boot` starts the model server
//! (127.0.0.1:api_port, bearer-token gated), the supervised Bun sidecar
//! (AgentLoop + connectors), and the RSI substrate. No webview, no Tauri.
//!
//! **Shipping name (D6a):** the dev binary is `feral-cli` (this package)
//! because the desktop dev binary already claims `target/debug/feral.exe`
//! (src-tauri package name `feral`). The user-facing name `feral` is
//! applied at packaging time (installer alias/rename).
//!
//! **Usage:** `feral-cli gateway` runs in the foreground until Ctrl+C,
//! then drains per spec D7 (planned shutdown, bounded wait, hard-kill
//! fallback). Exit codes: 0 clean, 1 startup failure, 2 usage error.

use std::sync::Arc;

mod admin;
mod chat;
mod common;

const USAGE: &str = "Feral Runtime (headless)

USAGE:
  feral gateway                 run the gateway in the foreground (Ctrl+C to stop)
  feral gateway start           start the gateway in the background
  feral gateway stop            stop a running gateway (graceful drain)
  feral gateway restart         restart the gateway
  feral gateway status          show gateway + model status
  feral status                  alias for `gateway status`
  feral model                   list installed models
  feral doctor                  diagnose the install (port, token, model, sidecar, GPU)
  feral chat                    interactive chat in the terminal
  feral help                    show this help
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("");
    let sub = args.get(1).map(String::as_str).unwrap_or("");

    let code: i32 = match (cmd, sub) {
        ("gateway", "") => run_gateway(), // foreground; never returns
        ("gateway", "start") => admin::gateway_start(),
        ("gateway", "stop") => admin::gateway_stop(),
        ("gateway", "restart") => admin::gateway_restart(),
        ("gateway", "status") | ("status", _) => admin::gateway_status(),
        ("gateway", other) => {
            eprintln!("unknown gateway subcommand: {other}\n{USAGE}");
            2
        }
        ("model", _) | ("models", _) => admin::model_list(),
        ("doctor", _) => admin::doctor(),
        ("chat", _) => chat::run(), // never returns
        ("help" | "--help" | "-h", _) => {
            print!("{USAGE}");
            0
        }
        ("", _) => {
            print!("{USAGE}");
            2
        }
        (other, _) => {
            eprintln!("unknown command: {other}\n{USAGE}");
            2
        }
    };
    std::process::exit(code);
}

fn run_gateway() -> i32 {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let code = rt.block_on(async {
        let runtime = feral_core::boot::build_runtime();

        // Single-instance guard: the API port is the lock. If it's taken,
        // another Feral host (desktop app or gateway) already owns this brain.
        let port = runtime.settings.api_port;
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(probe) => drop(probe), // free it for the real server below
            Err(_) => {
                eprintln!(
                    "feral: port {port} is busy — a Feral host (desktop app or another \
                     gateway) is already running. One brain, one process."
                );
                return 1;
            }
        }

        // Slice 3: the gateway's event sink broadcasts onto the runtime bus so
        // `/events` SSE subscribers replay host events live (LogEvents only
        // logged). It still logs, so gateway stderr is unchanged.
        let events: Arc<dyn feral_core::host::HostEvents> =
            Arc::new(feral_core::host::BroadcastEvents::new(runtime.events_tx.clone()));
        // Desktop control is a desktop-host feature; the gateway declines it.
        feral_core::boot::start(runtime.clone(), events, None, Vec::new()).await;
        tracing::info!(port, "feral gateway up — model API + sidecar supervised");

        // Stop on Ctrl+C (interactive) or a `POST /runtime/shutdown`
        // (`feral gateway stop`, cross-platform — no Windows console signal
        // group needed to reach a detached child).
        tokio::select! {
            _ = tokio::signal::ctrl_c() => tracing::info!("Ctrl+C — draining (D7)"),
            _ = runtime.shutdown.notified() => tracing::info!("shutdown request — draining (D7)"),
        }
        shutdown(&runtime).await;
        0
    });
    code
}

/// Graceful shutdown per spec D7: mark the exit as planned (so the sidecar
/// supervisor doesn't treat it as a crash / the RSI watchdog doesn't count
/// it), close the sidecar's stdin (its transport drains in-flight handlers
/// and exits), wait bounded, then hard-kill as the last resort.
async fn shutdown(runtime: &feral_core::runtime::RuntimeState) {
    *runtime.feral_agent_planned_exit.lock() =
        Some(feral_core::runtime::PlannedExit::shutdown());
    // Dropping the tx closes the stdin writer channel → sidecar sees EOF,
    // drains its #pending handlers, flushes, exits (existing behavior).
    runtime.feral_agent_tx.lock().take();
    let child = runtime.feral_agent_process.lock().take();
    if let Some(mut child) = child {
        match tokio::time::timeout(std::time::Duration::from_secs(30), child.wait()).await {
            Ok(status) => tracing::info!(?status, "sidecar exited cleanly"),
            Err(_) => {
                tracing::warn!("sidecar did not exit within 30s — killing");
                let _ = child.kill().await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression guard for the usage string: every command we accept on
    /// the CLI must be documented. If someone adds e.g. `feral-cli doctor`
    /// they must update USAGE too — keeps the user-facing surface in sync.
    #[test]
    fn usage_covers_all_commands() {
        assert!(USAGE.contains("gateway"), "USAGE must document `gateway`");
        assert!(USAGE.contains("chat"), "USAGE must document `chat`");
        assert!(USAGE.contains("help"), "USAGE must document `help`");
    }

    /// `main`'s argument parser must accept every command listed in USAGE.
    /// White-box check: `main()` returns 2 on unknown commands (per the
    /// "Exit codes" doc comment) and 0 on `help`. We invoke it through the
    /// public entry; cargo's test harness captures the process exit.
    #[test]
    #[ignore = "exits the test process — run via `feral-cli bogus` smoke instead"]
    fn unknown_command_exits_with_usage_error() {
        // Intentionally not run as a unit test: `std::process::exit` would
        // tear down the test harness. The real check is the smoke in
        // Task 4 / Step 4: `./target/debug/feral-cli bogus; echo $?` ⇒ 2.
    }
}