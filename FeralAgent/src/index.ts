/**
 * Feral Agent — entry point.
 *
 * Wires the four layers together and starts the selected transport:
 *   Sandbox (audit → egress → inference) → Memory → Tools → Agent core → Transport
 *
 * Security is constructed first: the audit log, egress proxy, and inference
 * router exist before any tool is registered or any message is handled.
 */

import { resolve, delimiter, sep } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { openDatabase } from "./db.ts";
import { AuditLog } from "./sandbox/audit-log.ts";
import { EgressProxy } from "./sandbox/egress-proxy.ts";
import { RealProcessSandbox } from "./sandbox/process-sandbox.ts";
import { InferenceRouter } from "./sandbox/inference-router.ts";
import { EpisodicMemory } from "./memory/episodic.ts";
import { SemanticMemory } from "./memory/semantic.ts";
import { RecallEngine } from "./memory/recall.ts";
import { MemoryExtractor, isJunkFactKey } from "./memory/extractor.ts";
import { Reconciler } from "./memory/reconciler.ts";
import { runMigration } from "./memory/fractal/migration.ts";
import { MemoryGraph } from "./memory/graph.ts";
import { MemoryGraphCleaner } from "./memory/graph-cleaner.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { createReadFileTool } from "./tools/builtin/read-file.ts";
import { createWriteFileTool } from "./tools/builtin/write-file.ts";
import { createListDirectoryTool } from "./tools/builtin/list-directory.ts";
import { createEditFileTool } from "./tools/builtin/edit-file.ts";
import { createFileSearchTool } from "./tools/builtin/file-search.ts";
import { createGrepTool } from "./tools/builtin/grep.ts";
import { createShellExecTool } from "./tools/builtin/shell-exec.ts";
import { createGitStatusTool, createGitDiffTool, createGitLogTool, createGitCommitTool, createGitBranchTool } from "./tools/builtin/git.ts";
import { createHttpRequestTool } from "./tools/builtin/http-request.ts";
import { createTimeDateTool } from "./tools/builtin/time-date.ts";
import { createCalculatorTool } from "./tools/builtin/calculator.ts";
import { createWebSearchTool } from "./tools/builtin/web-search.ts";
import { createFetchUrlTool } from "./tools/builtin/fetch-url.ts";
import { createReadWebpageTool } from "./tools/builtin/read-webpage.ts";
import { createDeepResearchTool } from "./tools/builtin/deep-research.ts";
import { createToolHealthTool } from "./tools/builtin/tool-health.ts";
import { createScanWorkspaceTool } from "./tools/builtin/scan-workspace.ts";
import { createReadSkillTool } from "./tools/builtin/read-skill.ts";
import { createListSkillsTool } from "./tools/builtin/list-skills.ts";
import { createCodeQualityTool } from "./tools/builtin/code-quality.ts";
import { ToolObservationLog } from "./telemetry/tool-observations.ts";
import { createDelegateTaskTool } from "./tools/builtin/delegate-task.ts";
import { createRecallTool } from "./tools/builtin/recall.ts";
import { AgentLoop } from "./core/agent-loop.ts";
import { HeartbeatLoop } from "./core/heartbeat.ts";
import { HookRegistry } from "./core/hook-registry.ts";
import { CronJobsRepo, CronScheduler, deliverCron } from "./cron/index.ts";
import { TauriTransport } from "./transports/tauri.ts";
import { ConnectorManager } from "./transports/connectors.ts";
import { bootstrapOnce } from "./rsi/mod.ts";
import { RsiBridge } from "./rsi/bridge.ts";
import { setEmbedInvoker, rsiBridgeEmbed, embed } from "./memory/fractal/embed.ts";
import { summarizeFromRouter, routerInfer } from "./memory/fractal/summarize.ts";
import { FractalMemory, type FractalActivity } from "./memory/fractal/fractal-memory.ts";
import { LEAF_STORE_FILENAME } from "./memory/fractal/leaf-store.ts";
import { withTimeout } from "./memory/fractal/bench/orchestrator.ts";
import { RsiSidecar } from "./rsi/sidecar.ts";
import { shouldAutostartPassive } from "./rsi/passive-supervisor.ts";
import { createDreamCycle } from "./rsi/dream-cycle.ts";
import { defaultJournalPath } from "./rsi/journal.ts";
import { ActivityMonitor } from "./rsi/activity-monitor.ts";
import { resolveDreamConfig, dreamCloudGate } from "./rsi/dream-config.ts";
import { episodeStartOptions } from "./rsi/episode-options.ts";
import {
  mapGenomeToAgentConfig,
  readChampion,
  defaultChampionPath,
} from "./rsi/champion.ts";
import type { DeliveryTarget, Schedule } from "./types.ts";
import { loadSoul, watchSoul, resolveSoulPaths } from "./core/soul-loader.ts";
import { loadUserConfig } from "./core/user-loader.ts";
import { AskUserBridgeImpl } from "./core/ask-user-bridge.ts";
import { createAskUserTool } from "./tools/builtin/ask-user.ts";
import { DesktopControlBridgeImpl } from "./core/desktop-control-bridge.ts";
import { createControlAppTool } from "./tools/builtin/control-app.ts";
import { LeadDesk } from "./core/lead-desk.ts";
import { createCaptureLeadTool } from "./tools/builtin/capture-lead.ts";
import { createEscalateToHumanTool } from "./tools/builtin/escalate-to-human.ts";
import { createScheduleMeetingTool } from "./tools/builtin/schedule-meeting.ts";
import type { InferenceConfig, ModelTarget, Transport } from "./types.ts";

interface AppConfig {
  transport: "tauri";
  dbPath: string;
  /**
   * Every fs/shell/git tool is scoped to these roots. Multiple roots so the
   * agent can work across the project, a scratch dir, and any extra paths the
   * user whitelists — without re-configuring per project.
   */
  workspaceRoots: string[];
  inference: InferenceConfig;
}

/** The agent's own home: RSI git substrate, SQLite db, SOUL/identity. */
const FERAL_HOME = resolve(homedir(), ".feral");

/**
 * Resolve the agent's filesystem sandbox roots.
 *
 * - `FERAL_WORKSPACE` is a path-list (`;` on Windows, `:` elsewhere). When
 *   unset it defaults to the launch cwd, so "work in the project I opened"
 *   keeps working.
 * - A dedicated scratch dir under ~/.feral/workspace is ALWAYS added, so a
 *   task always has somewhere it fully owns to read/write even if cwd is
 *   read-only.
 * - Self-protection wall: the agent gets broad file + shell access, but never
 *   to its own brain. Any root that OVERLAPS ~/.feral — whether it contains it
 *   (an ancestor, including the filesystem root) or sits inside it (RSI repo,
 *   db, SOUL) — is dropped with a warning. The scratch subtree is the one
 *   allowed exception. This is the "can't modify its own code/state" guarantee.
 */

/** True iff `child` is `parent` or lies beneath it. Appends a separator before
 *  the prefix test so a filesystem root (`"/"` / `"C:\\"`, which already ends
 *  in a separator) doesn't produce a double-separator prefix that never
 *  matches — the trailing-separator bug that let `FERAL_WORKSPACE=/` slip the
 *  self-protection wall. */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(base);
}

export function loadWorkspaceRoots(env: NodeJS.ProcessEnv): string[] {
  const raw = env.FERAL_WORKSPACE;
  const requested = raw && raw.trim()
    ? raw.split(delimiter).map((s) => s.trim()).filter(Boolean)
    : [process.cwd()];
  const roots = requested.map((p) => resolve(p));

  const scratch = resolve(FERAL_HOME, "workspace");
  try { mkdirSync(scratch, { recursive: true }); } catch { /* best effort */ }
  roots.push(scratch);

  const guarded = roots.filter((r) => {
    if (isWithin(r, scratch)) return true; // scratch subtree — the one allowed path under ~/.feral
    // Drop any root that overlaps the brain in EITHER direction: an ancestor
    // that contains ~/.feral (isWithin(FERAL_HOME, r)) OR a path inside ~/.feral
    // that isn't scratch (isWithin(r, FERAL_HOME)). Both would expose RSI/db/SOUL.
    if (isWithin(FERAL_HOME, r) || isWithin(r, FERAL_HOME)) {
      console.warn(
        `[config] dropping workspace root "${r}" — it would expose ${FERAL_HOME} ` +
          `(agent state/identity). Point FERAL_WORKSPACE at a project dir instead.`,
      );
      return false;
    }
    return true;
  });
  return [...new Set(guarded)];
}

