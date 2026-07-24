//! Tauri command surface, split by domain (R7 — dispatch only, zero logic
//! changes). Each submodule holds a cohesive slice of the `#[tauri::command]`
//! functions that used to live directly in `lib.rs`; this file just wires
//! them back into scope so `lib.rs`'s `collect_commands!` invocation keeps
//! resolving every name unqualified, unchanged.

pub mod agents;
pub mod byok;
pub mod chat;
pub mod conversations;
pub mod feral;
pub mod files;
pub mod models;
pub mod projects;
pub mod settings;
pub mod setup;
pub mod system;
pub mod voice;

pub(crate) use agents::*;
pub(crate) use byok::*;
pub(crate) use chat::*;
pub(crate) use conversations::*;
pub(crate) use feral::*;
pub(crate) use files::*;
pub(crate) use models::*;
pub(crate) use projects::*;
pub(crate) use settings::*;
pub(crate) use setup::*;
pub(crate) use system::*;
pub(crate) use voice::*;

#[cfg(test)]
mod command_count_test {
    /// R7: 128 entries in `collect_commands!` as of the pre-split baseline
    /// (Task 4 Step 1 inventory: 74 commands defined directly in `lib.rs`,
    /// now split across these submodules, plus 54 already-modularized
    /// commands referenced via qualified paths like `mcp::mcp_catalog`).
    /// Update this constant ONLY when a command is deliberately added or
    /// removed, and note the change in that PR's description.
    // 130 = 128 baseline + setup_detect + setup_verify (guided onboarding,
    // 2026-07-10).
    // 131 = + connectors::connectors_whatsapp_qr (GUI QR pairing, fe5b5b6).
    // That commit added the command without bumping this constant, so the test
    // has been failing on main ever since — CI does not run the src-tauri
    // suite, which is why it went unnoticed.
    // 132 = + feral_submit_feedback (thumbs 👍/👎 → RSI acceptance signal,
    // 9c1849f). Same story as fe5b5b6: added without bumping the baseline, so
    // the suite has been red since. CI still does not run it — until it does,
    // this constant only moves when someone runs `cargo test -p feral --lib`
    // by hand.
    const EXPECTED_COMMAND_COUNT: usize = 132;

    /// There is no runtime introspection API for `collect_commands!`
    /// contents, so this test reads `lib.rs`'s macro invocation and counts
    /// identifiers — mirrors `scripts/check-api-docs.mjs`'s drift-check
    /// pattern (B1).
    #[test]
    fn collect_commands_count_matches_baseline() {
        let lib_rs = include_str!("../lib.rs");
        let start = lib_rs.find("collect_commands![").expect("macro not found");
        let open = start + "collect_commands![".len();
        let close = lib_rs[open..].find(']').unwrap() + open;
        let body = &lib_rs[open..close];
        let count = body.split(',').filter(|s| !s.trim().is_empty()).count();
        assert_eq!(
            count, EXPECTED_COMMAND_COUNT,
            "collect_commands! count drifted — update EXPECTED_COMMAND_COUNT if intentional"
        );
    }
}
