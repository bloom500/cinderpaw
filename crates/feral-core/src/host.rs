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
use tokio::sync::broadcast;

pub trait HostEvents: Send + Sync + 'static {
    /// Fire-and-forget host event, e.g. `emit("feral://agent-ready", json!({}))`.
    fn emit(&self, event: &str, payload: Value);
}

/// One host event as it travels the runtime's observability bus. Cloned to
/// every `/events` SSE subscriber (Faza 4.5 Slice 3), so it must be `Clone`.
#[derive(Clone, Debug)]
pub struct HostEvent {
    pub event: String,
    pub payload: Value,
}

/// Headless default: every event becomes a tracing log line.
pub struct LogEvents;

impl HostEvents for LogEvents {
    fn emit(&self, event: &str, payload: Value) {
        tracing::info!(target: "host_events", %event, %payload, "event");
    }
}

/// Slice 3 headless sink: log the event (as `LogEvents` did) AND fan it out on
/// the runtime's broadcast bus so the Public Runtime API `/events` SSE stream
/// can replay it live. `send` erroring means zero subscribers right now — an
/// idle gateway with no `curl -N /events` attached — which is not a problem, so
/// the error is dropped.
///
/// ponytail: broadcast channel drops the oldest event for a subscriber that
/// lags past the channel capacity (see `RuntimeState::new`). Observability, not
/// a durable log — if a slow client misses events, it reconnects. Upgrade path
/// if that ever bites: per-subscriber buffering or an on-disk journal.
pub struct BroadcastEvents {
    tx: broadcast::Sender<HostEvent>,
}

impl BroadcastEvents {
    pub fn new(tx: broadcast::Sender<HostEvent>) -> Self {
        Self { tx }
    }
}

impl HostEvents for BroadcastEvents {
    fn emit(&self, event: &str, payload: Value) {
        tracing::info!(target: "host_events", %event, %payload, "event");
        let _ = self.tx.send(HostEvent {
            event: event.to_string(),
            payload,
        });
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The `/events` SSE path depends on `BroadcastEvents::emit` reaching a
    /// subscriber with the event name + payload intact. This is that contract.
    #[tokio::test]
    async fn broadcast_events_reach_subscriber() {
        let (tx, _) = broadcast::channel(8);
        let mut rx = tx.subscribe();
        let sink = BroadcastEvents::new(tx);

        sink.emit("feral://agent-output", json!({ "data": "hi" }));

        let ev = rx.recv().await.expect("subscriber should receive the event");
        assert_eq!(ev.event, "feral://agent-output");
        assert_eq!(ev.payload, json!({ "data": "hi" }));
    }

    /// Emitting with zero subscribers must not panic — an idle gateway has no
    /// `/events` client attached, and `send` returning `Err(NoSubscribers)` is
    /// the normal case, not a failure.
    #[test]
    fn broadcast_events_no_subscriber_is_ok() {
        let (tx, _) = broadcast::channel(8);
        let sink = BroadcastEvents::new(tx);
        sink.emit("feral://x", json!({})); // must not panic
    }
}
