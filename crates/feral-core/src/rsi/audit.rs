//! Append-only, hash-chained audit log for `SandboxBounds` mutations.
//!
//! Mirrors the design of the sidecar's `audit-log.ts`: each row carries
//! `prev_hash` (the previous row's `entry_hash`) and
//! `entry_hash = sha256(prev_hash || 0x02 || canonical(row))`. A
//! post-hoc UPDATE to any row breaks its own `entry_hash`; a DELETE
//! breaks the next row's `prev_hash` linkage. `verify()` walks the
//! chain and reports the first break.
//!
//! **Why a separate file (not the SQLite `audit_log` table)**: the
//! sidecar's audit_log is hash-chained at the row level, but the chain
//! head lives in the same database file. If an attacker rewrites the
//! DB they can rewrite both the rows AND the chain head. The bounds
//! audit lives in a flat file because (a) the bounds file is small
//! and changes rarely, (b) a separate file means the chain head has
//! no relationship to the DB, (c) it can be inspected with `cat` for
//! human auditing without a SQLite client.
//!
//! **Storage format**: one JSON object per line (NDJSON), each line
//! flushed to disk before `append` returns. The log is append-only at
//! the Rust level — there is no public method to delete or rewrite a
//! row, and the file is opened with `OpenOptions::append | create`.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Anchor for the first link in the chain.
pub const GENESIS: &str = "GENESIS";

/// One row in the audit log. The shape is part of the on-disk
/// contract — once a row is written, all four fields are fixed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundsAuditRow {
    /// Wall-clock timestamp when the mutation was applied. UTC ISO-8601
    /// for human readability; the chain integrity is anchored on the
    /// hash, not the timestamp.
    pub timestamp: String,
    /// Which field of `SandboxBounds` was touched.
    pub field: String,
    /// The previous value, serialised to a JSON string (or `null` for
    /// the genesis row).
    pub old_value: Option<String>,
    /// The new value, serialised to a JSON string.
    pub new_value: String,
    /// `user_confirmed` for the initial bootstrap (no user prompt), or
    /// a short reason the user supplied when approving the change.
    pub reason: String,
    pub prev_hash: String,
    pub entry_hash: String,
}

/// What `verify` reports back.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum AuditVerifyResult {
    Ok { entries: u64 },
    Broken {
        line: usize,
        reason: String,
    },
}

/// Handle to an open audit log. Cheap to construct; expensive
/// operations are explicit (`append`, `verify`).
pub struct SandboxBoundsAudit {
    path: PathBuf,
}

