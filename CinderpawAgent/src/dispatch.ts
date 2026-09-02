/**
 * Inbound-message dispatch — the per-message switch extracted verbatim out
 * of `main()` (R7). Takes the boot context as an explicit parameter instead
 * of closing over module scope, per the plan's "thread state explicitly"
 * fallback (the switch's closure-state was too tangled — ~30 boot-scope
 * bindings — to recast as a mechanical per-case handler map without
 * touching business logic).
 *
 * `ctx.moduleEvalBusy` / `ctx.loraTrainBusy` are read AND reassigned by
 * their cases below, so they're intentionally left un-destructured (a
 * destructured primitive would only mutate a local copy, not `ctx`, and the
 * busy-guard would silently stop guarding across calls).
 */

import { join } from "node:path";
import type { InboundMessage, ModelTarget, Schedule, DeliveryTarget } from "./types.ts";
import type { BootContext } from "./boot.ts";
import { cfgBool, cfgPath } from "./config.ts";
import { runUnattended } from "./core/unattended.ts";
import { parseDoneWhenFromMessage } from "./cron/done-when.ts";
import { sha256Canonical } from "./rsi/infra/hash-chain.ts";
import { defaultJournalDir, journalFilename, verifyJournal } from "./rsi/infra/journal.ts";
import { liveModuleRegistry } from "./rsi/l4-modules/seam-runtime.ts";
import { bannerTitle, getCurrentTask, getLastActive } from "./memory/resume.ts";
import { getActiveWorkspaceId, getWorkspace } from "./memory/workspaces.ts";
import { governanceCheck } from "./rsi/l5-gov/governance.ts";
import { readChampion, defaultChampionPath } from "./rsi/l1-config/champion.ts";
import { withTimeout } from "./memory/fractal/bench/orchestrator.ts";
import { routerInfer } from "./memory/fractal/summarize.ts";
import { parseResponse } from "./core/agent-loop.ts";
import { BrainStack } from "./brain/brain-stack.ts";
import { rebuildDerivedBrain } from "./brain/brain-config.ts";

/**
 * Diagnostics go to stderr; stdout is reserved for the transport protocol.
 * Duplicated from boot.ts's identical helper rather than shared, to avoid a
 * circular runtime import between the two modules for a 3-line function.
 */
function log(message: string): void {
  process.stderr.write(`[cinderpaw] ${message}\n`);
}

/**
 * The sidecar version, for module manifests' runtime-compat stamp.
 * Duplicated from boot.ts's VERSION for the same anti-cycle reason as
 * log() above (dispatch may only type-import from boot).
 */
import pkgJson from "../package.json" with { type: "json" };
function sidecarVersion(): string {
  return cfgPath("CINDERPAW_VERSION") ?? ((pkgJson as { version?: string }).version || "0.0.0-dev");
}

/**
 * True when a base URL points at a loopback (local) host. Duplicated from
 * boot.ts's identical helper for the same reason as log() above.
 */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * What a good answer is when it will be spoken out loud.
 *
 * Written as a description of the surface, not as a personality override: the
 * owner's prompt, voice and tools stay exactly as they are, and only the shape of
 * the output changes. Every line here is a failure observed in a real call —
 * markdown read aloud as punctuation, a 95-second monologue in reply to a
 * greeting, and notes recited at someone who just said hello.
 */
const VOICE_SURFACE_BRIEF = [
  "## This turn is a VOICE CALL",
  "Your answer will be read out loud by a speech engine, and the person is listening, not reading.",
  "",
  "This changes how you SPEAK, not what you DO. Search, read files, run commands —",
  "use every tool exactly as you would in a typed conversation, and do the work before",
  "answering. If it will take a moment, say so in one short line first ('let me look')",
  "and then report what you found. Being brief is about the words, never about doing less.",
  "",
  // Said out loud because the two voice surfaces disagreed without it: the Live
  // engine's briefing carries this rule and the pipeline's did not. It is
  // usually redundant — a model answers in the language of the text it is given
  // — which is exactly why it was never missed: while the transcriber was
  // latched to one language, the agent was replying correctly to what it saw.
  // With detection free again, this is what keeps a switch mid-call from being
  // answered in the previous language.
  "- Answer in the language the person spoke to you in, whatever it is, and switch when they do.",
  "- Two or three sentences. If the full answer is longer, say the short version and offer the rest.",
  "- Plain spoken language. No markdown, no headings, no bullet lists, no code blocks, no emoji.",
  "- No preamble and no summary of what you are about to say — just say it.",
  "- Numbers, paths and identifiers: say them only when they matter, and say them the way a person would.",
  "- If you need to show something long (code, a table, a list), say so briefly and write it in the chat instead.",
].join("\n");