/** True when a base URL points at a loopback (local) host. */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function loadConfig(): AppConfig {
  const env = process.env;
  const workspaceRoots = loadWorkspaceRoots(env);

  // ":memory:" is a SQLite sentinel and must not be path-resolved.
  const dbEnv = env.FERAL_DB ?? "data/feral.db";
  const dbPath = dbEnv === ":memory:" ? ":memory:" : resolve(dbEnv);

  return {
    transport: "tauri", // only transport wired in V1
    dbPath,
    workspaceRoots,
    inference: {
      primary: {
        // Default to the bundled Rust/llama.cpp engine (OpenAI-compatible API on
        // 11435). Override with FERAL_PROVIDER/FERAL_BASE_URL to target external
        // Ollama (11434) or any other OpenAI-compatible server.
        provider: env.FERAL_PROVIDER ?? "openai_compatible",
        model: env.FERAL_MODEL ?? "qwen2.5:7b",
        baseUrl: env.FERAL_BASE_URL ?? "http://127.0.0.1:11435",
        // Optional API key for cloud providers (OpenAI-compatible
        // / Anthropic / Nvidia NIM). Ignored for `ollama`. The
        // trustedBaseUrls check below is what prevents this from
        // being a free-for-all — a stray key still needs an
        // allowlisted baseUrl to actually reach a model.
        ...(env.FERAL_API_KEY ? { apiKey: env.FERAL_API_KEY } : {}),
      },
      ...(env.FERAL_FALLBACK_MODEL
        ? {
            fallback: {
              provider: env.FERAL_FALLBACK_PROVIDER ?? "ollama",
              model: env.FERAL_FALLBACK_MODEL,
              baseUrl: env.FERAL_FALLBACK_BASE_URL ?? "http://localhost:11434",
              ...(env.FERAL_FALLBACK_API_KEY
                ? { apiKey: env.FERAL_FALLBACK_API_KEY }
                : {}),
            },
          }
        : {}),
      tokenBudget: {
        // P1-#1: relaxed-but-real cap. The user wants infinite-feeling
        // conversations but a runaway agent that loops in retry hell or
        // burns $50 in 10 minutes has to be stopped somewhere. These
        // defaults are deliberately generous:
        //
        //   5M per conversation  ≈ 2,500–10,000 normal turns, or ~50–200
        //                          deep-research turns. A real user never
        //                          hits this; a runaway agent does.
        //   50M per day          ≈ ~$15/day on Haiku, ~$150 on Sonnet,
        //                          ~$750 on Opus. Bankrupting only by
        //                          genuine abuse or a bug.
        //
        // Behavior at limit: `onExhausted: "stop"` — finish the current
        // turn cleanly and surface a `budget_exceeded` event so the UI
        // can ask the user whether to continue. No silent bricking.
        //
        // Override: FERAL_BUDGET_CONVERSATION / FERAL_BUDGET_DAY / *_POLICY
        // env vars. Pass an explicit number to lower (or raise) the cap;
        // pass `Infinity` (the previous default) for the unbounded
        // pre-P1-#1 behavior if a power user really wants it.
        perConversation: Number(env.FERAL_BUDGET_CONVERSATION ?? 5_000_000),
        perDay: Number(env.FERAL_BUDGET_DAY ?? 50_000_000),
        onExhausted:
          env.FERAL_BUDGET_POLICY === "stop" ? "stop" : "compress_and_continue",
      },
      // Comma-separated allowlist of inference endpoints. Omitted → defaults to
      // exactly the configured primary/fallback targets.
      ...(env.FERAL_TRUSTED_BASE_URLS
        ? {
            trustedBaseUrls: env.FERAL_TRUSTED_BASE_URLS.split(",")
              .map((u) => u.trim())
              .filter(Boolean),
          }
        : {}),
    },
  };
}