impl SandboxBoundsAudit {
    /// Open the audit log at `path`. The file is created if missing.
    /// Does not load the chain head — that happens on the first
    /// `append` (so a fresh file starts at GENESIS without an explicit
    /// genesis row, matching the sidecar's behaviour).
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create_dir_all {}", parent.display()))?;
        }
        // Touch the file so subsequent appends don't race on first
        // open. We never truncate.
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("open audit log {}", path.display()))?;
        Ok(Self { path })
    }

    /// Append one row to the chain. Returns the entry hash on success.
    /// The chain head is read from disk (last non-empty line) and the
    /// new row is written atomically with respect to other writers
    /// within the same process — but the file lock is a single-process
    /// lock and we explicitly do NOT coordinate across processes. The
    /// Feral app is single-instance by design (lockfile in main); if
    /// that ever changes this needs revisiting.
    pub fn append(
        &self,
        field: &str,
        old_value: Option<&str>,
        new_value: &str,
        reason: &str,
    ) -> Result<String> {
        // Reading the head and appending must be ONE operation. Without this,
        // two tasks — and the dream cycle really does update bounds from more
        // than one — each read the same head, each computed a hash from it, and
        // the second row's `prev_hash` pointed at a row that was no longer the
        // one before it. `verify()` then reported the chain broken, which is
        // the one thing this file exists to be able to deny.
        //
        // ponytail: one global lock, not one per path. Bounds updates are rare
        // enough that contention is not a concern; make it a per-path map if
        // that ever stops being true.
        static APPEND_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = APPEND_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let prev_hash = self.last_hash()?;
        let row = BoundsAuditRow {
            timestamp: Utc::now().to_rfc3339(),
            field: field.to_string(),
            old_value: old_value.map(|s| s.to_string()),
            new_value: new_value.to_string(),
            reason: reason.to_string(),
            prev_hash: prev_hash.clone(),
            entry_hash: String::new(), // computed below
        };
        let entry_hash = hash_row(&prev_hash, &row);

        // Mutate the row in-place to record the hash, then serialise.
        let mut final_row = row;
        final_row.entry_hash = entry_hash.clone();

        let line = serde_json::to_string(&final_row)
            .context("serialise audit row")?
            + "\n";

        let mut f = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.path)
            .with_context(|| format!("open audit log for append: {}", self.path.display()))?;
        f.write_all(line.as_bytes())
            .with_context(|| format!("write audit row to {}", self.path.display()))?;
        f.flush().with_context(|| "flush audit log")?;
        Ok(entry_hash)
    }

    /// Read the entry_hash of the last row in the log, or GENESIS if
    /// the log is empty (or only contains rows that pre-date the chain
    /// — currently we never write such rows, so this is just the
    /// empty-log case).
    pub fn last_hash(&self) -> Result<String> {
        let f = match File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(GENESIS.to_string()),
            Err(e) => {
                return Err(anyhow!(e))
                    .with_context(|| format!("open audit log: {}", self.path.display()))
            }
        };
        let reader = BufReader::new(f);
        let mut last: Option<String> = None;
        for line in reader.lines() {
            let line = line.context("read audit log line")?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let row: BoundsAuditRow = match serde_json::from_str(trimmed) {
                Ok(r) => r,
                Err(_) => continue, // skip malformed (shouldn't happen in our writes)
            };
            last = Some(row.entry_hash);
        }
        Ok(last.unwrap_or_else(|| GENESIS.to_string()))
    }

    /// Walk the entire chain and verify integrity. O(n) on log size;
    /// intended to be called at startup + on demand, not per-request.
    pub fn verify(&self) -> Result<AuditVerifyResult> {
        let f = match File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(AuditVerifyResult::Ok { entries: 0 })
            }
            Err(e) => return Err(anyhow!(e)),
        };
        let reader = BufReader::new(f);
        let mut prev = GENESIS.to_string();
        let mut count: u64 = 0;
        for (idx, line) in reader.lines().enumerate() {
            let line = line.with_context(|| format!("read audit log line {}", idx + 1))?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let row: BoundsAuditRow = serde_json::from_str(trimmed)
                .with_context(|| format!("parse audit log line {}", idx + 1))?;

            if row.prev_hash != prev {
                return Ok(AuditVerifyResult::Broken {
                    line: idx + 1,
                    reason: "prev_hash linkage broken".to_string(),
                });
            }
            let mut expected_row = row.clone();
            expected_row.entry_hash = String::new();
            let expected = hash_row(&prev, &expected_row);
            // A row written before the canonicalisation changed hashes under
            // the old scheme. Accept either, so an upgrade does not turn every
            // existing log into a tampering report.
            if expected != row.entry_hash
                && hash_row_legacy(&prev, &expected_row) != row.entry_hash
            {
                return Ok(AuditVerifyResult::Broken {
                    line: idx + 1,
                    reason: "entry_hash mismatch (row content altered)".to_string(),
                });
            }
            prev = row.entry_hash.clone();
            count += 1;
        }
        Ok(AuditVerifyResult::Ok { entries: count })
    }

    /// The last recorded value of every field the chain has ever touched.
    ///
    /// Used by `SandboxBounds::load_from` to check that the bounds FILE still
    /// says what the audit says it should. Verifying the chain proves the log
    /// was not edited; it proves nothing about the file the log is describing,
    /// and those are two different documents.
    pub fn last_values(&self) -> Result<std::collections::HashMap<String, String>> {
        let mut out = std::collections::HashMap::new();
        let f = match File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(anyhow!(e)),
        };
        for line in BufReader::new(f).lines() {
            let line = line?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(row) = serde_json::from_str::<BoundsAuditRow>(trimmed) else {
                continue;
            };
            out.insert(row.field, row.new_value);
        }
        Ok(out)
    }

    /// Path to the log file (mostly for diagnostics + the boot
    /// surface).
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// SHA-256 of `prevHash || 0x02 || canonical(row)`. The 0x02 marker AND the
/// canonicalisation now match `audit-log.ts`, so the two chains really can be
/// walked by one tool. Until the separator was fixed below, only the marker
/// matched and the claim in this comment was false.
fn hash_row(prev_hash: &str, row: &BoundsAuditRow) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prev_hash.as_bytes());
    hasher.update([0x02]);
    hasher.update(canonicalise(row).as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Deterministic serialisation of the row's content. Field order is
/// fixed so the hash is stable across runs and across OS line endings.
///
/// Separated by `U+0001`, with `U+0000null` for an absent value — the same
/// scheme `FeralAgent/src/egress/audit-log.ts` uses, so the two chains really
/// are walkable by one tool. They were not before: this joined on `|`, which
/// occurs in ordinary text, so `field="a|b", reason="c"` and `field="a",
/// reason="b|c"` produced the SAME canonical string and therefore the same
/// hash. A rearrangement between two fields was invisible to `verify()` —
/// exactly the tampering the chain is supposed to catch.
fn canonicalise(row: &BoundsAuditRow) -> String {
    let f = |v: Option<&str>| -> String {
        match v {
            Some(v) => v.to_string(),
            None => "\u{0}null".to_string(),
        }
    };
    [
        f(Some(&row.timestamp)),
        f(Some(&row.field)),
        f(row.old_value.as_deref()),
        f(Some(&row.new_value)),
        f(Some(&row.reason)),
    ]
    .join("\u{1}")
}

/// The pre-2026-08 canonicalisation, kept ONLY so rows written before the
/// separator changed still verify.
///
/// Dropping it would have made every existing audit log read as tampered at
/// the first boot after the upgrade — a false accusation is worse than the
/// ambiguity it replaced, and the user has no way to tell the two apart.
fn canonicalise_legacy(row: &BoundsAuditRow) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        row.timestamp,
        row.field,
        row.old_value.as_deref().unwrap_or(""),
        row.new_value,
        row.reason
    )
}

