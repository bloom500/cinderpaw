//! Faza 2 — code-RSI: the Rust half of the trust boundary.
//! Spec: `docs/superpowers/specs/2026-07-01-faza2-code-rsi-design.md` §2.
//!
//! Two things live here, both deliberately OUT of the sidecar's reach:
//!
//! 1. `validate_code_patch` — the policy wall, re-asserted in Rust.
//!    The TS wall (`code-genome.ts`) exists too, but TS is exactly the
//!    thing code-RSI mutates; the wall that finally matters is the one
//!    compiled into the binary the agent cannot edit. Same locked
//!    policy: `src/rsi/` only, `.ts` only, ≤200 changed lines, the
//!    enforcement chain denylisted, no traversal / absolute paths /
//!    binary patches.
//!
//! 2. `score_code_patch` — the code-candidate score formula (I7).
//!    TS reports raw measurements (test counts, tsc exit, build exit,
//!    changed lines); this function turns them into the 0..100 scalar
//!    the ratchet compares. Locked weights (spec §5.3):
//!
//!    ```text
//!    score = 100 · (0.60·pass_rate + 0.15·tsc_clean
//!                   + 0.15·build_ok + 0.10·(1 − changed/200))
//!    ```
//!
//!    Small diffs are favoured by construction; a patch that breaks
//!    the type-check or the build loses its component entirely.

use serde::{Deserialize, Serialize};

/// Locked policy constants. Mirror of `DEFAULT_CODE_PATCH_POLICY` in
/// `code-genome.ts` — keep in sync BY HAND; the duplication is the
/// point (each side enforces independently).
const ALLOWED_DIR_PREFIX: &str = "src/rsi/";
const ALLOWED_EXTENSION: &str = ".ts";
const MAX_CHANGED_LINES: u32 = 200;
const DENYLIST_BASENAMES: &[&str] = &[
    "code-genome.ts",
    "code-sandbox.ts",
    "contract-runner.ts",
    "contract-stages.ts",
    "contract-deps.ts",
    "contract-leaves.ts",
    "contract.ts",
    "ratchet-handler.ts",
    "confidence.ts",
    // TS-side additions that talk to this wall / the scorer:
    "code-leaves.ts",
    "code-rsi.ts",
    "pending-patches.ts",
];

/// Raw measurements the sandbox eval runner (TS, `code-sandbox.ts`)
/// reports. snake_case on the wire, like every bridge payload.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CodePatchMeasurements {
    pub tests_passed: u32,
    pub tests_failed: u32,
    pub tests_exit_code: i32,
    pub tsc_exit_code: i32,
    pub build_exit_code: i32,
    pub changed_lines: u32,
}

/// The scored verdict, mirroring `ScoreBreakdown`'s shape discipline.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CodePatchScore {
    /// Composite 0..100.
    pub score: f64,
    pub pass_rate: f64,
    pub tsc_clean: bool,
    pub build_ok: bool,
    /// 1 − changed_lines/200, clamped to 0..1 (smaller diff = higher).
    pub diff_economy: f64,
}

/// Locked formula weights (spec §5.3). Not host-tunable — a retune is
/// a code change to THIS file, audited like any scorer change.
const W_PASS: f64 = 0.60;
const W_TSC: f64 = 0.15;
const W_BUILD: f64 = 0.15;
const W_DIFF: f64 = 0.10;

/// Score a code candidate's raw measurements. Pure + deterministic.
/// A suite with zero recorded tests scores pass_rate 0 — "no evidence"
/// is not "all green" — and a crashed/killed suite gets no pass
/// credit for its partial counts (see the inline rule).
pub fn score_code_patch(m: &CodePatchMeasurements) -> CodePatchScore {
    let total = m.tests_passed + m.tests_failed;
    // No pass credit when: nothing ran; the runner killed the suite
    // (negative exit = timeout/crash — a partial pass count is not a
    // pass rate); or the suite exited non-zero WITHOUT any parsed
    // failures (crashed before the summary → the counts are garbage).
    // Exit 1 WITH parsed failures is the honest partial-failure case.
    let pass_rate = if total == 0 || m.tests_exit_code < 0 || (m.tests_exit_code != 0 && m.tests_failed == 0) {
        0.0
    } else {
        f64::from(m.tests_passed) / f64::from(total)
    };
    let tsc_clean = m.tsc_exit_code == 0;
    let build_ok = m.build_exit_code == 0;
    let diff_economy =
        (1.0 - f64::from(m.changed_lines) / f64::from(MAX_CHANGED_LINES)).clamp(0.0, 1.0);

    let score = 100.0
        * (W_PASS * pass_rate
            + W_TSC * if tsc_clean { 1.0 } else { 0.0 }
            + W_BUILD * if build_ok { 1.0 } else { 0.0 }
            + W_DIFF * diff_economy);

    CodePatchScore {
        score: score.clamp(0.0, 100.0),
        pass_rate,
        tsc_clean,
        build_ok,
        diff_economy,
    }
}

