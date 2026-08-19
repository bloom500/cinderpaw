//! Where connector credentials live. One vault entry per (connector, field),
//! addressed by a `secret_ref` string that accounts and configs may carry
//! freely — it is a name, not a value.

pub const CONNECTOR_SERVICE: &str = "ai.bloom.feral.connectors";

pub fn secret_ref(connector_id: &str, field_key: &str) -> String {
    format!("connector:{connector_id}:{field_key}")
}

pub fn put(connector_id: &str, field_key: &str, value: &str) -> anyhow::Result<()> {
    crate::secret_store::set(CONNECTOR_SERVICE, &entry_of(connector_id, field_key), value)
}

pub fn read(secret_ref: &str) -> Option<String> {
    let entry = secret_ref.strip_prefix("connector:")?;
    crate::secret_store::get(CONNECTOR_SERVICE, entry)
}

pub fn forget(connector_id: &str, field_key: &str) -> anyhow::Result<()> {
    crate::secret_store::clear(CONNECTOR_SERVICE, &entry_of(connector_id, field_key))
}

fn entry_of(connector_id: &str, field_key: &str) -> String {
    format!("{connector_id}:{field_key}")
}

// ---------------------------------------------------------------------------
// Plaintext → vault migration (Task 3, connector-accounts).
//
// Existing installs have connector secrets sitting in plaintext inside
// `~/.feral/connectors.json`. This moves them into the vault on startup,
// with no user interaction, and without ever losing a credential — including
// when the process is killed mid-migration.
// ---------------------------------------------------------------------------

/// Abstraction over the vault (Task 2's `put`/`read`) so migration steps can
/// be tested with an injectable failure at each one.
pub trait Vault {
    fn put(&self, connector_id: &str, field_key: &str, value: &str) -> anyhow::Result<()>;
    fn read(&self, secret_ref: &str) -> Option<String>;
}

/// Abstraction over `connectors::{load_connector_configs, save_connector_configs}`
/// so a failed disk write can be injected in a test.
pub trait ConfigIo {
    fn load(&self) -> Vec<crate::connectors::ConnectorConfig>;
    fn save(&self, connectors: &[crate::connectors::ConnectorConfig]) -> Result<(), String>;
}

/// Production `Vault` — Task 2's real `put`/`read`.
pub struct RealVault;
impl Vault for RealVault {
    fn put(&self, connector_id: &str, field_key: &str, value: &str) -> anyhow::Result<()> {
        put(connector_id, field_key, value)
    }
    fn read(&self, secret_ref: &str) -> Option<String> {
        read(secret_ref)
    }
}

/// Production `ConfigIo` — the real `connectors.json` on disk.
pub struct RealConfigIo;
impl ConfigIo for RealConfigIo {
    fn load(&self) -> Vec<crate::connectors::ConnectorConfig> {
        crate::connectors::load_connector_configs()
    }
    fn save(&self, connectors: &[crate::connectors::ConnectorConfig]) -> Result<(), String> {
        crate::connectors::save_connector_configs(connectors)
    }
}

/// Outcome of a migration pass. Connector ids only — never secret values.
#[derive(Debug, Default)]
pub struct MigrationReport {
    /// Connector ids whose secrets were fully moved into the vault and
    /// stripped from the config.
    pub moved: Vec<String>,
    /// (connector id, field key) pairs that could not be verified in the
    /// vault and were therefore left untouched in the config.
    pub left_in_place: Vec<(String, String)>,
}

/// Move plaintext connector secrets into the vault.
///
/// The order IS the recovery story: the config is only rewritten once the
/// vault copy has been read back successfully, so a process killed anywhere
/// in here leaves the credential readable from at least one place, and the
/// next run repeats the same steps to completion.
///
/// Nothing here logs a secret value. Connector ids and outcomes only.
pub fn migrate_plaintext_secrets(vault: &dyn Vault, io: &dyn ConfigIo) -> MigrationReport {
    let mut report = MigrationReport::default();
    let mut rows = io.load();
    let mut dirty = false;

    for row in &mut rows {
        if row.secrets.is_empty() {
            continue;
        }
        let mut verified: Vec<String> = Vec::new();
        for (field, value) in row.secrets.clone() {
            // 1-2. write
            if let Err(e) = vault.put(&row.id, &field, &value) {
                tracing::warn!(connector = %row.id, field = %field, error = %e,
                    "connector secret migration: vault write failed; leaving it in the config");
                report.left_in_place.push((row.id.clone(), field));
                continue;
            }
            // 3. verify — a write we cannot read back is not a migration
            match vault.read(&secret_ref(&row.id, &field)) {
                Some(v) if v == value => verified.push(field),
                _ => {
                    tracing::warn!(connector = %row.id, field = %field,
                        "connector secret migration: vault could not read the value back; \
                         leaving it in the config");
                    report.left_in_place.push((row.id.clone(), field));
                }
            }
        }
        if !verified.is_empty() {
            for field in &verified {
                row.secrets.remove(field);
            }
            dirty = true;
            report.moved.push(row.id.clone());
        }
    }

    if dirty {
        // 4. atomic rewrite (save_connector_configs writes temp + rename)
        if let Err(e) = io.save(&rows) {
            tracing::warn!(error = %e,
                "connector secret migration: config rewrite failed; secrets remain in both places \
                 and the next start will retry");
            report.moved.clear();
            return report;
        }
        // 5. verify nothing is left behind
        for row in io.load() {
            if !row.secrets.is_empty() {
                tracing::warn!(connector = %row.id,
                    "connector secret migration: config still holds secrets after rewrite");
            }
        }
    }
    report
}

/// Run the migration against the real vault and the real `connectors.json`.
/// Called once at startup, before connectors are read for use. No user
/// interaction; failures are logged (connector ids only) and retried on the
/// next start.
pub fn migrate_plaintext_secrets_at_startup() -> MigrationReport {
    migrate_plaintext_secrets(&RealVault, &RealConfigIo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_ref_format_is_stable() {
        assert_eq!(secret_ref("matrix", "MATRIX_TOKEN"), "connector:matrix:MATRIX_TOKEN");
    }

    #[test]
    fn read_returns_none_for_empty_string() {
        assert_eq!(read(""), None);
    }

    #[test]
    fn read_returns_none_for_wrong_prefix() {
        assert_eq!(read("wrong:matrix:TOKEN"), None);
    }

    #[test]
    fn read_returns_none_for_missing_field_segment() {
        assert_eq!(read("connector:matrix"), None);
    }

    #[test]
    fn put_and_read_with_colon_in_ids() {
        if put("test:conn", "TEST:TOKEN", "s3cret").is_err() {
            eprintln!("no secret backend available; skipping");
            return;
        }
        let r = secret_ref("test:conn", "TEST:TOKEN");
        assert_eq!(read(&r).as_deref(), Some("s3cret"));
        forget("test:conn", "TEST:TOKEN").expect("forget");
        assert_eq!(read(&r), None);
    }

    #[test]
    fn a_ref_from_put_reads_back_the_value() {
        if put("test-conn", "TEST_TOKEN", "s3cret").is_err() {
            eprintln!("no secret backend available; skipping");
            return;
        }
        let r = secret_ref("test-conn", "TEST_TOKEN");
        assert_eq!(read(&r).as_deref(), Some("s3cret"));
        forget("test-conn", "TEST_TOKEN").expect("forget");
        assert_eq!(read(&r), None);
    }
}
