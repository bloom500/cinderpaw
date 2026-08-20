/**
 * Safety points — "what did it change while I was out, and can I put it back".
 *
 * The write tools have no backup and the audit log records only the NEW content
 * of a write, never the previous one. So after an unattended run there was no
 * way to answer either question: not what changed, and certainly not how to
 * undo it. That is the concrete shape of "I'll come back and my project will be
 * wrecked", and no amount of sandboxing addresses it — the workspace roots stop
 * the agent leaving the project, not damaging it.
 *
 * A safety point is a full snapshot of the workspace taken before an unattended
 * turn, stored as a git commit. Afterwards the diff against a second snapshot
 * is exactly the list of changes, and the commit is a restore source.
 *
 * **It never touches the user's git state.** No commit on their branch, no
 * stash entry, no index modification, no checkout. Snapshots are built with a
 * throwaway index (`GIT_INDEX_FILE`) and `commit-tree`, which writes an orphan
 * commit object and nothing else; the only visible trace is a ref under
 * `refs/feral/safety/`, which no branch, tag or log surface lists by default.
 * A safety mechanism that mutates the thing it is protecting is not one.
 *
 * Workspaces that are not git repositories get a *shadow* repository whose
 * git dir lives under `~/.feral/safety/` — the project tree itself gets no
 * `.git` directory and no new files at all.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { feralHome } from "../config.ts";
import { resolveExecutables } from "./executables.ts";

/** Absolute path to git, resolved once (PATH-hijack hardening, as git.ts). */
const GIT = resolveExecutables(["git"])[0] ?? "git";

/**
 * Paths never worth snapshotting. Applied only to shadow repositories — a real
 * repo already has the user's own .gitignore, which is a better list than any
 * we could guess.
 */
const SHADOW_EXCLUDES = [
  ".git/",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "target/",
  "dist/",
  "build/",
  ".next/",
  ".cache/",
  "*.log",
];

/** Wall-clock cap per git invocation. A snapshot must never hang a turn. */
const GIT_TIMEOUT_MS = 120_000;

export interface SafetyPoint {
  /** Workspace root the snapshot covers. */
  root: string;
  /** Commit sha of the "before" snapshot. */
  before: string;
  /** Shadow git dir, or null when the workspace is a real repository. */
  gitDir: string | null;
  /** Human label (the job or session this belongs to). */
  label: string;
  createdAt: number;
}

export interface ChangeSummary {
  /** False when no snapshot could be taken — say so rather than imply "nothing changed". */
  available: boolean;
  files: Array<{ status: string; path: string }>;
  insertions: number;
  deletions: number;
  /** A command the user can paste to inspect or undo. Null when unavailable. */
  restoreHint: string | null;
  /** Why no snapshot exists, when `available` is false. */
  reason?: string;
}