/// What the validator learned about an accepted patch.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PatchStats {
    pub files: Vec<String>,
    pub changed_lines: u32,
}

/// Validate a unified diff against the locked policy. Returns
/// `Err(reason)` on any violation — the commit path treats that as a
/// hard reject, before anything touches the substrate.
///
/// This is a POLICY scanner, not a full diff parser: it reads the
/// `---`/`+++` headers and counts hunk body lines, which is exactly
/// the surface the policy judges. Anything it cannot recognise as a
/// well-formed file section is a reject (fail closed).
pub fn validate_code_patch(patch: &str) -> Result<PatchStats, String> {
    if patch.trim().is_empty() {
        return Err("empty patch".into());
    }

    let mut files: Vec<String> = Vec::new();
    let mut changed_lines: u32 = 0;
    let mut in_hunk = false;
    // The `---` side of the section we're inside, pending its `+++` pair.
    // Some(None) = saw `--- /dev/null` (file creation).
    let mut pending_old: Option<Option<String>> = None;

    for raw in patch.lines() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);

        if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            return Err("binary patch not allowed".into());
        }
        if let Some(rest) = line.strip_prefix("--- ") {
            check_header_path(rest)?;
            pending_old = Some(header_path(rest));
            in_hunk = false;
            continue;
        }
        if let Some(rest) = line.strip_prefix("+++ ") {
            let Some(old_side) = pending_old.take() else {
                return Err("malformed diff: '+++' without preceding '---'".into());
            };
            // BOTH sides are judged — a rename escaping the allowed dir
            // is a violation on whichever side offends.
            check_header_path(rest)?;
            // The file this section touches: the new path, or the old
            // one for a deletion (`+++ /dev/null`).
            if let Some(path) = header_path(rest).or(old_side) {
                if !files.contains(&path) {
                    files.push(path);
                }
            }
            in_hunk = false;
            continue;
        }
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        if in_hunk && (line.starts_with('+') || line.starts_with('-')) {
            changed_lines += 1;
        }
    }

    if files.is_empty() {
        return Err("patch touches no files".into());
    }
    if changed_lines == 0 {
        return Err("patch changes no lines".into());
    }
    if changed_lines > MAX_CHANGED_LINES {
        return Err(format!(
            "patch too large: {changed_lines} changed lines > {MAX_CHANGED_LINES}"
        ));
    }
    Ok(PatchStats {
        files,
        changed_lines,
    })
}

/// Normalise a `---`/`+++` header payload to a repo-relative path, or
/// `None` for `/dev/null` (created/deleted side, no path to judge).
fn header_path(rest: &str) -> Option<String> {
    // Strip a trailing tab-timestamp some diff tools append.
    let rest = rest.split('\t').next().unwrap_or(rest).trim();
    if rest == "/dev/null" {
        return None;
    }
    let stripped = rest
        .strip_prefix("a/")
        .or_else(|| rest.strip_prefix("b/"))
        .unwrap_or(rest);
    Some(stripped.replace('\\', "/"))
}

