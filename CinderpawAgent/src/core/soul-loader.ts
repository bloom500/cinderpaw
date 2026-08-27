/**
 * SOUL.md loader.
 *
 * Cinderpaw Agent's identity is defined in SOUL.md, shipped as a bundled default
 * and overridable by the user at `~/.feral/SOUL.md`. The loader picks whichever
 * exists (user wins), computes a stable version hash for cache-invalidation
 * and audit logging, and warns when the file exceeds recommended size limits.
 *
 * The watcher (`watchSoul`) is a hot-reload mechanism for the user override —
 * it does NOT watch the bundled file (changes there require a release). The
 * watcher is debounced because editors often emit multiple events per save.
 *
 * Build behaviour: the bundled SOUL.md is embedded into the binary as a
 * compile-time string via Bun's `import ... with { type: "text" }` attribute.
 * This avoids the runtime file-read issue (where the file does not exist in
 * the temp directory Bun uses for compiled binaries).
 */

import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { feralHome } from "../config.ts";
import { APP_HOME_DIR_NAME } from "../brand.ts";
// @ts-expect-error — Bun's text import attribute, not typed by @types/bun yet.
import bundledSoul from "../SOUL.md" with { type: "text" };
// @ts-expect-error — Bun's text import attribute, not typed by @types/bun yet.
import bundledIdentity from "../IDENTITY.md" with { type: "text" };
// @ts-expect-error — Bun's text import attribute, not typed by @types/bun yet.
import bundledAgents from "../AGENTS.md" with { type: "text" };

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
  /**
   * WHO the agent is — SOUL.md + IDENTITY.md — without AGENTS.md's working
   * manual. For a surface that needs the character and not the job: a voice
   * call is briefed with this once and has one tool, so the text agent's tool
   * discipline is four kilobytes of instructions about work it is not doing,
   * crowding out the part that decides how it sounds.
   */
  persona: string;
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
 * The "bundled" path is informational only — at runtime the bundled content
 * is the compile-time-embedded `bundledSoul` constant (see top of file).
 * We still resolve a path for diagnostics and for the hot-reload message
 * ("no user override at <path>"). The path points at a phantom location
 * because the binary does not contain a separate SOUL.md file.
 */
export function resolveSoulPaths(homeDir?: string): SoulPaths {
  // The bundled SOUL.md is embedded at build time; the resolved path is
  // for diagnostics only. Pointing at the source location is more honest
  // than pretending there's a file on disk.
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "..", "SOUL.md");
  const user = join(profileDir(homeDir), "SOUL.md");
  return { bundled, user };
}

/**
 * The profile dir to read overrides from. `homeDir` stays the test-isolation
 * seam (an OS home, `.feral` appended); omitting it — every production caller —
 * goes through `feralHome()`, so CINDERPAW_HOME is honored. It previously defaulted
 * to `homedir()`, which is why an isolated profile still loaded the real user's
 * SOUL.md and IDENTITY.md.
 */
function profileDir(homeDir?: string): string {
  return homeDir === undefined ? feralHome() : join(homeDir, APP_HOME_DIR_NAME);
}

/**
 * Companion identity documents, each bundled at build time and individually
 * overridable by the user at `~/.feral/<NAME>.md`:
 *
 *   - IDENTITY.md — who the agent is (name, nature, audience)
 *   - AGENTS.md   — working habits (tools, memory, skills, judgment)
 *
 * Returns the composed text of all companions, user override winning per
 * file. Pure aside from the existsSync/readFileSync probes; any read error
 * falls back to the bundled copy so a corrupt override never bricks startup.
 */
function loadCompanion(file: string, bundled: string, homeDir?: string): string {
  const userPath = join(profileDir(homeDir), file);
  let content = bundled ?? "";
  if (existsSync(userPath)) {
    const userContent = safeRead(userPath);
    if (userContent.length > 0) content = userContent;
  }
  return content.trim();
}

/** Join the non-empty parts with the separator the composed document uses. */
function compose(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("\n\n---\n\n");
}

/**
 * Load the SOUL.md, preferring the user override. The bundled default is
 * the compile-time-embedded `bundledSoul` string (set via Bun's text import).
 * Throws only if the bundled content is missing (a programmer error — the
 * binary should never ship without it). User-file read errors are caught
 * and logged so a corrupt override never bricks the agent.
 */
export function loadSoul(homeDir?: string): SoulConfig {
  const paths = resolveSoulPaths(homeDir);
  let content: string;
  let source: SoulSource;

  if (existsSync(paths.user)) {
    content = safeRead(paths.user);
    source = "user";
  } else if (bundledSoul && typeof bundledSoul === "string" && bundledSoul.length > 0) {
    content = bundledSoul;
    source = "bundled";
  } else {
    throw new Error(
      `SOUL.md not found. No user override at ${paths.user} and the ` +
        `embedded bundled content is empty. This is a build/packaging error — ` +
        `the binary is missing its identity document.`,
    );
  }

  // Append IDENTITY.md + AGENTS.md (bundled defaults, per-file user
  // overrides). They ride inside the same SOUL block of the system prompt,
  // so the version hash and size warnings cover the composed document.
  const identity = loadCompanion("IDENTITY.md", bundledIdentity as string, homeDir);
  const agents = loadCompanion("AGENTS.md", bundledAgents as string, homeDir);
  // WHO, without HOW TO WORK. A voice call is briefed with this and nothing
  // else, and AGENTS.md is the text agent's operating manual — finish the task,
  // act then narrate, tool discipline — for a surface whose only tool is
  // `ask_cinder`. Four kilobytes about a job the caller is not doing, diluting
  // the two that say who is speaking. Its own header draws the same line:
  // "Personality lives in SOUL.md; this file is the operating manual".
  const persona = compose(content.trim(), identity);
  content = compose(persona, agents);

  const version = createHash("sha256").update(content).digest("hex").slice(0, 8);
  const approxTokens = Math.ceil(content.length / CHARS_PER_TOKEN);
  maybeWarnSize(source, approxTokens, paths);

  return {
    content,
    persona,
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
  homeDir: string | undefined,
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