type Log = (message: string) => void;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git with a fixed argv. Never throws; a failure is a non-zero code. */
function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<GitResult> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(GIT, args, {
        cwd,
        env: {
          ...process.env,
          // commit-tree refuses to run without an identity, and we must not
          // depend on (or be recorded as) the user's configured one.
          GIT_AUTHOR_NAME: "Cinderpaw",
          GIT_AUTHOR_EMAIL: "safety@feral.local",
          GIT_COMMITTER_NAME: "Cinderpaw",
          GIT_COMMITTER_EMAIL: "safety@feral.local",
          // Never prompt for credentials from a background run.
          GIT_TERMINAL_PROMPT: "0",
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      done({ code: -1, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** Stable per-root directory name for a shadow repo. */
function shadowDirFor(root: string): string {
  const hash = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12);
  return join(feralHome(), "safety", `${basename(root) || "root"}-${hash}`);
}

/**
 * Whether snapshotting this root is sane.
 *
 * A home directory or a filesystem root is not a project: snapshotting it would
 * mean indexing everything the user owns, which is slow, enormous, and not what
 * anyone means by "protect my project".
 */
function snapshottable(root: string): string | null {
  const r = resolve(root);
  if (r === resolve(homedir())) return "workspace root is the home directory";
  // "C:\\", "/", "D:/" and friends.
  if (/^([A-Za-z]:[\\/]?|[\\/])$/.test(r)) return "workspace root is a filesystem root";
  return null;
}

/** The repository root containing `root`, or null when it is not tracked. */
async function realRepoRoot(root: string): Promise<string | null> {
  const res = await git(["rev-parse", "--show-toplevel"], root);
  return res.code === 0 && res.stdout ? res.stdout : null;
}

/** Prepare a shadow repository for a non-git workspace. Idempotent. */
async function ensureShadow(root: string, log: Log): Promise<string | null> {
  const gitDir = shadowDirFor(root);
  try {
    await mkdir(gitDir, { recursive: true });
    const init = await git(["--git-dir", gitDir, "--work-tree", root, "init", "--quiet"], root);
    if (init.code !== 0) {
      log(`safety-point: shadow init failed for ${root}: ${init.stderr}`);
      return null;
    }
    await mkdir(join(gitDir, "info"), { recursive: true });
    await writeFile(join(gitDir, "info", "exclude"), SHADOW_EXCLUDES.join("\n") + "\n", "utf8");
    return gitDir;
  } catch (err) {
    log(`safety-point: shadow setup failed for ${root}: ${String(err)}`);
    return null;
  }
}

/**
 * Build one snapshot commit of the current worktree.
 *
 * The throwaway index is the whole trick: `git add -A` against `GIT_INDEX_FILE`
 * stages the worktree into a scratch file, so the user's real index — their
 * carefully staged half-commit, say — is never read or written.
 */
async function snapshot(
  root: string,
  gitDir: string | null,
  label: string,
  log: Log,
): Promise<string | null> {
  // Unique per call, not per millisecond: two snapshots that start in the same
  // tick would otherwise stage into the SAME scratch index and hand each other
  // the wrong tree — silently, as a plausible-looking file list. Two roots of
  // one run, or a cron job firing while a chat message is answered, are enough.
  const indexFile = join(
    feralHome(),
    "safety",
    `index-${process.pid}-${Date.now()}-${randomUUID()}`,
  );
  const env: Record<string, string> = { GIT_INDEX_FILE: indexFile };
  if (gitDir) {
    env.GIT_DIR = gitDir;
    env.GIT_WORK_TREE = root;
  }
  try {
    await mkdir(join(feralHome(), "safety"), { recursive: true });
    const add = await git(["add", "-A", "--", "."], root, env);
    // A partial add (an unreadable file, a permission error) still produces a
    // usable tree; only a total failure is fatal.
    if (add.code !== 0 && !add.stderr.includes("warning")) {
      log(`safety-point: add failed in ${root}: ${add.stderr}`);
      return null;
    }
    const tree = await git(["write-tree"], root, env);
    if (tree.code !== 0 || !tree.stdout) {
      log(`safety-point: write-tree failed in ${root}: ${tree.stderr}`);
      return null;
    }
    // No parent: an orphan snapshot that cannot be mistaken for, or interfere
    // with, the user's own history.
    const commit = await git(
      ["commit-tree", tree.stdout, "-m", `feral safety point: ${label}`],
      root,
      env,
    );
    if (commit.code !== 0 || !commit.stdout) {
      log(`safety-point: commit-tree failed in ${root}: ${commit.stderr}`);
      return null;
    }
    const sha = commit.stdout.split("\n")[0]!.trim();
    // A ref keeps the objects from being garbage-collected. Namespaced well
    // away from refs/heads and refs/tags so nothing lists it by accident.
    await git(["update-ref", `refs/feral/safety/${Date.now()}`, sha], root, env);
    return sha;
  } catch (err) {
    log(`safety-point: snapshot failed in ${root}: ${String(err)}`);
    return null;
  } finally {
    await rm(indexFile, { force: true }).catch(() => {});
  }
}

/**
 * Snapshot the workspace before an unattended run.
 *
 * Returns null when no snapshot is possible (no git, no workspace, an
 * unsuitable root). That is a degraded mode, not an error: the run proceeds and
 * the digest says plainly that changes could not be tracked, which is far
 * better than blocking the task or implying safety that is not there.
 */
export async function createSafetyPoint(
  label: string,
  log: Log = () => {},
  root?: string,
): Promise<SafetyPoint | null> {
  // The caller passes the workspace root it already resolved (boot.ts owns
  // `loadWorkspaceRoots`); cwd is the fallback for callers that have none.
  const target = root ?? process.cwd();
  try {
    if (!(await stat(target).then((s) => s.isDirectory()).catch(() => false))) return null;
  } catch {
    return null;
  }
  const unsuitable = snapshottable(target);
  if (unsuitable) {
    log(`safety-point: skipped — ${unsuitable} (${target})`);
    return null;
  }

  const repoRoot = await realRepoRoot(target);
  const effectiveRoot = repoRoot ?? resolve(target);
  const gitDir = repoRoot ? null : await ensureShadow(effectiveRoot, log);
  if (!repoRoot && !gitDir) return null;

  const before = await snapshot(effectiveRoot, gitDir, label, log);
  if (!before) return null;
  log(`safety-point: ${effectiveRoot} snapshotted at ${before.slice(0, 8)}${gitDir ? " (shadow)" : ""}`);
  return { root: effectiveRoot, before, gitDir, label, createdAt: Date.now() };
}

/** Parse `git diff --numstat` into a file list and totals. */
function parseNumstat(out: string): { files: string[]; insertions: number; deletions: number } {
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of out.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] !== "-") insertions += Number(m[1]);
    if (m[2] !== "-") deletions += Number(m[2]);
    files.push(m[3]!);
  }
  return { files, insertions, deletions };
}

/**
 * What changed on disk since the safety point was taken.
 *
 * Takes a second snapshot and diffs the two commits, rather than diffing the
 * commit against the working tree: only the two-snapshot form sees files that
 * were newly created, and a run that creates files is the common case.
 */
export async function changedSince(
  point: SafetyPoint | SafetyPoint[] | null,
  log: Log = () => {},
): Promise<ChangeSummary> {
  const points = point === null ? [] : Array.isArray(point) ? point : [point];
  if (points.length === 0) {
    return {
      available: false,
      files: [],
      insertions: 0,
      deletions: 0,
      restoreHint: null,
      reason: "no safety point was taken (workspace is not snapshottable, or git is unavailable)",
    };
  }
  if (points.length === 1) return changedSinceOne(points[0]!, log);

  // ponytail: sequential. Two or three roots of small diffs, and a parallel git
  // storm on a large repo buys nothing. Parallelise if root counts ever grow.
  const parts: ChangeSummary[] = [];
  for (const p of points) parts.push(await changedSinceOne(p, log));
  const tracked = parts.filter((p) => p.available);
  if (tracked.length === 0) {
    return {
      available: false,
      files: [],
      insertions: 0,
      deletions: 0,
      restoreHint: null,
      reason: parts[0]?.reason ?? "no workspace root could be tracked",
    };
  }
  // Paths are root-relative, and two roots can hold the same relative path. Once
  // there is more than one, only the absolute path identifies a file — and the
  // fingerprint that drives the no-progress guard is built from these strings,
  // so an ambiguous one would make edits in different roots cancel out.
  const files = points.flatMap((p, i) =>
    (parts[i]!.available ? parts[i]!.files : []).map((f) => ({
      status: f.status,
      path: join(p.root, f.path),
    })),
  );
  const untracked = points.filter((_, i) => !parts[i]!.available).map((p) => p.root);
  return {
    available: true,
    files,
    insertions: tracked.reduce((n, p) => n + p.insertions, 0),
    deletions: tracked.reduce((n, p) => n + p.deletions, 0),
    restoreHint: tracked.map((p) => p.restoreHint).filter(Boolean).join("\n") || null,
    // Partial coverage is stated, not implied: "available" means what follows is
    // real, never that it is the whole story.
    reason:
      untracked.length > 0 ? `not tracked: ${untracked.join(", ")}` : undefined,
  };
}

async function changedSinceOne(
  point: SafetyPoint,
  log: Log = () => {},
): Promise<ChangeSummary> {
  const after = await snapshot(point.root, point.gitDir, `${point.label} (after)`, log);
  if (!after) {
    return {
      available: false,
      files: [],
      insertions: 0,
      deletions: 0,
      restoreHint: null,
      reason: "the post-run snapshot failed",
    };
  }

  const env: Record<string, string> = {};
  if (point.gitDir) {
    env.GIT_DIR = point.gitDir;
    env.GIT_WORK_TREE = point.root;
  }

  const names = await git(
    ["diff", "--name-status", point.before, after],
    point.root,
    env,
  );
  const numstat = await git(["diff", "--numstat", point.before, after], point.root, env);
  const totals = parseNumstat(numstat.stdout);

  const files = names.stdout
    .split("\n")
    .map((l) => /^([A-Z])\d*\t(.+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ status: m[1]!, path: m[2]!.split("\t").pop()! }));

  const prefix = point.gitDir ? `git --git-dir="${point.gitDir}" --work-tree="${point.root}" ` : "git ";
  return {
    available: true,
    files,
    insertions: totals.insertions,
    deletions: totals.deletions,
    // Inspect first, restore second — deliberately in that order, because the
    // restore command is destructive and should not be the first thing copied.
    restoreHint:
      files.length > 0
        ? `${prefix}diff ${point.before.slice(0, 12)}   # review\n` +
          `${prefix}checkout ${point.before.slice(0, 12)} -- .   # undo everything above`
        : null,
  };
}

