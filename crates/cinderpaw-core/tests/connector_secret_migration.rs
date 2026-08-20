use cinderpaw_core::connector_secrets::{migrate_plaintext_secrets, ConfigIo, Vault};
use cinderpaw_core::connectors::{blank_connector_config, ConnectorConfig};
use std::cell::RefCell;
use std::collections::HashMap;

#[derive(Default)]
struct FakeVault {
    stored: RefCell<HashMap<String, String>>,
    /// Simulates a vault that accepts writes but cannot read them back.
    swallow_writes: bool,
}
impl Vault for FakeVault {
    fn put(&self, c: &str, f: &str, v: &str) -> anyhow::Result<()> {
        if !self.swallow_writes {
            self.stored.borrow_mut().insert(format!("connector:{c}:{f}"), v.to_string());
        }
        Ok(())
    }
    fn read(&self, r: &str) -> Option<String> { self.stored.borrow().get(r).cloned() }
}

struct FakeIo { rows: RefCell<Vec<ConnectorConfig>>, fail_save: bool }
impl ConfigIo for FakeIo {
    fn load(&self) -> Vec<ConnectorConfig> { self.rows.borrow().clone() }
    fn save(&self, c: &[ConnectorConfig]) -> Result<(), String> {
        if self.fail_save { return Err("disk full".into()); }
        *self.rows.borrow_mut() = c.to_vec();
        Ok(())
    }
}

fn discord_with_secret() -> ConnectorConfig {
    let mut cfg = blank_connector_config("discord");
    cfg.secrets.insert("DISCORD_TOKEN".into(), "tok-abc".into());
    cfg
}

#[test]
fn moves_the_secret_and_strips_it_from_the_config() {
    let vault = FakeVault::default();
    let io = FakeIo { rows: RefCell::new(vec![discord_with_secret()]), fail_save: false };

    let report = migrate_plaintext_secrets(&vault, &io);

    assert_eq!(report.moved, vec!["discord".to_string()]);
    assert_eq!(vault.read("connector:discord:DISCORD_TOKEN").as_deref(), Some("tok-abc"));
    assert!(io.load()[0].secrets.is_empty(), "config still holds the secret");
}

#[test]
fn a_vault_that_cannot_read_back_leaves_everything_alone() {
    // The credential must never be deleted on the strength of a write we
    // could not verify. Better a secret still on disk than no secret at all.
    let vault = FakeVault { swallow_writes: true, ..Default::default() };
    let io = FakeIo { rows: RefCell::new(vec![discord_with_secret()]), fail_save: false };

    let report = migrate_plaintext_secrets(&vault, &io);

    assert!(report.moved.is_empty());
    assert_eq!(report.left_in_place.len(), 1);
    assert_eq!(io.load()[0].secrets.get("DISCORD_TOKEN").map(String::as_str), Some("tok-abc"));
}

#[test]
fn a_failed_config_write_leaves_the_secret_in_both_places() {
    let vault = FakeVault::default();
    let io = FakeIo { rows: RefCell::new(vec![discord_with_secret()]), fail_save: true };

    migrate_plaintext_secrets(&vault, &io);

    assert_eq!(vault.read("connector:discord:DISCORD_TOKEN").as_deref(), Some("tok-abc"));
    assert_eq!(io.load()[0].secrets.get("DISCORD_TOKEN").map(String::as_str), Some("tok-abc"));
}

#[test]
fn running_it_again_after_a_crash_finishes_the_job() {
    // State after a crash between vault-write and config-rewrite: the secret
    // is in both places. The second run must complete, not double-write junk.
    let vault = FakeVault::default();
    vault.put("discord", "DISCORD_TOKEN", "tok-abc").unwrap();
    let io = FakeIo { rows: RefCell::new(vec![discord_with_secret()]), fail_save: false };

    let report = migrate_plaintext_secrets(&vault, &io);

    assert_eq!(report.moved, vec!["discord".to_string()]);
    assert!(io.load()[0].secrets.is_empty());
    assert_eq!(vault.read("connector:discord:DISCORD_TOKEN").as_deref(), Some("tok-abc"));
}

#[test]
fn a_config_with_no_secrets_is_not_rewritten() {
    let vault = FakeVault::default();
    let io = FakeIo { rows: RefCell::new(vec![blank_connector_config("discord")]), fail_save: true };
    // fail_save: true proves save was never called — it would have errored.
    let report = migrate_plaintext_secrets(&vault, &io);
    assert!(report.moved.is_empty());
    assert!(report.left_in_place.is_empty());
}

#[test]
fn no_log_line_contains_the_secret() {
    use tracing_subscriber::fmt::MakeWriter;
    // Capture every log emitted during a migration whose vault refuses reads,
    // which is the path with the most logging.
    let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    struct Grab(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for Grab {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf); Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    impl<'a> MakeWriter<'a> for Grab {
        type Writer = Grab;
        fn make_writer(&'a self) -> Grab { Grab(self.0.clone()) }
    }
    let sub = tracing_subscriber::fmt().with_writer(Grab(captured.clone())).finish();
    tracing::subscriber::with_default(sub, || {
        let vault = FakeVault { swallow_writes: true, ..Default::default() };
        let io = FakeIo { rows: RefCell::new(vec![discord_with_secret()]), fail_save: false };
        migrate_plaintext_secrets(&vault, &io);
    });
    let logs = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
    assert!(!logs.contains("tok-abc"), "a secret value reached the logs: {logs}");
}