function buildTransport(kind: AppConfig["transport"]): Transport {
  switch (kind) {
    case "tauri":
      return new TauriTransport();
    default:
      // Exhaustive: V2 transports are stubbed and not selectable yet.
      throw new Error(`unsupported transport: ${kind}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);

  // --- RSI bootstrap (Faza 0 — Keystone) ---
  // Boot the Bounded-RSI substrate. Two slices, two owners:
  //
  //   - Rust slice (git repo at ~/.feral/rsi/, PLAN.md, SandboxBounds,
  //     audit chain) — bootstrapped by Tauri's `setup()` hook in
  //     src-tauri/src/lib.rs BEFORE the sidecar process spawns. By
  //     the time we reach this line, that slice is already live.
  //
  //   - Sidecar slice (5 tables in feral.db, 4 initial
  //     strategy-genomes) — bootstrapped here. Idempotent: re-running
  //     is a no-op.
  //
  // This is fail-soft: a failed bootstrap here doesn't kill the
  // sidecar — chat still works, just without RSI. The error is
  // surfaced to the log so the operator can diagnose.
  try {
    const result = bootstrapOnce(db.raw);
    if (!result.allTablesPresent) {
      log(`RSI tables missing: ${result.missingTables.join(", ")} — migration may have failed`);
    }
    log(
      `RSI bootstrap → strategy_seeds=${result.strategyGenomesSeeded} ` +
        `tables_ok=${result.allTablesPresent}`,
    );
  } catch (err) {
    log(`RSI bootstrap failed (continuing without RSI): ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Identity: load SOUL.md (bundled default + user override). The loader
  // is the source of truth for the agent's tone, identity, and behavior; it
  // is wired in early so the system prompt is consistent on the first turn
  // and the watcher is alive before any user request lands. ---
  const soul = loadSoul();
  log(`soul loaded — source=${soul.source} version=${soul.version} ` +
    `~${soul.approxTokens.toLocaleString()} tokens`);

  // --- Personalization: read ~/.feral/onboarding.json (written by the React
  // onboarding wizard). The userName and agentName are injected as a USER
  // block in the system prompt so the model uses them in replies. If no
  // record exists yet (user skipped onboarding), the block is omitted and
  // the agent uses generic defaults. ---
  const user = loadUserConfig();
  if (user.hasOnboarded) {
    log(`user onboarded — userName="${user.userName}" agentName="${user.agentName}"`);
  } else {
    log(`user not onboarded — using generic defaults (no USER block)`);
  }
  const stopSoulWatcher = watchSoul(homedir(), (fresh) => {
    // Hot-reload: only NEW sessions pick up the change. Active sessions
    // keep their original system prompt so the conversation stays coherent.
    log(`soul hot-reload — source=${fresh.source} version=${fresh.version} ` +
      `~${fresh.approxTokens.toLocaleString()} tokens (applies to new sessions)`);
  });
  if (stopSoulWatcher === (() => {})) {
    // Watcher returned the no-op stub — only happens when there is no user
    // override. Surface the bundled path so the user knows where to find it.
    const paths = resolveSoulPaths();
    log(`soul — using bundled default (no user override at ${paths.user})`);
  }

  // --- Layer 3: Sandbox (built first) ---
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  // NB: deliberately NOT named `process` to avoid shadowing the global
  // Node `process` object (which we still need below for process.env).
  const processSandbox = new RealProcessSandbox(audit.logger);
  const router = new InferenceRouter(config.inference, audit.logger, db.raw);

  // Bundled local engine used as an automatic fallback when the user hot-swaps
  // to a cloud model. A transient cloud failure (e.g. MiniMax 429 rate-limit)
  // then degrades to the on-device model instead of hard-failing the turn.
  // Prefer the boot primary when it is itself local; otherwise the default
  // bundled-engine target (always on 11435). ponytail: if no local model is
  // loaded the fallback also fails — same "both failed" error, no worse.
  const localFallbackTarget: ModelTarget = isLoopbackUrl(
    config.inference.primary.baseUrl,
  )
    ? config.inference.primary
    : {
        provider: "openai_compatible",
        model: process.env.FERAL_MODEL ?? "qwen2.5:7b",
        baseUrl: process.env.FERAL_BASE_URL ?? "http://127.0.0.1:11435",
      };

  // --- Layer 2: Memory ---
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const semantic = new SemanticMemory(db.raw, audit.logger);
  const recall = new RecallEngine(episodic, semantic);

  // --- Memory graph (moved up so tools can reference it at registry build time) ---
  const memoryGraph = new MemoryGraph();
  const graphCleaner = new MemoryGraphCleaner();
  graphCleaner.startSchedule();
  // Boot-time hygiene sweep: purge junk facts/nodes written by the old
  // colon-split extractor (keys like "- language", "1. user shared a link",
  // reasoning leakage). Runs every start so junk can never survive a restart
  // even if an older binary wrote it — deletions stay deleted.
  {
    let sweptFacts = 0;
    for (const fact of semantic.all()) {
      if (isJunkFactKey(fact.key)) {
        semantic.delete(fact.key);
        sweptFacts++;
      }
    }
    const sweptNodes = memoryGraph.sweepJunk((idText, label) =>
      isJunkFactKey(idText) || isJunkFactKey(label.toLowerCase()),
    );
    if (sweptFacts > 0 || sweptNodes > 0) {
      log(`memory hygiene: removed ${sweptFacts} junk fact(s), ${sweptNodes} junk graph node(s)`);
    }
  }
  // Surface accumulated graph facts in every recall so a brand-new session
  // starts with what the agent already knows about the user.
  recall.setGraph(memoryGraph);

  // --- ECC tool observation telemetry ---
  const dataDir = config.dbPath === ":memory:" ? "data" : require("node:path").dirname(config.dbPath);
  const observations = new ToolObservationLog(dataDir);

  // --- Fractal Memory Search (semantic recall over the RAPTOR tree) ---
  // Wraps the legacy RecallEngine: with a built tree + an embedding model it
  // serves the semantic + FTS5 hybrid; otherwise it transparently falls back
  // to RecallEngine, so there is zero regression before the model is on disk.
  // The tree is loaded from disk here; the first build runs in the background
  // after the embed bridge is wired (below), and is a no-op without a model.
  //
  // `loadLeaves` reuses the per-row embedding already stored in SQLite when
  // present — that's what makes subsequent rebuilds free of re-embedding.
  // `persistEmbeddings` is the write-back hook the tree builder calls after
  // each chunk, so freshly-computed vectors land on disk for next time
  // (crash-safe: rows that didn't get written just get re-embedded next run).
  // Organism pulse forwarder: FractalMemory emits recall/grow activity that
  // drives the living Mandelbrot. The transport doesn't exist yet, so route
  // through a holder wired to it below (same pattern as `sendHolder`).
  const fractalActivitySink: { current: (a: FractalActivity) => void } = {
    current: () => {},
  };
  const fractalMemory = new FractalMemory({
    loadLeaves: () =>
      episodic.all().map((e) => ({
        id: e.id ?? 0,
        text: e.content,
        vec: e.embedding ?? new Float32Array(0), // reuse stored vec when present
        ts: e.timestamp,
        sessionId: e.sessionId,
      })),
    embed: (texts) => embed(texts),
    summarize: summarizeFromRouter(router),
    ftsSearch: (q, limit) => episodic.search(q, limit),
    fallback: recall,
    treePath: require("node:path").join(dataDir, "fractal-tree.json"),
    leafStorePath: require("node:path").join(dataDir, LEAF_STORE_FILENAME),
    // Dev-only subset cap for the benchmark gate: build/measure over the first
    // N leaves so we get real numbers in minutes on CPU instead of hours over
    // the full corpus. Unset in production (whole corpus). See FractalMemoryDeps.
    maxLeaves: Number(process.env.FERAL_FRACTAL_BENCH_MAX_LEAVES) || 0,
    log,
    persistEmbeddings: (rows) => episodic.setEmbeddings(rows),
    clearEmbeddings: () => episodic.clearEmbeddings(),
    onActivity: (a) => fractalActivitySink.current(a),
  });

  // --- Env-cap guard ---
  // If the user is routing through a *cloud* provider (anything not on the
  // loopback) but forgot to set FERAL_FRACTAL_BENCH_MAX_LEAVES, the next
  // rebuild will try to summarise every leaf in the corpus and the
  // provider will reject the call with "context window exceeds limit".
  // That bug has already broken a manual UI bench run once (silent empty
  // tree, 0% recall on both engines). Warn loudly so the next operator
  // sees it before clicking Run Benchmark.
  {
    const baseUrl = process.env.FERAL_BASE_URL ?? "";
    const isLoopback = baseUrl === "" || /^(https?:\/\/)?(127\.|localhost)/i.test(baseUrl);
    const cap = Number(process.env.FERAL_FRACTAL_BENCH_MAX_LEAVES) || 0;
    if (!isLoopback && cap === 0) {
      log(
        `[bench-cap] WARN: FERAL_BASE_URL=${baseUrl} is non-loopback but ` +
          `FERAL_FRACTAL_BENCH_MAX_LEAVES is unset. The next fractal rebuild ` +
          `will try to summarise the full corpus (~2.7k leaves) and the ` +
          `cloud provider will likely reject with "context window exceeds limit", ` +
          `leaving you with an empty tree and 0% recall. ` +
          `Set FERAL_FRACTAL_BENCH_MAX_LEAVES=200 (or another small number) ` +
          `before launching, or the next rebuild may fail.`,
      );
    }
  }

  fractalMemory.init();

  // --- Tools (each gated by the sandbox) ---
  // ask_user bridge is created up front so the registry can hand it to
  // every tool's context. The bridge emits `ask_user` events through a
  // mutable holder — we wire the holder's target to `transport.send` once
  // the transport is built (a few lines below). Before that, events are
  // silently dropped, which is fine because no tool can run before the
  // transport is started.
  const sendHolder: { current: (e: import("./types.ts").OutboundEvent) => void } = {
    current: () => {},
  };
  const askUser = new AskUserBridgeImpl((e) => sendHolder.current(e));

  // Desktop-control bridge — structural OS control of native apps via the Rust
  // host. Same sendHolder plumbing as askUser: the request flows out over the
  // transport, the Rust host runs the OS action behind its security gate, and
  // the `desktop_control_response` is routed back to the bridge below. The
  // `control_app` tool is only registered when the user has opted in (see
  // FERAL_ENABLE_DESKTOP_CONTROL); the bridge itself is always created so the
  // response-routing wiring is unconditional.
  const desktopControl = new DesktopControlBridgeImpl((e) => sendHolder.current(e));

  // --- P0-4: hook registry. Shared singleton that every layer can
  // emit into and any plugin / future tool can subscribe to. The
  // tool registry receives it next so before_tool_call handlers can
  // block tool invocations.
  const hooks = new HookRegistry();

  // --- Reconciler (Pathway 3 step 2 Task 2 + Task 3) ---
  // Single subscriber to `after_memory_write`. Task 3 wires
  // `fractal.upsertLeaf(...)` for fact writes; Task 4 will additionally
  // mirror the result into `memoryGraph.reconcile(treeView)`. Started
  // here — after `fractalMemory.init()` and after `hooks` is built —
  // so the tree is ready before the first capture event arrives.
  const reconciler = new Reconciler({
    hooks,
    fractal: fractalMemory,
    graph: memoryGraph,
    embed,
  });
  reconciler.start();

  // --- Migration (Pathway 3 step 2 Task 4) ---
  // One-shot lift of the ~41 pre-step1 facts from SemanticMemory into
  // the new reactive tree. Idempotent via marker file; failure-tolerant
  // (missing model is non-fatal — the FTS5 fallback keeps the old
  // facts reachable via auto-inject). Best-effort, fire-and-forget
  // — the result is logged but the boot does not block on it.
  void runMigration({
    semantic,
    fractal: fractalMemory,
    embed,
    dataDir,
  }).then((result) => {
    if (result.ran) {
      log(`migration: lifted ${result.facts} fact(s) into the reactive tree`);
    } else if (result.error) {
      log(`migration: skipped (${result.error}) — will retry next boot`);
    } else {
      log("migration: marker present, no-op");
    }
  }).catch((e) => {
    log(`migration: unexpected error: ${String(e)}`);
  });

  const registry = new ToolRegistry(egress, audit, processSandbox, observations, askUser, undefined, hooks, desktopControl);
  registry.register(createReadFileTool(config.workspaceRoots));
  registry.register(createWriteFileTool(config.workspaceRoots));
  registry.register(createListDirectoryTool(config.workspaceRoots));
  // edit_file: in-place string replacement (safer than overwriting)
  registry.register(createEditFileTool(config.workspaceRoots));
  // file_search: glob-style file finder under the workspace
  registry.register(createFileSearchTool(config.workspaceRoots));
  // grep: regex content search under the workspace
  registry.register(createGrepTool(config.workspaceRoots));
  // shell_exec: argv-only program runner (NO shell — no injection surface),
  // scoped to the workspace roots and a binary whitelist. On by default so the
  // agent can actually run things; set FERAL_ENABLE_SHELL_EXEC=false to disable.
  if (process.env.FERAL_ENABLE_SHELL_EXEC !== "false") {
    registry.register(createShellExecTool(config.workspaceRoots));
  }
  // git_*: process-spawn tools for the workspace
  registry.register(createGitStatusTool(config.workspaceRoots));
  registry.register(createGitDiffTool(config.workspaceRoots));
  registry.register(createGitLogTool(config.workspaceRoots));
  registry.register(createGitCommitTool(config.workspaceRoots));
  registry.register(createGitBranchTool(config.workspaceRoots));
  // http_request: only registered when at least one domain is whitelisted
  const httpDomains = (process.env.FERAL_HTTP_DOMAINS ?? "")
    .split(",").map((d) => d.trim()).filter(Boolean);
  if (httpDomains.length > 0) {
    registry.register(createHttpRequestTool(httpDomains));
  }
  // time_date + calculator: pure utilities, no permissions
  registry.register(createTimeDateTool());
  registry.register(createCalculatorTool());
  registry.register(createWebSearchTool());
  // fetch_url: extend FERAL_FETCH_DOMAINS env (comma-separated) to whitelist domains
  const fetchDomains = (process.env.FERAL_FETCH_DOMAINS ?? "")
    .split(",").map((d) => d.trim()).filter(Boolean);
  if (fetchDomains.length > 0) {
    registry.register(createFetchUrlTool(fetchDomains));
  }
  // read_webpage: Jina Reader — extracts clean markdown from any URL (no API key needed)
  const jinaApiKey = process.env.FERAL_JINA_API_KEY;
  registry.register(createReadWebpageTool(jinaApiKey));
  // deep_research: DeepResearch-style iterative loop (search → read → extract → synthesize)
  registry.register(createDeepResearchTool(router, jinaApiKey));
  // tool_health: ECC-style health report — agent can diagnose its own tool reliability
  registry.register(createToolHealthTool(observations));
  // scan_workspace: ECC AgentShield — detect secrets + code security issues in workspace
  registry.register(createScanWorkspaceTool(config.workspaceRoots[0]!));
  // read_skill: Claude Code-style on-demand body loader for locally-installed
  // skills. The system prompt only carries a short menu; the LLM calls this
  // tool to load the full SKILL.md body of any skill it wants to apply.
  registry.register(createReadSkillTool(`${homedir()}/.feral/skills`));
  // list_skills: the drawer index. Skills are no longer dumped into every
  // prompt; the model calls this to discover ids, then read_skill to load one.
  registry.register(createListSkillsTool(`${homedir()}/.feral/skills`));

  // F7 — code-quality tools. Auto-detect project type and run the
  // appropriate command (npm test, cargo test, pytest, go test, make test,
  // etc.). All five share the same factory and the same exec allowlist
  // (resolved at module load time per F0.5 hardening).
  registry.register(createCodeQualityTool("run_tests", config.workspaceRoots));
  registry.register(createCodeQualityTool("format_code", config.workspaceRoots));
  registry.register(createCodeQualityTool("lint_code", config.workspaceRoots));
  registry.register(createCodeQualityTool("install_deps", config.workspaceRoots));
  registry.register(createCodeQualityTool("build_project", config.workspaceRoots));

  // ask_user — interactive questions (Claude.ai-style). No permissions;
  // pure event emission through the AskUserBridge in the tool context.
  registry.register(createAskUserTool());

  // control_app — OS-level desktop control via the accessibility tree. This
  // is powerful (it can click/type into any non-denylisted app), so it is
  // OPT-IN, exactly like shell_exec: enable with FERAL_ENABLE_DESKTOP_CONTROL=true.
  // The Rust host ALSO independently gates every call on the same flag plus an
  // app allow/deny policy, so even if this registration is reached the host is
  // the final authority. Default OFF.
  if (process.env.FERAL_ENABLE_DESKTOP_CONTROL === "true") {
    registry.register(createControlAppTool());
    log("control_app enabled (FERAL_ENABLE_DESKTOP_CONTROL=true) — OS desktop control is active");
  }

  // recall — read-only on-demand semantic search over past conversations,
  // backed by Fractal Memory Search. Capture stays reactive (MemoryExtractor);
  // this is the explicit-search counterpart to per-turn auto-injection.
  registry.register(
    createRecallTool((q, limit) => fractalMemory.query(q, limit)),
  );

  // P0-1: delegate_task — spawn a subagent for an isolated, bounded
  // task. The subagent inherits the parent's router / sandbox /
  // audit / hooks but gets its own WorkingMemory, filtered
  // registry, and budget.
  registry.register(createDelegateTaskTool({
    router,
    parentRegistry: registry,
    allTools: registry.list(),
    audit,
    egress,
    process: processSandbox,
    observations,
    episodic,
    hooks,
    parentSessionIdFor: (ctxSessionId) =>
      // The tool's ctx.sessionId is either the parent sessionId
      // itself (when the tool is called by the parent agent) or a
      // subagent's child sessionId (for nested delegation). We
      // surface the parent's id by stripping the subagent prefix.
      ctxSessionId.startsWith("subagent:")
        ? ctxSessionId.split(":")[1] ?? ctxSessionId
        : ctxSessionId,
  }));

  // Lead-handling tools for the public connector mode (WhatsApp "business"
  // persona). They are registered globally but only EXPOSED to the public
  // profile (see PUBLIC_ALLOWED_TOOLS in transports/connectors.ts). The shared
  // LeadDesk lets escalate/schedule reach the live connector (owner ping +
  // conversation pause); records land under ~/.feral/leads/.
  const leadsDir = resolve(homedir(), ".feral", "leads");
  const leadDesk = new LeadDesk();
  registry.register(createCaptureLeadTool(leadsDir));
  registry.register(createEscalateToHumanTool(leadDesk, leadsDir));
  registry.register(createScheduleMeetingTool(leadDesk, leadsDir));

  // --- Proactive subsystem (X1) ---
  // MoodEngine + InnerThoughtsLoop used to be wired into core by default
  // (FERAL_INNER_THOUGHTS_ENABLED !== "false"). That burned inference on
  // every idle cycle, contended with the global MODEL mutex (P6), and
  // contradicted the "no-compromise privacy" pitch. They are now an
  // explicit, opt-in subsystem:
  //
  //   FERAL_PROACTIVE_ENABLED=true  → load + wire mood + inner-thoughts
  //   default (unset / =false)        → neither module is loaded or run
  //
  // The modules themselves are kept on disk (mood.ts, inner-thoughts.ts)
  // for power users / future revival. They are loaded via dynamic import
  // so a sidecar that never opts in pays zero cost — no eager class
  // definitions, no startup work, no `setInterval` ticking, no router
  // contention, no audit-log writes from `#persistThought`.
  const proactiveEnabled = process.env.FERAL_PROACTIVE_ENABLED === "true";
  let mood: import("./core/mood.ts").MoodEngine | null = null;
  let innerThoughts: import("./core/inner-thoughts.ts").InnerThoughtsLoop | null = null;
  if (proactiveEnabled) {
    const { MoodEngine } = await import("./core/mood.ts");
    const { InnerThoughtsLoop } = await import("./core/inner-thoughts.ts");
    mood = new MoodEngine();
    log("mood engine enabled (FERAL_PROACTIVE_ENABLED=true)");

    // Inner thoughts loop — heavily gated so it surfaces at most 2-3
    // messages per day, NEVER interrupts active conversations, and only
    // fires when there's genuine signal in mood + recent activity.
    // See InnerThoughtsLoop for gate details.
    innerThoughts = new InnerThoughtsLoop(router, episodic, mood, db.raw, {
      intervalMs: Number(process.env.FERAL_THOUGHTS_INTERVAL_MS ?? 2 * 60 * 1000),
      // 10 min idle — definitely a real break, not just the user looking
      // away from the screen for a second.
      minIdleMs: Number(process.env.FERAL_THOUGHTS_MIN_IDLE_MS ?? 10 * 60_000),
      // 4 hours between messages — caps cadence at ~1 per idle period.
      cooldownMs: Number(process.env.FERAL_THOUGHTS_COOLDOWN_MS ?? 4 * 60 * 60_000),
      // Hard daily cap: 2-3 proactive messages per UTC day. The user
      // can override higher (FERAL_THOUGHTS_DAILY_CAP=10) or lower (=0
      // to effectively disable emits). The four gates together produce
      // a maximally non-spammy agent when the user opts in.
      dailyCap: Number(process.env.FERAL_THOUGHTS_DAILY_CAP ?? 3),
      moodGateThreshold: Number(process.env.FERAL_THOUGHTS_MOOD_THRESHOLD ?? 0.5),
    });
    log("inner-thoughts loop enabled (opt-in via FERAL_PROACTIVE_ENABLED)");
  }

  // --- Memory extractor (async, fire-and-forget after each turn) ---
  // Path 3 step 2: the extractor fires `after_memory_write` to the
  // shared HookRegistry on every fact / observation persistence. The
  // Reconciler (constructed earlier in this file) subscribes to the
  // event and keeps the fractal tree reactive. Without a registry
  // attached, the extractor silently no-ops the fires (pre-Path-3
  // behaviour).
  const extractor = new MemoryExtractor(router, semantic, episodic, hooks);
  extractor.setGraph(memoryGraph);

  // --- Layer 1: Agent core ---
  const agent = new AgentLoop(
    router, registry, episodic,
    { onBudgetExhausted: config.inference.tokenBudget.onExhausted },
    fractalMemory,
    extractor,
    soul,
    user,
    hooks,
  );

  // --- Heartbeat loop (P2-#1) ---
  // Periodic OutboundEvent so the Tauri shell knows the sidecar is
  // alive. The transport's onMessage handler should treat absence of
  // heartbeats for N intervals as a hang signal.
  const heartbeat = new HeartbeatLoop({
    intervalMs: Number(process.env.FERAL_HEARTBEAT_INTERVAL_MS ?? 30_000),
    getActiveSessions: () => agent.activeSessionCount,
  });

  // --- Cron scheduler (P0-3) ---
  // User-schedulable jobs that run in the background.
  //
  // X3 fix (cron-as-agent): each job now runs through the full `AgentLoop`
  // — the same tool registry (read_file / web_search / delegate_task all
  // resolve), the same budget gates, episodic memory, and audit trail as a
  // user-driven session. The `cron:${job.id}` sessionId gives every job its
  // own WorkingMemory, so cron runs never pollute a real user's transcript,
  // and the per-session mutex in `handle()` serializes overlapping runs of
  // the same job. Streaming events from the run are swallowed (there is no
  // live chat to render them); only the final answer is delivered, and
  // failures surface via `onJobError` below.
  const cronRepo = new CronJobsRepo(db.raw);
  const cronScheduler = new CronScheduler({
    repo: cronRepo,
    runJob: async (job) => {
      const sessionId = `cron:${job.id}`;
      try {
        // `handle()` never throws — on failure it emits an `error` event to
        // the sink and returns the error text. Capture that event and throw
        // so the scheduler records the run as failed (and onJobError fires)
        // instead of delivering the error string as a "result".
        let runError: string | null = null;
        const content = await agent.handle(
          sessionId,
          "You are running as a scheduled background task. Complete the task " +
            "without asking for clarification; produce the final answer.\n\n" +
            `Task: ${job.task}`,
          `cron-${job.id}-${Date.now()}`,
          (event) => {
            // No live chat is attached to a cron run — chunk/tool events
            // have nowhere to render; only failures matter here.
            if (event.type === "error") runError = event.message;
          },
        );
        if (runError) throw new Error(runError);
        return content.trim();
      } finally {
        // N2 fix: the synthetic `cron:${job.id}` sessionId would otherwise
        // grow the router's per-conversation-token map forever (one entry
        // per scheduled job for the life of the sidecar). Evict it after
        // each run so a long-running Tauri session doesn't accumulate
        // thousands of stale cron entries.
        router.evictSession(sessionId);
      }
    },
    // X3: failed/timed-out runs become a visible `cron_error` event in the
    // UI instead of dying silently in the run-history table.
    onJobError: (job, message) => {
      transport.send({
        type: "cron_error",
        jobId: job.id,
        jobName: job.name,
        message,
      });
    },
    deliver: (target, content, job, ctx) => {
      // Replace the default emit with transport.send for chat targets
      // and use the egress proxy (when one is registered) for webhooks.
      // For V1 the default fetch (globalThis.fetch) is fine — the
      // webhook URL is admin-controlled, not user-controlled.
      if (target.kind === "chat") {
        transport.send({
          type: "cron_fired",
          jobId: job.id,
          jobName: job.name,
          sessionId: target.sessionId,
          content,
        });
        return;
      }
      return deliverCron(target, content, job, ctx);
    },
    tickIntervalMs: Number(process.env.FERAL_CRON_TICK_MS ?? 30_000),
    jobTimeoutMs: Number(process.env.FERAL_CRON_JOB_TIMEOUT_MS ?? 5 * 60_000),
  });

  // --- Layer 4: Transport ---
  const transport = buildTransport(config.transport);
  // Now that the transport exists, wire the ask_user bridge's emit target.
  // Every `ask_user` event from now on flows through the transport to the
  // React UI, and `ask_user_response` messages from the UI are routed back
  // to the bridge inside the `onMessage` handler below.
  sendHolder.current = (e) => transport.send(e);
  // Forward organism pulses as plain sidecar lines; Rust relays every line to
  // the frontend over `feral://agent-output`, where the organism filters for
  // `type: "fractal_activity"` (mirrors how RSI engine events travel). The
  // kind-discriminated `OutboundEvent` member added below makes this a typed
  // send — no `as unknown` cast needed for `recall` / `grow` / `seed`.
  fractalActivitySink.current = (a) =>
    transport.send({ type: "fractal_activity", ...a });

  // --- RSI sidecar (Faza 1) ---
  // The bridge writes `rsi_request` lines via transport.send; the
  // `onMessage` switch routes `rsi_response` lines back to
  // `bridge.onResponse`. The sidecar builds the production engine
  // (real adapters, real taste miner, real escape tracker) and emits
  // `rsi_engine_event` outbound events that mirror into Rust's
  // `RsiEngineState` AND ack in-flight `rsi_start`/`rsi_stop`/
  // `rsi_set_concurrency` requests via the `RsiRequestRegistry`.
  const rsiBridge = new RsiBridge({
    send: (msg) => transport.send(msg as unknown as import("./types.ts").OutboundEvent),
  });
  // Fractal Memory Search (Phase 0): point the embed module at the live bridge
  // so embed(...) routes text → Rust `embed_text` → vectors. Until a model is
  // present Rust returns an error and callers fall back to FTS5; this just
  // makes the path available.
  setEmbedInvoker(rsiBridgeEmbed(rsiBridge));
  // RAPTOR tree build, in the background now that embed() can reach Rust.
  // `rebuildIfStale` is a no-op when init() already loaded a fresh tree from
  // disk, so we don't re-pay the (cloud) summary cost on every boot — it only
  // builds on first run or after the corpus grows materially.
  void fractalMemory
    .rebuildIfStale()
    .catch((e) => log(`fractal: initial rebuild error: ${String(e)}`));
  // Dev-only benchmark gate (FERAL_RUN_FRACTAL_BENCH=1). Runs INSIDE the live
  // sidecar because embeddings only work here (the embed bridge needs Rust).
  // Builds the tree if needed, scores flat FTS5 vs the fractal hybrid on a
  // generated (or supplied) query set, writes a JSON report next to the tree,
  // and logs the ship/no-ship verdict. Never affects normal startup.
  if (process.env.FERAL_RUN_FRACTAL_BENCH) {
    void (async () => {
      try {
        const fs = require("node:fs") as typeof import("node:fs");
        await fractalMemory.rebuildIfStale();
        if (!fractalMemory.hasTree) {
          log("fractal-bench: no tree (no embedding model on disk?) — skipping");
          return;
        }
        const queriesPath = process.env.FERAL_FRACTAL_BENCH_QUERIES;
        const report = await fractalMemory.benchmark({
          infer: routerInfer(router),
          querySetJsonl: queriesPath ? fs.readFileSync(queriesPath, "utf8") : undefined,
          count: Number(process.env.FERAL_FRACTAL_BENCH_COUNT) || 50,
          seed: Number(process.env.FERAL_FRACTAL_BENCH_SEED) || 1,
        });
        const outPath = require("node:path").join(dataDir, "fractal-bench-report.json");
        fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
        const v = report.verdict;
        log(
          `fractal-bench: n=${report.n} k=${report.k} | ` +
            `recall@${report.k} fractal=${report.fractal.meanRecallAtK.toFixed(3)} ` +
            `fts=${report.fts.meanRecallAtK.toFixed(3)} | ` +
            `p99 fractal=${report.fractal.p99Ms.toFixed(1)}ms fts=${report.fts.p99Ms.toFixed(1)}ms | ` +
            `verdict=${v.ship ? "SHIP" : "HOLD"}${v.reasons.length ? " — " + v.reasons.join("; ") : ""} | ` +
            `report=${outPath}`,
        );
      } catch (e) {
        log(`fractal-bench: failed: ${String(e)}`);
      }
    })();
  }
  // Dream Cycle: event-driven scheduler replaces the old continuous
  // PassiveSupervisor loop. Config + activity monitor are built here so
  // the sidecar's onIdle can both feed telemetry and drive the scheduler's
  // sleep/cooldown. Late-bind `dream` through this holder (the scheduler
  // needs the sidecar to start it — break the cycle the same way passive did).
  const dreamCfg = resolveDreamConfig(process.env);
  const activityMonitor = new ActivityMonitor({ errorWindowMs: dreamCfg.errorWindowMs });
  const dreamTelemetryPath =
    process.env.FERAL_RSI_TELEMETRY ??
    require("node:path").join(homedir(), ".feral", "rsi", "dream.jsonl");
  // Carries the in-flight episode's start time + trigger from the
  // scheduler's `start` callback to the run-end telemetry append.
  // Dream Cycle glue (telemetry + started/ended events + cooldown threading)
  // lives in createDreamCycle so the full idle→episode→telemetry→ended path is
  // exercised end-to-end in a test (audit D2), not just inline here.
  const dreamCycle = createDreamCycle({
    send: (e) => transport.send(e),
    telemetryPath: dreamTelemetryPath,
    // BRSI §2.9 Evolution Journal: per-day rotating file under the
    // per-instance ~/.feral/rsi/journal dir. Resolved per write so a
    // process spanning UTC midnight rolls to the next day's file.
    journalPath: () => defaultJournalPath(),
    activityMonitor,
    config: dreamCfg,
    log,
  });
  const rsiSidecar = new RsiSidecar({
    router,
    db: db.raw,
    bridge: rsiBridge,
    send: (e) => transport.send(e as unknown as import("./types.ts").OutboundEvent),
    log,
    onIdle: dreamCycle.onEpisodeEnd,
    // The Crux: a new ratcheted-best config is applied to the LIVE agent
    // (temperature today; the UI Controls override still wins per-session).
    onChampion: (record) => {
      const params = mapGenomeToAgentConfig(record.config);
      agent.applyChampionParams(params);
      log(`rsi champion: applied genome ${record.genomeId} (score=${record.score.toFixed(1)}) → agent ${JSON.stringify(params)}`);
    },
  });
  // Boot with the last persisted champion so the agent doesn't start
  // cold on every relaunch (resume the learned tuning immediately).
  {
    const champ = readChampion(defaultChampionPath());
    if (champ) {
      agent.applyChampionParams(mapGenomeToAgentConfig(champ.config));
      log(`rsi champion: loaded persisted champion ${champ.genomeId} (score=${champ.score.toFixed(1)})`);
    }
  }
  // Dream Cycle: the evolutionary engine runs ONE bounded episode per
  // trigger (idle / error), then sleeps until the next trigger. The
  // engine math is untouched — only the *when* changed. The standing
  // goal + bounded budgets come from episodeStartOptions; the trigger
  // signals from the activity monitor.
  const dream = dreamCycle.arm(rsiSidecar, episodeStartOptions(process.env));

  // Connector Surface (inbound): Discord/Telegram/… share this one agent.
  // The host writes ~/.feral/connectors.json and pokes us with
  // `connectors_reload`; reconcile here. Started in onReady once the agent and
  // tools are fully wired.
  const connectors = new ConnectorManager(agent, log, leadDesk);

  transport.onMessage(async (msg) => {
    switch (msg.type) {
      case "ping":
        transport.send({ type: "pong" });
        break;
      case "connectors_reload":
        void connectors.reload();
        break;

      // PROVISIONAL (temporary Settings button): run the Fractal Memory Search
      // benchmark gate on demand and emit the verdict back to the UI. Runs off
      // the hot path; builds the tree first if needed. The whole flow is
      // hardening-wrapped so the FE panel can NEVER spin forever:
      //   - build phase has its own wall-clock cap (15 min default)
      //   - bench phase delegates to `benchmarkWithProgress` which has a
      //     separate wall-clock cap (10 min default), bounded query
      //     generation (concurrency 4), and a default count of 12 (not 50)
      //   - any throw or timeout emits a typed `fractal_bench_result
      //     {ok:false, error, phase}` so the panel can show a real reason
      //   - periodic `fractal_bench_progress` events give the panel a live
      //     status line ("generating queries 4/12" / "running queries 4/12")
      //     so the user can see something is happening, not just a spinner
      case "fractal_benchmark": {
        void (async () => {
          const send = (event: import("./types.ts").OutboundEvent): void => {
            transport.send(event);
          };
          // `phase` is set ONLY for genuine wall-clock timeouts (the orchestrator
          // tags those "at <phase>"). Non-timeout failures — empty query set, no
          // model loaded, no tree — leave it undefined so the panel shows the
          // self-explanatory message without a misleading "blew its budget" hint.
          const sendError = (error: string, phase?: "build" | "queries" | "run"): void => {
            send({ type: "fractal_bench_result", ok: false, error, phase });
          };
          const buildTimeoutMs = 15 * 60 * 1000;
          try {
            // Phase 1: ensure a tree exists. Bounded by its own wall clock
            // (the rebuild was the previous infinite-spin path: 2.8 s/text
            // × 2695 leaves on CPU = ~2 hours, and looked identical to the
            // sidecar being dead).
            send({
              type: "fractal_bench_progress",
              kind: "generate_queries",
              current: 0,
              total: 0,
              message: "Building RAPTOR tree…",
            });
            await withTimeout(
              fractalMemory.rebuildIfStale(),
              buildTimeoutMs,
              "build",
            );
            if (!fractalMemory.hasTree) {
              sendError(
                "No RAPTOR tree — is the embedding model present and the build finished? Try restarting after the model is on disk.",
              );
              return;
            }
            // Phase 2: run the benchmark through the hardening wrapper.
            // Progress is forwarded as a typed `fractal_bench_progress`
            // event; timeout / errors throw and are caught below.
            const report = await fractalMemory.benchmarkWithProgress({
              infer: routerInfer(router),
              onProgress: (p) => {
                send({
                  type: "fractal_bench_progress",
                  kind: p.kind,
                  current: p.current,
                  total: p.total,
                  message: p.message,
                });
              },
            });
            const fs = require("node:fs") as typeof import("node:fs");
            const outPath = require("node:path").join(dataDir, "fractal-bench-report.json");
            fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
            send({
              type: "fractal_bench_result",
              ok: true,
              ship: report.verdict.ship,
              reasons: report.verdict.reasons,
              n: report.n,
              k: report.k,
              fractalRecall: report.fractal.meanRecallAtK,
              ftsRecall: report.fts.meanRecallAtK,
              fractalP99Ms: report.fractal.p99Ms,
              ftsP99Ms: report.fts.p99Ms,
              path: outPath,
            });
          } catch (e) {
            // The orchestrator's timeout errors carry "at <phase>" in the
            // message; surface that so the panel can tell the user which
            // phase was the bottleneck.
            const msg = String(e);
            // Only a real timeout carries "at <phase>" (see orchestrator's
            // withTimeout). Everything else (empty set, no model, no tree) gets
            // no phase → no misleading budget hint.
            const phase = /at build/.test(msg)
              ? "build"
              : /at queries/.test(msg)
                ? "queries"
                : /at run/.test(msg)
                  ? "run"
                  : undefined;
            sendError(msg, phase);
          }
        })();
        break;
      }

      // Reactive-tree drill-down: return the real member memories of one
      // top-level cluster so the UI can unfold a branch / show a leaf card.
      // Best-effort — an out-of-range index or no tree yields `leaves: []`.
      case "fractal_cluster_leaves": {
        const id = msg.id ?? "";
        const clusterIndex = msg.clusterIndex ?? 0;
        let leaves: { leafId: number; text: string; ts: number }[] = [];
        try {
          leaves = fractalMemory.clusterLeaves(clusterIndex);
        } catch (e) {
          log(`fractal_cluster_leaves failed: ${String(e)}`);
        }
        transport.send({ type: "fractal_cluster_leaves_result", id, leaves });
        break;
      }

      case "shutdown":
        log(`shutdown requested`);
        askUser.cancelAll("shutdown");
        db.close();
        process.exit(0);
        break;

      case "ask_user_response": {
        // Forward the user's selection back to the matching pending request.
        // Both `requestId` and `answers` are required — the transport's
        // `isInbound` validator only checks the `type` field, so we still
        // re-validate the payload here before calling the bridge.
        if (msg.requestId && msg.answers) {
          askUser.resolve(msg.requestId, msg.answers);
        } else {
          log(`ask_user_response: missing requestId or answers — ignored`);
        }
        break;
      }
      case "ask_user_cancel": {
        // The user clicked Skip (or the UI is tearing down) — reject the
        // pending Promise so the agent loop can continue with whatever
        // fallback the model chose for the missing input.
        if (msg.requestId) {
          askUser.cancel(msg.requestId, msg.reason ?? "user cancelled");
        }
        break;
      }

      case "desktop_control_response": {
        // Result of an OS desktop-control action run by the Rust host. Route
        // it back to the matching pending request so the control_app tool's
        // awaited Promise settles. `id` echoes the originating request id.
        if (msg.id) {
          desktopControl.resolve(msg.id, msg.ok === true, msg.data, msg.error);
        } else {
          log(`desktop_control_response: missing id — ignored`);
        }
        break;
      }

      case "set_model": {
        const provider = msg.provider;
        const model = msg.model;
        const baseUrl = msg.baseUrl;
        if (!provider || !model || !baseUrl) {
          transport.send({
            type: "model_error",
            message: "set_model requires provider, model, and baseUrl",
          });
          return;
        }
        try {
          const primary: ModelTarget = { provider, model, baseUrl, apiKey: msg.apiKey };
          // Keep the bundled local engine as fallback when switching to a
          // cloud (non-loopback) model, so a 429/transient cloud failure
          // degrades to on-device inference instead of a hard error. Switching
          // BACK to a local primary needs no fallback (it IS the safe target).
          const fallback = isLoopbackUrl(baseUrl) ? undefined : localFallbackTarget;
          router.reconfigure(primary, fallback);
          // Local models forward their active context window so the agent loop
          // compacts to the real KV-cache size (Hardware can raise it well past
          // the old 8192); cloud models send none and use the cloud budget.
          router.setContextWindow(msg.contextWindow);
          transport.send({ type: "model_set", provider, model });
          log(
            `model hot-swapped → ${provider}/${model} @ ${baseUrl}` +
              (fallback ? ` (fallback → ${fallback.baseUrl})` : ""),
          );
        } catch (err) {
          transport.send({
            type: "model_error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "stop": {
        // User pressed the Stop button. Abort the in-flight generation for
        // that session (or everything when no sessionId is given). The loop
        // aborts the router fetch + per-session tool signal and emits a
        // `done` event with `stopped: true`, which the frontend renders as
        // a clean "stopped" state.
        if (msg.sessionId) {
          log(`stop requested for session ${msg.sessionId}`);
          agent.stop(msg.sessionId);
        } else {
          log(`stop requested for all sessions`);
          agent.stopAll();
        }
        break;
      }

      case "message": {
        const id = msg.id ?? crypto.randomUUID();
        const sessionId = msg.sessionId ?? "default";
        const content = msg.content ?? "";
        if (!content.trim()) {
          transport.send({
            type: "error",
            id,
            message: "empty message content",
          });
          return;
        }
        // X1 fix: mood updates are only emitted when the proactive
        // subsystem is enabled. Default = off, so the hot message path
        // does no MoodEngine work.
        mood?.applyEvent("message_received");
        // Inner-thoughts loop watches idle time. Reset the timer on every
        // user message so the loop knows the user is actively chatting
        // and waits for a quiet moment before surfacing its own thoughts.
        // Cheap (single Date.now() write). Only meaningful when the
        // proactive subsystem is on.
        innerThoughts?.noteUserActivity();
        // Dream Cycle activity clock: an inbound user message means the
        // user is here, so the idle trigger resets. Cheap single write.
        activityMonitor.recordActivity(Date.now());
        // skillsContext is the per-turn roster of locally-installed skills
        // (metadata only) sent by Rust. Rendered as a short "Available
        // skills" menu in the system prompt; the LLM loads any skill's body
        // on demand via the `read_skill` tool. See WorkingMemory.setSkillMenu.
        const skillsContext = msg.skillsContext;
        // Image attachments (data URLs) forwarded by the host. Passed through
        // to the agent loop so vision-capable models receive real pixels.
        const images = Array.isArray(msg.images)
          ? msg.images.filter((i): i is string => typeof i === "string" && i.startsWith("data:image/"))
          : undefined;
        // Controls-panel overrides (temperature / max_tokens) ride along on
        // every send; the loop validates and clamps them per session.
        const inferParams =
          msg.inferParams && typeof msg.inferParams === "object"
            ? msg.inferParams
            : undefined;
        await agent.handle(sessionId, content, id, (event) => {
          transport.send(event);
          // X1 fix: same gating as the message-received update above.
          if (event.type === "done")       mood?.applyEvent("message_answered");
          if (event.type === "tool_done") {
            const r = event.result as { ok?: boolean } | null;
            mood?.applyEvent(r?.ok === false ? "tool_error" : "tool_success");
          }
          if (event.type === "error") {
            mood?.applyEvent("inference_error");
            // Dream Cycle error trigger: a real agent failure feeds the
            // monitor's rolling window. Enough failures wake an episode
            // (the literature's "error" trigger — improve when something
            // is actually going wrong).
            activityMonitor.recordError(Date.now());
          }
        }, skillsContext, images, inferParams);
        break;
      }

      // P0-3: cron_* messages. Body shape is loosely typed at the
      // transport layer (the InboundMessage union doesn't carry the
      // detail fields yet — V1 reads them off `msg as any` and
      // validates inside the handler).
      case "cron_list": {
        const jobs = cronRepo.list();
        transport.send({
          type: "model_set", // reuse existing event shape for now
          provider: "cron",
          model: `jobs:${jobs.length}`,
        });
        log(`cron_list → ${jobs.length} job(s)`);
        break;
      }
      case "cron_add": {
        const m = msg as unknown as {
          id?: string;
          name?: string;
          task?: string;
          schedule?: Schedule;
          delivery?: DeliveryTarget;
        };
        if (!m.name || !m.task || !m.schedule || !m.delivery) {
          transport.send({
            type: "model_error",
            message: "cron_add requires name, task, schedule, delivery",
          });
          return;
        }
        const job = cronRepo.upsert({
          id: m.id,
          name: m.name,
          task: m.task,
          schedule: m.schedule,
          delivery: m.delivery,
        });
        log(`cron_add → ${job.id} (${job.name})`);
        break;
      }
      case "cron_remove": {
        const m = msg as unknown as { id?: string };
        if (!m.id) {
          transport.send({
            type: "model_error",
            message: "cron_remove requires id",
          });
          return;
        }
        const removed = cronRepo.remove(m.id);
        log(`cron_remove → ${m.id} (${removed ? "ok" : "not found"})`);
        break;
      }
      case "cron_toggle": {
        const m = msg as unknown as { id?: string; enabled?: boolean };
        if (!m.id || typeof m.enabled !== "boolean") {
          transport.send({
            type: "model_error",
            message: "cron_toggle requires id and enabled",
          });
          return;
        }
        cronRepo.setEnabled(m.id, m.enabled);
        log(`cron_toggle → ${m.id} enabled=${m.enabled}`);
        break;
      }

      // RSI engine driver (Faza 1 production wiring). The Rust host
      // generates a `request_id` UUID and waits on a oneshot that the
      // matching `rsi_engine_event` line fires. The sidecar builds /
      // drives / stops the engine; rsi_engine_event is the only ack
      // surface the host needs.
      case "rsi_start": {
        const goal = msg.rsiGoal ?? "rsiautomation";
        const maxIterations = msg.rsiMaxIterations ?? 50;
        const maxTotalTokens = msg.rsiMaxTotalTokens ?? 5_000_000;
        const concurrency = msg.rsiConcurrency ?? 1;
        log(`rsi_start goal="${goal}" maxIter=${maxIterations} maxTokens=${maxTotalTokens} conc=${concurrency}`);
        await rsiSidecar.start(
          { goal, maxIterations, maxTotalTokens, concurrency },
          msg.id,
        );
        break;
      }
      case "rsi_stop": {
        log(`rsi_stop requested`);
        rsiSidecar.stop(msg.id);
        break;
      }
      case "rsi_set_concurrency": {
        const n = msg.rsiNewConcurrency ?? 1;
        log(`rsi_set_concurrency → ${n}`);
        rsiSidecar.setConcurrency(n, msg.id);
        break;
      }
      case "rsi_response": {
        // Bridge response delivery — every `rsi_request` we emitted is
        // paired with exactly one `rsi_response` line by Rust. Route
        // it back to the RsiBridge so the awaiting Promise settles.
        //
        // Rust (`handle_rsi_request`) sends PLAIN field names — `id`, `ok`,
        // `data`, `error` — mirroring the `rsi_request` it reads (`id`,
        // `method`, `params`). This handler previously read the prefixed
        // `rsiRequestId`/`rsiOk`/`rsiData`/`rsiError`, which Rust never sends,
        // so EVERY response was "without requestId — ignored" and every
        // bridge Promise (notably `embed_text`) hung forever — the real cause
        // of the RAPTOR tree build never finishing. Match Rust's field names.
        if (msg.id) {
          rsiSidecar.onResponse({
            id: msg.id,
            ok: msg.ok ?? false,
            ...(msg.data !== undefined ? { data: msg.data } : {}),
            ...(msg.error ? { error: msg.error } : {}),
          });
        } else {
          log(`rsi_response without id — ignored`);
        }
        break;
      }
    }
  });

  transport.onReady(() => {
    log(
      `ready — transport=${config.transport} model=${config.inference.primary.model} ` +
        `workspace=${config.workspaceRoots.join(", ")}`,
    );
    // X1 fix: inner-thoughts is opt-in via FERAL_PROACTIVE_ENABLED.
    if (innerThoughts) {
      innerThoughts.setEmit((event) => transport.send(event));
      innerThoughts.start();
    }
    // P2-#1: heartbeat always on — even when the proactive loop is off.
    // The transport's onMessage handler should treat absence of
    // heartbeats for ≥3 intervals as a hang signal.
    heartbeat.setEmit((event) => transport.send(event));
    heartbeat.start();
    // P0-3: cron scheduler. Same pattern as inner-thoughts — start
    // after the transport is up so a job that fires immediately can
    // deliver through the transport.
    cronScheduler.start();
    log(`cron scheduler enabled (${cronRepo.list().length} job(s) loaded)`);
    // Start any enabled inbound connectors (Discord, …) now that the agent and
    // its tools are live. Best-effort: failures log to stderr, never crash.
    void connectors.reload();

    // Dream Cycle: arm the event-driven scheduler when a real model is
    // configured. Off when FERAL_RSI_PASSIVE=false or only a placeholder
    // model is present (avoids spinning on empty responses). On a cloud
    // (non-loopback) endpoint, dreaming is additionally refused unless
    // FERAL_RSI_ALLOW_CLOUD is explicitly set (anti-burn). `start()` only
    // arms the trigger poll — it does NOT launch an episode immediately.
    const decision = shouldAutostartPassive(process.env);
    if (!decision.enabled) {
      log(`rsi dream: not arming scheduler (${decision.reason})`);
    } else {
      const baseUrl = process.env.FERAL_BASE_URL ?? "";
      let isLoopback = baseUrl === "";
      try {
        const h = new URL(baseUrl).hostname;
        isLoopback = h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
      } catch {
        // Unparseable/empty baseUrl → keep the `baseUrl === ""` default
        // (empty means the in-process loopback default).
      }
      const gate = dreamCloudGate(process.env, { isLoopback });
      if (!gate.enabled) {
        log(`rsi dream: not arming scheduler (${gate.reason})`);
      } else {
        log(`rsi dream: arming event-driven scheduler (${decision.reason}; ${gate.reason})`);
        dream?.start();
      }
    }
  });

  // Persist final audit state on unexpected termination.
  const shutdown = () => {
    // Break the Dream Cycle trigger loop so we don't launch an episode
    // into a closing process.
    dream?.shutdown();
    // X1 fix: only stop the inner-thoughts loop if it was actually
    // started (i.e. the proactive subsystem is on).
    innerThoughts?.stop();
    heartbeat.stop();
    cronScheduler.stop();
    void connectors.stopAll();
    graphCleaner.stop();
    try {
      stopSoulWatcher();
    } catch {
      // watcher may already be closed; safe to ignore
    }
    try {
      askUser.cancelAll("shutdown");
    } catch {
      // ignore — bridge may already be empty
    }
    try {
      desktopControl.cancelAll("shutdown");
    } catch {
      // ignore — bridge may already be empty
    }
    try {
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  transport.start();
}

/** Diagnostics go to stderr; stdout is reserved for the transport protocol. */
function log(message: string): void {
  process.stderr.write(`[feral] ${message}\n`);
}

// Only auto-start when run as the entry point — importing this module (e.g.
// from a test) must not boot the whole app.
if (import.meta.main) {
  main().catch((err) => {
    // Startup misconfiguration (e.g. a target outside trustedBaseUrls) should
    // fail fast with a clear, single-line reason rather than a raw stack trace.
    log(`fatal: failed to start — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
