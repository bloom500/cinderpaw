/**
 * Feral Agent — entry point.
 *
 * Wires the four layers together and starts the selected transport:
 *   Sandbox (audit → egress → inference) → Memory → Tools → Agent core → Transport
 *
 * Security is constructed first: the audit log, egress proxy, and inference
 * router exist before any tool is registered or any message is handled.
 */

import { resolve } from "node:path";
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
import { createCodeQualityTool } from "./tools/builtin/code-quality.ts";
import { ToolObservationLog } from "./telemetry/tool-observations.ts";
import { createFeedbackSkillTool } from "./tools/builtin/feedback-skill.ts";
import { createDelegateTaskTool } from "./tools/builtin/delegate-task.ts";
import { createMemoryOpsTool } from "./tools/builtin/memory-ops.ts";
import { createMemoryGraphOpsTool } from "./tools/builtin/memory-graph-ops.ts";
import { AgentLoop } from "./core/agent-loop.ts";
import { HeartbeatLoop } from "./core/heartbeat.ts";
import { HookRegistry } from "./core/hook-registry.ts";
import { CronJobsRepo, CronScheduler, deliverCron } from "./cron/index.ts";
import { SkillsStorage, SkillAutoCreator } from "./skills/index.ts";
import { TauriTransport } from "./transports/tauri.ts";
import { ConnectorManager } from "./transports/connectors.ts";
import { bootstrapOnce } from "./rsi/mod.ts";
import { RsiBridge } from "./rsi/bridge.ts";
import { setEmbedInvoker, rsiBridgeEmbed, embed } from "./memory/fractal/embed.ts";
import { summarizeFromRouter, routerInfer } from "./memory/fractal/summarize.ts";
import { FractalMemory } from "./memory/fractal/fractal-memory.ts";
import { RsiSidecar } from "./rsi/sidecar.ts";
import {
  PassiveSupervisor,
  shouldAutostartPassive,
  passiveStartOptions,
} from "./rsi/passive-supervisor.ts";
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
import type { InferenceConfig, Transport } from "./types.ts";

interface AppConfig {
  transport: "tauri";
  dbPath: string;
  workspace: string;
  inference: InferenceConfig;
}

