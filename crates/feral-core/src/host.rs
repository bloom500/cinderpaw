//! The host seam (spec D2, invariant 7: transports are replaceable).
//!
//! feral-core never talks to a UI directly. Anything that today reaches the
//! webview via `app.emit(event, payload)` will instead go through this trait:
//! the Tauri entry point forwards to the webview, the headless entry point
//! logs and publishes on the Public Runtime API `/events` SSE stream.
//! No consumers yet — Slice 2 wires `feral_agent.rs` through it.

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
