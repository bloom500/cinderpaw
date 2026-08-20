# Connector Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make adding a conversation-surface connector cost one descriptor entry plus, when the wire protocol is new, one transport module — never an edit to shared code.

**Architecture:** `feral-core` owns a single connector catalog (descriptors) and a single account model whose `status` is the truth about a connection; secrets move out of `connectors.json` into the storage BYOK already uses; the sidecar's `ConnectorManager` loses its three named connector fields in favour of a registry of `LiveConnector` implementations. OAuth arrives as one pairing method — the device authorization grant — modelled as a state machine the UI can read.

**Tech Stack:** Rust (`feral-core`, `src-tauri`, `keyring`, `serde`, `tokio`), TypeScript/Bun (`CinderpawAgent` sidecar), React + Zustand (`frontend-react`).

**Spec:** `docs/specs/2026-08-19-phase-3-connector-accounts.md` — read it before Task 1.

## Global Constraints

- **Pairing and transport are independent fields on the descriptor.** Never merge them into one enum.
- **An account carries `secret_ref`, never a secret value.** The value is read from the vault by the process that uses it, at the moment it uses it.
- **No log line at any level ever contains a secret value** — not truncated, not hashed, not "first four characters".
- **Migration order is: write vault → verify vault → atomically rewrite config → verify no secret remains.** A crash at any step must leave the credential recoverable and the next start must finish the job.
- **Adding a connector must not require modifying `ConnectorManager`.** Enforced by Task 8's test.
- **One catalog.** After Task 5, `src-tauri/src/connectors.rs` contains no connector list.
- **Existing connectors keep their behaviour exactly**: Discord, Slack and WhatsApp keep their pairing, personas, allowlists, channels, public mode and health reporting.
- **Never work on `main`.** Branch: `feat/connector-accounts`.
- **Run `./scripts/verify.sh` before declaring the plan done**, not after every task. Per-task test commands are given below.
- Conventional commits, one logical change per commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `crates/feral-core/src/secret_store.rs` | **New.** Keychain-with-file-fallback storage, parameterised by service + entry key. The logic currently inlined in `byok.rs`. |
| `crates/feral-core/src/byok.rs` | **Modified.** Delegates to `secret_store`; public API and on-disk behaviour unchanged. |
| `crates/feral-core/src/connector_secrets.rs` | **New.** Connector-scoped vault: `secret_ref` format, set/get/clear, and the plaintext migration. |
| `crates/feral-core/src/connectors.rs` | **Modified.** Descriptor gains `transport` + richer `PairingMethod`; config gains nothing; `secrets` becomes migration-only. |
| `crates/feral-core/src/connector_accounts.rs` | **New.** `ConnectorAccount`, `AccountStatus`, `AuthState`, persistence in `~/.feral/connector-accounts.json`. |
| `crates/feral-core/src/oauth_device.rs` | **New.** Device authorization grant: request, poll, refresh — as pure state transitions over an injected clock and HTTP client. |
| `src-tauri/src/connectors.rs` | **Modified.** Catalog list deleted; view types built from `feral-core` descriptors. Commands for the device flow. |
| `CinderpawAgent/src/transports/registry.ts` | **New.** `LiveConnector`, `ConnectorContext`, the factory registry. |
| `CinderpawAgent/src/transports/connectors.ts` | **Modified.** `ConnectorManager` holds `Map<id, LiveConnector>`; the three existing classes gain the interface. |
| `CinderpawAgent/src/transports/matrix.ts` | **New.** Matrix transport. |
| `CinderpawAgent/src/transports/mattermost.ts` | **New.** Mattermost transport. |
| `CinderpawAgent/src/transports/twitch.ts` | **New.** Twitch transport. |
| `frontend-react/src/components/connectors/AccountCard.tsx` | **New.** Renders status and the device-code instruction. |

---

## Stage A — Rust foundation

### Task 1: Generic secret store

**Files:**
- Create: `crates/feral-core/src/secret_store.rs`
- Modify: `crates/feral-core/src/lib.rs` (add `pub mod secret_store;`)
- Modify: `crates/feral-core/src/byok.rs:670-830` (delegate)
- Test: `crates/feral-core/src/secret_store.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Consumes: `keyring`, `crate::byok_file_store` (Linux only, already exists)
- Produces:
  - `pub fn set(service: &str, entry: &str, value: &str) -> anyhow::Result<()>`
  - `pub fn get(service: &str, entry: &str) -> Option<String>`
  - `pub fn clear(service: &str, entry: &str) -> anyhow::Result<()>`
  - `pub fn is_unavailable(err: &keyring::Error) -> bool`

Why first: `byok.rs` already contains keychain-with-fallback logic, written twice inside `byok_set` alone. Connectors need the same behaviour under a different service name. Copying it would be the third and fourth copy.

- [ ] **Step 1: Write the failing test**

```rust
// crates/feral-core/src/secret_store.rs
#[cfg(test)]
mod tests {
    use super::*;

