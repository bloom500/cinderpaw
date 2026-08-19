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
mod providers_ui;
mod chat;
mod common;
mod guided;
mod install;
mod migrate;

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

// Declaration order = `feral --help` order (clap). Daily commands first,
// evolution/operator plumbing last, marked "(advanced)" — a first `--help`
// should read as a product, not a research tool (audit 2026-07-10 Part 2).
#[derive(Subcommand)]
enum Command {
    /// Interactive chat in the terminal
    Chat,
    /// Connect your AI: detects what you already have, verifies it with a
    /// real completion, and only then saves it (guided; --classic = wizard)
    #[command(alias = "onboard")]
    Setup {
        /// Use the full step-by-step wizard instead of the guided flow
        #[arg(long)]
        classic: bool,
        /// Skip the one-time security acknowledgement prompt
        #[arg(long)]
        accept_risk: bool,
    },
    /// Run or manage the background gateway (no subcommand = run in foreground)
    Gateway {
        #[command(subcommand)]
        action: Option<GatewayAction>,
    },
    /// Show gateway + model status (alias for `gateway status`)
    Status,
    /// Stop the running gateway (alias for `gateway stop`)
    Stop,
    /// Update Feral to the latest release, then restart the gateway
    Update,
    /// Remove Feral. Settings, memory, keys and models are KEPT unless --purge
    Uninstall {
        /// Also delete ~/.feral — settings, memory, API keys, models. Permanent.
        #[arg(long)]
        purge: bool,
        /// Skip the confirmation prompt (for scripts)
        #[arg(long, short = 'y')]
        yes: bool,
    },
    /// Bring an existing OpenClaw or Hermes Agent setup into Feral
    Migrate {
        /// Only consider this tool ("openclaw" or "hermes")
        #[arg(long)]
        from: Option<String>,
        /// Look here instead of the usual install locations
        #[arg(long)]
        source: Option<std::path::PathBuf>,
        /// Print the plan and exit without writing anything
        #[arg(long)]
        dry_run: bool,
        /// Skip the confirmation prompt
        #[arg(long, short = 'y')]
        yes: bool,
        /// Replace files that already exist in ~/.feral
        #[arg(long)]
        overwrite: bool,
    },
    /// Diagnose the install (port, token, model, sidecar, GPU, connectors)
    Doctor,
    /// List installed models
    Model,
    /// List AI providers, switch the active one, or store an API key
    #[command(alias = "provider")]
    Providers {
        #[command(subcommand)]
        action: Option<crate::admin::ProvidersAction>,
    },
    /// Inspect or reload connectors (Discord/Slack/…)
    #[command(alias = "channels")]
    Connectors {
        #[command(subcommand)]
        action: Option<ConnectorsAction>,
    },
    /// Watch the Dream Cycle live
    Dreams,
    /// Print the gateway log (`-f` to follow)
    Logs {
        #[arg(short, long)]
        follow: bool,
    },
    /// Read or write settings.json
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Interactive chat in the terminal (alias for `chat`)
    Tui,
    /// (advanced) Inspect or drive L6 Meta Evolution (the engine's own strategy)
    Meta {
        #[command(subcommand)]
        action: Option<MetaAction>,
    },
    /// (advanced) Slice A5 (L5 Governance) — drive the policy FSM end-to-end
    /// (status / propose / approve / freeze / verify …). Mirrors `meta …`
    /// for surface + JSON plumbing; operations live in `admin::governance`.
    Governance {
        #[command(subcommand)]
        action: admin::GovernanceAction,
    },
    /// (advanced) Phase B (L4 Architecture Evolution) — module candidates per
    /// seam: list / show / approve / reject / demote / evaluate / propose.
    /// Approval is the only path that promotes a module (spec §6).
    Modules {
        #[command(subcommand)]
        action: admin::ModulesAction,
    },
    /// (advanced) Faza 4 (L2 Personal Adaptation) — LoRA training on your own
    /// conversations: status / train / reviews / approve / reject. Needs a
    /// LOCAL primary model + a registered trainer (docs/LORA_TRAINER.md).
    Lora {
        #[command(subcommand)]
        action: admin::LoraAction,
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
    /// Configure a connector against a running gateway
    Set {
        /// Connector id (discord, slack, whatsapp, telegram)
        id: String,
        /// A secret field, KEY=VALUE (repeatable). E.g. --secret DISCORD_TOKEN=abc
        #[arg(long = "secret")]
        secrets: Vec<String>,
        /// Turn the connector on
        #[arg(long, conflicts_with = "disable")]
        enable: bool,
        /// Turn the connector off
        #[arg(long)]
        disable: bool,
        /// Allowed sender id (repeatable)
        #[arg(long = "allow")]
        allowlist: Vec<String>,
        /// Channel/chat id the agent answers without an @mention (repeatable)
        #[arg(long = "channel")]
        channels: Vec<String>,
        /// Multi-agent routing: run this connector as a DIFFERENT agent —
        /// full system prompt for its sessions ("" clears it)
        #[arg(long)]
        persona: Option<String>,
        /// Restrict the persona to these tools (repeatable; omit = full toolset)
        #[arg(long = "persona-tool")]
        persona_tools: Vec<String>,
    },
}

#[derive(Subcommand)]
enum MetaAction {
    /// Show the current MetaGenome, generation and live fitness (default)
    Status,
    /// Settle the pending candidate and propose the next one
    Evolve,
    /// Roll the pending candidate back to its baseline
    Rollback,
    /// Print the append-only generation history
    History,
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
            // OpenClaw parity: plain `feral` in a terminal opens the chat TUI
            // (like plain `openclaw`). Piped/non-TTY keeps help + exit 2 so
            // scripts that probe the binary don't hang on an interactive app.
            if std::io::stdin().is_terminal() && std::io::stdout().is_terminal() {
                chat::run() // never returns
            }
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
        Some(Command::Stop) => admin::gateway_stop(),
        Some(Command::Setup { classic, accept_risk }) => {
            if classic {
                admin::setup()
            } else {
                guided::run(accept_risk)
            }
        }
        Some(Command::Chat) | Some(Command::Tui) => chat::run(), // never returns
        // Both branch on how Feral was installed — npm, from source, or a
        // system package — because the answer is a different command each time
        // (see install.rs). The npm launcher still intercepts `update` before it
        // reaches this binary; every other install lands here.
        Some(Command::Update) => install::update(),
        Some(Command::Uninstall { purge, yes }) => install::uninstall(purge, yes),
        Some(Command::Migrate { from, source, dry_run, yes, overwrite }) => {
            migrate::run(from, source, dry_run, yes, overwrite)
        }
        Some(Command::Doctor) => admin::doctor(),
        Some(Command::Logs { follow }) => admin::logs(follow),
        Some(Command::Model) => admin::model_list(),
        Some(Command::Providers { action }) => match action {
            None => providers_ui::providers_pick(),
            Some(admin::ProvidersAction::List) => admin::providers_list(),
            Some(admin::ProvidersAction::Use { id, model }) => admin::providers_use(&id, model),
            Some(admin::ProvidersAction::SetKey { id, model, no_verify, activate }) => {
                admin::providers_set_key(&id, model, no_verify, activate)
            }
        },
        Some(Command::Connectors { action }) => match action {
            None | Some(ConnectorsAction::List) => admin::connectors_list(),
            Some(ConnectorsAction::Reload) => admin::connectors_reload(),
            Some(ConnectorsAction::Set { id, secrets, enable, disable, allowlist, channels, persona, persona_tools }) => {
                admin::connectors_set(&id, secrets, enable, disable, allowlist, channels, persona, persona_tools)
            }
        },
        Some(Command::Dreams) => admin::dreams(),
        Some(Command::Meta { action }) => match action {
            None | Some(MetaAction::Status) => admin::meta("meta_status"),
            Some(MetaAction::Evolve) => admin::meta("meta_evolve"),
            Some(MetaAction::Rollback) => admin::meta("meta_rollback"),
            Some(MetaAction::History) => admin::meta("meta_history"),
        },
        Some(Command::Config { action }) => match action {
            ConfigAction::Get { key } => admin::config_get(key.as_deref()),
            ConfigAction::Set { key, value } => admin::config_set(&key, &value),
        },
        Some(Command::Governance { action }) => admin::governance(action),
        Some(Command::Modules { action }) => admin::modules(action),
        Some(Command::Lora { action }) => admin::lora(action),
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
        // Desktop control, capabilities and admin are all desktop-host
        // features: the gateway has no window to drive, no skill catalogue to
        // vouch for and no updater. `None` makes each request answer "not
        // available here" instead of hanging, which is the shape the boot
        // signature exists to force. (This call had not been updated since
        // `capabilities` and `admin` were added, so the gateway binary did not
        // compile at all — caught by `scripts/verify.sh`, which is what it is
        // for.)
        feral_core::boot::start(runtime.clone(), events, None, None, None, Vec::new()).await;
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

