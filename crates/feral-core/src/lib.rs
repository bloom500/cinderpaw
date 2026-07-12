//! feral-core — the Feral Runtime, host-agnostic.
//!
//! Everything a Feral host process needs that does NOT depend on Tauri:
//! inference, model management, the local HTTP API, RSI substrate, settings,
//! paths. Consumed by two entry points: the Tauri desktop app (src-tauri)
//! and the headless `feral` binary (Faza 4.5 Slice 2).
//! Invariants: docs/runtime-invariants.md.

pub mod api;
pub mod boot;
pub mod byok;
pub mod connectors;
pub mod db_key;
pub mod feral_agent;
pub mod gpu_detect;
pub mod host;
pub mod inference;
pub mod models;
pub mod paths;
pub mod perf_policy;
pub mod rsi;
pub mod runtime;
pub mod settings;
pub mod setup;
pub mod sidecar_protocol;
pub mod sysinfo_mod;
pub mod tools;
pub mod transcription;
