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
import { SIDECAR_PROTOCOL } from "./protocol.ts";
import { dispatchMessage } from "./dispatch.ts";
import { cfgBool, cfgInt, cfgPath } from "./config.ts";
import { AuditLog } from "./egress/audit-log.ts";
import { EgressProxy } from "./egress/egress-proxy.ts";
import { RealProcessSandbox } from "./egress/process-sandbox.ts";
import { InferenceRouter } from "./egress/inference-router.ts";
import { EpisodicMemory } from "./memory/episodic.ts";
import { SemanticMemory } from "./memory/semantic.ts";
import { RecallEngine } from "./memory/recall.ts";
import { MemoryExtractor, isJunkFactKey } from "./memory/extractor.ts";
import { Reconciler } from "./memory/reconciler.ts";
import { runMigration } from "./memory/fractal/migration.ts";
import { MemoryGraph } from "./memory/graph.ts";
import { MemoryGraphCleaner } from "./memory/graph-cleaner.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { McpManager } from "./egress/mcp-manager.ts";
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
import { createSelfTools } from "./tools/builtin/self.ts";
import { AgentLoop } from "./core/agent-loop.ts";
import { HeartbeatLoop } from "./core/heartbeat.ts";
import { HookRegistry } from "./core/hook-registry.ts";
import { CronJobsRepo, CronScheduler, deliverCron } from "./cron/index.ts";
import { TauriTransport } from "./transports/tauri.ts";
import { ConnectorManager } from "./transports/connectors.ts";
import { bootstrapOnce } from "./rsi/mod.ts";
import { RsiBridge } from "./rsi/infra/bridge.ts";
import { setEmbedInvoker, rsiBridgeEmbed, embed } from "./memory/fractal/embed.ts";
import { summarizeFromRouter, routerInfer } from "./memory/fractal/summarize.ts";
import { FractalMemory, type FractalActivity } from "./memory/fractal/fractal-memory.ts";
import { LEAF_STORE_FILENAME } from "./memory/fractal/leaf-store.ts";
import { RsiSidecar } from "./rsi/sidecar.ts";
import { hitsToItems, itemsToHits, liveModuleRegistry, liveSeamAdapter, onModuleQuarantine } from "./rsi/l4-modules/seam-runtime.ts";
import { shouldAutostartPassive } from "./rsi/l1-config/passive-supervisor.ts";
import { createDreamCycle } from "./rsi/l1-config/dream-cycle.ts";
import { defaultJournalPath } from "./rsi/infra/journal.ts";
import { ActivityMonitor } from "./rsi/l1-config/activity-monitor.ts";
import { resolveDreamConfig, dreamCloudGate } from "./rsi/l1-config/dream-config.ts";
import { episodeStartOptions, episodeBudgetCaps } from "./rsi/l1-config/episode-options.ts";
import { MetaEvolution } from "./rsi/l6-meta/meta-evolution.ts";
import { effectiveGates, loadPolicy } from "./rsi/l5-gov/governance.ts";
import { ensureGenesisPolicy, GovernanceLifecycle } from "./rsi/l5-gov/governance-lifecycle.ts";
import {
  mapGenomeToAgentConfig,
  readChampion,
  defaultChampionPath,
} from "./rsi/l1-config/champion.ts";
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
import { CircuitBreaker } from "./egress/circuit-breaker.ts";
import { BrainStack } from "./brain/brain-stack.ts";
import { loadBrainConfig } from "./brain/brain-config.ts";

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
 * Sidecar version, surfaced verbatim in the runtime identity doc emitted
 * by `self_describe` and used as the L4 manifest `compat.runtime` floor.
 * Static import so `bun --compile` bundles it — the previous
 * `readFileSync(new URL("../package.json", …))` silently fell back to
 * "0.0.0-dev" inside the compiled binary (caught live by the B7 smoke:
 * every module manifest failed its runtime floor). Env override kept.
 */
import pkgJson from "../package.json" with { type: "json" };
export const VERSION: string =
  cfgPath("FERAL_VERSION") ??
  ((pkgJson as { version?: string }).version || "0.0.0-dev");

/** When this sidecar process started, for uptime reports. */
const BOOT_EPOCH_MS = Date.now();

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

/**
 * Boot sequence — wires the full agent stack (sandbox → memory → tools →
 * agent core → transport) and returns the context the per-message dispatch
 * switch (`dispatch.ts`) needs. Renamed from `main` (R7); `index.ts` keeps a
 * thin `main()` wrapper so `src/tui/chat.ts`'s `await import("../index.ts")`
 * / `.main` contract is unchanged.
 *
 * @param transportOverride — when set, use this transport instead of building
 *   the default TauriTransport. Used by the TUI chat loop (src/tui/chat.ts)
 *   which passes a TuiTransport so events fan out in-process instead of
 *   writing JSON to stdout.
 */