/**
 * A comparable stamp of "how the workspace differs from the snapshot".
 *
 * `changedSince` answers cumulatively — everything since the run began — which
 * is the right answer for a report and the wrong one for "did THIS turn do
 * anything". A run that changed three files in its first hour reports three
 * files on every turn afterwards, so a per-turn check against zero would never
 * fire, and the crash-loop guard that depends on it would never fire either.
 *
 * Comparing two stamps answers the per-turn question: identical means the
 * workspace is in the same state it was in after the previous turn. Insertions
 * and deletions are in it because re-editing one file leaves the file COUNT
 * unchanged while the content moves.
 *
 * An unavailable summary stamps as "unknown", which never equals itself — a
 * workspace we cannot measure must not be reported as one that did not change.
 */
export function changeFingerprint(summary: ChangeSummary): string {
  if (!summary.available) return `unknown:${Math.random()}`;
  const paths = summary.files.map((f) => `${f.status}${f.path}`).sort().join(",");
  return `${summary.insertions}+${summary.deletions}/${paths}`;
}

/**
 * Rebuild a `SafetyPoint` from the columns a run row persists.
 *
 * `changedSince` takes the object, not a ref, so after a sidecar restart the
 * original is gone — but its three fields are on the row. This is what lets a
 * resumed run diff against where the WHOLE run started rather than against
 * where the restart happened, which is the difference between "here is
 * everything that changed while you were out" and "here is the last ten
 * minutes of it".
 *
 * `gitDir` matters as much as the other two: a workspace that is not a git
 * repository is tracked through a shadow git dir under `~/.feral/safety/`, and
 * a point rebuilt without it would look for a git dir inside the project that
 * was deliberately never created there.
 *
 * Returns null when there is no usable snapshot — including a half-written row
 * with a root but no commit. Null is not "nothing changed": `changedSince(null)`
 * already answers `available: false` with a reason, and that distinction is the
 * whole point of the `available` flag.
 */
