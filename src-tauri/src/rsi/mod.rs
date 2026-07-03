//! Host-side RSI command layer. The substrate itself lives in
//! `feral_core::rsi` (re-exported below); only the Tauri command wrappers —
//! the sole write path into the substrate — remain here.
pub mod commands;
pub use feral_core::rsi::*;
