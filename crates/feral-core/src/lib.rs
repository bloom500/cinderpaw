//! feral-core — the Feral Runtime, host-agnostic.
//!
//! Everything a Feral host process needs that does NOT depend on Tauri:
//! inference, model management, the local HTTP API, RSI substrate, settings,
//! paths. Consumed by two entry points: the Tauri desktop app (src-tauri)
//! and the headless `feral` binary (Faza 4.5 Slice 2).
//! Invariants: docs/runtime-invariants.md.