/**
 * A safety point for every workspace root that can take one.
 *
 * The agent writes wherever the workspace roots let it, so a snapshot of only
 * the first root answers "what changed while I was out" with a confident,
 * wrong zero — and feeds that same zero to the no-progress guard, which reads
 * it as a run that achieved nothing. Roots that cannot be snapshotted (the home
 * directory, a filesystem root) are skipped exactly as before; they simply do
 * not contribute a point.
 */
export async function createSafetyPoints(
  label: string,
  log: Log = () => {},
  roots: string[] = [],
): Promise<SafetyPoint[]> {
  const points: SafetyPoint[] = [];
  for (const root of roots) {
    const point = await createSafetyPoint(label, log, root);
    if (point) points.push(point);
  }
  return points;
}

/** The three run columns, holding a whole list of points instead of one. */
export function safetyColumns(points: SafetyPoint[]): {
  root: string | null;
  before: string | null;
  gitDir: string | null;
} {
  if (points.length === 0) return { root: null, before: null, gitDir: null };
  return {
    root: JSON.stringify(points.map((p) => p.root)),
    before: JSON.stringify(points.map((p) => p.before)),
    gitDir: JSON.stringify(points.map((p) => p.gitDir)),
  };
}

/** A JSON list of values, or a single legacy value written before the list. */
function parseColumn(value: string | null): Array<string | null> {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as Array<string | null>;
  } catch {
    // A row written when the column held one bare path.
  }
  return [value];
}

/**
 * Every point on a persisted row — the list form of {@link safetyPointFrom}.
 *
 * Rows written before the columns held lists carry a bare path, which parses
 * back to a single point, so a run interrupted across the upgrade still
 * resumes against its original snapshot instead of silently losing it.
 */
export function safetyPointsFrom(run: {
  id: string;
  createdAt: number;
  safetyRoot: string | null;
  safetyBefore: string | null;
  safetyGitDir: string | null;
}): SafetyPoint[] {
  const roots = parseColumn(run.safetyRoot);
  const befores = parseColumn(run.safetyBefore);
  const gitDirs = parseColumn(run.safetyGitDir);
  const points: SafetyPoint[] = [];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const before = befores[i];
    if (!root || !before) continue; // half-written: unavailable beats unreadable
    points.push({
      root,
      before,
      gitDir: gitDirs[i] ?? null,
      label: `run/${run.id}`,
      createdAt: run.createdAt,
    });
  }
  return points;
}

export function safetyPointFrom(run: {
  id: string;
  createdAt: number;
  safetyRoot: string | null;
  safetyBefore: string | null;
  safetyGitDir: string | null;
}): SafetyPoint | null {
  if (!run.safetyRoot || !run.safetyBefore) return null;
  return {
    root: run.safetyRoot,
    before: run.safetyBefore,
    gitDir: run.safetyGitDir,
    label: `run/${run.id}`,
    createdAt: run.createdAt,
  };
}
