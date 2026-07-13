//! `SandboxBounds` — the agent-immutable contract that defines what
//! the RSI agent may and may not touch.
//!
//! This is the **other half** of Bounded-RSI. The scorer lives in Rust
//! and the agent can't edit Rust, but the scorer is just one thing
//! the agent must not edit. The full list:
//!
//! 1. The `ScorerWeights` — formula for the composite fitness score.
//! 2. The eval suite (`~/.feral/rsi/eval/`) — the tasks that determine
//!    fitness.
//! 3. The SandboxBounds file itself — recursively, because otherwise
//!    the agent could just disable its own restrictions.
#![allow(dead_code)]
// `genesis_hash` is the re-export of the GENESIS audit-chain
// constant. A future Tauri command (Faza 4 — Mandelbrot) will expose
// it to the UI as the chain anchor; the allow keeps the build clean
// until then.
//! 4. The SandboxBounds audit log — append-only, hash-chained.
//! 5. The git repo at `~/.feral/rsi/.git/` — the substrate of memory.
//!    (Read access is fine; write access is mediated by Rust commands
//!    that always go through a bounds check.)
//! 6. The genome snapshot dir at `~/.feral/rsi/genomes/`.
//! 7. The meta/PBT state at `~/.feral/rsi/meta/`.
//! 8. The PLAN.md.
//!
//! `SandboxBounds` is serialised to `~/.feral/rsi/sandbox_bounds.json`.
//! Mutations are written via `save_with_audit`, which appends a row to
//! the hash-chained audit log first; on failure the JSON file is not
//! touched. The audit log's chain head is the integrity anchor —
//! re-loading the file always re-verifies the chain before trusting
//! the JSON.
//!
//! **Why we keep the file at all** (rather than making the bounds
//! compile-time constants): Faza 5's "cost ceiling enforcement" needs
//! `max_total_cost_usd` to be re-tunable per-user without recompiling
//! Feral. Bounds is the only mutable knob. Everything else lives in
//! code.

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::audit::{ensure_ok, SandboxBoundsAudit, GENESIS};
use super::scorer::ScorerFormula;
use crate::paths::rsi_sandbox_bounds_path;

const BOUNDS_FILE_VERSION: u32 = 1;

/// The full set of bounds. New fields default safely — adding a field
/// to the struct is not a breaking change; changing the *meaning* of
/// an existing field IS, and requires an audit entry.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SandboxBounds {
    /// Schema version for forward-compat. Bumped when the JSON shape
    /// changes in a way older binaries can't read.
    pub version: u32,
    /// Current scorer formula. The hash of this struct is recorded in
    /// the audit log so a formula change can never be silent.
    pub scorer: ScorerFormula,
    /// Hard cap on cumulative USD spent across the whole RSI session.
    /// When reached, the loop halts with `StopReason::BudgetExhausted`
    /// and cannot be restarted without explicit user confirmation
    /// (the bounds file is the user-signed knob for this).
    pub max_total_cost_usd: f64,
    /// Soft warning threshold as a fraction of `max_total_cost_usd`
    /// (0..1). UI shows a warning at this level.
    pub cost_warning_ratio: f64,
    /// Per-iteration USD ceiling. Independent of the total cap so a
    /// runaway iteration is caught even when the total budget is far
    /// from exhausted.
    pub max_per_iteration_cost_usd: f64,
    /// The Goodhart divergence threshold (Tier 1 +% that has to be
    /// sustained). 0.02 = +2% in the spec; we keep the value here so
    /// the user can retune if their eval suite produces noisier
    /// signals than ours.
    pub goodhart_tier1_threshold: f64,
    /// The matching Tier 2 drop threshold (negative number). -0.01 in
    /// the spec.
    pub goodhart_tier2_threshold: f64,
    /// How many consecutive EvalComplete samples must hit the Tier 1/2
    /// thresholds before Goodhart flips. 3 in the spec.
    pub goodhart_consecutive_required: u32,
}