export async function dispatchMessage(ctx: BootContext, msg: InboundMessage): Promise<void> {
  const {
    db, audit, router, localFallbackTarget, dataDir, fractalMemory, askUser, hostTools, desktopControl, capabilityBridge, adminBridge, mcpManager, mood, innerThoughts, agent, cronRepo, transport, rsiBridge, activityMonitor, metaEvolution, rsiSidecar, dream, connectors, codePatchGate, governanceGate, modulesGate, loraGate, coworkApprovals, coworkMailbox, coworkAgents,
    runHooks,
    brainDerived, brainBreaker,
  } = ctx;

  switch (msg.type) {
      case "ping":
        transport.send({ type: "pong" });
        break;
      case "connectors_reload": {
        // The host sends the rows WITH their secrets, read out of the vault.
        // Reading connectors.json ourselves stopped being enough the moment
        // the migration emptied that file of credentials: every connector on
        // the machine would have come back up blank. The file path stays as
        // the fallback for a host that has not been updated.
        const rows = (msg as { connectors?: unknown }).connectors;
        if (Array.isArray(rows)) void connectors.applyRows(rows as never);
        else void connectors.reload();
        break;
      }
      // Thumbs 👍/👎 on an assistant message → one audit "feedback" row, the
      // wired source of the §2.10 `acceptance` personal-fitness signal. 👍 is
      // recorded as result "success", 👎 as "error"; the rated message id
      // rides `toolName`. Fire-and-forget — no reply, and audit.log never
      // throws to us.
      case "feedback":
        audit.log({
          actionType: "feedback",
          sessionId: msg.sessionId ?? "",
          result: msg.feedbackValue === "up" ? "success" : "error",
          toolName: msg.feedbackMessageId,
        });
        break;
      // BRSI §2.8 `user` Wake trigger: run one dream episode now. The scheduler
      // launches it on its next tick, bypassing the idle/cooldown gate.
      case "rsi_dream_now":
        dream.requestUserDream();
        break;

      // Faza 6 (L6) Meta Evolution — status / evolve / rollback / history.
      // Request/response correlated by `id` (same convention as chat): the
      // gateway's /meta/* routes and the desktop both consume `meta_result`.
      case "meta_status":
        transport.send({ type: "meta_result", id: msg.id ?? "", op: "status", ...metaEvolution.status() });
        break;
      case "meta_evolve":
        transport.send({ type: "meta_result", id: msg.id ?? "", op: "evolve", ...metaEvolution.evolve() });
        break;
      case "meta_rollback":
        transport.send({ type: "meta_result", id: msg.id ?? "", op: "rollback", ...metaEvolution.rollback() });
        break;
      case "meta_history":
        transport.send({ type: "meta_result", id: msg.id ?? "", op: "history", ok: true, history: metaEvolution.history() });
        break;

      // Slice A5 (L5 Governance) — host drives the `GovernanceLifecycle`
      // FSM through one inbound message per op, paired by `id` with the
      // `governance_result` reply the gateway + CLI consume. Mirrors the
      // meta_* handlers above: spread the lifecycle result onto the reply,
      // keep the handler synchronous, and bubble `{ ok:false, reason }`
      // results through unchanged (they're policy outcomes, not transport
      // errors — see brief §1 "Results that are `{ok:false, reason}` from
      // the FSM are NOT transport errors").
      case "governance_status": {
        const gl = governanceGate();
        transport.send({ type: "governance_result", id: msg.id ?? "", op: "status", ...gl.status() });
        break;
      }
      case "governance_propose": {
        const gl = governanceGate();
        const document = (msg as { document?: unknown }).document;
        transport.send({
          type: "governance_result",
          id: msg.id ?? "",
          op: "propose",
          ...gl.propose(document, "operator"),
        });
        break;
      }
      case "governance_approve": {
        const gl = governanceGate();
        // Brief: "if msg.documentHash is absent, compute it via
        // sha256Canonical(gl.proposalDocument(msg.id)) and echo the hash
        // in the result." Lets the CLI `cinderpaw governance approve <id>`
        // skip the canonical-JSON roundtrip in Rust; API callers that DO
        // pass an explicit hash still get the stale-hash safety net
        // (AC4) — pass nothing and we recompute, pass a wrong one and the
        // FSM rejects with a mismatch reason.
        // `msg.id` is the transport correlation id (a UUID minted by
        // governance_roundtrip), NOT the policy id — prefer `policyId`
        // like the reject handler does.
        const policyId = (msg as { policyId?: string }).policyId ?? "";
        let documentHash = (msg as { documentHash?: string }).documentHash ?? "";
        let computedHash = "";
        if (!documentHash) {
          const doc = gl.proposalDocument(policyId);
          if (!doc) {
            transport.send({
              type: "governance_result",
              id: msg.id ?? "",
              op: "approve",
              ok: false,
              reason: `unknown proposal: ${policyId}`,
            });
            break;
          }
          computedHash = sha256Canonical(doc);
          documentHash = computedHash;
        }
        const note = (msg as { note?: string }).note ?? "";
        const result = gl.approve(policyId, documentHash, note, "operator");
        transport.send({
          type: "governance_result",
          id: msg.id ?? "",
          op: "approve",
          ...result,
          ...(computedHash ? { documentHash: computedHash } : {}),
        });
        break;
      }
      case "governance_reject": {
        const gl = governanceGate();
        const policyId = (msg as { policyId?: string }).policyId ?? (msg as { id?: string }).id ?? "";
        const reason = (msg as { reason?: string }).reason ?? "";
        transport.send({
          type: "governance_result",
          id: msg.id ?? "",
          op: "reject",
          ...gl.reject(policyId, reason, "operator"),
        });
        break;
      }
      case "governance_rollback": {
        const gl = governanceGate();
        const reason = (msg as { reason?: string }).reason ?? "operator rollback";
        transport.send({
          type: "governance_result",
          id: msg.id ?? "",
          op: "rollback",
          ...gl.rollback(reason, "operator"),
        });
        break;
      }
      case "governance_freeze": {
        const gl = governanceGate();
        const layers = (msg as { layers?: string[] }).layers ?? [];
        const reason = (msg as { reason?: string }).reason ?? "";
        transport.send({
          type: "governance_result",
          id: msg.id ?? "",
          op: "freeze",
          ...gl.freeze(layers as ("l1" | "l2" | "l3" | "l4" | "l6")[], reason, "operator"),
        });
        break;
      }
      case "governance_unfreeze": {
        const gl = governanceGate();
        const layers = (msg as { layers?: string[] }).layers ?? [];
        const reason = (msg as { reason?: string }).reason ?? "";
        transport.send({
          type: "governance_result",
          id: msg.id ?? "",
          op: "unfreeze",
          ...gl.unfreeze(layers as ("l1" | "l2" | "l3" | "l4" | "l6")[], reason, "operator"),
        });
        break;
      }
      case "governance_verify": {
        const gl = governanceGate();
        // Brief: gl.verify() PLUS verifyJournal on last 7 UTC days. The
        // audit/chain verification is fast (in-process SHA256); the journal
        // walk caps at 7 to keep this snappy even on long-running installs.
        const chains = gl.verify();
        const journal: Array<{ file: string; ok: boolean; badRow?: number; reason?: string }> = [];
        const dir = defaultJournalDir();
        for (let offset = 0; offset < 7; offset++) {
          const d = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
          const file = journalFilename(d);
          const res = verifyJournal(`${dir}/${file}`);
          journal.push(
            res.ok
              ? { file, ok: true }
              : { file, ok: false, badRow: res.badRow, reason: res.reason },
          );
        }
        const allOk = chains.ok && journal.every((j) => j.ok);
        transport.send({
          type: "governance_result",
          id: msg.id ?? "",
          op: "verify",
          ok: allOk,
          chains,
          journal,
        });
        break;
      }
      case "governance_history": {
        const gl = governanceGate();
        const limit = (msg as { limit?: number }).limit ?? 50;
        transport.send({
          type: "governance_result",
          id: msg.id ?? "",
          op: "history",
          ok: true,
          history: gl.historyRows(limit),
        });
        break;
      }

      // Phase B (L4 Architecture Evolution) — modules surface (spec §10).
      // Same conventions as governance_*: one `modules_result` per request
      // paired by `id`; `{ok:false, reason}` results are lifecycle
      // outcomes, not transport errors.
      case "modules_list": {
        void (async () => {
          const ml = await modulesGate();
          const registry = liveModuleRegistry();
          const snap = registry.snapshot();
          const modules: Array<Record<string, unknown>> = [];
          for (const [seam, entry] of Object.entries(snap.seams)) {
            const ids = new Set(entry.candidates);
            if (entry.active !== "builtin") ids.add(entry.active);
            for (const moduleId of ids) {
              const env = ml.envelopeOf(moduleId);
              const report = env?.data.evalReport as
                | { accept?: boolean; reason?: string; gate?: { bootstrap?: Record<string, unknown> }; latency?: Record<string, unknown> }
                | undefined;
              modules.push({
                id: moduleId,
                seam,
                state: (env?.data.state as string | undefined) ?? "unknown",
                displayName: ml.manifestOf(moduleId)?.displayName ?? moduleId,
                active: entry.active === moduleId,
                ...(report
                  ? {
                      eval: {
                        accept: report.accept ?? false,
                        reason: report.reason ?? "",
                        bootstrap: report.gate?.bootstrap ?? {},
                        latency: report.latency ?? {},
                      },
                    }
                  : {}),
              });
            }
          }
          transport.send({
            type: "modules_result",
            id: msg.id ?? "",
            op: "list",
            ok: true,
            seams: snap.seams,
            modules,
          });
        })();
        break;
      }
      case "module_resolve": {
        void (async () => {
          const ml = await modulesGate();
          const moduleId = (msg as { moduleId?: string }).moduleId ?? "";
          const action = (msg as { moduleAction?: string }).moduleAction ?? "";
          const note = (msg as { note?: string }).note ?? "";
          const seam = (msg as { seam?: string }).seam ?? "";
          const result =
            action === "approve"
              ? ml.approve(moduleId, "operator")
              : action === "reject"
                ? ml.reject(moduleId, "operator", note || "rejected by operator")
                : action === "demote"
                  ? ml.demote(seam, "operator", note || "manual demote")
                  : { ok: false as const, reason: `invalid moduleAction '${action}' (approve|reject|demote)` };
          transport.send({
            type: "modules_result",
            id: msg.id ?? "",
            op: "resolve",
            action,
            ...result,
          });
        })();
        break;
      }
      case "module_propose": {
        // Gap 6 (L4 generative half): the LOCAL model authors a module
        // candidate for a seam. Proposal only — the returned moduleId
        // still has to clear the full lifecycle via `module_evaluate`.
        void (async () => {
          const reply = (extra: Record<string, unknown>): void => {
            transport.send({ type: "modules_result", id: msg.id ?? "", op: "propose", ...extra } as never);
          };
          if (!router.isPrimaryLocal) {
            reply({ ok: false, reason: "module proposal requires a LOCAL primary model (no network during proposal)" });
            return;
          }
          try {
            const { proposeModule } = await import("./rsi/l4-modules/module-proposer.ts");
            const { defaultModulesDir } = await import("./rsi/l4-modules/module-registry.ts");
            const proposed = await proposeModule({
              completeLocal: async ({ system, user, maxTokens }) => {
                const res = await router.complete({
                  sessionId: "module-proposer",
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
              modulesDir: defaultModulesDir(),
              runtimeVersion: sidecarVersion(),
              ...(typeof (msg as { seam?: string }).seam === "string" && (msg as { seam?: string }).seam
                ? { seam: (msg as { seam?: string }).seam }
                : {}),
            });
            if (!proposed) {
              reply({ ok: false, reason: "proposer declined (SKIP / nothing module-shaped / wall reject) — no candidate this round" });
              return;
            }
            log(`module-proposer: candidate ${proposed.moduleId} for seam ${proposed.seam} — ${proposed.rationale}`);
            reply({ ok: true, moduleId: proposed.moduleId, seam: proposed.seam, rationale: proposed.rationale });
          } catch (err) {
            reply({ ok: false, reason: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
      }
      case "module_evaluate": {
        void (async () => {
          const reply = (extra: Record<string, unknown>): void => {
            transport.send({ type: "modules_result", id: msg.id ?? "", op: "evaluate", ...extra } as never);
          };
          if (ctx.moduleEvalBusy) {
            reply({ ok: false, reason: "a module evaluation is already running" });
            return;
          }
          if (rsiSidecar.isRunning()) {
            reply({ ok: false, reason: "RSI engine is running — the eval suite would fight it for the model; retry after the episode" });
            return;
          }
          ctx.moduleEvalBusy = true;
          try {
            const ml = await modulesGate();
            const moduleId = (msg as { moduleId?: string }).moduleId ?? "";
            // Walk the pre-eval states as needed (idempotent re-entry:
            // a module already `built`/`quarantined` goes straight to eval).
            if (!ml.stateOf(moduleId)) {
              const p = ml.propose(moduleId);
              if (!p.ok) return reply({ ok: false, reason: p.reason });
            }
            if (ml.stateOf(moduleId) === "proposed") {
              const s = ml.sandbox(moduleId);
              if (!s.ok) return reply({ ok: false, reason: s.reason });
            }
            if (ml.stateOf(moduleId) === "sandboxed") {
              const b = await ml.build(moduleId);
              if (!b.ok) return reply({ ok: false, reason: b.reason });
            }
            const manifest = ml.manifestOf(moduleId);
            if (!manifest) return reply({ ok: false, reason: "manifest unreadable" });
            const { defaultModulesDir } = await import("./rsi/l4-modules/module-registry.ts");
            const evalDeps = rsiSidecar.moduleEvalDeps({
              seam: manifest.seam,
              moduleDir: join(defaultModulesDir(), moduleId),
              limits: manifest.limits,
            });
            const res = await ml.evaluate(moduleId, evalDeps);
            reply({
              ok: res.ok,
              ...(res.ok ? { state: res.state } : { reason: res.reason }),
              ...(res.report
                ? {
                    report: {
                      accept: res.report.accept,
                      reason: res.report.reason,
                      pairs: res.report.pairs.length,
                      bootstrap: res.report.gate.bootstrap,
                      latency: res.report.latency,
                      capabilitiesMeasured: res.report.capabilitiesMeasured,
                    },
                  }
                : {}),
            });
          } catch (err) {
            reply({ ok: false, reason: err instanceof Error ? err.message : String(err) });
          } finally {
            ctx.moduleEvalBusy = false;
          }
        })();
        break;
      }

      // Sprint 1.6 — Memory Resume. Read-only — never writes memory. Used by
      // R5 — MCP over stdin. The desktop's Extensions page (and any future
      // gateway route) drives the sidecar-owned MCP connections through
      // these four ops; every reply is one `mcp_result` line correlated by
      // `id`, mirroring the governance_result discipline.
      case "mcp_reload": {
        void mcpManager
          .reconcile()
          .then(() =>
            transport.send({
              type: "mcp_result",
              id: msg.id ?? "",
              op: "reload",
              ok: true,
              servers: mcpManager.status(),
            }),
          )
          .catch((e) =>
            transport.send({
              type: "mcp_result",
              id: msg.id ?? "",
              op: "reload",
              ok: false,
              error: String(e),
            }),
          );
        break;
      }
      case "mcp_status": {
        transport.send({
          type: "mcp_result",
          id: msg.id ?? "",
          op: "status",
          ok: true,
          servers: mcpManager.status(),
        });
        break;
      }
      case "mcp_list_tools": {
        const serverId = (msg as { serverId?: string }).serverId ?? "";
        void mcpManager.listTools(serverId).then(
          (tools) =>
            transport.send({
              type: "mcp_result",
              id: msg.id ?? "",
              op: "list_tools",
              ok: true,
              tools,
            }),
          (e) =>
            transport.send({
              type: "mcp_result",
              id: msg.id ?? "",
              op: "list_tools",
              ok: false,
              error: String(e),
            }),
        );
        break;
      }
      case "mcp_call_tool": {
        const m = msg as { serverId?: string; tool?: string; args?: Record<string, unknown> };
        void mcpManager.callTool(m.serverId ?? "", m.tool ?? "", m.args ?? {}).then(
          (result) =>
            transport.send({
              type: "mcp_result",
              id: msg.id ?? "",
              op: "call_tool",
              ok: true,
              result,
            }),
          (e) =>
            transport.send({
              type: "mcp_result",
              id: msg.id ?? "",
              op: "call_tool",
              ok: false,
              error: String(e),
            }),
        );
        break;
      }

      // the React `WelcomeBack` banner and the TUI last-task row. The handler
      // looks up `current_task` + `active_workspace_id` + `last_active_at` in
      // `meta` and joins the workspace name from `workspaces`. On first launch
      // every field is null and the host renders "fresh start" copy.
      case "resume_get": {
        const task = getCurrentTask(db.raw);
        const workspaceId = getActiveWorkspaceId(db.raw);
        const workspaceName = workspaceId
          ? getWorkspace(db.raw, workspaceId)?.name ?? null
          : null;
        const lastActiveAt = getLastActive(db.raw);
        transport.send({
          type: "resume_get_result",
          id: msg.id ?? "",
          task: task
            ? {
                // Both consumers of this reply are headings — the desktop
                // WelcomeBack banner and the TUI last-task row — so the title is
                // shortened here, at the one place they share, rather than in
                // each UI. The stored value stays whole.
                title: bannerTitle(task.title),
                ts: task.ts,
                workspace_id: task.workspaceId ?? null,
              }
            : null,
          workspace_id: workspaceId,
          workspace_name: workspaceName,
          last_active_at: lastActiveAt,
        });
        break;
      }

      // /compact (OpenClaw slash parity) — summarize the older portion of one
      // session's transcript now. Replies with one `compact_result` paired by
      // `id`. The summarizer is a full LLM completion, so this can take a
      // while on CPU — the caller owns its own timeout.
      // Provider conformance (see egress/conformance.ts): three short probes
      // that establish whether the configured model can actually drive the
      // agent, as opposed to merely answering chat. Run on demand from setup.
      case "provider_conformance": {
        void (async () => {
          try {
            const { probeProvider } = await import("./egress/conformance.ts");
            const report = await probeProvider(
              (req) => router.complete(req),
              (raw) => ({
                calls: parseResponse(raw).toolCalls.map((c) => ({ name: c.name, args: c.args })),
              }),
            );
            transport.send({
              type: "provider_conformance_result",
              id: msg.id ?? "",
              ok: true,
              ready: report.ready,
              summary: report.summary,
              probes: report.probes,
            });
          } catch (err) {
            transport.send({
              type: "provider_conformance_result",
              id: msg.id ?? "",
              ok: false,
              ready: false,
              summary: `conformance probe failed: ${String(err)}`,
              probes: [],
            });
          }
        })();
        break;
      }

      case "compact_session": {
        const sessionId = msg.sessionId ?? "default";
        try {
          const result = await agent.compactSession(sessionId);
          transport.send({ type: "compact_result", id: msg.id ?? "", ok: true, result });
        } catch (err) {
          transport.send({ type: "compact_result", id: msg.id ?? "", ok: false, error: String(err) });
        }
        break;
      }

      // Faza 2 Slice 5 — the code-patch approval gate. Store + apply live in
      // `pending-patches.ts`; this is only the IPC seam. Live apply needs the
      // real source repo (dev-mode knob CINDERPAW_CODE_RSI_REPO); without it an
      // approval is recorded but the patch stays un-applied.
      case "rsi_code_patches_list": {
        const { sendCodePatches } = await codePatchGate();
        sendCodePatches();
        break;
      }
      case "rsi_code_patch_resolve": {
        void (async () => {
          const { store, sendCodePatches } = await codePatchGate();
          const patchId = msg.id ?? "";
          const action = msg.patchAction;
          const ack = (status: string, error?: string): void => {
            transport.send({ type: "code_patch_resolved", id: patchId, status, ...(error ? { error } : {}) });
            sendCodePatches();
          };
          try {
            if (action !== "approve" && action !== "reject") {
              ack("error", `invalid patchAction '${String(action)}'`);
              return;
            }
            if (action === "approve") {
              // §8: this resolve IS the human approval — the check bites
              // on frozen.l3 (freeze wins over approval, G-INV-7).
              const gov = governanceCheck("l3_code_patch_apply", { approvalPresent: true });
              if (!gov.allowed) {
                ack("error", gov.reason);
                return;
              }
            }
            const resolved = store.resolve(patchId, action);
            if (action === "reject") {
              ack(resolved.status);
              return;
            }
            const repoRoot = cfgPath("CINDERPAW_CODE_RSI_REPO");
            if (!repoRoot) {
              ack("approved", "live apply unavailable: set CINDERPAW_CODE_RSI_REPO to the source repo");
              return;
            }
            const { applyPatchLive } = await import("./rsi/l3-code/pending-patches.ts");
            const r = await applyPatchLive({ store, id: patchId, repoRoot });
            ack(store.get(patchId)?.status ?? "error", r.ok ? undefined : r.reason);
          } catch (err) {
            ack("error", err instanceof Error ? err.message : String(err));
          }
        })();
        break;
      }

      // Agent Cowork S4 — the user's answer to a cowork approval request
      // rendered in chat. Unknown or already-terminal ids are a logged
      // no-op: a late double-click must never surface as an error.
      case "cowork_approval_resolve": {
        const requestId = msg.id ?? "";
        const action = msg.approvalAction;
        if (!requestId || (action !== "approve" && action !== "reject")) {
          log(`cowork_approval_resolve: missing id or approvalAction — ignored`);
          break;
        }
        const resolved = coworkApprovals.resolveExternal(requestId, action === "approve");
        if (!resolved) {
          log(`cowork_approval_resolve: unknown or already-resolved request ${requestId}`);
        }
        break;
      }

      // Agent Cowork S6 — the person writes to a teammate DIRECTLY from the
      // panel. Deliberately not routed through the main agent: making it
      // retype a message the human already wrote costs a whole model turn and
      // lets the wording drift on the way. The mailbox already accepts
      // `from: "human"`; this is the door the UI needed.
      case "cowork_user_message": {
        const to = (msg.toAgentId ?? "").trim();
        const body = (msg.body ?? "").trim();
        if (!to || !body) {
          log("cowork_user_message: missing toAgentId or body — ignored");
          break;
        }
        const target = coworkAgents.get(to);
        if (!target) {
          log(`cowork_user_message: unknown teammate ${to} — ignored`);
          break;
        }
        const threadId = msg.threadId?.trim() || null;
        // Same hop accounting as cowork_send, so a human reply inside a thread
        // advances the chain instead of resetting the cap.
        const hops = coworkMailbox.lastHopsInThread(threadId) + 1;
        coworkMailbox.send({
          fromAgentId: "human",
          toAgentId: target.id,
          threadId,
          body,
          payloadJson: JSON.stringify({ coworkHops: hops }),
        });
        log(`cowork: direct message to "${target.name}" (${body.length} chars, hop ${hops})`);
        break;
      }

      // Agent Cowork S6 — replay one thread from the mailbox. The panel is
      // otherwise live-only: it accumulates events in memory and loses them on
      // restart, so reopening a chat where teammates had worked showed nothing
      // even though every row was still on disk. The thread id IS the chat's
      // session id (see cowork_send), which is what ties a conversation in the
      // sidebar to the teammates who worked in it.
      case "cowork_history": {
        const threadId = (msg.threadId ?? "").trim();
        const rows = threadId ? coworkMailbox.byThread(threadId) : coworkMailbox.recent(50);
        transport.send({
          type: "cowork_history_result",
          threadId,
          messages: rows.map((m) => ({
            id: m.id,
            fromAgentId: m.fromAgentId,
            toAgentId: m.toAgentId,
            // Names resolved HERE, where the roster is: the stored row keeps
            // ids, and a panel that had to guess would be back to rendering
            // "demo-agent-atlas" at the person.
            fromAgentName: coworkAgents.get(m.fromAgentId)?.name,
            toAgentName: coworkAgents.get(m.toAgentId)?.name,
            body: m.body,
            status: m.status,
            createdAt: m.createdAt,
          })),
        });
        break;
      }

      // Faza 4 (L2 LoRA) — the personal-adaptation gate IPC.
      case "rsi_lora_reviews_list": {
        void (async () => {
          const { sendLoraReviews } = await loraGate();
          sendLoraReviews();
        })();
        break;
      }
      case "rsi_lora_review_resolve": {
        void (async () => {
          const { registry, reviews, sendLoraReviews } = await loraGate();
          const cardId = msg.id ?? "";
          const action = msg.loraAction;
          const ack = (status: string, error?: string): void => {
            transport.send({ type: "lora_review_resolved", id: cardId, status, ...(error ? { error } : {}) });
            sendLoraReviews();
          };
          try {
            if (action !== "approve" && action !== "reject") {
              ack("error", `invalid loraAction '${String(action)}'`);
              return;
            }
            if (action === "approve") {
              // §8: same policy-referenced gate as L3 — frozen.l2 blocks.
              const gov = governanceCheck("l2_lora_promote", { approvalPresent: true });
              if (!gov.allowed) {
                ack("error", gov.reason);
                return;
              }
            }
            const { applyLoraReview } = await import("./rsi/l2-adapt/lora-pipeline.ts");
            const { record } = applyLoraReview(registry, reviews, cardId, action);
            if (action === "approve") {
              // Promotion is live: stage the new champion adapter and reload
              // the model so the user is answered by it from now on. A
              // failed apply does NOT roll back the promotion — the adapter
              // also applies at every future load, so a transient reload
              // error self-heals; the ack carries the detail either way.
              try {
                await rsiBridge.request("rsi_set_lora", { path: record.adapterPath, scale: 1.0 });
                ack("approved");
              } catch (err) {
                ack("approved", `promoted, but live apply failed (applies at next model load): ${
                  err instanceof Error ? err.message : String(err)}`);
              }
              return;
            }
            ack("rejected");
          } catch (err) {
            ack("error", err instanceof Error ? err.message : String(err));
          }
        })();
        break;
      }
      case "rsi_lora_train": {
        void (async () => {
          const fail = (reason: string): void => {
            log(`lora train: ${reason}`);
            transport.send({ type: "lora_train_result", ok: false, reason });
          };
          if (ctx.loraTrainBusy) {
            fail("a training cycle is already running");
            return;
          }
          ctx.loraTrainBusy = true;
          try {
            if (!router.isPrimaryLocal) {
              fail("LoRA training requires a LOCAL primary model (the adapter applies to the local GGUF)");
              return;
            }
            const { registry, reviews, sendLoraReviews } = await loraGate();
            const { runLoraTrainingCycle, deriveAdapterId } = await import("./rsi/l2-adapt/lora-pipeline.ts");
            const { CliTrainer } = await import("./rsi/l2-adapt/trainers/cli-trainer.ts");
            const { writeDataset } = await import("./rsi/l2-adapt/dataset-builder.ts");
            const { makeLoraEvalRunner } = await import("./rsi/l2-adapt/lora-eval-runner.ts");
            const { makeRunEval } = await import("./rsi/infra/run-eval.ts");
            const { makeGetSpecs } = await import("./rsi/infra/get-specs.ts");
            const { makeInvokeAgent } = await import("./rsi/infra/invoke-agent.ts");
            const { championSeed } = await import("./rsi/l1-config/champion.ts");
            const { DEFAULT_SYSTEM_PROMPT } = await import("./rsi/sidecar.ts");
            const { paths } = await import("./rsi/infra/instance-paths.ts");
            const pathMod = require("node:path") as typeof import("node:path");

            const domainRaw = msg.loraDomain ?? "general";
            const DOMAINS = ["general", "coding", "research", "writing", "planning"] as const;
            const domain = (DOMAINS as readonly string[]).includes(domainRaw)
              ? (domainRaw as (typeof DOMAINS)[number])
              : "general";

            // Dataset: the most recent conversation record, heuristically
            // paired + redacted (Slice 2). ponytail: flat 5000-row cap;
            // incremental/windowed mining when datasets need curating.
            const rows = db.raw
              .query<{ sessionId: string; timestamp: number; role: string; content: string }, []>(
                "SELECT session_id AS sessionId, timestamp, role, content FROM episodic ORDER BY timestamp DESC LIMIT 5000",
              )
              .all();
            const datasetId = `ds-${new Date().toISOString().slice(0, 10)}-${Date.now() % 100000}`;
            const datasetPath = pathMod.join(paths().root, "lora", "datasets", `${datasetId}.jsonl`);
            const dataset = writeDataset(rows, datasetPath);
            if (dataset.pairs.length < 10) {
              fail(`not enough training data: ${dataset.pairs.length} usable pairs (need >= 10) — keep talking to Cinderpaw and retry`);
              return;
            }

            const baseModel = router.currentModel.model;
            const hyperparameters: Record<string, unknown> = {};
            const adapterId = deriveAdapterId(domain, baseModel, dataset.hash, hyperparameters);

            // Eval identity: the champion config when one exists, else a
            // fixed conservative config — CONSTANT across both eval runs so
            // the adapter is the only variable.
            const genome = championSeed(readChampion(defaultChampionPath())) ?? {
              id: "lora-eval-identity",
              generation: 0,
              lineage: [],
              config: {
                promptTemplateId: 0,
                temperature: 0.2,
                systemPromptId: 0,
                retrievalStrategy: "episodic" as const,
                contextWindowUsage: 0.4,
                toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
                decompositionDepth: 0,
              },
            };
            const invokeAgent = makeInvokeAgent({
              router,
              contextBudget: 1024,
              // Same identity + /no_think discipline as the config ladder's
              // eval (sidecar.ts) — Tier 0 grades the agent-as-shipped.
              getSystemPrompt: () =>
                "You are Cinderpaw, a local AI agent made by bloom. " + DEFAULT_SYSTEM_PROMPT + " /no_think",
            });
            const getSpecs = makeGetSpecs({
              fetchTier0: () => rsiBridge.request("rsi_get_tier0_specs", {}),
            });
            const runEval = makeLoraEvalRunner({
              setLora: async (p) => {
                await rsiBridge.request("rsi_set_lora", { path: p, scale: 1.0 });
              },
              runEval: makeRunEval({ getSpecs, invokeAgent, log }),
              genome,
              baselineAdapterPath: () => registry.champion(domain)?.adapterPath ?? null,
              log,
            });

            log(`lora train: starting cycle ${adapterId} (domain=${domain}, base=${baseModel}, pairs=${dataset.pairs.length})`);
            const result = await runLoraTrainingCycle({
              registry,
              reviews,
              trainer: new CliTrainer(),
              domain,
              baseModel,
              dataset: { id: datasetId, path: dataset.path, hash: dataset.hash },
              hyperparameters,
              outputDir: pathMod.join(paths().root, "lora", "adapters", adapterId),
              runEval,
            });
            if (!result.ok) {
              fail(result.reason);
              return;
            }
            log(`lora train: cycle done — ${result.card.gate.verdict} (${result.card.gate.reason})`);
            transport.send({
              type: "lora_train_result",
              ok: true,
              adapterId: result.record.id,
              verdict: result.card.gate.verdict,
            });
            sendLoraReviews();
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
          } finally {
            ctx.loraTrainBusy = false;
          }
        })();
        break;
      }

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
        mcpManager.killAll();
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
      case "tool_response": {
        // The host ran a tool it owns and is handing back the result — see
        // core/host-tool-bridge.ts. `error` and `content` are distinct on
        // purpose: an error reaches the model as a failed tool call it can read
        // and retry differently, while content is the tool's output.
        if (!msg.requestId) {
          log(`tool_response: missing requestId — ignored`);
          break;
        }
        const routed =
          typeof msg.error === "string"
            ? hostTools.fail(msg.requestId, msg.error)
            : hostTools.resolve(msg.requestId, msg.content ?? "");
        // An unmatched id means the agent already gave up on that call (the
        // registry's own 60s timeout, or a stop). Silence here is how a host
        // ends up waiting forever on a conversation that already moved on.
        if (!routed) log(`tool_response: no pending host tool call ${msg.requestId} — it already timed out or was cancelled`);
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

      case "capability_response": {
        // Result of a host-side capability list/inspect/install. Settle the
        // matching pending request so the tool's awaited Promise resolves.
        if (msg.id) {
          capabilityBridge.resolve(msg.id, msg.ok === true, msg.data, msg.error);
        } else {
          log(`capability_response: missing id — ignored`);
        }
        break;
      }

      case "admin_response": {
        if (msg.id) {
          adminBridge.resolve(msg.id, msg.ok === true, msg.data, msg.error);
        } else {
          log(`admin_response: missing id — ignored`);
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
          //
          // …unless the host tells us the engine has no model resident. The
          // desktop unloads the GGUF on every switch to cloud, so the fallback
          // was guaranteed to 503 "no model selected" — burying the real cloud
          // error — and the Rust API's lazy-load would drag the multi-GB model
          // straight back into RSS on the first hiccup.
          // A second cloud provider, when the host found one, in preference to
          // the local engine. It is the only fallback that exists on a machine
          // with no GGUF resident — which is where the missing one hurt, since
          // there a single 429 ended the turn outright.
          const cloudFallback: ModelTarget | undefined = msg.fallback?.provider
            ? {
                provider: msg.fallback.provider,
                model: msg.fallback.model,
                baseUrl: msg.fallback.baseUrl,
                apiKey: msg.fallback.apiKey,
              }
            : undefined;
          const fallback = isLoopbackUrl(baseUrl)
            // A local primary IS the safe target; nothing to fail over to.
            ? undefined
            : (cloudFallback ??
               (msg.localFallbackAvailable === false ? undefined : localFallbackTarget));
          router.reconfigure(primary, fallback);
          // The router now trusts only the new targets. A brain still holding
          // the old ones would route the next turn to an endpoint the router
          // refuses — which is how a model switch used to end every turn with
          // "refusing to contact untrusted inference endpoint", naming the
          // provider the user had just left. Refusing was right; routing there
          // at all was the fault.
          const nextBrain = rebuildDerivedBrain(brainDerived, primary, fallback);
          if (nextBrain) agent.setBrain(new BrainStack(nextBrain, brainBreaker, log));
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

      // A call that Gemini conducted, filed after the fact. No reply is
      // generated and no event is emitted beyond the ack: the user already
      // heard the answer, live, and the only thing missing was the record.
      case "record_turn": {
        await agent.recordTurn(
          msg.sessionId ?? "default",
          msg.content ?? "",
          msg.assistantContent ?? "",
        );
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
        // Memory Resume (current_task / last_active_at) is written from
        // AgentLoop's user-turn observer, wired in boot — connector surfaces
        // reach the agent without passing through here, and they are the user
        // working too.
        //
        // skillsContext is the per-turn roster of locally-installed skills
        // (metadata only) sent by Rust. Rendered as a short "Available
        // skills" menu in the system prompt; the LLM loads any skill's body
        // on demand via the `read_skill` tool. See WorkingMemory.setSkillMenu.
        const skillsContext = msg.skillsContext;
        // A voice call is a surface, like a chat app with a narrow column — the
        // mechanism the loop already has for "adapt the format to where this is
        // read" (`setSessionSurface`, a per-turn drawer that leaves the owner's
        // full prompt and toolset intact). Set per message rather than per session
        // because the same conversation is spoken to and typed in, alternately,
        // and the brief must follow whichever is happening now.
        if (msg.surface === "voice") {
          agent.setSessionSurface(sessionId, VOICE_SURFACE_BRIEF, { spoken: true });
        } else if (msg.surface === "text") {
          // Explicitly typed → drop the spoken brief. Only the desktop sends this
          // field, so a connector's own brief is never touched here.
          agent.setSessionSurface(sessionId, "");
        }
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
        // The boot MCP reconcile is fire-and-forget, so the very first message
        // could be planned against a registry that had no MCP tools in it yet —
        // the agent answered "I have no tool for that" for a server the user
        // could see connected. Bounded wait; a slow server still lands on the
        // next turn via #syncTools(). No-op once the reconcile has settled.
        await mcpManager.ready();
        const relay = (event: import("./types.ts").OutboundEvent) => {
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
          // The turn's own verdict, which is the only place the runtime learns
          // whether the WORK landed rather than whether the plumbing held.
          //
          // Until now the engine's error trigger heard inference failures and
          // nothing else, and its fitness vector was built from tool results
          // and the thumbs a user almost never gives. So the agent could fail
          // a job outright and no part of the self-improvement loop counted
          // that as a reason to change anything: it adapted to its own
          // plumbing, never to its results.
          //
          // Two consumers, one row. `recordOutcome` makes a failed turn wake
          // an episode; the audit row makes it a `workflow_completion` signal
          // in the next candidate's fitness vector (see personal-fitness.ts,
          // where that signal kind was declared and left unwired).
          //
          // `runSummary` closes an unattended RUN and restates the last turn
          // rather than being one, and an `incomplete` turn is one an
          // unattended caller is about to continue — counting either would
          // double-count the work. Only a terminal turn is a unit of work.
          if (event.type === "done" && !event.runSummary && !event.incomplete) {
            const ok = event.outcome === undefined || event.outcome === "completed";
            const at = Date.now();
            activityMonitor.recordOutcome(at, ok);
            try {
              audit.log({
                sessionId,
                actionType: "task_outcome",
                // The structured reason, so a journal row says WHICH way it
                // ended and not merely that it did.
                toolName: event.outcome ?? "completed",
                result: ok ? "success" : "error",
              });
            } catch {
              // Telemetry: a failed audit write must never cost the user a turn.
            }
          }
        };
        // Unattended: CINDERPAW_AUTONOMOUS already means "nobody is at the machine
        // to answer ask_user". The same fact means nobody is here to type
        // "continue" either, so a turn cut short by the wall-clock budget must
        // be resumed rather than delivered as the answer. Continuation only
        // fires on an outcome that was actually cut off, so an ordinary message
        // costs exactly one turn as before.
        if (cfgBool("CINDERPAW_AUTONOMOUS")) {
          // A durable row, exactly as a connector message gets one. This path
          // used to call runUnattended with NO options at all: no recorder, so
          // nothing survived the process; no stall guard, so a run producing
          // nothing kept its whole continuation budget; and no completion
          // check, so `done_when:` was inert here. With continuations sized at
          // an eight-hour deadline that stopped being a small omission.
          const record = await runHooks.begin(
            sessionId,
            content,
            "desktop",
            sessionId,
            parseDoneWhenFromMessage(content),
          );
          const run = await runUnattended(
            (text, messageId) =>
              agent.handleTurn(sessionId, text, messageId, relay, skillsContext, images, inferParams),
            content,
            id,
            record
              ? { recorder: record.recorder, stalled: record.stalled, verify: record.verify }
              : {},
          );
          const verdict = await record?.done(run);
          const summary = verdict ? `${run.text}\n\n${verdict}` : run.text;
          // Concluded BEFORE the event goes out, for the reason the connectors
          // conclude before sending: a process that dies in between leaves a row
          // that knows both that it ended and what it owed.
          record?.conclude(summary);
          // Each turn emits its own `done`, and a turn that was cut short is
          // flagged `incomplete` so a consumer knows not to treat it as the
          // answer. But only THIS loop knows whether another turn is actually
          // coming: with continuations exhausted or disabled, the last event a
          // consumer saw was an incomplete `done` followed by silence, and
          // anything waiting for the real answer waited forever. Close the run
          // explicitly when it ends without finishing.
          if (!run.finished) {
            transport.send({
              type: "done",
              id,
              content: summary,
              stopped: false,
              traceId: id,
              outcome: run.outcome,
              incomplete: false,
              runSummary: true,
            });
          }
          record?.delivered();
        } else {
          await agent.handle(sessionId, content, id, relay, skillsContext, images, inferParams);
        }
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
}
