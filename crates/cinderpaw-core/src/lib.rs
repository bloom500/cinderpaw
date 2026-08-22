//! cinderpaw-core — the Feral Runtime, host-agnostic.
//!
//! Everything a Cinderpaw host process needs that does NOT depend on Tauri:
//! inference, model management, the local HTTP API, RSI substrate, settings,
//! paths. Consumed by two entry points: the Tauri desktop app (src-tauri)
//! and the headless `feral` binary (Faza 4.5 Slice 2).
//! Invariants: docs/runtime-invariants.md.

pub mod api;
pub mod atomic_file;
pub mod boot;
pub mod brand;
pub mod env;
pub mod byok;
#[cfg(target_os = "linux")]
pub mod byok_file_store;
pub mod connectors;
pub mod connector_accounts;
pub mod connector_secrets;
pub mod db_key;
pub mod cinderpaw_agent;
pub mod gpu_detect;
pub mod host;
pub mod inference;
pub mod live;
pub mod livekit;
pub mod migrate;
pub mod migrate_home;
pub mod models;
pub mod oauth_device;
pub mod paths;
pub mod perf_policy;
pub mod rsi;
pub mod runtime;
pub mod secret_store;
pub mod settings;
pub mod tts;
pub mod setup;
pub mod sidecar_protocol;
pub mod sysinfo_mod;
pub mod toolchain;
pub mod tools;
pub mod utf8_stream;
pub mod transcription;
