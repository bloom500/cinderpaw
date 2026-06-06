/**
 * SOUL.md loader.
 *
 * Feral Agent's identity is defined in SOUL.md, shipped as a bundled default
 * and overridable by the user at `~/.feral/SOUL.md`. The loader picks whichever
 * exists (user wins), computes a stable version hash for cache-invalidation
 * and audit logging, and warns when the file exceeds recommended size limits.
 *
 * The watcher (`watchSoul`) is a hot-reload mechanism for the user override —
 * it does NOT watch the bundled file (changes there require a release). The
 * watcher is debounced because editors often emit multiple events per save.
 */

import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

/** Approximate token cost ceiling before we warn the user. */
export const SOFT_CAP_TOKENS = 4_000;
/** Above this we warn loudly — anything bigger is almost certainly a mistake. */
export const HARD_WARN_TOKENS = 10_000;
/** Rough heuristic: 1 token ≈ 4 chars of English. */
const CHARS_PER_TOKEN = 4;

export type SoulSource = "user" | "bundled";

export interface SoulConfig {
  /** The raw SOUL.md text. Injected verbatim as the first system-prompt block. */
  content: string;
  /** Which file this content came from. */
  source: SoulSource;
  /** Short SHA-256 hash of the content. Use for cache-busting and audit logs. */
  version: string;
  /** Epoch ms when the content was last read. */
  loadedAt: number;
  /** Approximate token count. */
  approxTokens: number;
}

export interface SoulPaths {
  /** Absolute path of the bundled SOUL.md (the default shipped with the binary). */
  bundled: string;
  /** Absolute path of the user override, if one exists at `~/.feral/SOUL.md`. */
  user: string;
}

/**
 * Resolve the bundled and user SOUL.md paths. Pure — no I/O — so callers can
 * use this to display "you can edit your soul here" messages.
 *
 * `import.meta.dir` resolves to the directory of this source file at runtime.
 * In a compiled Bun binary, the bundled SOUL.md sits next to the executable.
 */
export function resolveSoulPaths(homeDir: string = homedir()): SoulPaths {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "..", "SOUL.md");
  const user = join(homeDir, ".feral", "SOUL.md");
  return { bundled, user };
}

/**
 * Load the SOUL.md, preferring the user override. Throws only if the bundled
 * file is missing (a programmer error — the binary should never ship without
 * it). User-file read errors are caught and logged so a corrupt override
 * never bricks the agent.
 */
export function loadSoul(homeDir: string = homedir()): SoulConfig {
  const paths = resolveSoulPaths(homeDir);
  let content: string;
  let source: SoulSource;

  if (existsSync(paths.user)) {
    content = safeRead(paths.user);
    source = "user";
  } else if (existsSync(paths.bundled)) {
    content = safeRead(paths.bundled);
    source = "bundled";
  } else {
    throw new Error(
      `SOUL.md not found. Expected bundled at ${paths.bundled}. ` +
        `This is a build/packaging error — the binary is missing its identity document.`,
    );
  }

  const version = createHash("sha256").update(content).digest("hex").slice(0, 8);
  const approxTokens = Math.ceil(content.length / CHARS_PER_TOKEN);
  maybeWarnSize(source, approxTokens, paths);

  return {
    content,
    source,
    version,
    loadedAt: Date.now(),
    approxTokens,
  };
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    // A unreadable user override falls back to the bundled one; we don't
    // brick startup over a permissions glitch.
    console.error(`[soul] failed to read ${path}: ${errMessage(err)}`);
    return "";
  }
}

function maybeWarnSize(source: SoulSource, tokens: number, paths: SoulPaths): void {
  if (tokens > HARD_WARN_TOKENS) {
    console.warn(
      `[soul] WARNING: SOUL.md (${source}) is ~${tokens.toLocaleString()} tokens ` +
        `(hard cap ${HARD_WARN_TOKENS.toLocaleString()}). This will inflate every ` +
        `system prompt. Edit ${paths.user} to slim it down.`,
    );
  } else if (tokens > SOFT_CAP_TOKENS) {
    console.warn(
      `[soul] SOUL.md (${source}) is ~${tokens.toLocaleString()} tokens (soft cap ` +
        `${SOFT_CAP_TOKENS.toLocaleString()}). Consider trimming — every token here is ` +
        `paid on every LLM call.`,
    );
  }
}

/**
 * Watch the user-override SOUL.md and re-emit a fresh SoulConfig on change.
 * Debounced (50ms) because editors and IDEs emit multiple events per save.
 *
 * Returns a cleanup function. Call it on shutdown to release the fs handle.
 *
 * If the user override does not exist yet, returns a no-op cleanup (the agent
 * is using the bundled identity, which can only change on release).
 */
export function watchSoul(
  homeDir: string,
  onChange: (soul: SoulConfig) => void,
): () => void {
  const paths = resolveSoulPaths(homeDir);
  if (!existsSync(paths.user)) {
    return () => {};
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = true;

  const handler: Parameters<FSWatcher["on"]>[1] = () => {
    if (!active) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!active) return;
      try {
        const fresh = loadSoul(homeDir);
        onChange(fresh);
      } catch (err) {
        console.error(`[soul] reload failed: ${errMessage(err)}`);
      }
    }, 50);
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(paths.user, { persistent: false }, handler);
  } catch (err) {
    console.error(`[soul] cannot watch ${paths.user}: ${errMessage(err)}`);
    return () => {};
  }

  return () => {
    active = false;
    if (timer) clearTimeout(timer);
    try {
      watcher.close();
    } catch {
      // already closed; safe to ignore
    }
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