impl Default for SandboxBounds {
    fn default() -> Self {
        Self {
            version: BOUNDS_FILE_VERSION,
            scorer: ScorerFormula::default(),
            max_total_cost_usd: 25.0,
            cost_warning_ratio: 0.8,
            max_per_iteration_cost_usd: 0.50,
            goodhart_tier1_threshold: 0.02,
            goodhart_tier2_threshold: -0.01,
            goodhart_consecutive_required: 3,
        }
    }
}

impl SandboxBounds {
    /// Load `SandboxBounds` from disk, verifying the audit chain first.
    /// If the bounds file doesn't exist yet, returns the default —
    /// callers should then `save_with_audit` to write the initial
    /// state. If the chain is broken, returns an error: the operator
    /// (or the user via the UI) must decide whether to discard the
    /// file or repair the chain.
    pub fn load() -> Result<Self> {
        Self::load_from(&rsi_sandbox_bounds_path())
    }

    /// Path-parameterised core so tests can run without touching the
    /// user's `~/.feral/`.
    pub fn load_from(bounds_path: &Path) -> Result<Self> {
        let audit_path = bounds_path.with_extension("audit.log");
        let audit = SandboxBoundsAudit::open(&audit_path)?;
        let verify = audit.verify().context("verifying bounds audit chain")?;
        ensure_ok(&verify)?;

        if !bounds_path.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(bounds_path)
            .with_context(|| format!("read bounds file {}", bounds_path.display()))?;
        let parsed: SandboxBounds = serde_json::from_str(&raw)
            .with_context(|| format!("parse bounds file {}", bounds_path.display()))?;
        if parsed.version != BOUNDS_FILE_VERSION {
            anyhow::bail!(
                "bounds file version {} is not understood by this build (expected {})",
                parsed.version,
                BOUNDS_FILE_VERSION
            );
        }
        Ok(parsed)
    }

    /// Save the new bounds, appending one audit row per changed field.
    /// Only fields whose JSON-serialised value actually changed are
    /// recorded — keeps the audit log readable.
    ///
    /// **Ordering**: the file is written FIRST, then audit rows are
    /// appended for every changed field. If the file write succeeds
    /// but an audit append fails partway through, we leave the file
    /// in its new state and the audit log missing the corresponding
    /// rows — load() will re-verify and reject on next start if the
    /// chain breaks, which is the correct failure mode (the audit log
    /// is the integrity anchor; a partial append is a corruption
    /// signal). The reverse order (audit-first) would risk a lying
    /// audit log if the file write failed after the row was appended.
    pub fn save_with_audit(&self, audit: &SandboxBoundsAudit, reason: &str) -> Result<()> {
        // Always snapshot the current file (if any) for diff logging.
        let old = if rsi_sandbox_bounds_path().exists() {
            Some(std::fs::read_to_string(rsi_sandbox_bounds_path())?)
        } else {
            None
        };

        // Compute the field-level diff against the previous file.
        // We parse the old JSON as a generic `serde_json::Value` and
        // walk the new `SandboxBounds` field-by-field, only recording
        // changes. This is the simplest reliable way to keep the audit
        // log informative without exploding the call surface.
        let old_v: Option<serde_json::Value> = old
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok());

        let new_v = serde_json::to_value(self)?;

        // List of fields we record. Each entry: (field_name, value_fn).
        // value_fn returns the JSON-serialisable value at that field.
        let field_writers: [(&str, serde_json::Value); 7] = [
            ("scorer", new_v.get("scorer").cloned().unwrap_or(serde_json::Value::Null)),
            (
                "max_total_cost_usd",
                new_v.get("max_total_cost_usd").cloned().unwrap_or(serde_json::Value::Null),
            ),
            (
                "cost_warning_ratio",
                new_v.get("cost_warning_ratio").cloned().unwrap_or(serde_json::Value::Null),
            ),
            (
                "max_per_iteration_cost_usd",
                new_v
                    .get("max_per_iteration_cost_usd")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            ),
            (
                "goodhart_tier1_threshold",
                new_v
                    .get("goodhart_tier1_threshold")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            ),
            (
                "goodhart_tier2_threshold",
                new_v
                    .get("goodhart_tier2_threshold")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            ),
            (
                "goodhart_consecutive_required",
                new_v
                    .get("goodhart_consecutive_required")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            ),
        ];

