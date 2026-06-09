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
import { MemoryExtractor } from "./memory/extractor.ts";
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
import { AgentLoop } from "./core/agent-loop.ts";
import { MoodEngine } from "./core/mood.ts";
import { InnerThoughtsLoop } from "./core/inner-thoughts.ts";
import { HeartbeatLoop } from "./core/heartbeat.ts";
import { HookRegistry } from "./core/hook-registry.ts";
import { CronJobsRepo, CronScheduler, deliverCron } from "./cron/index.ts";
import { SkillsStorage, SkillAutoCreator } from "./skills/index.ts";
import { TauriTransport } from "./transports/tauri.ts";
import type { DeliveryTarget, Schedule } from "./types.ts";
import { loadSoul, watchSoul, resolveSoulPaths } from "./core/soul-loader.ts";
import { loadUserConfig } from "./core/user-loader.ts";
import { AskUserBridgeImpl } from "./core/ask-user-bridge.ts";
import { createAskUserTool } from "./tools/builtin/ask-user.ts";
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
        provider: env.FERAL_PROVIDER ?? "ollama",
        model: env.FERAL_MODEL ?? "qwen2.5:7b",
        baseUrl: env.FERAL_BASE_URL ?? "http://localhost:11434",
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

function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);

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

  // --- ECC tool observation telemetry ---
  const dataDir = config.dbPath === ":memory:" ? "data" : require("node:path").dirname(config.dbPath);
  const observations = new ToolObservationLog(dataDir);

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

  // --- P0-4: hook registry. Shared singleton that every layer can
  // emit into and any plugin / future tool can subscribe to. The
  // tool registry receives it next so before_tool_call handlers can
  // block tool invocations.
  const hooks = new HookRegistry();

  const registry = new ToolRegistry(egress, audit, processSandbox, observations, askUser, undefined, hooks);
  registry.register(createReadFileTool([config.workspace]));
  registry.register(createWriteFileTool([config.workspace]));
  registry.register(createListDirectoryTool([config.workspace]));
  // edit_file: in-place string replacement (safer than overwriting)
  registry.register(createEditFileTool([config.workspace]));
  // file_search: glob-style file finder under the workspace
  registry.register(createFileSearchTool([config.workspace]));
  // grep: regex content search under the workspace
  registry.register(createGrepTool([config.workspace]));
  // shell_exec + git_*: process-spawn tools for the workspace
  registry.register(createShellExecTool([config.workspace]));
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

  // --- Mood engine ---
  const mood = new MoodEngine();

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

  // --- Layer 1: Agent core ---
  const agent = new AgentLoop(
    router, registry, episodic,
    { onBudgetExhausted: config.inference.tokenBudget.onExhausted },
    recall,
    extractor,
    soul,
    user,
    hooks,
  );

  // --- Inner thoughts loop (proactive background) ---
  // P-#12: enabled by default — the agent must feel autonomous, coming to
  // the user with messages on its own. The loop is heavily gated so it
  // surfaces at most 2-3 messages per day, NEVER interrupts active
  // conversations, and only fires when there's genuine signal in mood
  // + recent activity. See InnerThoughtsLoop for gate details.
  // Disable with FERAL_INNER_THOUGHTS_ENABLED=false for a strictly
  // reactive agent.
  const innerThoughtsEnabled = process.env.FERAL_INNER_THOUGHTS_ENABLED !== "false";
  const innerThoughts = new InnerThoughtsLoop(router, episodic, mood, db.raw, {
    intervalMs: Number(process.env.FERAL_THOUGHTS_INTERVAL_MS ?? 2 * 60 * 1000),
    // 10 min idle — definitely a real break, not just the user looking
    // away from the screen for a second.
    minIdleMs: Number(process.env.FERAL_THOUGHTS_MIN_IDLE_MS ?? 10 * 60_000),
    // 4 hours between messages — caps cadence at ~1 per idle period.
    cooldownMs: Number(process.env.FERAL_THOUGHTS_COOLDOWN_MS ?? 4 * 60 * 60_000),
    // Hard daily cap: 2-3 proactive messages per UTC day. The user
    // can override higher (FERAL_THOUGHTS_DAILY_CAP=10) or lower (=0
    // to effectively disable emits). The four gates together produce
    // a maximally non-spammy agent by default.
    dailyCap: Number(process.env.FERAL_THOUGHTS_DAILY_CAP ?? 3),
    moodGateThreshold: Number(process.env.FERAL_THOUGHTS_MOOD_THRESHOLD ?? 0.5),
  });

  // --- Heartbeat loop (P2-#1) ---
  // Periodic OutboundEvent so the Tauri shell knows the sidecar is
  // alive. The transport's onMessage handler should treat absence of
  // heartbeats for N intervals as a hang signal.
  const heartbeat = new HeartbeatLoop({
    intervalMs: Number(process.env.FERAL_HEARTBEAT_INTERVAL_MS ?? 30_000),
    getActiveSessions: () => agent.activeSessionCount,
  });

  // --- Cron scheduler (P0-3) ---
  // User-schedulable jobs that run in the background. V1 runs each job
  // as a single LLM completion through the same router used for chat —
  // P0-1 (subagent delegation) will replace this with a proper tool-
  // using subagent run.
  const cronRepo = new CronJobsRepo(db.raw);
  const cronScheduler = new CronScheduler({
    repo: cronRepo,
    runJob: async (job) => {
      const res = await router.complete({
        sessionId: `cron:${job.id}`,
        messages: [
          {
            role: "system",
            content:
              "You are a scheduled task. Complete the user's task concisely. " +
              "Do not ask for clarification; produce the final answer.",
          },
          { role: "user", content: job.task },
        ],
        maxTokens: 2048,
        temperature: 0.3,
      });
      return res.content.trim();
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

  transport.onMessage(async (msg) => {
    switch (msg.type) {
      case "ping":
        transport.send({ type: "pong" });
        break;

      case "shutdown":
        log(`shutdown requested`);
        askUser.cancelAll("shutdown");
        db.close();
        process.exit(0);
        break;

      case "ask_user_response": {
        // Route the user's selection back to the matching pending request.
        // requestId/answers are present when type === "ask_user_response"
        // (the transport validates the shape; see isInbound).
        if (msg.requestId && msg.answers) {
          askUser.resolve(msg.requestId, msg.answers);
        } else {
          log(`ask_user_response: missing requestId or answers — ignored`);
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
        mood.applyEvent("message_received");
        // P-#12: the inner-thoughts loop watches idle time. Reset the
        // timer on every user message so the loop knows the user is
        // actively chatting and waits for a quiet moment before
        // surfacing its own thoughts. Cheap (single Date.now() write).
        if (innerThoughtsEnabled) innerThoughts.noteUserActivity();
        // skillsContext is the per-turn roster of locally-installed skills
        // (metadata only) sent by Rust. Rendered as a short "Available
        // skills" menu in the system prompt; the LLM loads any skill's body
        // on demand via the `read_skill` tool. See WorkingMemory.setSkillMenu.
        const skillsContext = msg.skillsContext;
        await agent.handle(sessionId, content, id, (event) => {
          transport.send(event);
          // Update mood based on what the agent loop emits.
          if (event.type === "done")       mood.applyEvent("message_answered");
          if (event.type === "tool_done") {
            const r = event.result as { ok?: boolean } | null;
            mood.applyEvent(r?.ok === false ? "tool_error" : "tool_success");
          }
          if (event.type === "error")      mood.applyEvent("inference_error");
        }, skillsContext);
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
    }
  });

  transport.onReady(() => {
    log(
      `ready — transport=${config.transport} model=${config.inference.primary.model} ` +
        `workspace=${config.workspace}`,
    );
    if (innerThoughtsEnabled) {
      innerThoughts.setEmit((event) => transport.send(event));
      innerThoughts.start();
      log("inner-thoughts loop enabled");
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
  });

  // Persist final audit state on unexpected termination.
  const shutdown = () => {
    if (innerThoughtsEnabled) innerThoughts.stop();
    heartbeat.stop();
    cronScheduler.stop();
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

try {
  main();
} catch (err) {
  // Startup misconfiguration (e.g. a target outside trustedBaseUrls) should
  // fail fast with a clear, single-line reason rather than a raw stack trace.
  log(`fatal: failed to start — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
