//! Host-side RSI command layer. The substrate itself lives in
//! `cinderpaw_core::rsi` (re-exported below); only the Tauri command wrappers —
//! the sole write path into the substrate — remain here.
pub mod commands;
pub use cinderpaw_core::rsi::*;