    /// OpenClaw-parity aliases: `feral onboard` = setup, `feral channels` =
    /// connectors (their naming) — muscle-memory for switchers.
    #[test]
    fn parses_onboard_alias_as_setup() {
        let cli = Cli::try_parse_from(["feral", "onboard"]).unwrap();
        assert!(matches!(cli.command, Some(Command::Setup { classic: false, accept_risk: false })));
    }

    #[test]
    fn parses_channels_alias_as_connectors() {
        let cli = Cli::try_parse_from(["feral", "channels"]).unwrap();
        assert!(matches!(cli.command, Some(Command::Connectors { action: None })));
    }

    /// Slice A5 — parse the `feral governance …` subcommands exactly the way
    /// clap will see them on the command line. The variants live in
    /// `crate::admin::GovernanceAction` (mirrors `meta` CLI parsing for
    /// A6+). Each test also pins the variant discriminant so a future
    /// clap attribute change that would silently re-shape the parser
    /// fails CI.
    /// Phase B (L4) — pin the `feral modules …` parser shape.
    #[test]
    fn parses_modules_list() {
        let cli = Cli::try_parse_from(["feral", "modules", "list"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Modules { action: crate::admin::ModulesAction::List })
        ));
    }

    #[test]
    fn parses_modules_approve_with_note() {
        let cli =
            Cli::try_parse_from(["feral", "modules", "approve", "mod-x", "-m", "looks good"]).unwrap();
        match cli.command {
            Some(Command::Modules {
                action: crate::admin::ModulesAction::Approve { id, message },
            }) => {
                assert_eq!(id, "mod-x");
                assert_eq!(message.as_deref(), Some("looks good"));
            }
            other => panic!("wrong parse: {:?}", std::mem::discriminant(&other)),
        }
    }

