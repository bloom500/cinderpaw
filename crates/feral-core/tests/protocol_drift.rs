// crates/feral-core/tests/protocol_drift.rs
//! R1: fails if FeralAgent/src/protocol.ts and
//! crates/feral-core/src/sidecar_protocol.rs name sets diverge.

use std::collections::HashSet;
use std::path::PathBuf;

fn extract_ts_array(source: &str, const_name: &str) -> HashSet<String> {
    let start = source
        .find(&format!("export const {const_name}"))
        .unwrap_or_else(|| panic!("{const_name} not found in protocol.ts"));
    let open = source[start..].find('[').unwrap() + start;
    let close = source[open..].find(']').unwrap() + open;
    let body = &source[open + 1..close];
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
        .join("../../FeralAgent/src/protocol.ts");
    let ts_source = std::fs::read_to_string(&ts_path)
        .unwrap_or_else(|e| panic!("read {ts_path:?}: {e}"));

    let ts_inbound = extract_ts_array(&ts_source, "INBOUND_TYPES");
    let ts_outbound = extract_ts_array(&ts_source, "OUTBOUND_TYPES");

    let rs_inbound: HashSet<String> = feral_core::sidecar_protocol::INBOUND_TYPES
        .iter().map(|s| s.to_string()).collect();
    let rs_outbound: HashSet<String> = feral_core::sidecar_protocol::OUTBOUND_TYPES
        .iter().map(|s| s.to_string()).collect();

    assert_eq!(ts_inbound, rs_inbound, "inbound type sets diverged");
    assert_eq!(ts_outbound, rs_outbound, "outbound type sets diverged");
}
