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
import { openDatabase } from "./db.ts";
import { AuditLog } from "./sandbox/audit-log.ts";
import { EgressProxy } from "./sandbox/egress-proxy.ts";
import { InferenceRouter } from "./sandbox/inference-router.ts";
import { EpisodicMemory } from "./memory/episodic.ts";
import { SemanticMemory } from "./memory/semantic.ts";
import { RecallEngine } from "./memory/recall.ts";
import { MemoryExtractor } from "./memory/extractor.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { createReadFileTool } from "./tools/builtin/read-file.ts";
import { createWriteFileTool } from "./tools/builtin/write-file.ts";
import { createListDirectoryTool } from "./tools/builtin/list-directory.ts";
import { createWebSearchTool } from "./tools/builtin/web-search.ts";
import { createFetchUrlTool } from "./tools/builtin/fetch-url.ts";
import { createReadWebpageTool } from "./tools/builtin/read-webpage.ts";
import { createDeepResearchTool } from "./tools/builtin/deep-research.ts";
import { createToolHealthTool } from "./tools/builtin/tool-health.ts";
import { createScanWorkspaceTool } from "./tools/builtin/scan-workspace.ts";
import { ToolObservationLog } from "./telemetry/tool-observations.ts";
import { AgentLoop } from "./core/agent-loop.ts";
import { MoodEngine } from "./core/mood.ts";
import { InnerThoughtsLoop } from "./core/inner-thoughts.ts";
import { TauriTransport } from "./transports/tauri.ts";
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
      },
      ...(env.FERAL_FALLBACK_MODEL
        ? {
            fallback: {
              provider: env.FERAL_FALLBACK_PROVIDER ?? "ollama",
              model: env.FERAL_FALLBACK_MODEL,
              baseUrl: env.FERAL_FALLBACK_BASE_URL ?? "http://localhost:11434",
            },
          }
        : {}),
      tokenBudget: {
        // No token caps by default. On BYOK the user pays their own provider, so
        // a daily/per-conversation ceiling has no cost rationale — it only bricks
        // long sessions (the old 50k/500k caps did exactly that after one deep
        // research turn). Conversations stay bounded by working-memory context
        // compression, not by a hard token wall. Power users can still opt into a
        // runaway guard via FERAL_BUDGET_* env vars; left unset means unlimited.
        perConversation: Number(env.FERAL_BUDGET_CONVERSATION ?? Infinity),
        perDay: Number(env.FERAL_BUDGET_DAY ?? Infinity),
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

  // --- Layer 3: Sandbox (built first) ---
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const router = new InferenceRouter(config.inference, audit.logger, db.raw);

  // --- Layer 2: Memory ---
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const semantic = new SemanticMemory(db.raw, audit.logger);
  const recall = new RecallEngine(episodic, semantic);

  // --- ECC tool observation telemetry ---
  const dataDir = config.dbPath === ":memory:" ? "data" : require("node:path").dirname(config.dbPath);
  const observations = new ToolObservationLog(dataDir);

  // --- Tools (each gated by the sandbox) ---
  const registry = new ToolRegistry(egress, audit, observations);
  registry.register(createReadFileTool([config.workspace]));
  registry.register(createWriteFileTool([config.workspace]));
  registry.register(createListDirectoryTool([config.workspace]));
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

  // --- Mood engine ---
  const mood = new MoodEngine();

  // --- Memory extractor (async, fire-and-forget after each turn) ---
  const extractor = new MemoryExtractor(router, semantic, episodic);

  // --- Layer 1: Agent core ---
  const agent = new AgentLoop(
    router, registry, episodic,
    { onBudgetExhausted: config.inference.tokenBudget.onExhausted },
    recall,
    extractor,
  );

  // --- Inner thoughts loop (proactive background) ---
  // Disabled by default in V1. The dental-pilot deliverable does not require it
  // and the loop contends for inference budget with real user requests.
  // Enable with: FERAL_INNER_THOUGHTS_ENABLED=true
  const innerThoughtsEnabled = process.env.FERAL_INNER_THOUGHTS_ENABLED === "true";
  const innerThoughts = new InnerThoughtsLoop(router, episodic, mood, db.raw, {
    intervalMs: Number(process.env.FERAL_THOUGHTS_INTERVAL_MS ?? 5 * 60 * 1000),
  });

  // --- Layer 4: Transport ---
  const transport = buildTransport(config.transport);

  transport.onMessage(async (msg) => {
    switch (msg.type) {
      case "ping":
        transport.send({ type: "pong" });
        break;

      case "shutdown":
        log(`shutdown requested`);
        db.close();
        process.exit(0);
        break;

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
        await agent.handle(sessionId, content, id, (event) => {
          transport.send(event);
          // Update mood based on what the agent loop emits.
          if (event.type === "done")       mood.applyEvent("message_answered");
          if (event.type === "tool_done") {
            const r = event.result as { ok?: boolean } | null;
            mood.applyEvent(r?.ok === false ? "tool_error" : "tool_success");
          }
          if (event.type === "error")      mood.applyEvent("inference_error");
        });
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
  });

  // Persist final audit state on unexpected termination.
  const shutdown = () => {
    if (innerThoughtsEnabled) innerThoughts.stop();
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