    #[test]
    fn parses_modules_demote() {
        let cli = Cli::try_parse_from(["feral", "modules", "demote", "retrieval_strategy"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Modules { action: crate::admin::ModulesAction::Demote { .. } })
        ));
    }

    #[test]
    fn parses_modules_evaluate() {
        let cli = Cli::try_parse_from(["feral", "modules", "evaluate", "mod-x"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Modules { action: crate::admin::ModulesAction::Evaluate { .. } })
        ));
    }

    #[test]
    fn parses_governance_status() {
        let cli = Cli::try_parse_from(["feral", "governance", "status"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Governance { action: crate::admin::GovernanceAction::Status })
        ));
    }

    #[test]
    fn parses_governance_history() {
        let cli = Cli::try_parse_from(["feral", "governance", "history"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Governance { action: crate::admin::GovernanceAction::History })
        ));
    }

    #[test]
    fn parses_governance_proposals() {
        let cli = Cli::try_parse_from(["feral", "governance", "proposals"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Governance { action: crate::admin::GovernanceAction::Proposals })
        ));
    }

    #[test]
    fn parses_governance_verify() {
        let cli = Cli::try_parse_from(["feral", "governance", "verify"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Governance { action: crate::admin::GovernanceAction::Verify })
        ));
    }

    #[test]
    fn parses_governance_propose_with_file() {
        let cli = Cli::try_parse_from([
            "feral", "governance", "propose", "/tmp/policy.json",
        ]).unwrap();
        if let Some(Command::Governance {
            action: crate::admin::GovernanceAction::Propose { file },
        }) = cli.command
        {
            assert_eq!(file.to_str(), Some("/tmp/policy.json"));
        } else {
            panic!("expected Governance::Propose");
        }
    }

    #[test]
    fn parses_governance_approve_id_only() {
        let cli = Cli::try_parse_from(["feral", "governance", "approve", "gp-3"]).unwrap();
        if let Some(Command::Governance {
            action: crate::admin::GovernanceAction::Approve { id },
        }) = cli.command
        {
            assert_eq!(id, "gp-3");
        } else {
            panic!("expected Governance::Approve");
        }
    }

    #[test]
    fn parses_governance_reject_with_reason() {
        let cli = Cli::try_parse_from([
            "feral", "governance", "reject", "gp-3", "-m", "gate too loose",
        ]).unwrap();
        if let Some(Command::Governance {
            action: crate::admin::GovernanceAction::Reject { id, message },
        }) = cli.command
        {
            assert_eq!(id, "gp-3");
            assert_eq!(message.as_deref(), Some("gate too loose"));
        } else {
            panic!("expected Governance::Reject");
        }
    }

    #[test]
    fn parses_governance_freeze_multiple_layers_with_message() {
        let cli = Cli::try_parse_from([
            "feral", "governance", "freeze", "l3", "l6", "-m", "audit pause",
        ]).unwrap();
        if let Some(Command::Governance {
            action: crate::admin::GovernanceAction::Freeze { layers, message },
        }) = cli.command
        {
            assert_eq!(layers, vec!["l3", "l6"]);
            assert_eq!(message.as_deref(), Some("audit pause"));
        } else {
            panic!("expected Governance::Freeze");
        }
    }

    #[test]
    fn parses_governance_unfreeze_layers() {
        let cli = Cli::try_parse_from(["feral", "governance", "unfreeze", "l4"]).unwrap();
        if let Some(Command::Governance {
            action: crate::admin::GovernanceAction::Unfreeze { layers, message },
        }) = cli.command
        {
            assert_eq!(layers, vec!["l4"]);
            assert!(message.is_none());
        } else {
            panic!("expected Governance::Unfreeze");
        }
    }

    #[test]
    fn parses_governance_rollback_no_args() {
        let cli = Cli::try_parse_from(["feral", "governance", "rollback"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Governance { action: crate::admin::GovernanceAction::Rollback })
        ));
    }
}