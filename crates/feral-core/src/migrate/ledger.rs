//! Present keys minus consumed keys.
//!
//! Their config formats move and we do not control them. Correctness against a
//! moving target cannot be promised; honesty about what we did not understand
//! can be, and it is enough. Every importer marks the paths it used, and
//! whatever is left is printed under `Not imported`. A provider added on their
//! side becomes a visible line rather than a bot that quietly stops answering.

use std::collections::BTreeSet;

#[derive(Debug, Default)]
pub struct KeyLedger {
    present: BTreeSet<String>,
    consumed: BTreeSet<String>,
}

impl KeyLedger {
    pub fn from_value(value: &serde_json::Value) -> Self {
        let mut present = BTreeSet::new();
        walk(value, String::new(), &mut present);
        Self {
            present,
            consumed: BTreeSet::new(),
        }
    }

    /// Mark one leaf path as handled. Unknown paths are ignored: an importer
    /// that defensively consumes an optional key it did not find is correct.
    pub fn consume(&mut self, path: &str) {
        self.consumed.insert(path.to_string());
    }

    /// Mark a whole subtree as handled — `channels.discord` covers
    /// `channels.discord.botToken` and every sibling.
    pub fn consume_prefix(&mut self, prefix: &str) {
        let dotted = format!("{prefix}.");
        let hits: Vec<String> = self
            .present
            .iter()
            .filter(|p| p.as_str() == prefix || p.starts_with(&dotted))
            .cloned()
            .collect();
        self.consumed.extend(hits);
    }

    /// Everything present that nothing claimed, in stable order.
    pub fn leftovers(&self) -> Vec<String> {
        self.present.difference(&self.consumed).cloned().collect()
    }
}

/// Stand-in for "the document isn't shaped like key/value config at all"
/// (root parses to a scalar or array). Not a real JSON key, so it can't
/// collide with a genuine path — it only appears when `walk` is called with
/// an empty path on a non-object value, which happens once, at the root.
const ROOT_SENTINEL: &str = "<root>";

/// A literal `.` inside a key name would otherwise be indistinguishable from
/// our path separator — `{"my.webhook": ...}` and real nesting `my` →
/// `webhook` would produce the same joined string, and a `consume_prefix`
/// aimed at the false parent (`"my"`) would then swallow a key it never
/// named. Escaping keeps every real key name's dots from ever lining up with
/// a separator dot.
fn escape_key(key: &str) -> String {
    key.replace('.', "\\.")
}

