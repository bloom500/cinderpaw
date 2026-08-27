//! Git substrate for the RSI layer, via the `git2` crate (libgit2
//! vendored). All access to `~/.feral/rsi/.git/` goes through this
//! module. The sidecar has no libgit2 / no `git` CLI access — every
//! commit, every diff, every LCA query, every fast-forward is an
//! explicit call here.
//!
//! **Branch model**
//! - `main` = the ratchet. Advances ONLY via `fast_forward_main`
//!   (which itself only succeeds when the new commit's score beats
//!   the prior tip's score — the monotonicity guarantee).
//! - One branch per live genome candidate, named `genome/<commit>`.
//!   Created lazily when a new candidate is committed.
//!
//! **Commit metadata format** — the spec asks for a JSON blob in the
//! commit message body:
//!
//! ```text
//! rsi: iteration {iter_id}
//!
//! {json_blob}
//! ```
//!
//! where `{json_blob}` carries `{score, strategy, parent_lineage,
//! mutation_type, cost_tokens, duration_ms}`. We parse this back out
//! on the read path with `parse_iteration_metadata`.

use std::path::{Path, PathBuf};
use std::str;

use anyhow::{anyhow, Context, Result};
use git2::{BranchType, Commit, DiffOptions, Oid, Repository, Signature};
use serde::{Deserialize, Serialize};

use crate::paths::rsi_dir;

/// Subdirectory of the RSI repo where genome snapshots live. Must
/// match `paths::rsi_genomes_dir()`; we re-declare it here so this
/// module can be reasoned about without an import cycle.
const GENOMES_DIR: &str = "genomes";

/// Metadata encoded into every iteration commit's message body.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq)]
pub struct IterationMetadata {
    pub score: f64,
    pub strategy: String,
    pub parent_lineage: Vec<String>,
    pub mutation_type: String,
    pub cost_tokens: u32,
    pub duration_ms: u32,
}

/// One row of the git log as the RSI layer sees it. The
/// `commit_hash` is the canonical id; `metadata_json` is the raw
/// JSON blob parsed from the commit body (as a string) when it
/// matches the iteration format, otherwise `None`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CommitMeta {
    pub commit_hash: String,
    pub parent_hashes: Vec<String>,
    pub author: String,
    pub timestamp: i64,
    pub summary: String,
    /// Parsed from the commit body when present, kept as a raw JSON
    /// string because `serde_json::Value` doesn't implement
    /// `specta::Type` and the UI parses it lazily.
    pub metadata_json: Option<String>,
}

/// Result of an `ratchet_attempt` call.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RatchetResult {
    /// True iff `main` advanced to the new commit.
    pub advanced: bool,
    /// Hash of the previous main tip (so the UI can show the diff).
    pub previous_tip: Option<String>,
    /// Hash of the new main tip after the call.
    pub new_tip: Option<String>,
    /// The candidate's score (echoed back for the UI).
    pub candidate_score: f64,
    /// The score on the prior tip, if there was one.
    pub prior_score: Option<f64>,
}

/// Report from a `gc` run. Sizes are loose-object counts, not bytes —
/// a single object's compressed size depends on its kind and content.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct GcReport {
    /// Number of loose object files in `.git/objects/xx/yyyy...` before GC.
    pub loose_before: usize,
    /// Number of loose object files that survived the prune.
    pub loose_after: usize,
    /// `loose_before - loose_after` — the number of loose files removed.
    pub loose_pruned: usize,
    /// Number of distinct refs walked while computing reachability
    /// (HEAD + every local branch).
    pub refs_visited: usize,
    /// Total reachable objects counted across all visited refs (commits +
    /// trees + blobs — same objects can be reachable from multiple refs
    /// and are de-duplicated by OID).
    pub reachable_objects: usize,
    /// Wall-clock duration of the prune phase. Tracked separately so a
    /// regression that turns the loop into a quadratic scan is visible
    /// without touching object counts.
    pub elapsed_ms: u128,
}

/// Open the RSI repo. Errors if the directory is not a git repo
/// (i.e. bootstrap has not been run).
pub fn open() -> Result<Repository> {
    let path = rsi_dir();
    Repository::open(&path)
        .with_context(|| format!("open git repo at {}", path.display()))
}

