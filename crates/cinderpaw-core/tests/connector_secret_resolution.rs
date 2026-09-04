//! The migration takes secrets OUT of `connectors.json`. Something has to put
//! them back on the way to the process that actually holds the connections.
//!
//! Without this, the first start after migrating would bring every connector
//! on the machine up with an empty credential — a security improvement that
//! quietly switches the product off.
//!
//! The vault is injected here on purpose. It is the OS keychain: shared with
//! whatever the person running the tests has actually paired, so a test that
//! called the real one would pass or fail depending on whose machine it ran
//! on. What is pinned is the folding, which is where the rules are.

use cinderpaw_core::connectors::{blank_connector_config, resolve_secrets_into, ConnectorConfig};
use std::collections::HashMap;

fn vault(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn resolve(rows: &mut [ConnectorConfig], stored: HashMap<String, String>) {
    resolve_secrets_into(rows, &move |reference| stored.get(reference).cloned());
}

#[test]
fn a_migrated_row_gets_its_credential_back_from_the_vault() {
    let mut discord = blank_connector_config("discord");
    discord.enabled = true; // secrets map is empty — the migration took it
    let mut rows = vec![discord];

    resolve(&mut rows, vault(&[("connector:discord:DISCORD_TOKEN", "from-vault")]));

    assert_eq!(rows[0].secrets.get("DISCORD_TOKEN").map(String::as_str), Some("from-vault"));
}

#[test]
fn a_row_that_still_holds_its_own_value_is_left_alone() {
    // An install mid-migration must behave exactly as it did before.
    let mut discord = blank_connector_config("discord");
    discord.secrets.insert("DISCORD_TOKEN".into(), "plain".into());
    let mut rows = vec![discord];

    resolve(&mut rows, vault(&[("connector:discord:DISCORD_TOKEN", "from-vault")]));

    assert_eq!(rows[0].secrets.get("DISCORD_TOKEN").map(String::as_str), Some("plain"));
}

#[test]
fn an_empty_vault_does_not_invent_a_value() {
    // "" and "missing" mean the same thing to a person and very different
    // things to a transport: one starts and fails at the provider with the
    // provider's words, the other refuses up front naming the key that is
    // missing. Only the second is useful.
    let mut discord = blank_connector_config("discord");
    let mut rows = vec![discord.clone()];
    resolve(&mut rows, vault(&[("connector:discord:DISCORD_TOKEN", "   ")]));
    assert!(!rows[0].secrets.contains_key("DISCORD_TOKEN"));

    discord = blank_connector_config("discord");
    let mut rows = vec![discord];
    resolve(&mut rows, HashMap::new());
    assert!(!rows[0].secrets.contains_key("DISCORD_TOKEN"));
}

#[test]
fn a_device_flow_connector_gets_credentials_it_never_had_a_form_for() {
    // Twitch has no pairing fields at all — the person types a code on the
    // provider's site. The tokens that come back still have to reach the
    // sidecar, so they are resolved by key rather than by form.
    let mut twitch = blank_connector_config("twitch");
    twitch.enabled = true;
    let mut rows = vec![twitch];

    resolve(
        &mut rows,
        vault(&[
            ("connector:twitch:OAUTH_ACCESS", "acc"),
            ("connector:twitch:OAUTH_REFRESH", "ref"),
        ]),
    );

    assert_eq!(rows[0].secrets.get("OAUTH_ACCESS").map(String::as_str), Some("acc"));
    assert_eq!(rows[0].secrets.get("OAUTH_REFRESH").map(String::as_str), Some("ref"));
}

#[test]
fn a_connector_the_catalog_has_never_heard_of_does_not_panic() {
    // A row left behind by an older build, or hand-edited. It gets the
    // credential keys every connector can have and nothing else.
    let mut unknown = blank_connector_config("something-else");
    unknown.enabled = true;
    let mut rows = vec![unknown];
    resolve(&mut rows, vault(&[("connector:something-else:OAUTH_ACCESS", "acc")]));
    assert_eq!(rows[0].secrets.get("OAUTH_ACCESS").map(String::as_str), Some("acc"));
}