/// Leaf paths only. An array is a leaf: descending into it would turn a
/// three-user allowlist into three lines of report noise, and nobody imports
/// `allowFrom[1]` independently of `allowFrom[0]`.
fn walk(value: &serde_json::Value, path: String, out: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::Object(map) if !map.is_empty() => {
            for (key, child) in map {
                let escaped = escape_key(key);
                let next = if path.is_empty() {
                    escaped
                } else {
                    format!("{path}.{escaped}")
                };
                walk(child, next, out);
            }
        }
        // Empty object. Nested (has a path), it's a leaf worth flagging —
        // e.g. `"settings": {}` is still something we did not understand.
        // At the root (no path), an empty object is truthfully empty config
        // and reporting nothing here is correct, not a lie.
        serde_json::Value::Object(_) => {
            if !path.is_empty() {
                out.insert(path);
            }
        }
        // Scalar, array, or null.
        _ => {
            if !path.is_empty() {
                out.insert(path);
            } else {
                // Root isn't object-shaped at all — nothing was understood,
                // but something is definitely there. Fail toward reporting.
                out.insert(ROOT_SENTINEL.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> serde_json::Value {
        json!({
            "channels": {
                "discord": { "enabled": true, "allowFrom": ["u1", "u2"] },
                "signal": { "enabled": true }
            },
            "timezone": "Europe/Bucharest"
        })
    }

    #[test]
    fn every_leaf_is_a_key_path_and_arrays_are_leaves() {
        let ledger = KeyLedger::from_value(&sample());
        let mut all = ledger.leftovers();
        all.sort();
        assert_eq!(
            all,
            vec![
                "channels.discord.allowFrom",
                "channels.discord.enabled",
                "channels.signal.enabled",
                "timezone",
            ]
        );
    }

    #[test]
    fn consumed_paths_drop_out_of_the_leftovers() {
        let mut ledger = KeyLedger::from_value(&sample());
        ledger.consume("channels.discord.enabled");
        ledger.consume("channels.discord.allowFrom");
        ledger.consume("timezone");
        assert_eq!(ledger.leftovers(), vec!["channels.signal.enabled"]);
    }

    #[test]
    fn consume_prefix_takes_a_whole_subtree() {
        let mut ledger = KeyLedger::from_value(&sample());
        ledger.consume_prefix("channels.discord");
        let mut rest = ledger.leftovers();
        rest.sort();
        assert_eq!(rest, vec!["channels.signal.enabled", "timezone"]);
    }

    #[test]
    fn consuming_a_path_that_is_not_there_is_harmless() {
        let mut ledger = KeyLedger::from_value(&sample());
        ledger.consume("channels.telegram.botToken");
        assert_eq!(ledger.leftovers().len(), 4);
    }

    #[test]
    fn a_new_key_on_their_side_shows_up_as_a_leftover() {
        // The regression this whole mechanism exists for: they add a provider,
        // every importer still passes, and the key must still be reported.
        let mut v = sample();
        v["channels"]["matrix"] = json!({ "accessToken": "x" });
        let mut ledger = KeyLedger::from_value(&v);
        ledger.consume_prefix("channels.discord");
        ledger.consume_prefix("channels.signal");
        ledger.consume("timezone");
        assert_eq!(ledger.leftovers(), vec!["channels.matrix.accessToken"]);
    }

    #[test]
    fn nested_empty_object_is_reported_but_top_level_empty_object_is_not() {
        // A nested empty object has no children to descend into, so it is
        // treated as a leaf and reported by its own path: safer to flag an
        // empty `"settings": {}` as "not imported" than to silently drop it.
        // The whole-config-is-empty case is different: there is no key name
        // to attach to the root, so it must not manufacture a bogus "" entry.
        let v = json!({ "settings": {}, "name": "x" });
        let ledger = KeyLedger::from_value(&v);
        let mut all = ledger.leftovers();
        all.sort();
        assert_eq!(all, vec!["name", "settings"]);

        let empty = KeyLedger::from_value(&json!({}));
        assert_eq!(empty.leftovers(), Vec::<String>::new());
    }

    #[test]
    fn a_dotted_key_name_is_not_swallowed_by_a_prefix_of_its_false_parent() {
        // "my" was never a namespace here — "my.webhook" is one literal key.
        // A prefix consume aimed at the false parent must not eat it.
        let v = json!({ "channels": { "my.webhook": { "enabled": true } } });
        let mut ledger = KeyLedger::from_value(&v);
        ledger.consume_prefix("channels.my");
        let leftovers = ledger.leftovers();
        assert_eq!(leftovers.len(), 1, "dotted key must still be reported: {leftovers:?}");

        // The exact path `leftovers()` reports round-trips through `consume`.
        let mut ledger2 = KeyLedger::from_value(&v);
        ledger2.consume(&leftovers[0]);
        assert!(ledger2.leftovers().is_empty());
    }

    #[test]
    fn a_non_object_root_is_reported_not_silently_swallowed() {
        // A malformed-but-parseable config (root is a scalar or array, not
        // an object) must not report as if everything were consumed.
        assert_eq!(KeyLedger::from_value(&json!(42)).leftovers().len(), 1);
        assert_eq!(KeyLedger::from_value(&json!(["a", "b"])).leftovers().len(), 1);
        assert_eq!(KeyLedger::from_value(&json!(null)).leftovers().len(), 1);
    }
}