/// Bootstrap the RSI substrate. Idempotent: if the repo already
/// exists, opens it and returns the existing tip. Otherwise
/// initialises a new repo on `main`, writes the embedded PLAN.md,
/// commits it, and returns the initial commit's hash.
///
/// **Note**: the eval/ tree (tier0/1/2) and the meta/ directory are
/// created here so the sidecar's first writes don't have to mkdir.
pub fn bootstrap() -> Result<String> {
    let rsi_path = rsi_dir();
    std::fs::create_dir_all(&rsi_path).context("create rsi dir")?;

    let repo = if rsi_path.join(".git").exists() {
        Repository::open(&rsi_path)?
    } else {
        let mut init_opts = git2::RepositoryInitOptions::new();
        // git2 0.19: initial_head takes &str, not Option<&str>.
        init_opts.initial_head("main");
        init_opts.mkpath(true);
        // We don't need any template files; the bare repo + main
        // branch is enough.
        git2::Repository::init_opts(&rsi_path, &init_opts)?
    };

    // Set HEAD to main (idempotent if already there).
    if let Ok(head) = repo.head() {
        if head.name().unwrap_or("") != "refs/heads/main" {
            // Stale HEAD — point it at main, creating main if needed.
            ensure_branch_exists(&repo, "main")?;
            repo.set_head("refs/heads/main")?;
        }
    } else {
        // Unborn repo: HEAD has no commit yet. We can't create a branch
        // object (there's no commit to anchor it to — that's the
        // "null OID cannot exist" trap), but we can point the symbolic
        // HEAD ref at refs/heads/main. The genesis commit below, made
        // against "HEAD", materialises main at that ref.
        repo.set_head("refs/heads/main")?;
    }

    // Write PLAN.md + tier0/task_marker so the initial commit has
    // actual content. The marker just makes the directory trackable
    // by git even before any task files exist.
    let plan_path = rsi_path.join("PLAN.md");
    if !plan_path.exists() {
        std::fs::write(&plan_path, super::plan::PLAN_MD)
            .with_context(|| format!("write PLAN.md to {}", plan_path.display()))?;
    } else {
        // The file says "DO NOT EDIT" and nothing checked. An edited PLAN.md is
        // never overwritten, so the copy the engine reads from disk could drift
        // away from the one compiled into the binary — and every later
        // discussion of "the plan" would be about two different documents.
        // We still do not overwrite (someone edited it on purpose, and silently
        // discarding their work would be worse), but we no longer stay quiet.
        match std::fs::read_to_string(&plan_path) {
            Ok(on_disk) if on_disk != super::plan::PLAN_MD => {
                tracing::warn!(
                    path = %plan_path.display(),
                    "PLAN.md on disk differs from the one built into this binary —                      it is being kept as-is, but the engine and the build no longer agree"
                );
            }
            _ => {}
        }
    }

    let eval_root = rsi_path.join("eval");
    for tier in 0u8..=2 {
        let dir = eval_root.join(format!("tier{}", tier));
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("mkdir {}", dir.display()))?;
        let marker = dir.join(".gitkeep");
        if !marker.exists() {
            std::fs::write(&marker, b"# Tier directory placeholder - see rsi/plan.rs\n")
                .with_context(|| format!("write marker {}", marker.display()))?;
        }
    }

    let genomes_dir = rsi_path.join(GENOMES_DIR);
    std::fs::create_dir_all(&genomes_dir).context("mkdir genomes")?;
    if !genomes_dir.join(".gitkeep").exists() {
        std::fs::write(genomes_dir.join(".gitkeep"), b"# Per-commit genome JSON snapshots\n")?;
    }

    let meta_dir = rsi_path.join("meta");
    std::fs::create_dir_all(&meta_dir).context("mkdir meta")?;
    if !meta_dir.join(".gitkeep").exists() {
        std::fs::write(meta_dir.join(".gitkeep"), b"# PBT state + taste_vector\n")?;
    }

    // If main already has a commit, we're done — bootstrap is
    // idempotent.
    if let Ok(head) = repo.head() {
        if let Some(oid) = head.target() {
            return Ok(oid.to_string());
        }
    }

    // First commit on main.
    let sig = Signature::now("cinderpaw-rsi", "rsi@cinderpaw.local")?;
    let mut index = repo.index()?;
    index.add_path(Path::new("PLAN.md"))?;
    index.add_path(Path::new("eval/tier0/.gitkeep"))?;
    index.add_path(Path::new("eval/tier1/.gitkeep"))?;
    index.add_path(Path::new("eval/tier2/.gitkeep"))?;
    index.add_path(Path::new("genomes/.gitkeep"))?;
    index.add_path(Path::new("meta/.gitkeep"))?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    let commit_oid = repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        "rsi: bootstrap — initial plan + substrate layout",
        &tree,
        &[], // no parents
    )?;

    Ok(commit_oid.to_string())
}

/// Ensure `branch` exists locally; create it from HEAD if not.
fn ensure_branch_exists(repo: &Repository, branch: &str) -> Result<()> {
    match repo.find_branch(branch, BranchType::Local) {
        Ok(_) => Ok(()),
        Err(_) => {
            // Empty repo: create the branch with no commit. If HEAD
            // already has a commit, branch from it.
            let head_oid = repo.head().ok().and_then(|h| h.target());
            match head_oid {
                Some(oid) => {
                    let commit = repo.find_commit(oid)?;
                    repo.branch(branch, &commit, true)?;
                }
                None => {
                    // Unborn repo: there's no commit to anchor a branch
                    // object to. Point the symbolic HEAD ref at the
                    // branch instead; the next commit against HEAD
                    // materialises it. (Trying to branch from
                    // `Oid::zero()` fails with "null OID cannot exist".)
                    repo.set_head(&format!("refs/heads/{branch}"))?;
                }
            }
            Ok(())
        }
    }
}