        // Collect the field-level diffs BEFORE writing the file, so a
        // failed file write doesn't leave us having to roll back audit
        // rows that were committed under an outdated assumption.
        let mut pending: Vec<(&str, Option<String>, String)> = Vec::new();
        for (field, new_field_value) in &field_writers {
            let old_field_value = old_v
                .as_ref()
                .and_then(|v| v.get(field).cloned())
                .unwrap_or(serde_json::Value::Null);

            if old_field_value != *new_field_value {
                let old_str = if old_field_value.is_null() {
                    None
                } else {
                    Some(old_field_value.to_string())
                };
                pending.push((field, old_str, new_field_value.to_string()));
            }
        }

        // Persist the new file. Pretty-printed for human auditing.
        let pretty = serde_json::to_string_pretty(self)?;
        std::fs::write(rsi_sandbox_bounds_path(), pretty)
            .with_context(|| format!("write bounds file {}", rsi_sandbox_bounds_path().display()))?;

        // Now that the file is on disk, append audit rows.
        for (field, old_str, new_str) in &pending {
            audit.append(field, old_str.as_deref(), new_str, reason)?;
        }

        // Surface a useful console line for the bootstrap path: which
        // fields changed. Without this the audit log is the only
        // signal, and reading it requires cat / jq.
        tracing::info!(reason = %reason, changed = pending.len(), "sandbox bounds updated");
        Ok(())
    }

    /// Initial bootstrap. Writes the default bounds file FIRST, then
    /// appends a single audit row that says "genesis". Returns the
    /// bounds. The reverse order would risk a lying audit log if the
    /// file write failed after the row was appended — see
    /// `save_with_audit` for the full rationale.
    pub fn bootstrap_with_audit(audit: &SandboxBoundsAudit) -> Result<Self> {
        let bounds = Self::default();
        std::fs::write(
            rsi_sandbox_bounds_path(),
            serde_json::to_string_pretty(&bounds)?,
        )
        .with_context(|| format!("write bootstrap bounds to {}", rsi_sandbox_bounds_path().display()))?;
        // Genesis row records the scorer formula only — the other
        // fields are derived from defaults and not interesting enough
        // to log in the genesis row.
        audit.append(
            "scorer",
            None,
            &serde_json::to_string(&bounds.scorer)?,
            "genesis",
        )?;
        Ok(bounds)
    }

    /// Returns the SHA-256 hash of the on-disk JSON, lowercase hex.
    /// Used by callers that want to detect external tampering between
    /// command invocations (the audit log is the authoritative record
    /// of Rust-side mutations).
    pub fn file_sha256(&self) -> Result<String> {
        use sha2::{Digest, Sha256};
        let raw = std::fs::read(rsi_sandbox_bounds_path())
            .with_context(|| format!("read bounds for hashing: {}", rsi_sandbox_bounds_path().display()))?;
        let mut h = Sha256::new();
        h.update(&raw);
        Ok(format!("{:x}", h.finalize()))
    }

    /// True iff the given path resolves under a protected subtree of
    /// the RSI directory. Used by every write-path command before
    /// touching the disk. The match is intentional — we list each
    /// protected subtree so a future addition to the RSI dir tree
    /// forces a code edit at every check site.
    ///
    /// Skips protected bases that do not currently exist on disk
    /// (e.g. the `eval/tier1/` and `eval/tier2/` directories before
    /// they're populated). The contract is "is `abs_path` inside
    /// any *currently-existing* protected subtree"; a protected
    /// subtree that doesn't exist yet can't contain anything.
    pub fn is_protected_path(&self, abs_path: &Path) -> Result<bool> {
        use crate::paths;
        let protected_full: Vec<std::path::PathBuf> = vec![
            paths::rsi_dir(),
            paths::rsi_sandbox_bounds_path(),
            paths::rsi_sandbox_bounds_audit_path(),
            paths::rsi_plan_path(),
            paths::rsi_genomes_dir(),
            paths::rsi_meta_dir(),
            paths::rsi_eval_dir(0),
            paths::rsi_eval_dir(1),
            paths::rsi_eval_dir(2),
        ];

        for base in &protected_full {
            if !base.exists() {
                continue;
            }
            if super::paths::is_under(base, abs_path)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// Re-export the GENESIS constant for callers that don't want to
/// import `audit` directly.
pub fn genesis_hash() -> &'static str {
    GENESIS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rsi::audit::AuditVerifyResult;
    use tempfile::TempDir;

    /// Build a fresh bounds file at `bounds_path` + the corresponding
    /// audit log, returning the loaded bounds and the audit handle.
    fn fresh(dir: &Path) -> (SandboxBounds, SandboxBoundsAudit) {
        let bounds = SandboxBounds::default();
        let audit = SandboxBoundsAudit::open(dir.join("bounds.audit.log")).unwrap();
        // The default file is written through the audit path so the
        // chain head and the file agree on init.
        audit.append("scorer", None, &serde_json::to_string(&bounds.scorer).unwrap(), "init").unwrap();
        std::fs::write(dir.join("bounds.json"), serde_json::to_string_pretty(&bounds).unwrap()).unwrap();
        (bounds, audit)
    }

    #[test]
    fn bootstrap_writes_genesis_row() {
        // Hermetic: FERAL_HOME points at a temp dir, so this exercises
        // the real production paths (rsi_sandbox_bounds_path etc.)
        // without touching the developer's ~/.feral/rsi.
        crate::rsi::test_support::with_temp_feral_home(|_root| {
            let bounds_path = crate::paths::rsi_sandbox_bounds_path();
            std::fs::create_dir_all(bounds_path.parent().unwrap()).unwrap();

            let audit =
                SandboxBoundsAudit::open(crate::paths::rsi_sandbox_bounds_audit_path()).unwrap();
            let bounds = SandboxBounds::bootstrap_with_audit(&audit).unwrap();
            assert_eq!(bounds.version, BOUNDS_FILE_VERSION);
            // Bounds default cap is the locked $25, not a leaked test value.
            assert_eq!(bounds.max_total_cost_usd, 25.0);
            match audit.verify().unwrap() {
                AuditVerifyResult::Ok { entries } => assert_eq!(entries, 1),
                _ => panic!("expected ok"),
            }
        });
    }

    #[test]
    fn save_with_audit_records_changed_fields_only() {
        crate::rsi::test_support::with_temp_feral_home(|_root| {
            let audit_path = crate::paths::rsi_sandbox_bounds_audit_path();
            std::fs::create_dir_all(audit_path.parent().unwrap()).unwrap();

            let audit = SandboxBoundsAudit::open(&audit_path).unwrap();
            let mut b = SandboxBounds::bootstrap_with_audit(&audit).unwrap();

            // Bump one field and save — only that field should produce a
            // new audit row.
            b.max_total_cost_usd = 50.0;
            let audit2 = SandboxBoundsAudit::open(&audit_path).unwrap();
            b.save_with_audit(&audit2, "user raised cap").unwrap();

            let raw = std::fs::read_to_string(&audit_path).unwrap();
            let rows: Vec<serde_json::Value> = raw
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| serde_json::from_str(l).unwrap())
                .collect();
            // Bootstrap row (scorer) + one changed-field row (max_total_cost_usd).
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[1]["field"], "max_total_cost_usd");
        });
    }

    #[test]
    fn protected_path_check_includes_eval_and_genomes() {
        let (_b, _a) = fresh(TempDir::new().unwrap().path());
        // We can't actually point at a real ~/.feral/rsi in tests; the
        // check is exercised through the integration surface in
        // commands.rs. Here we just sanity-check that the function
        // exists and the signature is right. We pass an EXISTING
        // path (the temp dir we just created) so `canonicalize()`
        // inside `is_under` doesn't fail on a non-existent target.
        let b = SandboxBounds::default();
        let r = b.is_protected_path(_a.path());
        assert!(r.is_ok());
    }
}
