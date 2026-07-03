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

use std::io::IsTerminal;
use std::sync::Arc;

use clap::{CommandFactory, Parser, Subcommand};

mod admin;
mod chat;
mod common;

/// Feral — your local AI runtime, headless. One brain, many faces: the same
/// memory, LoRA, dreams and tools as the desktop app, reachable over a small
/// loopback API and from this terminal.
#[derive(Parser)]
#[command(name = "feral", version, about, long_about = None)]
struct Cli {
    /// Machine-readable JSON output (where it applies).
    #[arg(long, global = true)]
    json: bool,
    /// Disable colored output.
    #[arg(long, global = true)]
    no_color: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run or manage the background gateway (no subcommand = run in foreground)
    Gateway {
        #[command(subcommand)]
        action: Option<GatewayAction>,
    },
    /// Show gateway + model status (alias for `gateway status`)
    Status,
    /// Interactive chat in the terminal
    Chat,
    /// Interactive chat in the terminal (alias for `chat`)
    Tui,
    /// Diagnose the install (port, token, model, sidecar, GPU, connectors)
    Doctor,
    /// Print the gateway log (`-f` to follow)
    Logs {
        #[arg(short, long)]
        follow: bool,
    },
    /// List installed models
    Model,
    /// Inspect or reload connectors (Discord/Slack/…)
    Connectors {
        #[command(subcommand)]
        action: Option<ConnectorsAction>,
    },
    /// Watch the Dream Cycle live
    Dreams,
    /// Read or write settings.json
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Generate a shell completion script
    Completion {
        /// bash | zsh | fish | powershell | elvish
        shell: clap_complete::Shell,
    },
}

#[derive(Subcommand)]
enum GatewayAction {
    /// Start the gateway in the background
    Start,
    /// Stop a running gateway (graceful drain)
    Stop,
    /// Restart the gateway
    Restart,
    /// Show gateway + model status
    Status,
}

#[derive(Subcommand)]
enum ConnectorsAction {
    /// List configured connectors (default)
    List,
    /// Reload connectors.json into a running gateway
    Reload,
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Print settings.json, or one key
    Get { key: Option<String> },
    /// Set a top-level key (value parsed as JSON when possible)
    Set { key: String, value: String },
}

fn main() {
    let cli = Cli::parse();

    // Global output modes. Color auto-disables when piped (not a TTY) or when
    // NO_COLOR is set — the standard convention — and `--no-color` forces it.
    common::init_json(cli.json);
    let color = !cli.no_color
        && !cli.json
        && std::env::var_os("NO_COLOR").is_none()
        && std::io::stdout().is_terminal();
    common::init_color(color);

    let code: i32 = match cli.command {
        None => {
            let _ = Cli::command().print_help();
            println!();
            2
        }
        Some(Command::Gateway { action }) => match action {
            None => run_gateway(), // foreground; returns its exit code
            Some(GatewayAction::Start) => admin::gateway_start(),
            Some(GatewayAction::Stop) => admin::gateway_stop(),
            Some(GatewayAction::Restart) => admin::gateway_restart(),
            Some(GatewayAction::Status) => admin::gateway_status(),
        },
        Some(Command::Status) => admin::gateway_status(),
        Some(Command::Chat) | Some(Command::Tui) => chat::run(), // never returns
        Some(Command::Doctor) => admin::doctor(),
        Some(Command::Logs { follow }) => admin::logs(follow),
        Some(Command::Model) => admin::model_list(),
        Some(Command::Connectors { action }) => match action {
            None | Some(ConnectorsAction::List) => admin::connectors_list(),
            Some(ConnectorsAction::Reload) => admin::connectors_reload(),
        },
        Some(Command::Dreams) => admin::dreams(),
        Some(Command::Config { action }) => match action {
            ConfigAction::Get { key } => admin::config_get(key.as_deref()),
            ConfigAction::Set { key, value } => admin::config_set(&key, &value),
        },
        Some(Command::Completion { shell }) => {
            let mut cmd = Cli::command();
            clap_complete::generate(shell, &mut cmd, "feral", &mut std::io::stdout());
            0
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

    /// clap validates the whole command tree — conflicting args, bad flag
    /// definitions, duplicate names — in one assertion. Replaces the old
    /// hand-rolled USAGE-string regression guard.
    #[test]
    fn cli_tree_is_valid() {
        Cli::command().debug_assert();
    }
}