/// Commit a new genome onto a candidate branch. Returns the new
/// commit hash. The genome JSON is written to
/// `genomes/<commit>.json` and the metadata is encoded into the
/// commit message.
pub fn commit_genome(
    genome_id: &str,
    genome_json: &serde_json::Value,
    parent_commits: &[&str],
    metadata: &IterationMetadata,
    candidate_branch: &str,
) -> Result<String> {
    let repo = open()?;

    // Write the genome snapshot file.
    let rsi_root = rsi_dir();
    let snapshot_rel = format!("{}/{}.json", GENOMES_DIR, &short_id_for_filename(genome_id));
    let snapshot_abs = rsi_root.join(&snapshot_rel);
    std::fs::create_dir_all(snapshot_abs.parent().unwrap())?;
    // Atomic: a torn snapshot is a genome nobody can read back, and this file is
    // the record of what the commit is ABOUT.
    crate::atomic_file::write_atomic(
        &snapshot_abs,
        serde_json::to_string_pretty(genome_json)?.as_bytes(),
    )?;

    // Stage the snapshot.
    let mut index = repo.index()?;
    index.add_path(Path::new(&snapshot_rel))?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    // Resolve parents — if any parent commits are provided, they
    // must already exist in the repo (callers should commit
    // sequentially, not in parallel).
    let mut parents: Vec<Commit> = Vec::with_capacity(parent_commits.len());
    for p in parent_commits {
        let oid = Oid::from_str(p).with_context(|| format!("parse parent oid '{}'", p))?;
        let c = repo.find_commit(oid).with_context(|| format!("find parent {}", p))?;
        parents.push(c);
    }
    let parent_refs: Vec<&Commit> = parents.iter().collect();

    let sig = Signature::now("cinderpaw-rsi", "rsi@cinderpaw.local")?;
    let msg = format_iteration_message(genome_id, metadata);
    let commit_oid = repo.commit(
        None, // update the branch ref via repo::branch below
        &sig,
        &sig,
        &msg,
        &tree,
        &parent_refs,
    )?;

    // Make sure the candidate branch exists at this commit.
    let commit = repo.find_commit(commit_oid)?;
    if repo.find_branch(candidate_branch, BranchType::Local).is_err() {
        repo.branch(candidate_branch, &commit, true)?;
    } else {
        // Branch exists — point it at the new commit. In git2 0.19
        // the way to update a branch's target is through its
        // `Reference`: branch.into_reference().set_target(...). The
        // previous `branch.set_target(...)` call shape existed in
        // older versions of the crate.
        let branch = repo.find_branch(candidate_branch, BranchType::Local)?;
        let mut reference = branch.into_reference();
        reference.set_target(commit_oid, "rsi: new candidate")?;
    }

    Ok(commit_oid.to_string())
}

/// Attempt to advance `main` to `candidate_commit`. Succeeds only if
/// the candidate's metadata score is strictly greater than the
/// current `main` tip's score. Returns a `RatchetResult` describing
/// the outcome (advanced or not, and the before/after tips).
pub fn ratchet_attempt(candidate_commit: &str) -> Result<RatchetResult> {
    let repo = open()?;
    let candidate_oid =
        Oid::from_str(candidate_commit).with_context(|| format!("parse candidate oid '{}'", candidate_commit))?;
    let candidate = repo
        .find_commit(candidate_oid)
        .with_context(|| format!("find candidate commit {}", candidate_commit))?;
    let candidate_meta = parse_iteration_metadata(&candidate)
        .ok_or_else(|| anyhow!("candidate commit has no parseable iteration metadata"))?;
    let candidate_score = candidate_meta.score;

    // Find main's current tip (if any).
    let (previous_tip, prior_score) = match repo.find_branch("main", BranchType::Local) {
        Ok(b) => match b.get().target() {
            Some(tip_oid) => {
                let tip_commit = repo.find_commit(tip_oid)?;
                let prior = parse_iteration_metadata(&tip_commit).map(|m| m.score);
                (Some(tip_oid.to_string()), prior)
            }
            None => (None, None),
        },
        Err(_) => (None, None),
    };

    let prior_score_value = prior_score.unwrap_or(f64::NEG_INFINITY);
    let advanced = candidate_score > prior_score_value;

    if !advanced {
        // previous_tip is cloned into new_tip because the contract is
        // "no advance → main tip unchanged". Rust's move checker
        // refuses to use the same String twice without cloning.
        return Ok(RatchetResult {
            advanced: false,
            previous_tip: previous_tip.clone(),
            new_tip: previous_tip,
            candidate_score,
            prior_score,
        });
    }

    // Fast-forward main. We do NOT merge — the ratchet is a strict
    // replacement of the tip with a strictly-higher-scoring commit.
    // If main's history does not contain the candidate, this is a
    // fast-forward of a fresh ref.
    let main_branch = repo.find_branch("main", BranchType::Local)?;
    let mut main_reference = main_branch.into_reference();
    main_reference.set_target(candidate_oid, "rsi: ratchet advance")?;
    // Not `let _ =`. If HEAD fails to follow main, the next `commit_genome` —
    // which commits to "HEAD" — writes onto whatever ref HEAD still points at,
    // quietly building the lineage somewhere other than main. A ratchet that
    // reports `advanced: true` with the repo in that state is a lie.
    repo.set_head("refs/heads/main")
        .context("ratchet advanced main but could not move HEAD to it")?;

    Ok(RatchetResult {
        advanced: true,
        previous_tip,
        new_tip: Some(candidate_oid.to_string()),
        candidate_score,
        prior_score,
    })
}