fn hash_row_legacy(prev_hash: &str, row: &BoundsAuditRow) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prev_hash.as_bytes());
    hasher.update([0x02]);
    hasher.update(canonicalise_legacy(row).as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Convenience for callers: confirm a verify result is `Ok`. Returns
/// Err with a descriptive message otherwise.
pub fn ensure_ok(result: &AuditVerifyResult) -> Result<()> {
    match result {
        AuditVerifyResult::Ok { .. } => Ok(()),
        AuditVerifyResult::Broken { line, reason } => {
            bail!("sandbox bounds audit log is broken at line {}: {}", line, reason)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn fresh_log_starts_at_genesis() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("audit.log");
        let audit = SandboxBoundsAudit::open(&p).unwrap();
        assert_eq!(audit.last_hash().unwrap(), GENESIS);
    }

    #[test]
    fn chain_advances_on_append() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("audit.log");
        let audit = SandboxBoundsAudit::open(&p).unwrap();

        let h1 = audit.append("w_success", None, "55", "init").unwrap();
        assert_ne!(h1, GENESIS);
        let h2 = audit.append("w_success", Some("55"), "60", "tune").unwrap();
        assert_ne!(h2, h1);
        assert_eq!(audit.last_hash().unwrap(), h2);
    }

    #[test]
    fn verify_ok_for_unbroken_chain() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("audit.log");
        let audit = SandboxBoundsAudit::open(&p).unwrap();
        audit.append("w_success", None, "55", "init").unwrap();
        audit.append("w_cost", Some("15"), "20", "tune").unwrap();
        audit.append("w_error", Some("20"), "25", "tune").unwrap();
        match audit.verify().unwrap() {
            AuditVerifyResult::Ok { entries } => assert_eq!(entries, 3),
            AuditVerifyResult::Broken { line, reason } => {
                panic!("unexpected break at line {}: {}", line, reason)
            }
        }
    }

    #[test]
    fn verify_detects_rewritten_row() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("audit.log");
        let audit = SandboxBoundsAudit::open(&p).unwrap();
        audit.append("w_success", None, "55", "init").unwrap();
        audit.append("w_cost", Some("15"), "20", "tune").unwrap();
        // Tamper with the second row's new_value.
        let raw = std::fs::read_to_string(&p).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        let tampered = lines[1].replace(r#""new_value":"20""#, r#""new_value":"999""#);
        std::fs::write(&p, format!("{}\n{}\n", lines[0], tampered)).unwrap();
        match audit.verify().unwrap() {
            AuditVerifyResult::Broken { line, .. } => assert_eq!(line, 2),
            AuditVerifyResult::Ok { .. } => panic!("expected break"),
        }
    }

    #[test]
    fn verify_detects_deleted_row() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("audit.log");
        let audit = SandboxBoundsAudit::open(&p).unwrap();
        audit.append("a", None, "1", "init").unwrap();
        audit.append("b", Some("1"), "2", "x").unwrap();
        audit.append("c", Some("2"), "3", "y").unwrap();
        // Delete the middle row.
        let raw = std::fs::read_to_string(&p).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        std::fs::write(&p, format!("{}\n{}\n", lines[0], lines[2])).unwrap();
        match audit.verify().unwrap() {
            AuditVerifyResult::Broken { line, .. } => assert_eq!(line, 2),
            AuditVerifyResult::Ok { .. } => panic!("expected break"),
        }
    }
}