function loadConfig(): AppConfig {
  const env = process.env;
  const workspace = resolve(env.FERAL_WORKSPACE ?? process.cwd());

  // ":memory:" is a SQLite sentinel and must not be path-resolved.
  const dbEnv = env.FERAL_DB ?? "data/feral.db";
  const dbPath = dbEnv === ":memory:" ? ":memory:" : resolve(dbEnv);

  return {
    transport: "tauri", // only transport wired in V1
    dbPath,
    workspace,
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
    log,
    persistEmbeddings: (rows) => episodic.setEmbeddings(rows),
  });
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

  const registry = new ToolRegistry(egress, audit, processSandbox, observations, askUser, undefined, hooks, desktopControl);
  registry.register(createReadFileTool([config.workspace]));
  registry.register(createWriteFileTool([config.workspace]));
  registry.register(createListDirectoryTool([config.workspace]));
  // edit_file: in-place string replacement (safer than overwriting)
  registry.register(createEditFileTool([config.workspace]));
  // file_search: glob-style file finder under the workspace
  registry.register(createFileSearchTool([config.workspace]));
  // grep: regex content search under the workspace
  registry.register(createGrepTool([config.workspace]));
  // shell_exec: generic program runner (argv-only, no shell). Opt-in — a
  // host program runner is too broad to register by default. Enable with
  // FERAL_ENABLE_SHELL_EXEC=true. git_* / run_tests / format_code below are
  // always available and cover the common cases without it.
  if (process.env.FERAL_ENABLE_SHELL_EXEC === "true") {
    registry.register(createShellExecTool([config.workspace]));
  }
  // git_*: process-spawn tools for the workspace
  registry.register(createGitStatusTool([config.workspace]));
  registry.register(createGitDiffTool([config.workspace]));
  registry.register(createGitLogTool([config.workspace]));
  registry.register(createGitCommitTool([config.workspace]));
  registry.register(createGitBranchTool([config.workspace]));
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
  registry.register(createScanWorkspaceTool(config.workspace));
  // read_skill: Claude Code-style on-demand body loader for locally-installed
  // skills. The system prompt only carries a short menu; the LLM calls this
  // tool to load the full SKILL.md body of any skill it wants to apply.
  registry.register(createReadSkillTool(`${homedir()}/.feral/skills`));

  // F7 — code-quality tools. Auto-detect project type and run the
  // appropriate command (npm test, cargo test, pytest, go test, make test,
  // etc.). All five share the same factory and the same exec allowlist
  // (resolved at module load time per F0.5 hardening).
  registry.register(createCodeQualityTool("run_tests", [config.workspace]));
  registry.register(createCodeQualityTool("format_code", [config.workspace]));
  registry.register(createCodeQualityTool("lint_code", [config.workspace]));
  registry.register(createCodeQualityTool("install_deps", [config.workspace]));
  registry.register(createCodeQualityTool("build_project", [config.workspace]));

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

  // memory_ops / memory_graph — explicit CRUD over semantic memory and the
  // knowledge graph. The extractor feeds both automatically in the
  // background; these tools let the agent act on "remember X" / "forget Y"
  // immediately and query what it already knows.
  registry.register(createMemoryOpsTool(semantic));
  registry.register(createMemoryGraphOpsTool(memoryGraph));

  // P0-2: feedback_skill — refine a skill's body given user feedback.
  // Default OFF (auto-creation is gated separately by
  // FERAL_SKILL_AUTO_CREATE); the tool itself is always available.
  registry.register(createFeedbackSkillTool(db.raw, router));

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

  // --- Skills subsystem (P0-2) ---
  const skillsStorage = new SkillsStorage();
  const skillAutoCreateEnabled = process.env.FERAL_SKILL_AUTO_CREATE === "true";
  // The auto-creator is created up front; whether it actually fires
  // depends on `enabled` AND on MemoryExtractor wiring below. The
  // onCreated callback emits a `skill_created` event so the React UI
  // can prompt the user to review.
  const skillCreator = new SkillAutoCreator({
    storage: skillsStorage,
    db: db.raw,
    router,
    enabled: skillAutoCreateEnabled,
    onCreated: (manifest, path) => {
      log(`skill created → ${manifest.id} (${manifest.name}) v${manifest.version}`);
      // The transport may not be wired yet at construction time, but
      // it's wired by the time any auto-create runs (those run AFTER
      // the first handle, which is AFTER transport.start()).
      if (sendHolder.current !== (() => {})) {
        sendHolder.current({
          type: "skill_created",
          skillId: manifest.id,
          name: manifest.name,
          path,
          version: manifest.version,
        });
      }
    },
  });

  // --- Memory extractor (async, fire-and-forget after each turn) ---
  const extractor = new MemoryExtractor(router, semantic, episodic, skillCreator);
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
  // Forward declaration: the sidecar's onIdle restarts the engine via
  // the passive supervisor, but the supervisor needs the sidecar to
  // start it — late-bind through this holder to break the cycle.
  let passive: PassiveSupervisor | undefined;
  const rsiSidecar = new RsiSidecar({
    router,
    db: db.raw,
    bridge: rsiBridge,
    send: (e) => transport.send(e as unknown as import("./types.ts").OutboundEvent),
    onIdle: () => passive?.onRunEnded(),
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
  // Passive RSI: the evolutionary engine runs in the background by
  // default (no UI trigger), starting itself when a real model is
  // present and restarting on each run end for continuous evolution.
  passive = new PassiveSupervisor({
    start: () => rsiSidecar.start(passiveStartOptions(process.env)),
    isRunning: () => rsiSidecar.isRunning(),
    log,
  });

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
          router.reconfigure({ provider, model, baseUrl, apiKey: msg.apiKey });
          transport.send({ type: "model_set", provider, model });
          log(`model hot-swapped → ${provider}/${model} @ ${baseUrl}`);
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
          if (event.type === "error")      mood?.applyEvent("inference_error");
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
        if (msg.rsiRequestId) {
          rsiSidecar.onResponse({
            id: msg.rsiRequestId,
            ok: msg.rsiOk ?? false,
            ...(msg.rsiData !== undefined ? { data: msg.rsiData } : {}),
            ...(msg.rsiError ? { error: msg.rsiError } : {}),
          });
        } else {
          log(`rsi_response without requestId — ignored`);
        }
        break;
      }
    }
  });

  transport.onReady(() => {
    log(
      `ready — transport=${config.transport} model=${config.inference.primary.model} ` +
        `workspace=${config.workspace}`,
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

    // Passive RSI: autostart the background evolutionary engine when a
    // real model is configured. Off when FERAL_RSI_PASSIVE=false or when
    // only a placeholder model is present (avoids spinning on empty
    // responses). The user never has to open /rsi — the agent improves
    // its own configuration on its own.
    const decision = shouldAutostartPassive(process.env);
    if (decision.enabled) {
      log(`rsi passive: autostarting background engine (${decision.reason})`);
      void passive?.begin();
    } else {
      log(`rsi passive: not autostarting (${decision.reason})`);
    }
  });

  // Persist final audit state on unexpected termination.
  const shutdown = () => {
    // Break the passive restart loop so we don't relaunch the engine
    // into a closing process.
    passive?.shutdown();
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

main().catch((err) => {
  // Startup misconfiguration (e.g. a target outside trustedBaseUrls) should
  // fail fast with a clear, single-line reason rather than a raw stack trace.
  log(`fatal: failed to start — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