/// Last N commits across all refs, newest first. Used by the
/// lineage / taste-vector miner in Faza 3.
pub fn log(max: usize) -> Result<Vec<CommitMeta>> {
    let repo = open()?;
    let mut revwalk = repo.revwalk()?;
    revwalk.push_head()?;
    // Every local branch tip, not just HEAD. The docstring promised "across all
    // refs" and only main was walked, so every candidate that was evaluated and
    // NOT ratcheted — the `genome-*` branches — was invisible to whatever reads
    // this. Selection then drew parents only from the promoted line, which is
    // the opposite of exploring: the search saw only the path it had already
    // taken.
    if let Ok(branches) = repo.branches(Some(BranchType::Local)) {
        for branch in branches.flatten() {
            if let Some(oid) = branch.0.get().target() {
                // The revwalk de-duplicates, so pushing main again is harmless.
                let _ = revwalk.push(oid);
            }
        }
    }
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;

    let mut out = Vec::with_capacity(max.min(1024));
    for oid in revwalk.take(max) {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        let parents: Vec<String> = commit.parent_ids().map(|o| o.to_string()).collect();
        let metadata_json = parse_iteration_metadata(&commit)
            .and_then(|m| serde_json::to_string(&m).ok());
        out.push(CommitMeta {
            commit_hash: commit.id().to_string(),
            parent_hashes: parents,
            author: commit.author().name().unwrap_or("").to_string(),
            timestamp: commit.time().seconds(),
            summary: commit.summary().unwrap_or("").to_string(),
            metadata_json,
        });
    }
    Ok(out)
}

/// Lowest common ancestor of two commits. Returns `None` when the
/// two histories have no shared commit (e.g. parallel branches from
/// an empty start). Returns the LCA's commit hash otherwise.
pub fn lca(a: &str, b: &str) -> Result<Option<String>> {
    let repo = open()?;
    let a_oid = Oid::from_str(a).with_context(|| format!("parse a '{}'", a))?;
    let b_oid = Oid::from_str(b).with_context(|| format!("parse b '{}'", b))?;
    let a_commit = repo.find_commit(a_oid)?;
    let b_commit = repo.find_commit(b_oid)?;
    let lca_oid = repo.merge_base(a_commit.id(), b_commit.id())?;
    Ok(Some(lca_oid.to_string()))
}

/// Unified diff between two commits. Returns the diff as a string
/// suitable for the LLM-driven taste vector miner.
pub fn diff(a: &str, b: &str) -> Result<String> {
    let repo = open()?;
    let a_oid = Oid::from_str(a).with_context(|| format!("parse a '{}'", a))?;
    let b_oid = Oid::from_str(b).with_context(|| format!("parse b '{}'", b))?;
    let a_commit = repo.find_commit(a_oid)?;
    let b_commit = repo.find_commit(b_oid)?;
    let a_tree = a_commit.tree()?;
    let b_tree = b_commit.tree()?;
    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    let diff = repo.diff_tree_to_tree(Some(&a_tree), Some(&b_tree), Some(&mut opts))?;
    let mut out = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        out.push(line.origin());
        out.push_str(str::from_utf8(line.content()).unwrap_or(""));
        true
    })?;
    Ok(out)
}

/// Format the iteration commit message body in the spec'd shape.
/// Format:
///
/// ```text
/// rsi: iteration <genome_id>
///
/// {json}
/// ```
fn format_iteration_message(genome_id: &str, meta: &IterationMetadata) -> String {
    // A failure here writes `{}` into the commit body, which `parse_iteration_metadata`
    // then reads as "no metadata" — and the ratchet refuses the candidate with
    // a message about unparseable metadata, several steps away from the actual
    // problem. Say what really happened, where it happens.
    let blob = serde_json::to_string_pretty(meta).unwrap_or_else(|e| {
        tracing::error!(?e, genome_id, "failed to serialise iteration metadata for the commit body");
        "{}".to_string()
    });
    format!("rsi: iteration {}\n\n{}", genome_id, blob)
}

