//! `RuntimeState` — the host-agnostic runtime shared by every Cinderpaw host
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
use serde::Serialize;

use crate::host::HostEvent;
use crate::inference::ModelManager;
use crate::rsi;
use crate::rsi::runtime::{GoodhartSlot, RsiEngineState, RsiRequestRegistry};
use crate::settings::Settings;
use std::collections::HashMap;

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
    /// `cinderpaw://agent-exit` with `restarting:false` and stops the loop
    /// instead of respawning. Used by `cinderpaw-cli` on Ctrl+C and by
    /// anything else that wants a one-shot, no-recovery exit.
    Shutdown,
}

impl PlannedExit {
    /// Convenience constructor for the `Shutdown` variant. Symmetric
    /// with the `cinderpaw_cli` shutdown path; keeps the call site readable.
    pub fn shutdown() -> Self {
        Self::Shutdown
    }
}

pub type PlannedExitSlot = Arc<Mutex<Option<PlannedExit>>>;

/// Host-agnostic runtime state: the model manager, settings, the local API
/// token, the Cinderpaw Agent sidecar handles, and the RSI substrate/engine
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
    /// Cinderpaw Agent sidecar process.
    pub cinderpaw_agent_process: Arc<Mutex<Option<tokio::process::Child>>>,
    /// Whether the sidecar has announced itself ready, right now.
    ///
    /// `cinderpaw://agent-ready` is emitted once, when the marker appears on the
    /// sidecar's stderr. An event is only received by whoever is already
    /// listening — so a frontend that finishes mounting a second later never
    /// learns it happened, waits forever, and shows "waking up" for the rest of
    /// the session. This is the same fact, held rather than announced, so a
    /// listener that arrived late can simply ask.
    pub agent_ready: Arc<std::sync::atomic::AtomicBool>,
    /// Sender for writing JSON messages to the Cinderpaw Agent's stdin.
    /// Commands clone this to send messages without holding the lock during I/O.
    pub cinderpaw_agent_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<String>>>>,
    /// Faza 3: why the next sidecar exit is expected (deliberate restart
    /// or post-apply rebuild). Set before `start_kill()`; taken by the
    /// supervisor so planned exits never count as crashes toward the
    /// watchdog's revert threshold.
    pub cinderpaw_agent_planned_exit: PlannedExitSlot,
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
    /// is a oneshot whose sender is fired by `cinderpaw_agent::stdout_reader`
    /// when the matching `rsi_engine_event` arrives on stdout, so the
    /// command can return success only after the sidecar has actually
    /// accepted the request. Cloned into `cinderpaw_agent::spawn` so the
    /// reader can ack without holding the RuntimeState mutex.
    pub rsi_request_registry: RsiRequestRegistry,
    /// The model the Cinderpaw Agent sidecar actually infers with — the local GGUF
    /// name, or a cloud model id (e.g. `MiniMax-M3`) when a BYOK provider is
    /// active. Set by `cinderpaw_agent::spawn`. Distinct from `manager.current()`,
    /// which only ever knows the *local* engine; for a cloud session that's
    /// `None` while this is the real answer. Reported by `/runtime/status`.
    pub active_agent_model: Arc<Mutex<Option<String>>>,
    /// Faza 4.5 Slice 4: a graceful-shutdown signal. `POST /runtime/shutdown`
    /// fires it; the headless gateway selects on it alongside Ctrl+C to run the
    /// D7 drain. Cross-platform, so `cinderpaw gateway stop` doesn't depend on
    /// Windows console signal groups (which don't reach a detached child). The
    /// desktop host builds this field but never awaits it — window close is its
    /// exit — so a stray POST there is a harmless no-op.
    pub shutdown: Arc<tokio::sync::Notify>,
    /// Faza 4.5 Slice 3: the runtime's observability bus. Every host event
    /// (`HostEvents::emit`) that a broadcasting sink publishes lands here; the
    /// Public Runtime API `/events` SSE handler subscribes to replay them live.
    /// A `broadcast::Sender` is always present so any host can subscribe even
    /// before a sink is wired — subscribers just see nothing until events flow.
    pub events_tx: tokio::sync::broadcast::Sender<HostEvent>,

    /// Sprint 2 / audit C-5 — in-flight model downloads keyed by
    /// download id (uuid v4). Each entry carries the latest progress the
    /// download task forwarded via its mpsc channel, plus the final
    /// status when it lands (`Ok`, `Failed`, `Cancelled`). The wizard's
    /// `W3a` step polls `/runtime/models/download/:id` for updates — no
    /// SSE needed on the TUI side, the gateway already streams via SSE
    /// on `/events` if a richer view is wanted later.
    pub model_downloads: Arc<Mutex<HashMap<String, ModelDownload>>>,
}

/// Snapshot of an in-flight model download. Surfaced by
/// `GET /runtime/models/download/:id`.
#[derive(Debug, Clone, Serialize)]
pub struct ModelDownload {
    pub id: String,
    pub repo_id: String,
    pub filename: String,
    /// 0.0 ..= 1.0. The download task emits per-percent updates; the
    /// gateway stores only the latest, so the client never sees a
    /// stale snapshot.
    pub progress: f32,
    /// One of `"downloading"`, `"complete"`, `"failed"`, `"cancelled"`.
    pub status: String,
    /// Populated when `status == "failed"`.
    pub error: Option<String>,
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
            cinderpaw_agent_process: Arc::new(Mutex::new(None)),
            agent_ready: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            cinderpaw_agent_tx: Arc::new(Mutex::new(None)),
            cinderpaw_agent_planned_exit: Arc::new(Mutex::new(None)),
            rsi_state: rsi::RsiState::default(),
            rsi_goodhart: GoodhartSlot::default(),
            rsi_engine: Arc::new(Mutex::new(None)),
            rsi_request_registry: RsiRequestRegistry::default(),
            active_agent_model: Arc::new(Mutex::new(None)),
            shutdown: Arc::new(tokio::sync::Notify::new()),
            model_downloads: Arc::new(Mutex::new(HashMap::new())),
            events_tx,
        }
    }
}
