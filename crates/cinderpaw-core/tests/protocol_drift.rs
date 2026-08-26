// crates/cinderpaw-core/tests/protocol_drift.rs
//! R1: fails if CinderpawAgent/src/protocol.ts and
//! crates/cinderpaw-core/src/sidecar_protocol.rs name sets diverge.

use std::collections::HashSet;
use std::path::PathBuf;

fn extract_ts_array(source: &str, const_name: &str) -> HashSet<String> {
    let start = source
        .find(&format!("export const {const_name}"))
        .unwrap_or_else(|| panic!("{const_name} not found in protocol.ts"));
    let open = source[start..].find('[').unwrap() + start;
    let close = source[open..].find(']').unwrap() + open;
    let body = &source[open + 1..close];
    // Drop `//` comment tails before splitting. Without this a comment inside
    // the array parses as type names — its words become phantom entries and
    // the drift assertion fails for a reason that has nothing to do with
    // drift. Cost one confused debugging round on 2026-08-26.
    let body: String = body
        .lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n");
    body.split(',')
        .filter_map(|s| {
            let s = s.trim();
            let s = s.trim_start_matches('"').trim_end_matches('"');
            if s.is_empty() { None } else { Some(s.to_string()) }
        })
        .collect()
}

#[test]
fn inbound_and_outbound_types_match_ts() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let ts_path = PathBuf::from(&manifest_dir)
        .join("../../CinderpawAgent/src/protocol.ts");
    let ts_source = std::fs::read_to_string(&ts_path)
        .unwrap_or_else(|e| panic!("read {ts_path:?}: {e}"));

    let ts_inbound = extract_ts_array(&ts_source, "INBOUND_TYPES");
    let ts_outbound = extract_ts_array(&ts_source, "OUTBOUND_TYPES");

    let rs_inbound: HashSet<String> = cinderpaw_core::sidecar_protocol::INBOUND_TYPES
        .iter().map(|s| s.to_string()).collect();
    let rs_outbound: HashSet<String> = cinderpaw_core::sidecar_protocol::OUTBOUND_TYPES
        .iter().map(|s| s.to_string()).collect();

    assert_eq!(ts_inbound, rs_inbound, "inbound type sets diverged");
    assert_eq!(ts_outbound, rs_outbound, "outbound type sets diverged");
}

/// The ready handshake, checked across the language boundary.
///
/// Both sides already had a test. Both passed. Each compared its own constant
/// to itself, so when the rename moved the Rust marker to `cinderpaw-agent-ready`
/// and left `boot.ts` printing `feral-agent-ready`, nothing failed: the host
/// simply waited for a sentence the sidecar never says, `cinderpaw://agent-ready`
/// never fired, and the app stayed "waking up" forever. A test that reads the
/// OTHER language's source is the only kind that could have caught it.
#[test]
fn the_ready_marker_is_the_same_string_on_both_sides() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let boot_path = PathBuf::from(&manifest_dir).join("../../CinderpawAgent/src/boot.ts");
    let boot = std::fs::read_to_string(&boot_path)
        .unwrap_or_else(|e| panic!("read {boot_path:?}: {e}"));

    let decl = "const READY_MARKER = \"";
    let start = boot.find(decl).expect("READY_MARKER not declared in boot.ts") + decl.len();
    let end = start + boot[start..].find('"').expect("unterminated READY_MARKER literal");
    let ts_marker = &boot[start..end];

    assert_eq!(
        ts_marker,
        cinderpaw_core::cinderpaw_agent::READY_MARKER,
        "the sidecar prints a ready marker the host does not wait for — the app          will never leave its startup state",
    );
}