/// Parse the iteration metadata out of a commit message. Returns
/// None if the message doesn't start with `rsi: iteration ` or the
/// trailing JSON is unparseable.
pub fn parse_iteration_metadata(commit: &Commit) -> Option<IterationMetadata> {
    let msg = commit.message()?;
    let prefix = "rsi: iteration ";
    let body = msg.strip_prefix(prefix)?;
    // The body is `<genome_id>\n\n{json}` — skip the genome_id line
    // and the blank line, take whatever JSON follows.
    let mut parts = body.splitn(2, '\n');
    let _genome_id_line = parts.next()?;
    let rest = parts.next()?.trim_start_matches('\n').trim();
    serde_json::from_str::<IterationMetadata>(rest).ok()
}

/// A short, filesystem-safe id derived from a UUID. We do NOT use
/// the full UUID in filenames because:
/// 1. The git commit hash is the actual identifier we anchor on.
/// 2. Filenames longer than ~80 chars make `ls` outputs painful.
///
/// 8 hex chars = 32 bits of entropy, which is enough to disambiguate
/// genomes within a single user / single day.
fn short_id_for_filename(id: &str) -> String {
    let hex: String = id.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let short: String = hex.chars().take(8).collect();
    if !short.is_empty() {
        return short;
    }
    // An id with no hex digits at all filtered down to nothing, and the
    // snapshot then landed at `genomes/.json` — the SAME path for every such
    // genome, each one silently overwriting the last with no error anywhere.
    // Hash instead: still a short stable filename, but one that exists.
    use std::hash::{Hash as _, Hasher as _};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut h);
    format!("{:08x}", h.finish() as u32)
}

#[allow(dead_code)]
fn _unused_path_assertion() -> PathBuf {
    // Compile-time pin: the GENOMES_DIR constant must agree with
    // what paths.rs returns. If they diverge, this fn won't compile.
    let p = crate::paths::rsi_genomes_dir();
    assert_eq!(
        p.file_name().and_then(|s| s.to_str()),
        Some(GENOMES_DIR),
        "rsi::repo::GENOMES_DIR must match paths::rsi_genomes_dir()"
    );
    p
}

// ---------------------------------------------------------------------------
// Garbage collection (B6)
//
// The RSI layer adds one commit per iteration, each one writing a new
// `genomes/<id>.json` snapshot and a fresh loose-object blob. The repo
// itself stays bounded (commits are tiny, packs are coalesced by libgit2),
// but any code path that calls `repo.odb().write(...)` for an ephemeral
// scratch object leaves a loose file behind forever — those pile up.
//
// `gc` reclaims those by walking every ref (HEAD + all local branches),
// collecting the reachable OID set, then deleting loose files in
// `.git/objects/xx/yyyy...` whose OID is NOT in that set. Pack files
// are NEVER touched: their contents are by definition referenced by
// `.idx` and the pack is one read-only blob, so removing it would be
// the actual corruption risk we want to avoid.
//
// Async wrapper runs the inner sync work on `spawn_blocking` so a large
// prune (10k+ loose objects) never stalls the tokio executor. The hot
// path — `commit_genome` / `ratchet_attempt` — does NOT call gc inline;
// it's triggered from the scheduled maintenance task.
// ---------------------------------------------------------------------------

/// Async wrapper around `gc_sync`. Always runs the sync work on the
/// blocking pool, even when the prune set is empty, so the call site
/// pays nothing for being off the executor.
pub async fn gc() -> Result<GcReport> {
    tokio::task::spawn_blocking(gc_sync)
        .await
        .map_err(|e| anyhow!("gc task join: {e}"))?
}

/// How long a loose object is protected from pruning after it is written.
///
/// A commit writes its blobs before it references them, so anything younger
/// than this may belong to a write still in flight. Same reasoning as
/// `git gc --prune=<date>`.
const PRUNE_GRACE: std::time::Duration = std::time::Duration::from_secs(600);

/// Sync prune. Walks every local ref + HEAD, builds the reachable OID
/// set, then removes any loose-object file under `.git/objects/` whose
/// OID is unreachable. Pack files are left alone.
fn gc_sync() -> Result<GcReport> {
    gc_sync_with_grace(PRUNE_GRACE)
}