    /// A round-trip through whatever backend this machine has. Skipped when
    /// the machine has neither a keychain nor (on Linux) a writable home —
    /// CI containers are exactly that, and a storage test that fails there
    /// teaches people to ignore red.
    #[test]
    fn set_then_get_returns_the_value() {
        let service = "ai.bloom.feral.test";
        let entry = "secret-store-roundtrip";
        if set(service, entry, "hunter2").is_err() {
            eprintln!("no secret backend available; skipping");
            return;
        }
        assert_eq!(get(service, entry).as_deref(), Some("hunter2"));
        clear(service, entry).expect("clear");
        assert_eq!(get(service, entry), None);
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cargo test -p feral-core secret_store`
Expected: FAIL — `secret_store` does not exist.

- [ ] **Step 3: Write the module**

```rust
//! Secret storage: OS keychain first, encrypted file store as the Linux
//! fallback. Extracted from `byok.rs`, which had this logic inline and
//! duplicated; connectors need the same behaviour under their own service
//! name, and a third copy is how two of them drift.

/// True when the failure is the kind that justifies the file fallback:
/// no Secret Service, no D-Bus session — a headless Linux box. Other
/// errors (`NoEntry`, `Invalid`, `TooLong`) are real problems and bubble up.
pub fn is_unavailable(err: &keyring::Error) -> bool {
    matches!(
        err,
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_)
    )
}

/// File-store key. Namespaced by service so two services can hold the same
/// entry name; `byok` keeps its historical un-namespaced keys (see `byok.rs`).
fn file_key(service: &str, entry: &str) -> String {
    format!("{service}:{entry}")
}

pub fn set(service: &str, entry: &str, value: &str) -> anyhow::Result<()> {
    match keyring::Entry::new(service, entry) {
        Ok(e) => match e.set_password(value) {
            Ok(()) => {
                #[cfg(target_os = "linux")]
                let _ = crate::byok_file_store::file_clear(&file_key(service, entry));
                Ok(())
            }
            Err(err) if is_unavailable(&err) => fallback_set(service, entry, value),
            Err(err) => Err(err.into()),
        },
        Err(err) if is_unavailable(&err) => fallback_set(service, entry, value),
        Err(err) => Err(err.into()),
    }
}

pub fn get(service: &str, entry: &str) -> Option<String> {
    match keyring::Entry::new(service, entry) {
        Ok(e) => match e.get_password() {
            Ok(v) => Some(v),
            Err(keyring::Error::NoEntry) => None,
            Err(err) if is_unavailable(&err) => fallback_get(service, entry),
            Err(_) => None,
        },
        Err(err) if is_unavailable(&err) => fallback_get(service, entry),
        Err(_) => None,
    }
}

pub fn clear(service: &str, entry: &str) -> anyhow::Result<()> {
    if let Ok(e) = keyring::Entry::new(service, entry) {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(err) if !is_unavailable(&err) => return Err(err.into()),
            Err(_) => {}
        }
    }
    #[cfg(target_os = "linux")]
    crate::byok_file_store::file_clear(&file_key(service, entry))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn fallback_set(service: &str, entry: &str, value: &str) -> anyhow::Result<()> {
    tracing::warn!(service, entry, "secret_store: keychain unavailable; using encrypted file store");
    crate::byok_file_store::file_set(&file_key(service, entry), value)
}

#[cfg(not(target_os = "linux"))]
fn fallback_set(_service: &str, _entry: &str, _value: &str) -> anyhow::Result<()> {
    Err(anyhow::anyhow!("keychain unavailable and the file fallback is Linux-only"))
}

#[cfg(target_os = "linux")]
fn fallback_get(service: &str, entry: &str) -> Option<String> {
    crate::byok_file_store::file_get(&file_key(service, entry))
}

#[cfg(not(target_os = "linux"))]
fn fallback_get(_service: &str, _entry: &str) -> Option<String> {
    None
}
```

Note the log line: service and entry name only. No value, ever.

- [ ] **Step 4: Make `byok` delegate without changing its behaviour**

In `byok.rs`, keep `KEYCHAIN_SERVICE`, `byok_set`, `byok_get`, `byok_delete` and the keychain probe exactly as public API. Replace their bodies with calls into `secret_store`, passing the **historical** file key so existing installs keep reading their keys:

```rust
// byok.rs — file keys stay un-namespaced for back-compat with ~/.feral/byok.keys
pub fn byok_set(provider_id: &str, key: &str) -> anyhow::Result<()> {
    crate::secret_store::set_with_file_key(KEYCHAIN_SERVICE, provider_id, provider_id, key)
}
```

Add that one extra entry point to `secret_store` (`set_with_file_key` / `get_with_file_key` / `clear_with_file_key`), with `set`/`get`/`clear` calling it with `file_key(service, entry)`. Existing `~/.feral/byok.keys` files keep working untouched.

- [ ] **Step 5: Run the existing BYOK tests plus the new one**

Run: `cargo test -p feral-core byok && cargo test -p feral-core secret_store`
Expected: PASS, no BYOK test edited.

- [ ] **Step 6: Commit**

```bash
git add crates/feral-core/src/secret_store.rs crates/feral-core/src/byok.rs crates/feral-core/src/lib.rs
git commit -m "refactor(core): extract the secret store byok already had"
```

---

### Task 2: Connector-scoped vault

**Files:**
- Create: `crates/feral-core/src/connector_secrets.rs`
- Modify: `crates/feral-core/src/lib.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `secret_store::{set, get, clear}` (Task 1)
- Produces:
  - `pub fn secret_ref(connector_id: &str, field_key: &str) -> String`
  - `pub fn put(connector_id: &str, field_key: &str, value: &str) -> anyhow::Result<()>`
  - `pub fn read(secret_ref: &str) -> Option<String>`
  - `pub fn forget(connector_id: &str, field_key: &str) -> anyhow::Result<()>`
  - `pub const CONNECTOR_SERVICE: &str = "ai.bloom.feral.connectors";`

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_ref_is_stable_and_readable_back() {
        assert_eq!(secret_ref("matrix", "MATRIX_TOKEN"), "connector:matrix:MATRIX_TOKEN");
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
```

- [ ] **Step 2: Run and watch it fail**

Run: `cargo test -p feral-core connector_secrets`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```rust
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
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p feral-core connector_secrets`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/feral-core/src/connector_secrets.rs crates/feral-core/src/lib.rs
git commit -m "feat(core): store connector credentials in the vault, not the config"
```

---

### Task 3: Plaintext migration — verified and resumable

**Files:**
- Modify: `crates/feral-core/src/connector_secrets.rs` (add migration)
- Test: `crates/feral-core/tests/connector_secret_migration.rs`

**Interfaces:**
- Consumes: `put`, `read`, `secret_ref` (Task 2); `connectors::{load_connector_configs, save_connector_configs}`
- Produces: `pub fn migrate_plaintext_secrets(vault: &dyn Vault, io: &dyn ConfigIo) -> MigrationReport`
  - `pub trait Vault { fn put(&self, c: &str, f: &str, v: &str) -> anyhow::Result<()>; fn read(&self, r: &str) -> Option<String>; }`
  - `pub trait ConfigIo { fn load(&self) -> Vec<ConnectorConfig>; fn save(&self, c: &[ConnectorConfig]) -> Result<(), String>; }`
  - `pub struct MigrationReport { pub moved: Vec<String>, pub left_in_place: Vec<(String, String)> }`

The traits exist so failure can be injected at each step. The production callers pass thin wrappers over Task 2 and `connectors.rs`.

- [ ] **Step 1: Write the failing tests**

```rust
// crates/feral-core/tests/connector_secret_migration.rs
use feral_core::connector_secrets::{migrate_plaintext_secrets, ConfigIo, Vault};
use feral_core::connectors::{blank_connector_config, ConnectorConfig};
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
```

- [ ] **Step 2: Run and watch them fail**

Run: `cargo test -p feral-core --test connector_secret_migration`
Expected: FAIL — `migrate_plaintext_secrets` not found.

- [ ] **Step 3: Implement the five steps in order**

```rust
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
```

- [ ] **Step 4: Make the config write atomic**

`save_connector_configs` currently calls `std::fs::write`, which truncates before writing — a crash there loses the file. Replace with temp-file + rename in `crates/feral-core/src/connectors.rs`:

```rust
pub fn save_connector_configs(connectors: &[ConnectorConfig]) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(&ConnectorConfigFile { connectors: connectors.to_vec() })
        .map_err(|e| e.to_string())?;
    let path = config_path();
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("Couldn't save connector settings: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Couldn't save connector settings: {e}"))
}
```

- [ ] **Step 5: Add the log-sentinel test**

```rust
// same test file
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
```

- [ ] **Step 6: Run the tests**

Run: `cargo test -p feral-core --test connector_secret_migration`
Expected: PASS, six tests.

- [ ] **Step 7: Call it at startup**

In `crates/feral-core/src/boot.rs`, after the config directory is known and before connectors are read, call the migration with the production wrappers. One call, no user interaction.

- [ ] **Step 8: Commit**

```bash
git add crates/feral-core/src/connector_secrets.rs crates/feral-core/src/connectors.rs \
        crates/feral-core/src/boot.rs crates/feral-core/tests/connector_secret_migration.rs
git commit -m "feat(core): move connector secrets out of plaintext, verifiably"
```

---

### Task 4: The descriptor

**Files:**
- Modify: `crates/feral-core/src/connectors.rs:33-146`
- Test: `crates/feral-core/tests/catalog_endpoints.rs` (exists), plus new assertions

**Interfaces:**
- Produces:
  - `PairingMethod::{BotToken, Oauth, Qr, InstanceToken, OauthDevice { device_url, token_url, client_id, scopes }}`
  - `ConnectorCatalogEntry.transport: String`
  - `PairingFieldDef.secret: bool` — already present, now meaningfully false for instance URLs

Keep `BotToken`, `Oauth` and `Qr` exactly as they serialise today. The golden file `crates/feral-core/tests/testdata/connector_catalog.golden.json` will need regenerating **once**, deliberately, with the new `transport` field.

- [ ] **Step 1: Write the failing test**

```rust
// crates/feral-core/tests/catalog_endpoints.rs — add
#[test]
fn every_descriptor_names_a_transport() {
    for entry in feral_core::connectors::connectors_catalog() {
        assert!(!entry.transport.is_empty(), "{} has no transport", entry.id);
    }
}

#[test]
fn pairing_and_transport_vary_independently() {
    let cat = feral_core::connectors::connectors_catalog();
    let matrix = cat.iter().find(|c| c.id == "matrix").expect("matrix in catalog");
    let mattermost = cat.iter().find(|c| c.id == "mattermost").expect("mattermost in catalog");
    // Same pairing, different transport — the whole reason they are two fields.
    assert!(matches!(matrix.pairing_method, feral_core::connectors::PairingMethod::InstanceToken));
    assert!(matches!(mattermost.pairing_method, feral_core::connectors::PairingMethod::InstanceToken));
    assert_ne!(matrix.transport, mattermost.transport);
}

#[test]
fn an_instance_url_is_required_but_not_secret() {
    let cat = feral_core::connectors::connectors_catalog();
    let matrix = cat.iter().find(|c| c.id == "matrix").unwrap();
    let url = matrix.pairing_fields.iter().find(|f| f.key == "MATRIX_HOMESERVER").unwrap();
    assert!(!url.secret, "a homeserver URL is configuration, not a credential");
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cargo test -p feral-core --test catalog_endpoints`
Expected: FAIL — no `transport` field, no matrix entry.

- [ ] **Step 3: Extend the types and add the three descriptors**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PairingMethod {
    BotToken,
    Oauth,
    Qr,
    /// A user-chosen instance URL plus a credential. Matrix, Mattermost, Zulip.
    InstanceToken,
    /// OAuth 2.0 device authorization grant — the only flow a client that
    /// cannot hold a secret may use on providers like Twitch.
    OauthDevice {
        device_url: String,
        token_url: String,
        /// Public by definition; shipping it is not a secret leak.
        client_id: String,
        scopes: Vec<String>,
    },
}
```

Add `pub transport: String` to `ConnectorCatalogEntry`, set it on the four existing entries (`"discord"`, `"slack"`, `"whatsapp"`, `"telegram"`), and add the three witnesses with `coming_soon: true` until their transports land in Stage C.

- [ ] **Step 4: Regenerate the golden file, deliberately**

Run: `cargo test -p feral-core --test catalog_endpoints` — read the diff before accepting it. The only expected change is the added `transport` field and the three new entries.

- [ ] **Step 5: Run tests**

Run: `cargo test -p feral-core connectors && cargo test -p feral-core --test catalog_endpoints`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/feral-core/src/connectors.rs crates/feral-core/tests/
git commit -m "feat(core): descriptors name a transport and a pairing, separately"
```

---

### Task 5: One catalog

**Files:**
- Modify: `src-tauri/src/connectors.rs:82-168` (delete `CatalogDef`, `FieldDef`, `catalog_def()`, `catalog()`)
- Test: `src-tauri/src/connectors.rs` inline test

**Interfaces:**
- Consumes: `feral_core::connectors::connectors_catalog()`
- Produces: unchanged `ConnectorCatalogEntry` / `ConnectorField` **view** types — the frontend contract does not move.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod catalog_projection {
    #[test]
    fn the_desktop_catalog_is_a_projection_of_the_core_one() {
        let core: Vec<String> = feral_core::connectors::connectors_catalog()
            .into_iter().map(|c| c.id).collect();
        let desktop: Vec<String> = super::connectors_catalog()
            .into_iter().map(|c| c.id).collect();
        assert_eq!(core, desktop, "two catalogs have drifted — there must be one list");
    }
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cargo test -p feral catalog_projection` (the desktop crate is named `feral`; its lib is `app_lib`)
Expected: FAIL — the desktop list is the old hand-written four.

- [ ] **Step 3: Replace the list with a projection**

Delete `catalog_def()` and its structs. Rewrite `catalog()`:

```rust
/// The desktop catalog is a VIEW of the core one. It keeps its own shape
/// because the frontend already renders it, but it is no longer a second
/// list to remember to update — that is how the two drifted.
fn catalog() -> Vec<ConnectorCatalogEntry> {
    feral_core::connectors::connectors_catalog()
        .into_iter()
        .map(|c| ConnectorCatalogEntry {
            id: c.id,
            name: c.name,
            description: c.description,
            fields: c.pairing_fields.into_iter()
                .map(|f| ConnectorField { key: f.key, label: f.label, secret: f.secret })
                .collect(),
        })
        .collect()
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p feral connectors`
Expected: PASS. Also run the frontend suite — the shape it receives has not changed: `cd frontend-react && npx vitest run`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/connectors.rs
git commit -m "refactor(connectors): one catalog, the desktop renders a projection"
```

---

### Task 6: Accounts

**Files:**
- Create: `crates/feral-core/src/connector_accounts.rs`
- Modify: `crates/feral-core/src/lib.rs`
- Test: `crates/feral-core/tests/connector_accounts.rs`

**Interfaces:**
- Produces:
  - `ConnectorAccount { connector_id, display_name, status, metadata, auth_state, secret_ref, expires_at }`
  - `AccountStatus { Disconnected, Pairing, Connected, Expired, Revoked, Error(String) }`
  - `pub fn load_accounts() -> Vec<ConnectorAccount>` / `pub fn save_account(a: &ConnectorAccount) -> Result<(), String>`
  - `pub fn status_for(id: &str, now: i64) -> AccountStatus`

Persistence: `~/.feral/connector-accounts.json`, same atomic temp+rename as Task 3.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn an_account_never_serialises_a_secret_value() {
    let a = ConnectorAccount {
        connector_id: "twitch".into(),
        display_name: Some("feral_bot".into()),
        status: AccountStatus::Connected,
        metadata: [("scopes".to_string(), "chat:read".to_string())].into_iter().collect(),
        auth_state: None,
        secret_ref: Some("connector:twitch:TWITCH_ACCESS".into()),
        expires_at: Some(1_800_000_000),
    };
    let json = serde_json::to_string(&a).unwrap();
    assert!(json.contains("connector:twitch:TWITCH_ACCESS"));
    assert!(!json.contains("oauth2:"), "a token shape reached the account record");
}

#[test]
fn an_expired_credential_reports_expired_not_connected() {
    let now = 1_800_000_000_i64;
    let a = ConnectorAccount { expires_at: Some(now - 1), status: AccountStatus::Connected, ..sample() };
    assert!(matches!(effective_status(&a, now), AccountStatus::Expired));
}

#[test]
fn revoked_stays_revoked_even_with_a_future_expiry() {
    let now = 1_800_000_000_i64;
    let a = ConnectorAccount { expires_at: Some(now + 9_999), status: AccountStatus::Revoked, ..sample() };
    assert!(matches!(effective_status(&a, now), AccountStatus::Revoked));
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `cargo test -p feral-core --test connector_accounts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the model, `effective_status`, and atomic persistence**

`effective_status` is the one place that decides what the UI shows: `Revoked` and `Error` win over everything; `Connected` past `expires_at` becomes `Expired`; otherwise the stored status stands.

- [ ] **Step 4: Run tests**

Run: `cargo test -p feral-core --test connector_accounts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/feral-core/src/connector_accounts.rs crates/feral-core/src/lib.rs crates/feral-core/tests/connector_accounts.rs
git commit -m "feat(core): status is a value, not 'enabled in a file'"
```

---

## Stage B — the drawers go away

### Task 7: `LiveConnector` and the registry

**Files:**
- Create: `CinderpawAgent/src/transports/registry.ts`
- Test: `CinderpawAgent/tests/connector-registry.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ConnectorContext {
  row: ConnectorRow;                       // config, minus secrets
  secrets: Record<string, string>;         // resolved from the vault by the host
  agent: AgentLike;
  log: Log;
  runs: ConnectorRunHooks | null;
  askRouter: ChannelAskRouter;
  personaProfileId?: string;
}

export interface LiveConnector {
  start(ctx: ConnectorContext): Promise<void>;
  stop(): Promise<void>;
  health(): ConnectorHealth;
  send(sessionId: string, text: string): Promise<void>;
}

export type ConnectorFactory = () => LiveConnector;
export function registerTransport(id: string, make: ConnectorFactory): void;
export function transportFor(id: string): ConnectorFactory | undefined;
export function registeredTransports(): string[];
```

`send` deliberately matches `ChannelSender` in `CinderpawAgent/src/core/ask-user-channel.ts:28` — `(sessionId, text) => Promise<void>` — because session ids are already connector-prefixed and `ChannelAskRouter` already routes on that prefix. No message envelope is invented here.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { registerTransport, transportFor, registeredTransports } from "../src/transports/registry";

describe("transport registry", () => {
  it("hands back the factory it was given", () => {
    const made: string[] = [];
    registerTransport("fake", () => {
      made.push("built");
      return {
        async start() {}, async stop() {},
        health: () => ({ live: true }),
        async send() {},
      };
    });
    const factory = transportFor("fake");
    expect(factory).toBeDefined();
    factory!();
    expect(made).toEqual(["built"]);
    expect(registeredTransports()).toContain("fake");
  });

  it("returns undefined for a transport nobody registered", () => {
    expect(transportFor("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd CinderpawAgent && bun test tests/connector-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry** (a `Map`, three functions, no cleverness)

- [ ] **Step 4: Run tests**

Run: `cd CinderpawAgent && bun test tests/connector-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add CinderpawAgent/src/transports/registry.ts CinderpawAgent/tests/connector-registry.test.ts
git commit -m "feat(sidecar): a registry for connector transports"
```

---

### Task 8: `ConnectorManager` loses its named fields

**Files:**
- Modify: `CinderpawAgent/src/transports/connectors.ts:1450-1723` (the manager)
- Modify: `CinderpawAgent/src/transports/connectors.ts` (Discord/Slack/WhatsApp classes gain `implements LiveConnector`)
- Test: `CinderpawAgent/tests/connector-manager-registry.test.ts`

**Interfaces:**
- Consumes: Task 7's registry
- Produces: `ConnectorManager` unchanged from the outside — same constructor, same `reload()`, same health map, same `askRouter`.

- [ ] **Step 1: Write the acceptance test — the one that defines the phase**

```ts
/**
 * Constraint 6 from the spec: adding a connector must not require modifying
 * ConnectorManager. This test registers a connector the manager has never
 * heard of, from outside the module, and drives it end to end. If someone
 * later adds a fifth named field to the manager, this test still passes —
 * but the sixth connector will need one too, and that is the failure this
 * is here to make visible in review.
 */
import { describe, expect, it } from "bun:test";
import { ConnectorManager } from "../src/transports/connectors";
import { registerTransport } from "../src/transports/registry";

describe("adding a connector without touching the manager", () => {
  it("starts, reports health, sends and stops", async () => {
    const events: string[] = [];
    registerTransport("acme", () => ({
      async start() { events.push("start"); },
      async stop() { events.push("stop"); },
      health: () => ({ live: true }),
      async send(sessionId, text) { events.push(`send:${sessionId}:${text}`); },
    }));

    const mgr = new ConnectorManager(fakeAgent(), () => {});
    await mgr.applyRows([{ id: "acme", enabled: true, secrets: {} }]);

    expect(events).toContain("start");
    expect(mgr.healthOf("acme")).toEqual({ live: true });

    await mgr.send("acme:room1:user1", "hello");
    expect(events).toContain("send:acme:room1:user1:hello");

    await mgr.applyRows([]);
    expect(events).toContain("stop");
  });
});
```

`applyRows`, `healthOf` and `send` are the manager's existing reload/health paths given names the test can call; if they are currently private, expose them rather than reaching into internals.

- [ ] **Step 2: Run and watch it fail**

Run: `cd CinderpawAgent && bun test tests/connector-manager-registry.test.ts`
Expected: FAIL — the manager knows only three ids.

- [ ] **Step 3: Replace the named fields**

```ts
// before: #discord / #discordKey / #slack / #slackKey / #whatsapp / #whatsappKey
#live = new Map<string, LiveConnector>();
#keys = new Map<string, string>();
```

The reload path becomes one loop over rows: compute the row's signature with the existing `sig()` helper, skip when unchanged, otherwise stop the old instance, build the new one from `transportFor(row.id)`, start it, record health, and register its `send` with `askRouter.registerSender(row.id, (s, t) => instance.send(s, t))`. Rows whose transport is unregistered record `{ live: false, error: "no transport for <id> in this build" }` — the same honest shape the health map already uses.

- [ ] **Step 4: Wrap the three existing connectors**

`DiscordConnector`, `SlackConnector` and `WhatsAppConnector` keep every line of their current logic. Each gains `implements LiveConnector`, a `send(sessionId, text)` that routes to the channel it already resolves, and a `registerTransport("discord", () => new DiscordConnector(...))` call at module load.

- [ ] **Step 5: Run the whole sidecar suite**

Run: `cd CinderpawAgent && bun test`
Expected: PASS — including every existing connector test, unedited.

- [ ] **Step 6: Commit**

```bash
git add CinderpawAgent/src/transports/connectors.ts CinderpawAgent/tests/connector-manager-registry.test.ts
git commit -m "refactor(sidecar): connectors live in a map, not in named fields"
```

---

## Stage C — the witnesses

### Task 9: Device authorization grant

**Files:**
- Create: `crates/feral-core/src/oauth_device.rs`
- Test: `crates/feral-core/tests/oauth_device.rs`

**Interfaces:**
- Produces:
  - `pub struct DeviceCode { pub user_code: String, pub verification_uri: String, pub device_code: String, pub interval_secs: u64, pub expires_at: i64 }`
  - `pub enum PollOutcome { Pending, SlowDown, Granted(Tokens), Denied, Expired }`
  - `pub struct Tokens { pub access: String, pub refresh: Option<String>, pub expires_at: i64 }`
  - `pub trait TokenHttp { fn post_form(&self, url: &str, form: &[(&str, &str)]) -> Result<(u16, String), String>; }`
  - `pub fn start_device_flow(http: &dyn TokenHttp, m: &PairingMethod, now: i64) -> Result<DeviceCode, String>`
  - `pub fn poll_once(http: &dyn TokenHttp, m: &PairingMethod, code: &DeviceCode, now: i64) -> PollOutcome`
  - `pub fn refresh(http: &dyn TokenHttp, m: &PairingMethod, refresh_token: &str, now: i64) -> Result<Tokens, RefreshError>`
  - `pub enum RefreshError { Revoked, Transient(String) }`

Everything takes `now` and an injected HTTP client, so the tests need neither a clock nor a network.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn pending_then_granted_walks_the_state_machine() { /* fake http returns authorization_pending, then a token payload */ }

#[test]
fn slow_down_backs_off_rather_than_hammering() { /* 400 slow_down → PollOutcome::SlowDown */ }

#[test]
fn the_users_code_and_url_are_carried_out_of_start() { /* start_device_flow surfaces user_code + verification_uri */ }

#[test]
fn a_flow_past_its_expiry_reports_expired_not_pending() { /* now > expires_at → Expired */ }

#[test]
fn access_denied_is_denied_not_an_error() { /* 400 access_denied → Denied */ }

#[test]
fn refresh_stores_the_new_refresh_token() {
    // Twitch public-client refresh tokens are SINGLE USE. Keeping the old one
    // means the next refresh fails and the user is told they were revoked when
    // they were not.
}

#[test]
fn invalid_grant_is_revoked_and_a_500_is_transient() {
    // The difference decides whether the UI says "reconnect" or retries quietly.
}
```

Write each body against a `FakeHttp` that returns queued `(status, body)` pairs.

- [ ] **Step 2: Run and watch them fail**

Run: `cargo test -p feral-core --test oauth_device`
Expected: FAIL.

- [ ] **Step 3: Implement**

Follow RFC 8628: `POST device_url` with `client_id` + `scopes`; poll `token_url` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`; map `authorization_pending` → `Pending`, `slow_down` → `SlowDown`, `access_denied` → `Denied`, `expired_token` → `Expired`. Refresh uses `grant_type=refresh_token` and **always** returns the new refresh token for storage.

- [ ] **Step 4: Run tests**

Run: `cargo test -p feral-core --test oauth_device`
Expected: PASS, seven tests.

- [ ] **Step 5: Commit**

```bash
git add crates/feral-core/src/oauth_device.rs crates/feral-core/src/lib.rs crates/feral-core/tests/oauth_device.rs
git commit -m "feat(core): device authorization grant as a state machine"
```

---

### Task 10: The device flow on screen

**Files:**
- Modify: `src-tauri/src/connectors.rs` (commands `connector_pair_start`, `connector_pair_poll`)
- Create: `frontend-react/src/components/connectors/AccountCard.tsx`
- Test: `frontend-react/src/components/connectors/__tests__/AccountCard.test.tsx`

**Interfaces:**
- Consumes: Task 6 accounts, Task 9 flow
- Produces: `AccountCard({ account }: { account: ConnectorAccount })`

- [ ] **Step 1: Write the failing tests**

```tsx
it("tells the user exactly what to type, and where", () => {
  render(<AccountCard account={{
    connector_id: "twitch", status: "pairing",
    auth_state: { kind: "waiting_for_user", user_code: "ABCD-1234",
                  verification_uri: "https://twitch.tv/activate", expires_at: 0 },
  } as ConnectorAccount} />);
  expect(screen.getByText("ABCD-1234")).toBeTruthy();
  expect(screen.getByText(/twitch\.tv\/activate/)).toBeTruthy();
  // The mechanism is ours to know, not theirs.
  expect(screen.queryByText(/OAuth|device code|grant/i)).toBeNull();
});

it("offers a way back when the credential was revoked", () => {
  render(<AccountCard account={{ connector_id: "twitch", status: "revoked" } as ConnectorAccount} />);
  expect(screen.getByText(/disconnected/i)).toBeTruthy();
  expect(screen.getByRole("button", { name: /reconnect/i })).toBeTruthy();
});

it("distinguishes a timeout from a refusal", () => {
  // Two different states, two different sentences: one invites another try,
  // the other says the account said no.
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd frontend-react && npx vitest run src/components/connectors`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement the card and the two Tauri commands**

- [ ] **Step 4: Run tests**

Run: `cd frontend-react && npx vitest run src/components/connectors && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/components/connectors src-tauri/src/connectors.rs
git commit -m "feat(ui): show the pairing code, not the protocol"
```

---

### Task 11: Matrix transport

**Files:**
- Create: `CinderpawAgent/src/transports/matrix.ts`
- Test: `CinderpawAgent/tests/matrix-transport.test.ts`

Proves: **configuration that is required but not secret.** The homeserver URL comes from `ctx.row`, the access token from `ctx.secrets`.

- [ ] **Step 1: Write the failing test** — a fake homeserver: `/_matrix/client/v3/sync` returns one room event, `/rooms/{id}/send` records what was sent. Assert the transport reports `live: true`, routes an inbound message to the agent with session id `matrix:<room>:<user>`, and that `send()` posts to the right room.
- [ ] **Step 2: Run and watch it fail** — `cd CinderpawAgent && bun test tests/matrix-transport.test.ts`
- [ ] **Step 3: Implement** — long-poll `/sync` with `since`, `Authorization: Bearer <token>`, reconnect with backoff, `registerTransport("matrix", …)`.
- [ ] **Step 4: Run tests** — same command, expect PASS.
- [ ] **Step 5: Flip `coming_soon: false`** for matrix in `crates/feral-core/src/connectors.rs`.
- [ ] **Step 6: Commit** — `feat(connectors): talk to Cinderpaw from any Matrix homeserver`

---

### Task 12: Mattermost transport

**Files:**
- Create: `CinderpawAgent/src/transports/mattermost.ts`
- Test: `CinderpawAgent/tests/mattermost-transport.test.ts`

Proves: **the same pairing over a different wire protocol.** Personal access tokens do not expire and the WebSocket authenticates with an `Authorization` header ([Mattermost docs](https://developers.mattermost.com/integrate/reference/personal-access-token/)).

- [ ] **Step 1: Write the failing test** — fake WebSocket server emits a `posted` event; assert routing to `mattermost:<channel>:<user>` and that `send()` POSTs to `/api/v4/posts`.
- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement** — WebSocket to `<instance>/api/v4/websocket`, REST for sending, backoff on drop, `registerTransport("mattermost", …)`.
- [ ] **Step 4: Run tests**
- [ ] **Step 5: Flip `coming_soon: false`**
- [ ] **Step 6: Commit** — `feat(connectors): Mattermost, self-hosted`

---

### Task 13: Twitch transport

**Files:**
- Create: `CinderpawAgent/src/transports/twitch.ts`
- Test: `CinderpawAgent/tests/twitch-transport.test.ts`

Proves: **a credential with a life of its own.**

- [ ] **Step 1: Write the failing test** — fake IRC-over-WebSocket chat endpoint; assert the transport authenticates with the vault token, routes `twitch:<channel>:<user>`, and that a `401`/auth failure sets health to `{ live: false }` with a reason rather than silently retrying forever.
- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement** — connect, join channels from `ctx.row.channels`, send via the same socket, `registerTransport("twitch", …)`.
- [ ] **Step 4: Wire refresh** — before connecting, if the account is `Expired`, call Task 9's `refresh`; store the **new** refresh token; on `RefreshError::Revoked` set the account to `Revoked` and stop.
- [ ] **Step 5: Run tests**
- [ ] **Step 6: Flip `coming_soon: false`**
- [ ] **Step 7: Commit** — `feat(connectors): Twitch, with a token that renews itself`

---

### Task 14: Close the phase

- [ ] **Step 1: Run the repo gate** — `./scripts/verify.sh`. Everything green, no exceptions.
- [ ] **Step 2: Drive it in the real app** — pair Matrix against a real homeserver, send a message, read a reply. Confirm `~/.feral/connectors.json` holds no secret. Confirm the Twitch card shows a code.
- [ ] **Step 3: Update the spec's status line** to `complete`, and record anything that turned out differently from the design.
- [ ] **Step 4: Commit** — `docs: close phase 3`

---

## Self-review notes

- Spec §"Constraints" 1-7 map to Tasks 4, 6, 3, 9, 7, 8, 5 respectively; each has a test named for it.
- Spec §"Acceptance criteria" 1→Task 8, 2→Task 5, 3→Task 3, 4→Task 3, 5→Task 3, 6→Tasks 6+13, 7→Task 10, 8→Tasks 11-13, 9→Task 8, 10→Task 14.
- `send(sessionId, text)` is used with that exact signature in Tasks 7, 8, 11, 12 and 13.
- `secret_ref` format `connector:<id>:<field>` is used identically in Tasks 2, 3 and 6.
- Task 11-13 steps are deliberately terser than Tasks 1-10: they are three instances of a pattern the earlier tasks establish, and repeating full fake-server code three times would be noise. Each still names its files, its proof, and its commit.
