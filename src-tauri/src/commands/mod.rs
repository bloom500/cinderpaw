//! Tauri command surface, split by domain (R7 — dispatch only, zero logic
//! changes). Each submodule holds a cohesive slice of the `#[tauri::command]`
//! functions that used to live directly in `lib.rs`; this file just wires
//! them back into scope so `lib.rs`'s `collect_commands!` invocation keeps
//! resolving every name unqualified, unchanged.

pub mod agents;
pub mod byok;
pub mod chat;
pub mod conversations;
pub mod cinderpaw;
pub mod files;
pub mod live;
pub mod livekit;
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
pub(crate) use cinderpaw::*;
pub(crate) use files::*;
pub(crate) use live::*;
pub(crate) use livekit::*;
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
    // 136 = + tts_providers + tts_has_key + speak_text + stop_speaking (voice
    // mode's outbound half — the streaming TTS bridge and its key check).
    // 138 = + tts_voice_present + download_tts_voice (on-device TTS).
    // 139 = + tts_ready ("can this engine actually speak", which differs per
    // engine: a key for hosted ones, a downloaded voice for Piper).
    // 140 = + ui_log (the webview's console cannot be read from the terminal, so
    // the voice loop had no way to report its own decisions).
    // 141 = + tts_voices (the vendor's voice catalogue — account state, so it is
    // asked for rather than hardcoded).
    // 144 = + start_live_call + send_live_audio + end_live_call (the Gemini Live
    // speech-to-speech engine — one session replacing the STT→LLM→TTS chain,
    // so these three are a call's whole surface: start, feed, hang up).
    // 146 = + send_live_text + live_voices (typing into a live call, and the
    // prebuilt voices it can be pinned to — the model's voice is the one thing
    // a spoken call must not re-roll per session).
    // 147 = + set_rsi_allow_cloud_dreams (let the dream cycle run on a paid
    // cloud model — off by default, and until now that default had no switch
    // and no explanation anywhere the user could see it).
    // 150 = - install_skill, + install_capability + inspect_capability
    // + install_skill_from_url + install_skill_from_file. One command that
    // took the file body, the metadata AND the trust label from its caller
    // becomes four that each name a SOURCE and let the host fetch it — the
    // split exists so the agent can ask for a capability without also being
    // the thing that vouches for where it came from.
    // 154 = + connector_accounts_list + connector_pair_start
    // + connector_pair_poll + connector_refresh_expired. Phase 3: an account
    // is a thing with a status and a lifetime, so listing, pairing, polling
    // and renewing are four different questions rather than one flag.
    const EXPECTED_COMMAND_COUNT: usize = 156;

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