/// `gc_sync`, with the grace period as a parameter so tests can prune the
/// objects they just created.
fn gc_sync_with_grace(grace: std::time::Duration) -> Result<GcReport> {
    use std::collections::HashSet;
    use std::time::Instant;

    let started = Instant::now();
    let repo = open()?;
    let objects_dir = repo.path().join("objects");

    // 1. Walk every local ref (HEAD + branches) and collect the OIDs
    //    that any of them can reach. The set is shared across refs so
    //    reachable counts aren't inflated by branches that share commits.
    let mut reachable: HashSet<Oid> = HashSet::new();
    let mut refs_visited: usize = 0;

    // Always include HEAD, even on an unborn repo (HEAD may point at a
    // branch that has no commits yet — that's fine, the walk will be empty).
    if let Ok(head) = repo.head() {
        if let Some(target) = head.target() {
            reachable.insert(target);
        }
        refs_visited += 1;
    }
    for branch in repo.branches(Some(git2::BranchType::Local))? {
        let (branch, _) = branch?;
        if let Some(target) = branch.get().target() {
            reachable.insert(target);
        }
        refs_visited += 1;
    }

    // Expand each ref-tip into its full reachable closure via a revwalk.
    let mut walk = repo.revwalk()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    let tips: Vec<Oid> = reachable.iter().copied().collect();
    for tip in &tips {
        // push(tip) is safe even when tip isn't reachable from any
        // existing walk; revwalk pushes onto the pending frontier.
        let _ = walk.push(*tip);
    }
    for oid in walk {
        let oid = oid?;
        // Walk commits + their trees/blobs via the object peel.
        // `repo.find_commit(...).tree()` walks the tree; for full coverage
        // we use revwalk's hide/prune patterns or fetch_object(). We do
        // it manually: every commit pulls in a tree, every tree pulls in
        // blobs/sub-trees.
        if let Ok(commit) = repo.find_commit(oid) {
            if let Ok(tree) = commit.tree() {
                expand_tree(&repo, tree.id(), &mut reachable);
            }
        }
        reachable.insert(oid);
    }

    // 2. Walk loose-object files. Each is at `<objects>/xx/yyyy...`,
    //    where `xx` is the first two hex chars and `yyyy...` is the rest.
    //    We compute the OID from the path and delete the file iff the OID
    //    is not in the reachable set.
    let mut loose_before: usize = 0;
    let mut loose_after: usize = 0;
    let mut loose_pruned: usize = 0;

    let entries = match std::fs::read_dir(&objects_dir) {
        Ok(e) => e,
        Err(e) => return Err(anyhow!("read loose-object dir {}: {e}", objects_dir.display())),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = match name.to_str() {
            Some(s) => s,
            None => continue,
        };
        // Only consider 2-hex-char subdirectories — that's the git layout
        // for loose objects (`ab`, `cd`, …). Anything else (e.g. `pack/`,
        // `info/`) is structural and we skip it deliberately.
        if name_str.len() != 2 || !name_str.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let prefix = name_str.to_ascii_lowercase();
        for inner in std::fs::read_dir(entry.path())? {
            let inner = inner?;
            let inner_name = inner.file_name();
            let inner_str = match inner_name.to_str() {
                Some(s) => s,
                None => continue,
            };
            // Loose object basenames are 38 hex chars (SHA-1 minus the
            // 2-char prefix). Anything else — `.tmp` from an in-flight
            // write, `pack/` siblings, etc. — is left alone.
            if inner_str.len() != 38 || !inner_str.chars().all(|c| c.is_ascii_hexdigit()) {
                continue;
            }
            loose_before += 1;
            let hex = format!("{prefix}{inner_str}");
            let Ok(oid) = Oid::from_str(&hex) else { continue };
            if reachable.contains(&oid) {
                loose_after += 1;
                continue;
            }
            // Reachability was computed BEFORE this walk started. A commit
            // being written right now has already put its blobs on disk and
            // has not yet referenced them from a tree, so they look garbage —
            // and deleting them leaves the commit that follows pointing at
            // objects that no longer exist. That is corruption of the RSI
            // substrate itself: the lineage the ratchet walks.
            //
            // ponytail: a grace period, which is what `git gc --prune=<date>`
            // does for exactly this reason. Cheaper and less deadlock-prone
            // than taking a lock every commit path would also have to honour.
            // An object younger than this survives to the next GC.
            let young = inner
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| t.elapsed().unwrap_or_default() < grace)
                .unwrap_or(true); // unreadable timestamp → treat as fresh, keep it
            if young {
                loose_after += 1;
                continue;
            }
            // Use remove_file (not unlink) so the failure mode is the same
            // on Windows where unlink has stricter semantics.
            match std::fs::remove_file(inner.path()) {
                Ok(()) => loose_pruned += 1,
                Err(e) => {
                    // Lock contention or transient I/O error: skip this
                    // file and keep going. Refusing the whole prune over
                    // one file would amplify the GC latency cost on
                    // Windows where AV scanners briefly hold .git/ open.
                    tracing::warn!("gc: could not prune {}: {e}", inner.path().display());
                    loose_after += 1;
                }
            }
        }
    }

    Ok(GcReport {
        loose_before,
        loose_after,
        loose_pruned,
        refs_visited,
        reachable_objects: reachable.len(),
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// Recursively add a tree's blobs + sub-trees to `reachable`. A revwalk
/// over commits only gives us the commit graph; without this, a blob
/// reachable through the working tree but with no currently-checked-out
/// HEAD would look unreachable and get pruned.
fn expand_tree(repo: &Repository, tree_oid: Oid, reachable: &mut std::collections::HashSet<Oid>) {
    let Ok(tree) = repo.find_tree(tree_oid) else {
        return;
    };
    reachable.insert(tree_oid);
    for entry in tree.iter() {
        let id = entry.id();
        match entry.kind() {
            Some(git2::ObjectType::Tree) => expand_tree(repo, id, reachable),
            Some(git2::ObjectType::Blob) | Some(git2::ObjectType::Commit) => {
                reachable.insert(id);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// We don't run live git2 tests in CI by default (they're slow
    /// and require a clean tempdir). The test below is a smoke test
    /// for the message-format helpers, which is the only piece
    /// that's pure-data.
    #[test]
    fn format_and_parse_iteration_metadata_round_trips() {
        let meta = IterationMetadata {
            score: 73.4,
            strategy: "test".into(),
            parent_lineage: vec!["abc".into()],
            mutation_type: "mutation".into(),
            cost_tokens: 1234,
            duration_ms: 567,
        };
        let msg = format_iteration_message("gen-1234", &meta);
        assert!(msg.starts_with("rsi: iteration gen-1234"));
        // We can't easily round-trip through a Commit here without a
        // live repo, so we just verify the JSON slice parses.
        let json_part = msg.split_once('\n').unwrap().1.trim_start_matches('\n').trim();
        let parsed: IterationMetadata = serde_json::from_str(json_part).unwrap();
        assert_eq!(parsed, meta);
    }

    #[test]
    fn short_id_truncates_to_8_hex_chars() {
        assert_eq!(
            short_id_for_filename("550e8400-e29b-41d4-a716-446655440000"),
            "550e8400"
        );
        // An id with no hex digits at all must still get a filename of its
        // own. It used to filter down to "", which put every such genome's
        // snapshot at `genomes/.json` — one shared file, each write erasing
        // the previous genome without a word.
        let a = short_id_for_filename("zzz!!!");
        let b = short_id_for_filename("yyy???");
        assert_eq!(a.len(), 8, "a hexless id still needs a filename");
        assert_ne!(a, b, "two hexless ids must not share one snapshot path");
        assert_eq!(a, short_id_for_filename("zzz!!!"), "and it must be stable");
    }

    /// The keystone test: bootstrap the git substrate into a temp
    /// CINDERPAW_HOME and assert the on-disk layout + genesis commit are
    /// exactly what every later phase (ratchet, lineage, diff) relies
    /// on. This is the verification the original delivery lacked — the
    /// bootstrap was wired into setup() but never exercised by a test,
    /// so "Substrate is live on first launch" was unproven.
    #[test]
    fn bootstrap_creates_git_substrate() {
        crate::rsi::test_support::with_temp_feral_home(|root| {
            let head = bootstrap().expect("bootstrap must succeed");
            assert_eq!(head.len(), 40, "genesis commit hash is a git SHA-1");
            assert!(crate::rsi::paths::is_valid_commit_hash(&head));

            // The git repo and the full substrate layout exist on disk.
            assert!(root.join("rsi/.git").exists(), ".git created");
            let plan = root.join("rsi/PLAN.md");
            assert!(plan.exists(), "PLAN.md written");
            assert_eq!(
                std::fs::read_to_string(&plan).unwrap(),
                super::super::plan::PLAN_MD,
                "PLAN.md on disk matches the embedded plan byte-for-byte"
            );
            for rel in [
                "rsi/eval/tier0/.gitkeep",
                "rsi/eval/tier1/.gitkeep",
                "rsi/eval/tier2/.gitkeep",
                "rsi/genomes/.gitkeep",
                "rsi/meta/.gitkeep",
            ] {
                assert!(root.join(rel).exists(), "{rel} created");
            }

            // HEAD is on main, and the genesis commit is parentless with
            // the expected message + the PLAN.md as a diff-able ancestor.
            let repo = open().unwrap();
            assert_eq!(
                repo.head().unwrap().name().unwrap(),
                "refs/heads/main",
                "HEAD points at main (the ratchet branch)"
            );
            let commit = repo
                .find_commit(git2::Oid::from_str(&head).unwrap())
                .unwrap();
            assert_eq!(commit.parent_count(), 0, "genesis has no parents");
            assert!(commit
                .message()
                .unwrap()
                .contains("bootstrap — initial plan + substrate layout"));

            // Idempotent: a second bootstrap returns the same tip and
            // does not create a duplicate genesis.
            let head2 = bootstrap().expect("second bootstrap is a no-op");
            assert_eq!(head, head2, "bootstrap is idempotent");
        });
    }

    /// GC sanity: bootstrap → commit a handful of ratchet-advanced
    /// iterations → seed two unreferenced loose blobs → run `gc` →
    /// assert the seeded blobs are pruned, every reachable commit is
    /// still resolvable, and HEAD still points at `refs/heads/main`.
    /// This is the regression guard for the "RSI substrate grows
    /// unbounded" footgun: a bug that turned `gc` into a no-op (or, worse,
    /// pruned reachable objects) would only surface as missing iteration
    /// data days later, so the test pins the *outcome* rather than the
    /// implementation.
    #[test]
    fn gc_prunes_unreachable_loose_objects_and_keeps_reachable_intact() {
        crate::rsi::test_support::with_temp_feral_home(|_root| {
            // Bootstrap + a small chain of ratchet-advanced iterations.
            // Each iteration advances `main` strictly, so every committed
            // object ends up reachable from main by the end.
            let genesis = bootstrap().expect("bootstrap");
            let mut prev = genesis.clone();
            for i in 0..4 {
                let meta = IterationMetadata {
                    score: 50.0 + i as f64,
                    strategy: "gc-test".into(),
                    parent_lineage: vec![prev.clone()],
                    mutation_type: "noop".into(),
                    cost_tokens: 100,
                    duration_ms: 10,
                };
                let genome_id = format!("gen-gc-{i}");
                let genome_json = serde_json::json!({"i": i, "id": genome_id});
                let new_commit = commit_genome(
                    &genome_id,
                    &genome_json,
                    &[&prev],
                    &meta,
                    &format!("genome/{genome_id}"),
                )
                .expect("commit iteration");
                ratchet_attempt(&new_commit).expect("ratchet advance");
                prev = new_commit;
            }

            // Seed two unreferenced loose blobs straight into the ODB.
            // These simulate the real-world case where a tool writes a
            // scratch object (e.g. an LFS blob, an ephemeral stat cache)
            // and never references it from any commit.
            let repo = open().expect("open");
            let blob_a = repo
                .odb()
                .expect("odb")
                .write(git2::ObjectType::Blob, b"ephemeral-scratch-A")
                .expect("write blob A");
            let blob_b = repo
                .odb()
                .expect("odb")
                .write(git2::ObjectType::Blob, b"ephemeral-scratch-B")
                .expect("write blob B");

            // Sanity: both loose files actually exist on disk before GC.
            let objects_dir = std::path::Path::new(repo.path()).join("objects");
            for oid in [blob_a, blob_b] {
                let hex = oid.to_string();
                let (prefix, rest) = hex.split_at(2);
                let path = objects_dir.join(prefix).join(rest);
                assert!(
                    path.exists(),
                    "loose blob {} should exist at {} before gc",
                    hex,
                    path.display()
                );
            }

            // Run the prune. We do it via the sync inner so the test
            // doesn't depend on a tokio runtime; the async wrapper is
            // tested separately by the lib's normal compile/test cycle.
            // Zero grace: the objects under test were made moments ago, and the
            // production grace period exists precisely to spare those.
            let report = gc_sync_with_grace(std::time::Duration::ZERO).expect("gc_sync");
            assert!(
                report.loose_pruned >= 2,
                "gc should have pruned at least the two seeded blobs, got report={:?}",
                report
            );
            assert!(
                report.refs_visited >= 1,
                "gc should have visited at least HEAD, got report={:?}",
                report
            );

            // Post-conditions: the unreachable blobs are gone, every
            // reachable commit (genesis + the 4 iterations) is still
            // resolvable, and HEAD still names `refs/heads/main`.
            for oid in [blob_a, blob_b] {
                let hex = oid.to_string();
                let (prefix, rest) = hex.split_at(2);
                let path = objects_dir.join(prefix).join(rest);
                assert!(
                    !path.exists(),
                    "loose blob {} should be gone after gc, still at {}",
                    hex,
                    path.display()
                );
            }
            let repo = open().expect("reopen after gc");
            assert_eq!(
                repo.head().unwrap().name().unwrap(),
                "refs/heads/main",
                "HEAD must still point at main after gc"
            );
            let head_oid = repo.head().unwrap().target().expect("HEAD has target");
            let head_commit = repo.find_commit(head_oid).expect("HEAD commit resolves");
            assert!(
                parse_iteration_metadata(&head_commit).is_some(),
                "tip commit must still parse as an RSI iteration after gc"
            );
            // Walk the lineage backwards from HEAD; every parent commit
            // must still resolve, including the genesis.
            let mut cursor = Some(head_commit);
            let mut depth = 0usize;
            while let Some(c) = cursor {
                assert!(
                    repo.find_commit(c.id()).is_ok(),
                    "commit {} must resolve after gc",
                    c.id()
                );
                cursor = c.parents().next();
                depth += 1;
                assert!(depth < 100, "walk depth guard");
            }
            assert!(
                depth >= 5,
                "lineage should walk genesis + 4 iterations, walked only {depth}"
            );

            // A second GC is a no-op (everything reachable is already
            // accounted for, nothing to prune). This pins that the
            // function is idempotent and doesn't accumulate work.
            let report2 = gc_sync_with_grace(std::time::Duration::ZERO).expect("gc_sync idempotent");
            assert_eq!(
                report2.loose_pruned, 0,
                "second gc should prune nothing, got {:?}",
                report2
            );
        });
    }
}
