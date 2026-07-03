//! The host seam (spec D2, invariant 7: transports are replaceable).
//!
//! feral-core never talks to a UI directly. Anything that today reaches the
//! webview via `app.emit(event, payload)` will instead go through this trait:
//! the Tauri entry point forwards to the webview, the headless entry point
//! logs and publishes on the Public Runtime API `/events` SSE stream.
//! No consumers yet — Slice 2 wires `feral_agent.rs` through it.

use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::Value;

pub trait HostEvents: Send + Sync + 'static {
    /// Fire-and-forget host event, e.g. `emit("feral://agent-ready", json!({}))`.
    fn emit(&self, event: &str, payload: Value);
}

/// Headless default: every event becomes a tracing log line.
pub struct LogEvents;

impl HostEvents for LogEvents {
    fn emit(&self, event: &str, payload: Value) {
        tracing::info!(target: "host_events", %event, %payload, "event");
    }
}

/// Host-supplied closure that executes one `desktop_control_request` line
/// coming from the Feral Agent sidecar's stdout. The closure shape mirrors
/// `crate::desktop_control::handle_request(action, params) -> Result<Value, String>`
/// — the Tauri host injects its own implementation (which enforces all the
/// security gating). A headless host passes `None`, and `feral_agent`
/// responds to every desktop_control_request with
/// `ok:false, error:"desktop control not available in this host"` so the
/// sidecar's pending Promise never hangs.
pub type DesktopControlHandler = Arc<
    dyn Fn(String, Value) -> BoxFuture<'static, Result<Value, String>> + Send + Sync,
>;