export async function boot(transportOverride?: Transport) {
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
        model: cfgPath("FERAL_MODEL")!,
        baseUrl: cfgPath("FERAL_BASE_URL")!,
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
    maxLeaves: cfgInt("FERAL_FRACTAL_BENCH_MAX_LEAVES"),
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
    const baseUrl = cfgPath("FERAL_BASE_URL") ?? "";
    const isLoopback = baseUrl === "" || /^(https?:\/\/)?(127\.|localhost)/i.test(baseUrl);
    const cap = cfgInt("FERAL_FRACTAL_BENCH_MAX_LEAVES");
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

  // R5: the sidecar is the single owner of live MCP connections (see
  // sandbox/mcp-manager.ts). Boot reconcile runs in the background — a
  // slow or broken extension must never delay agent startup. The desktop
  // pokes `mcp_reload` after every config change (install/toggle/remove).
  const mcpManager = new McpManager(registry, audit.logger);
  void mcpManager
    .reconcile()
    .then(() => {
      const running = mcpManager.status().filter((s) => s.running).length;
      if (running > 0) log(`mcp: ${running} server(s) connected`);
    })
    .catch((e) => log(`mcp: boot reconcile failed: ${String(e)}`));

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
  if (cfgBool("FERAL_ENABLE_DESKTOP_CONTROL")) {
    registry.register(createControlAppTool());
    log("control_app enabled (FERAL_ENABLE_DESKTOP_CONTROL=true) — OS desktop control is active");
  }

  // recall — read-only on-demand semantic search over past conversations,
  // backed by Fractal Memory Search. Capture stays reactive (MemoryExtractor);
  // this is the explicit-search counterpart to per-turn auto-injection.
  // L4 (§1.1): the search routes through the retrieval_strategy seam — a
  // promoted module replaces the ranking; with none promoted the builtin
  // fast-path calls FractalMemory.query directly (no process boundary).
  const retrievalSeam = liveSeamAdapter(
    "retrieval_strategy",
    async (_method, params) => {
      const p = params as { query: string; k: number };
      return hitsToItems(await fractalMemory.query(p.query, p.k));
    },
    log,
  );
  registry.register(
    createRecallTool(async (q, limit) =>
      itemsToHits(
        await retrievalSeam.invoke("retrieve", { query: q, k: limit, sessionId: "recall-tool" }),
        limit,
      ),
    ),
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
  const proactiveEnabled = cfgBool("FERAL_PROACTIVE_ENABLED");
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
  // S5: Brain Stack wiring. Opt-in — loadBrainConfig() returns null when
  // brain.json is absent (and FERAL_BRAIN is unset), so production runs
  // with no brain.json see no behavior change. Each BrainStack owns its
  // own CircuitBreaker instance — tool-health and model-health live in
  // separate namespaces until S6 generalises the breaker key.
  const brainCfg = loadBrainConfig();
  const brain = brainCfg ? new BrainStack(brainCfg, new CircuitBreaker()) : null;
  const agent = new AgentLoop(
    router, registry, episodic,
    { onBudgetExhausted: config.inference.tokenBudget.onExhausted },
    fractalMemory,
    extractor,
    soul,
    user,
    hooks,
    brain,
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
  // Accept an override (e.g. TuiTransport for the terminal chat) or build
  // the default TauriTransport (newline-delimited JSON over stdin/stdout).
  const transport = transportOverride ?? buildTransport(config.transport);
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
  // One source of truth for the episode's bounded run config — reused for
  // the budget caps the journal reports against and for arming the engine.
  const episodeOpts = episodeStartOptions(process.env);
  // L5 Governance (spec 2026-07-04): first boot activates the genesis
  // policy (codifies the pre-L5 hardcoded defaults); every layer reads
  // the ACTIVE policy from disk through this accessor — rollbacks apply
  // at the next decision point, no restart (§6).
  ensureGenesisPolicy();
  const governancePolicy = () => loadPolicy().policy;
  {
    // §8: policy budgets are OUTER walls over the env-derived episode
    // config. Read once at startup like the env itself (episode knobs
    // are boot-scoped); maxIterations is clamped live in its getter.
    const b = governancePolicy().budgets;
    episodeOpts.maxTotalTokens = Math.min(episodeOpts.maxTotalTokens, b.episodeMaxTokens);
    episodeOpts.maxTotalCostUsd = Math.min(episodeOpts.maxTotalCostUsd, b.episodeMaxCostUsd);
    episodeOpts.maxWallClockMs = Math.min(episodeOpts.maxWallClockMs, b.episodeMaxWallClockMs);
    episodeOpts.maxIterations = Math.min(episodeOpts.maxIterations, b.episodeMaxIterations);
  }
  // L6 Meta Evolution — the MetaGenome that steers HOW the RSI searches
  // (docs/2026-07-04 spec). `dream_batch` drives the episode iteration
  // budget live (the getter re-reads the genome at each episode start)
  // unless the operator pinned it via FERAL_RSI_MAX_ITER.
  const metaEvolution = new MetaEvolution({ log, policy: governancePolicy });
  if (process.env.FERAL_RSI_MAX_ITER === undefined) {
    Object.defineProperty(episodeOpts, "maxIterations", {
      get: () =>
        Math.min(metaEvolution.current().dream_batch, governancePolicy().budgets.episodeMaxIterations),
      enumerable: true,
    });
  }
  const dreamCycle = createDreamCycle({
    send: (e) => transport.send(e),
    telemetryPath: dreamTelemetryPath,
    // BRSI §2.9 Evolution Journal: per-day rotating file under the
    // per-instance ~/.feral/rsi/journal dir. Resolved per write so a
    // process spanning UTC midnight rolls to the next day's file.
    journalPath: () => defaultJournalPath(),
    // BRSI §2.5: report honest remaining budget against the same limits
    // GoalConfig enforces for the episode.
    budgetCaps: episodeBudgetCaps(episodeOpts),
    activityMonitor,
    config: dreamCfg,
    log,
  });
  // Faza 2 code-RSI round, piggybacked on the Dream Cycle: after each
  // dream episode ends, propose ONE patch over the agent's own rsi/
  // sources and run it through the full contract (walls → worktree →
  // Rust score → substrate ratchet → approval queue). Dev-mode: requires
  // FERAL_CODE_RSI_REPO (the source monorepo) and a LOCAL primary model
  // (spec §2.5: no network during proposal). At most one round in flight.
  let codeRsiBusy = false;
  const maybeCodeRsiRound = async (): Promise<void> => {
    const repoRoot = cfgPath("FERAL_CODE_RSI_REPO");
    if (!repoRoot || codeRsiBusy) return;
    if (!router.isPrimaryLocal) {
      log("code-rsi: skipped — proposal requires a LOCAL primary model (spec §2.5)");
      return;
    }
    codeRsiBusy = true;
    try {
      const { proposeCodePatch } = await import("./rsi/l3-code/code-proposer.ts");
      const { makeCodeStageAdapters, runCodeCandidate } = await import("./rsi/l3-code/code-rsi.ts");
      const { bunExec } = await import("./rsi/l3-code/code-sandbox.ts");
      const { readdir, readFile } = await import("node:fs/promises");
      const rsiDir = require("node:path").join(repoRoot, "FeralAgent", "src", "rsi");

      const genome = await proposeCodePatch({
        completeLocal: async ({ system, user, maxTokens }) => {
          const res = await router.complete({
            sessionId: "code-rsi-proposer",
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            maxTokens,
            temperature: 0.4,
            cachePrompt: false,
            skipBudgetCheck: false,
          });
          return res.content;
        },
        // R2: rsi/ is now layered into subdirs (l1-config/, l3-code/, …), so
        // this must recurse and return rsi/-relative paths (e.g.
        // "l1-config/mutation.ts") — readRsiFile/proposeCodePatch already
        // treat the listRsiFiles entries as opaque relative paths, not bare
        // basenames, so no other call site changes.
        listRsiFiles: async () =>
          (await readdir(rsiDir, { recursive: true })).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\\/g, "/")),
        readRsiFile: (relPath) => readFile(require("node:path").join(rsiDir, relPath), "utf8"),
        baseCommit: async () =>
          (await bunExec(["git", "rev-parse", "HEAD"], { cwd: repoRoot, timeoutMs: 30_000 }))
            .stdout.trim(),
      });
      if (!genome) {
        log("code-rsi: proposer declined (SKIP / nothing diff-shaped) — no candidate this round");
        return;
      }

      const { store, sendCodePatches } = await codePatchGate();
      const genomeId = crypto.randomUUID();
      log(`code-rsi: candidate ${genomeId.slice(0, 8)} targets ${genome.affectedFiles.join(", ")}`);
      const result = await runCodeCandidate({
        genomeId,
        genome,
        deps: makeCodeStageAdapters({ bridge: rsiBridge, repoRoot }),
        cycleId: `c-code-${new Date().toISOString()}`,
        pendingStore: store,
      });
      log(
        `code-rsi: ${result.decided?.action ?? "?"} (${result.decided?.reason ?? "no reason"})` +
          (result.advanced ? ` — PROMOTED score=${result.score?.toFixed(1)}, queued for approval` : ""),
      );
      if (result.advanced) sendCodePatches();
    } catch (e) {
      log(`code-rsi: round failed: ${String(e)}`);
    } finally {
      codeRsiBusy = false;
    }
  };

  const rsiSidecar = new RsiSidecar({
    router,
    db: db.raw,
    bridge: rsiBridge,
    send: (e) => transport.send(e as unknown as import("./types.ts").OutboundEvent),
    log,
    // L6: the live MetaGenome scales the PBT selection knobs and
    // (tighten-only) the confidence gate.
    metaParams: () => metaEvolution.current(),
    // L5: policy gates tighten the promotion gate further (§7).
    policyGates: () => effectiveGates(governancePolicy()),
    onIdle: (...args: Parameters<typeof dreamCycle.onEpisodeEnd>) => {
      dreamCycle.onEpisodeEnd(...args);
      void maybeCodeRsiRound();
    },
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
  const dream = dreamCycle.arm(rsiSidecar, episodeOpts);

  // Connector Surface (inbound): Discord/Telegram/… share this one agent.
  // The host writes ~/.feral/connectors.json and pokes us with
  // `connectors_reload`; reconcile here. Started in onReady once the agent and
  // tools are fully wired.
  const connectors = new ConnectorManager(agent, log, leadDesk);

  // F6 — self.* runtime introspection tools (the agent's mental model of
  // its own substrate). Registered after `connectors` so the connector
  // handle is in scope for `self_connectors` / `self_health`, and after
  // `router` / `registry` are built (both are constructed earlier in this
  // file). No filesystem permissions — these tools read internal state
  // files directly, and the audit log records every call.
  const brainStackEnabled = brain !== undefined && brain !== null;
  for (const t of createSelfTools({
    router,
    registry,
    connectors,
    brainStackEnabled,
    version: VERSION,
    bootedAt: BOOT_EPOCH_MS,
  })) {
    registry.register(t);
  }

  // Faza 2 Slice 5: the code-patch approval gate, created lazily on first
  // IPC touch (installs that never use code-RSI pay nothing). One store per
  // process, persisted next to the journal.
  let codePatchGatePromise: Promise<{
    store: import("./rsi/l3-code/pending-patches.ts").PendingPatchStore;
    sendCodePatches: () => void;
  }> | null = null;
  const codePatchGate = () => {
    codePatchGatePromise ??= (async () => {
      const { PendingPatchStore, defaultPendingPatchesPath } = await import(
        "./rsi/l3-code/pending-patches.ts"
      );
      const store = new PendingPatchStore(defaultPendingPatchesPath());
      const sendCodePatches = (): void => {
        transport.send({
          type: "code_patches",
          patches: store.list().map((p) => ({
            id: p.id,
            status: p.status,
            score: p.score,
            rationale: p.genome.proposal.rationale,
            affectedFiles: p.genome.affectedFiles,
            patch: p.genome.patch,
            commitHash: p.commitHash,
            createdAt: p.createdAt,
            ...(p.note ? { note: p.note } : {}),
          })),
          manualWindowOpen: store.requiresManualApproval(),
          appliedCount: store.appliedCount(),
        });
      };
      return { store, sendCodePatches };
    })();
    return codePatchGatePromise;
  };

  // Slice A5 (L5 Governance) — the policy FSM. Lazy singleton, sync init
  // (GovernanceLifecycle has no async deps; only the journal dir resolution
  // touches the filesystem and that's deferred to the first read). Same
  // discipline as `codePatchGate` above: installs that never touch
  // governance (the majority of them) pay nothing.
  let glInstance: GovernanceLifecycle | null = null;
  const governanceGate = () => {
    glInstance ??= new GovernanceLifecycle({ log });
    return glInstance;
  };

  // Phase B (L4 Architecture Evolution) — the module lifecycle. Lazy
  // singleton over the SAME registry the live seam adapters read
  // (`liveModuleRegistry`), so an approve here is visible to the recall
  // tool's next request without a restart (§6). One eval at a time —
  // the paired suite fights for the model exactly like LoRA training.
  let mlInstance: import("./rsi/l4-modules/module-lifecycle.ts").ModuleLifecycle | null = null;
  let moduleEvalBusy = false;
  const modulesGate = async () => {
    if (!mlInstance) {
      const { ModuleLifecycle } = await import("./rsi/l4-modules/module-lifecycle.ts");
      mlInstance = new ModuleLifecycle({
        registry: liveModuleRegistry(),
        runtimeVersion: VERSION,
        log,
      });
    }
    return mlInstance;
  };
  // Watchdog auto-quarantine (§8.2) → desktop toast, unpaired event.
  onModuleQuarantine((moduleId, reason) => {
    transport.send({
      type: "modules_result",
      id: "",
      op: "quarantined",
      ok: true,
      moduleId,
      reason,
    });
  });

  // Faza 4 (L2 LoRA) — the personal-adaptation gate, same lazy-on-first-touch
  // discipline as the code-patch gate. Registry + review inbox persist next
  // to the journal; `sendLoraReviews` is the one shape the UI card renders.
  let loraGatePromise: Promise<{
    registry: import("./rsi/l2-adapt/lora-registry.ts").LoraRegistry;
    reviews: import("./rsi/l2-adapt/lora-pipeline.ts").LoraReviewStore;
    sendLoraReviews: () => void;
  }> | null = null;
  const loraGate = () => {
    loraGatePromise ??= (async () => {
      const { LoraRegistry } = await import("./rsi/l2-adapt/lora-registry.ts");
      const { LoraReviewStore, loraStats } = await import("./rsi/l2-adapt/lora-pipeline.ts");
      const registry = new LoraRegistry();
      const reviews = new LoraReviewStore();
      const sendLoraReviews = (): void => {
        transport.send({
          type: "lora_reviews",
          reviews: reviews.list().map((c) => {
            const rec = registry.get(c.adapterId);
            return {
              id: c.adapterId,
              domain: c.domain,
              status: c.status,
              verdict: c.gate.verdict,
              reason: c.gate.reason,
              metrics: c.metrics,
              adapterPath: rec?.adapterPath ?? "",
              baseModel: rec?.baseModel ?? "",
              createdAt: c.createdAt,
            };
          }),
          champions: registry
            .list()
            .filter((a) => a.status === "champion")
            .map((a) => ({ domain: a.domain, id: a.id, adapterPath: a.adapterPath })),
          stats: loraStats(registry.list(), reviews.list()),
        });
      };
      return { registry, reviews, sendLoraReviews };
    })();
    return loraGatePromise;
  };
  // One training cycle at a time — training is the heaviest thing this
  // process can trigger, and a second concurrent cycle would fight the
  // first for the model (the eval runner reloads it).
  let loraTrainBusy = false;


  // R7: everything `dispatchMessage` (dispatch.ts) needs from the boot
  // sequence, threaded explicitly instead of via closure. `moduleEvalBusy` /
  // `loraTrainBusy` are plain `let` flags that the switch (now in
  // dispatch.ts) reads AND reassigns across separate calls, so they live on
  // this shared, mutable `ctx` object rather than being destructured by
  // value on the other side.
  const ctx = {
    config, db, user, audit, router, localFallbackTarget, episodic, dataDir, fractalMemory, askUser, desktopControl, registry, mcpManager, mood, innerThoughts, agent, cronRepo, transport, rsiBridge, activityMonitor, metaEvolution, rsiSidecar, dream, connectors, codePatchGate, governanceGate, modulesGate, loraGate,
    moduleEvalBusy, loraTrainBusy,
  };
  transport.onMessage((msg) => {
    void dispatchMessage(ctx, msg);
  });


  transport.onReady(() => {
    // R1: the very first line of protocol traffic — before any other stdout
    // write — so the host can pin the sidecar's wire version. Skipped when
    // `transportOverride` is set (TUI mode fans events out in-process, not
    // over real stdout, so a raw JSON line here would just pollute the
    // terminal). `transport.onReady` fires on the next microtask after
    // `start()`, which is the earliest point the transport itself considers
    // safe to receive/emit — writing any earlier risks racing its own setup.
    if (!transportOverride) {
      console.log(JSON.stringify({ type: "hello", protocol: SIDECAR_PROTOCOL }));
    }
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
      const baseUrl = cfgPath("FERAL_BASE_URL") ?? "";
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

  return ctx;
}

/** Everything dispatchMessage() needs from the boot sequence — see ctx above. */
export type BootContext = Awaited<ReturnType<typeof boot>>;

/** Diagnostics go to stderr; stdout is reserved for the transport protocol. */
export function log(message: string): void {
  process.stderr.write(`[feral] ${message}\n`);
}