/// Judge one header path against the locked policy. `/dev/null` sides
/// pass (nothing to judge). Both sides of every file section run
/// through here, so a rename in or out of the allowed dir is caught
/// on the offending side.
fn check_header_path(rest: &str) -> Result<(), String> {
    let Some(p) = header_path(rest) else {
        return Ok(());
    };
    if p.starts_with('/') || (p.len() >= 2 && p.as_bytes()[1] == b':') {
        return Err(format!("absolute path not allowed: {p}"));
    }
    if p.split('/').any(|seg| seg == "..") {
        return Err(format!("path traversal not allowed: {p}"));
    }
    if !p.starts_with(ALLOWED_DIR_PREFIX) {
        return Err(format!("file outside {ALLOWED_DIR_PREFIX}: {p}"));
    }
    if !p.ends_with(ALLOWED_EXTENSION) {
        return Err(format!("only {ALLOWED_EXTENSION} files may be patched: {p}"));
    }
    let basename = p.rsplit('/').next().unwrap_or(&p);
    if DENYLIST_BASENAMES.contains(&basename) {
        return Err(format!("enforcement file may not be patched: {p}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(passed: u32, failed: u32, tsc: i32, build: i32, changed: u32) -> CodePatchMeasurements {
        CodePatchMeasurements {
            tests_passed: passed,
            tests_failed: failed,
            tests_exit_code: if failed > 0 { 1 } else { 0 },
            tsc_exit_code: tsc,
            build_exit_code: build,
            changed_lines: changed,
        }
    }

    #[test]
    fn perfect_small_patch_scores_high() {
        // all green, 20/200 lines → 60 + 15 + 15 + 10·0.9 = 99
        let s = score_code_patch(&m(100, 0, 0, 0, 20));
        assert!((s.score - 99.0).abs() < 1e-9, "got {}", s.score);
    }

    #[test]
    fn failing_tests_dominate_the_penalty() {
        let mut meas = m(50, 50, 0, 0, 0);
        meas.tests_exit_code = 0; // summary parsed despite failures
        let s = score_code_patch(&meas);
        // 60·0.5 + 15 + 15 + 10 = 70
        assert!((s.score - 70.0).abs() < 1e-9, "got {}", s.score);
    }

    #[test]
    fn crashed_suite_gets_no_pass_credit() {
        let mut meas = m(100, 0, 0, 0, 0);
        meas.tests_exit_code = -2; // timed out / crashed
        let s = score_code_patch(&meas);
        assert_eq!(s.pass_rate, 0.0);
    }

    #[test]
    fn zero_tests_is_no_evidence_not_full_marks() {
        let s = score_code_patch(&m(0, 0, 0, 0, 10));
        assert_eq!(s.pass_rate, 0.0);
    }

    #[test]
    fn dirty_tsc_and_build_lose_their_components() {
        let s = score_code_patch(&m(10, 0, 2, 1, 0));
        // 60 + 0 + 0 + 10 = 70
        assert!((s.score - 70.0).abs() < 1e-9, "got {}", s.score);
    }

    const GOOD_PATCH: &str = "diff --git a/src/rsi/mutation.ts b/src/rsi/mutation.ts\n\
--- a/src/rsi/mutation.ts\n\
+++ b/src/rsi/mutation.ts\n\
@@ -1,2 +1,2 @@\n\
-old line\n\
+new line\n";

    #[test]
    fn good_patch_passes_with_stats() {
        let stats = validate_code_patch(GOOD_PATCH).unwrap();
        assert_eq!(stats.files, vec!["src/rsi/mutation.ts"]);
        assert_eq!(stats.changed_lines, 2);
    }

    #[test]
    fn crlf_input_is_tolerated() {
        let crlf = GOOD_PATCH.replace('\n', "\r\n");
        assert!(validate_code_patch(&crlf).is_ok());
    }

    #[test]
    fn rejects_outside_rsi_and_wrong_extension_and_denylist() {
        for (path, needle) in [
            ("src/agent-loop.ts", "outside"),
            ("src/rsi/notes.md", ".ts"),
            ("src/rsi/code-genome.ts", "enforcement"),
            ("src/rsi/ratchet-handler.ts", "enforcement"),
            ("src/rsi/../secrets.ts", "traversal"),
            ("/etc/cron.d/x.ts", "absolute"),
        ] {
            let patch = GOOD_PATCH.replace("src/rsi/mutation.ts", path);
            let err = validate_code_patch(&patch).unwrap_err();
            assert!(err.contains(needle), "path {path}: got '{err}'");
        }
    }

    #[test]
    fn rejects_binary_empty_and_oversized() {
        assert!(validate_code_patch("").is_err());
        assert!(validate_code_patch("Binary files a/x and b/x differ\n").is_err());

        let mut big = String::from("--- a/src/rsi/mutation.ts\n+++ b/src/rsi/mutation.ts\n@@ -1 +1 @@\n");
        for _ in 0..201 {
            big.push_str("+padding\n");
        }
        let err = validate_code_patch(&big).unwrap_err();
        assert!(err.contains("too large"), "got '{err}'");
    }

    #[test]
    fn rename_out_of_the_allowed_dir_is_rejected() {
        let patch = "--- a/src/rsi/mutation.ts\n+++ b/src/tools/escape.ts\n@@ -1 +1 @@\n-a\n+b\n";
        assert!(validate_code_patch(patch).is_err());
    }

    #[test]
    fn dev_null_sides_are_fine_for_create_and_delete() {
        let create = "--- /dev/null\n+++ b/src/rsi/new-idea.ts\n@@ -0,0 +1 @@\n+export {};\n";
        assert!(validate_code_patch(create).is_ok());
        let delete = "--- a/src/rsi/old-idea.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export {};\n";
        assert!(validate_code_patch(delete).is_ok());
    }

    #[test]
    fn orphan_plus_header_is_malformed() {
        let patch = "+++ b/src/rsi/mutation.ts\n@@ -1 +1 @@\n-a\n+b\n";
        assert!(validate_code_patch(patch).unwrap_err().contains("malformed"));
    }
}
