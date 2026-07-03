//! `RuntimeState` — the host-agnostic runtime shared by every Feral host
//! process (Faza 4.5 Slice 2). Everything here used to live only in the
//! Tauri desktop app's `AppState`; the fields that don't depend on Tauri
//! (`tauri::State`, `AppHandle`, …) moved here so a future headless host can
//! build the same runtime without pulling in Tauri at all.
//!
//! `src-tauri`'s `AppState` now composes this via `runtime: Arc<RuntimeState>`
//! plus a `Deref` impl, so existing `state.manager` / `state.rsi_state` call
//! sites across `src-tauri/src/lib.rs` keep compiling unchanged.

use std::sync::Arc;

use parking_lot::Mutex;

use crate::host::HostEvent;
use crate::inference::ModelManager;
use crate::rsi;
use crate::rsi::runtime::{GoodhartSlot, RsiEngineState, RsiRequestRegistry};
use crate::settings::Settings;

/// Why the next sidecar exit is expected. Whoever kills the child on
/// purpose sets this BEFORE `start_kill()`; the supervisor takes it on
/// exit and skips both the crash-failure accounting and the Faza 3
/// watchdog counter (a deliberate restart must never count toward
/// "≥2 deaths → revert the patch").
pub enum PlannedExit {
    /// Plain restart (e.g. `restart_sidecar` after an env toggle).
    Restart,
    /// Faza 3 Slice 2: a live-applied code patch wants to become the
    /// running agent. The supervisor rebuilds the sidecar from
    /// `repo_root` while the process is dead (Windows locks a running
    /// exe — this is the only safe moment to overwrite the binary),
    /// then respawns.
    Rebuild { repo_root: String },
    /// Faza 4.5 Slice 2 (D7): a clean shutdown. The supervisor emits
    /// `feral://agent-exit` with `restarting:false` and stops the loop
    /// instead of respawning. Used by `feral-cli` on Ctrl+C and by
    /// anything else that wants a one-shot, no-recovery exit.
    Shutdown,
}

impl PlannedExit {
    /// Convenience constructor for the `Shutdown` variant. Symmetric
    /// with the `feral_cli` shutdown path; keeps the call site readable.
    pub fn shutdown() -> Self {
        Self::Shutdown
    }
}

pub type PlannedExitSlot = Arc<Mutex<Option<PlannedExit>>>;

/// Host-agnostic runtime state: the model manager, settings, the local API
/// token, the Feral Agent sidecar handles, and the RSI substrate/engine
/// state. Held behind an `Arc` by whatever host process constructs it
/// (Tauri's `AppState` today; a headless host later).
pub struct RuntimeState {
    pub manager: Arc<ModelManager>,
    pub settings: Settings,
    /// Per-launch bearer token for the local HTTP API (V4). Generated at
    /// startup, handed to the API server and injected as the api key whenever
    /// the sidecar is pointed at the local engine, so the loopback API can
    /// require auth without breaking the in-app path.
    pub local_api_token: Arc<str>,
    /// Feral Agent sidecar process.
    pub feral_agent_process: Arc<Mutex<Option<tokio::process::Child>>>,
    /// Sender for writing JSON messages to the Feral Agent's stdin.
    /// Commands clone this to send messages without holding the lock during I/O.
    pub feral_agent_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<String>>>>,
    /// Faza 3: why the next sidecar exit is expected (deliberate restart
    /// or post-apply rebuild). Set before `start_kill()`; taken by the
    /// supervisor so planned exits never count as crashes toward the
    /// watchdog's revert threshold.
    pub feral_agent_planned_exit: PlannedExitSlot,
    /// RSI (Fractal Memory System) state. Holds the cached SandboxBounds
    /// and the initialised flag so every RSI command can answer "are
    /// we bootstrapped?" without a disk round-trip. Populated by
    /// `rsi_init`; consumed by every other rsi::* command.
    pub rsi_state: rsi::RsiState,
    /// Goodhart detector's rolling window. Kept as a separate field so
    /// it can be re-built lazily inside the command without contending
    /// on `rsi_state`.
    pub rsi_goodhart: GoodhartSlot,
    /// Engine status mirror. `None` until the sidecar emits its first
    /// engine event. Populated from the `rsi_engine_event` outbound
    /// events on stdout.
    pub rsi_engine: Arc<Mutex<Option<RsiEngineState>>>,
    /// In-flight ack registry for the 3 engine-driver commands
    /// (`rsi_start` / `rsi_stop` / `rsi_set_concurrency`). Each entry
    /// is a oneshot whose sender is fired by `feral_agent::stdout_reader`
    /// when the matching `rsi_engine_event` arrives on stdout, so the
    /// command can return success only after the sidecar has actually
    /// accepted the request. Cloned into `feral_agent::spawn` so the
    /// reader can ack without holding the RuntimeState mutex.
    pub rsi_request_registry: RsiRequestRegistry,
    /// Faza 4.5 Slice 3: the runtime's observability bus. Every host event
    /// (`HostEvents::emit`) that a broadcasting sink publishes lands here; the
    /// Public Runtime API `/events` SSE handler subscribes to replay them live.
    /// A `broadcast::Sender` is always present so any host can subscribe even
    /// before a sink is wired — subscribers just see nothing until events flow.
    pub events_tx: tokio::sync::broadcast::Sender<HostEvent>,
}

impl RuntimeState {
    pub fn new(manager: Arc<ModelManager>, settings: Settings, local_api_token: Arc<str>) -> Self {
        // ponytail: 512-event ring buffer. Enough to bridge a subscriber's
        // reconnect gap without unbounded memory; a lagging client drops the
        // oldest events (broadcast semantics), which is fine for observability.
        let (events_tx, _) = tokio::sync::broadcast::channel(512);
        Self {
            manager,
            settings,
            local_api_token,
            feral_agent_process: Arc::new(Mutex::new(None)),
            feral_agent_tx: Arc::new(Mutex::new(None)),
            feral_agent_planned_exit: Arc::new(Mutex::new(None)),
            rsi_state: rsi::RsiState::default(),
            rsi_goodhart: GoodhartSlot::default(),
            rsi_engine: Arc::new(Mutex::new(None)),
            rsi_request_registry: RsiRequestRegistry::default(),
            events_tx,
        }
    }
}
