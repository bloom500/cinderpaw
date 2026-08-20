import { useEffect, useState } from 'react';
import { Moon, Sparkles, Check, X, AlertTriangle, Code2, FileText, GitMerge, Undo2, Brain, Shield } from 'lucide-react';
import { tauri, type DreamTelemetrySummary, type JournalRow, type ChampionTreeRow, type CodePatch, type CodePatchStatus, type CodePatchesPayload } from '@/lib/tauri';
import { events, type LoraReviewsLine, type MetaResultLine, type GovernanceResultLine, type ModulesResultLine } from '@/lib/tauri/events';
import { useDream, type DreamStage } from '@/stores/dream';
import { useSettings } from '@/stores/settings';

/** The §2.8 stages the sidecar actually emits (dream/mutate are subsumed by the
 *  opaque engine episode in Faza 1). The live indicator walks these in order. */
const STAGE_STEPS: { key: DreamStage; label: string }[] = [
  { key: 'wake', label: 'Wake' },
  { key: 'observe', label: 'Observe' },
  { key: 'evaluate', label: 'Evaluate' },
  { key: 'remember', label: 'Remember' },
  { key: 'sleep', label: 'Sleep' },
];

/** Live Dream Cycle stage indicator — lights up wake→observe→evaluate→remember
 *  →sleep as the sidecar emits `dream_cycle` stage pulses. Shown only while a
 *  cycle is running. The `evaluate` step spans the whole episode (the engine's
 *  proposal/eval loop is opaque in Faza 1), so it dwells there the longest. */
function DreamStageStepper({ stage }: { stage: DreamStage | null }) {
  const activeIdx = STAGE_STEPS.findIndex((s) => s.key === stage);
  return (
    <div className="flex items-center gap-1.5 text-micro" aria-label="Dream cycle stage">
      {STAGE_STEPS.map((s, i) => {
        const state = activeIdx < 0 ? 'idle' : i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'todo';
        return (
          <span key={s.key} className="flex items-center gap-1">
            <span
              className={
                state === 'active'
                  ? 'text-brand font-medium'
                  : state === 'done'
                    ? 'text-text-secondary'
                    : 'text-text-muted'
              }
            >
              {s.label}
            </span>
            {i < STAGE_STEPS.length - 1 && <span className="text-text-muted">›</span>}
          </span>
        );
      })}
    </div>
  );
}

/**
 * "Cinderpaw's Dreams" — lifetime view of the Dream Cycle (RSI self-improvement
 * that runs while the user is idle). Reads aggregated telemetry from
 * `~/.feral/rsi/dream.jsonl` via `rsi_dream_telemetry` and refreshes whenever
 * a new episode ends (the `dream_cycle` pulse the sidecar emits). Read-only:
 * the user watches Cinderpaw improve itself, they don't pilot it.
 *
 * `ratchets` is the number that matters — each one is a real improvement
 * committed to main, so "N improvements" is the honest "it got better" signal
 * (vs `episodes`, which only counts that it tried).
 */
const RECENT_LIMIT = 16;

export function CinderpawDreamsPanel() {
  const [summary, setSummary] = useState<DreamTelemetrySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<JournalRow[]>([]);
  const [champions, setChampions] = useState<ChampionTreeRow[]>([]);
  const [pendingPatches, setPendingPatches] = useState<CodePatchesPayload | null>(null);
  const [resolving, setResolving] = useState<Set<string>>(new Set());
  const [requested, setRequested] = useState(false);
  // Faza 4 (L2 LoRA) — review inbox + champions + one-at-a-time training state.
  const [loraReviews, setLoraReviews] = useState<LoraReviewsLine | null>(null);
  const [loraResolving, setLoraResolving] = useState<Set<string>>(new Set());
  const [loraTraining, setLoraTraining] = useState(false);
  const [loraTrainNote, setLoraTrainNote] = useState<string | null>(null);
  // Faza 6 (L6) Meta Evolution — status snapshot + in-flight/action note.
  const [metaStatus, setMetaStatus] = useState<MetaResultLine | null>(null);
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaNote, setMetaNote] = useState<string | null>(null);
  // Slice A6 (L5 Governance) — safety-rules snapshot + tamper check + inbox.
  const [govStatus, setGovStatus] = useState<GovernanceResultLine | null>(null);
  const [govVerify, setGovVerify] = useState<GovernanceResultLine | null>(null);
  const [govResolving, setGovResolving] = useState<Set<string>>(new Set());
  const [govNote, setGovNote] = useState<string | null>(null);
  // Phase B (L4 Architecture Evolution) — module inbox + quarantine toast.
  const [modulesList, setModulesList] = useState<ModulesResultLine | null>(null);
  const [modulesResolving, setModulesResolving] = useState<Set<string>>(new Set());
  const [modulesNote, setModulesNote] = useState<string | null>(null);
  const dreaming = useDream((s) => s.dreaming);
  const stage = useDream((s) => s.stage);
  const settings = useSettings((s) => s.settings);
  const setAllowCloudDreams = useSettings((s) => s.setRsiAllowCloudDreams);
  const [allowBusy, setAllowBusy] = useState(false);

  // Why the panel can be empty forever. Dreaming on a cloud model spends real
  // money in the background, so it is off unless the user says yes — and on a
  // machine with no local model that is EVERY dream, which made "no dreams
  // yet" a permanent state with its reason buried in a log file. A route of
  // `local:…` (or none at all, the bundled default) is free and always dreams.
  const route = settings?.active_route ?? null;
  const onCloudModel = route !== null && !route.startsWith('local:');
  const dreamsAsleep = onCloudModel && settings?.rsi_allow_cloud_dreams !== true;
  const budget = settings?.rsi_max_cost_usd ?? 0;

  // BRSI §2.8 `user` Wake trigger: ask the Dream Cycle to run one episode now
  // instead of waiting for the idle gate. Best-effort — a failure (sidecar not
  // running) is swallowed; the scheduler launches on its next tick.
  const dreamNow = async () => {
    try {
      await tauri.rsi.dreamNow();
      setRequested(true);
    } catch { /* sidecar not running — ignore */ }
  };

  // Faza 6 — Evolve / Rollback. Fire-and-forget; the `meta_result` listener
  // clears the busy flag, surfaces the reason on failure and re-requests status.
  const runMetaAction = async (op: 'evolve' | 'rollback') => {
    if (metaBusy) return;
    setMetaBusy(true);
    setMetaNote(null);
    try {
      await tauri.rsi.meta(op);
    } catch {
      setMetaBusy(false); // sidecar not running — allow retry
    }
  };

  // Slice A6 — approve or reject one pending rules proposal. The sidecar's
  // ack (`governance_result` op approve/reject) clears the in-flight set and
  // re-requests status; approve omits the document hash on purpose — the
  // sidecar computes it from the stored proposal (A5 convenience path).
  const resolveProposal = async (policyId: string, action: 'approve' | 'reject') => {
    if (govResolving.has(policyId)) return;
    setGovResolving((s) => new Set(s).add(policyId));
    try {
      await tauri.rsi.governance(action, {
        policyId,
        reason: action === 'reject' ? 'rejected from desktop' : undefined,
      });
    } catch {
      setGovResolving((s) => {
        const next = new Set(s);
        next.delete(policyId);
        return next;
      });
    }
  };

  // Phase B (L4) — approve / reject a module candidate, or demote a seam
  // back to its builtin. The ack (`modules_result` op resolve) clears the
  // in-flight set and re-requests the list.
  const resolveModule = async (
    action: 'approve' | 'reject' | 'demote',
    args: { moduleId?: string; seam?: string },
  ) => {
    const key = args.moduleId ?? args.seam ?? '';
    if (modulesResolving.has(key)) return;
    setModulesResolving((s) => new Set(s).add(key));
    try {
      await tauri.rsi.modules(action, args);
    } catch {
      setModulesResolving((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  };

  // `requested` holds until the episode actually starts (`dreaming` flips
  // true) — a fixed short timer here made the button silently revert while
  // the request was still queued behind a running episode, which read as
  // "nothing happened". The long fallback only covers a sidecar that never
  // starts the episode at all.
  useEffect(() => {
    if (dreaming) {
      setRequested(false);
      return;
    }
    if (!requested) return;
    const t = setTimeout(() => setRequested(false), 120_000);
    return () => clearTimeout(t);
  }, [dreaming, requested]);

  // Faza 2 Slice 5 — approve or reject a pending code patch. The sidecar
  // replies with `code_patch_resolved` + a refreshed `code_patches` snapshot
  // (handled by the listeners below); the per-row "resolving" set keeps the
  // buttons disabled until the ack lands so a double-click can't fire twice.
  const resolvePatch = async (patchId: string, action: 'approve' | 'reject') => {
    if (resolving.has(patchId)) return;
    setResolving((s) => new Set(s).add(patchId));
    try {
      await tauri.rsi.codePatchResolve(patchId, action);
    } catch {
      // Sidecar didn't ack — drop the resolving flag so the user can retry.
      setResolving((s) => {
        const next = new Set(s);
        next.delete(patchId);
        return next;
      });
    }
  };

  // Faza 4 — approve/reject one LoRA review card. Approve promotes the
  // adapter to domain champion and applies it to the loaded model live.
  const resolveLoraCard = async (cardId: string, action: 'approve' | 'reject') => {
    if (loraResolving.has(cardId)) return;
    setLoraResolving((s) => new Set(s).add(cardId));
    try {
      await tauri.rsi.loraReviewResolve(cardId, action);
    } catch {
      setLoraResolving((s) => {
        const next = new Set(s);
        next.delete(cardId);
        return next;
      });
    }
  };

  // Faza 4 — run one training cycle. Long-running (train + two eval passes);
  // the button stays busy until `lora_train_result` lands.
  const loraTrainNow = async () => {
    if (loraTraining) return;
    setLoraTraining(true);
    setLoraTrainNote(null);
    try {
      await tauri.rsi.loraTrain();
    } catch (e) {
      setLoraTraining(false);
      setLoraTrainNote(String(e));
    }
  };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await tauri.rsi.dreamTelemetry(RECENT_LIMIT);
        if (alive) { setSummary(s); setError(null); }
      } catch (e) {
        if (alive) setError(String(e));
      }
      // Receipts are a soft add-on: a failure here (e.g. no journal yet)
      // must never blank the whole panel, so it has its own guard.
      try {
        const rows = await tauri.rsi.journalRecent(RECENT_LIMIT);
        if (alive) setReceipts(rows);
      } catch {
        if (alive) setReceipts([]);
      }
      // Tree of Champions (§7.4) — its own guard, same soft-add-on discipline.
      try {
        const tree = await tauri.rsi.championTree();
        if (alive) setChampions(tree);
      } catch {
        if (alive) setChampions([]);
      }
      // Faza 2 Slice 5 — pending code-patch queue. Fire-and-forget IPC; the
      // real data arrives via `onCodePatches` below. Same soft-add-on
      // discipline as the other fetches.
      try {
        await tauri.rsi.codePatchesList();
      } catch { /* sidecar not running — the listener will fill in later */ }
      // Faza 4 — LoRA review inbox, same fire-and-forget discipline.
      try {
        await tauri.rsi.loraReviewsList();
      } catch { /* sidecar not running — the listener will fill in later */ }
      // Faza 6 (L6) — MetaGenome status, same fire-and-forget discipline.
      try {
        await tauri.rsi.meta('status');
      } catch { /* sidecar not running — the listener will fill in later */ }
      // Slice A6 (L5) — safety-rules status + tamper check, same discipline.
      try {
        await tauri.rsi.governance('status');
        await tauri.rsi.governance('verify');
      } catch { /* sidecar not running — the listener will fill in later */ }
      // Phase B (L4) — module inbox, same discipline.
      try {
        await tauri.rsi.modules('list');
      } catch { /* sidecar not running — the listener will fill in later */ }
    };
    void load();
    // A completed episode appends a new line → reload to pick it up.
    const unlistenDream = events.onDreamCycle.listen((e) => {
      if (alive && e.phase === 'ended') void load();
    });
    // Pending patches stream: full snapshot on every change.
    const unlistenPatches = events.onCodePatches.listen((e) => {
      if (!alive) return;
      // The wire type carries `status: string` (Rust doesn't tag enums on
      // the wire); the domain type is the strict `CodePatchStatus` union per
      // spec §2.5. The cast is sound because the sidecar is the only writer
      // and only emits one of the six named values.
      setPendingPatches({
        patches: e.patches as unknown as CodePatch[],
        manualWindowOpen: e.manualWindowOpen,
        appliedCount: e.appliedCount,
      });
      // Any ack of a row we were tracking is no longer in flight.
      setResolving((s) => {
        if (s.size === 0) return s;
        const next = new Set(s);
        for (const p of e.patches) next.delete(p.id);
        return next;
      });
    });
    // Per-row ack: clear the resolving flag for the acked id.
    const unlistenResolved = events.onCodePatchResolved.listen((e) => {
      if (!alive) return;
      setResolving((s) => {
        if (!s.has(e.id)) return s;
        const next = new Set(s);
        next.delete(e.id);
        return next;
      });
    });
    // Faza 4 — LoRA inbox snapshots + per-card acks + train outcomes.
    const unlistenLora = events.onLoraReviews.listen((e) => {
      if (!alive) return;
      setLoraReviews(e);
      setLoraResolving((s) => {
        if (s.size === 0) return s;
        const next = new Set(s);
        for (const r of e.reviews) next.delete(r.id);
        return next;
      });
    });
    const unlistenLoraResolved = events.onLoraReviewResolved.listen((e) => {
      if (!alive) return;
      if (e.error) setLoraTrainNote(e.error);
      setLoraResolving((s) => {
        if (!s.has(e.id)) return s;
        const next = new Set(s);
        next.delete(e.id);
        return next;
      });
    });
    const unlistenLoraTrain = events.onLoraTrainResult.listen((e) => {
      if (!alive) return;
      setLoraTraining(false);
      setLoraTrainNote(e.ok ? null : (e.reason ?? 'training failed'));
    });
    // Faza 6 — meta_result stream: status snapshots feed the card directly;
    // evolve/rollback outcomes surface their reason and trigger a re-status.
    const unlistenMeta = events.onMetaResult.listen((e) => {
      if (!alive) return;
      if (e.op === 'status') {
        setMetaStatus(e);
        return;
      }
      if (e.op === 'evolve' || e.op === 'rollback') {
        setMetaBusy(false);
        setMetaNote(e.ok ? null : (e.reason ?? `${e.op} failed`));
        void tauri.rsi.meta('status').catch(() => {});
      }
    });
    // Slice A6 — governance_result stream: status/verify snapshots feed the
    // card; approve/reject acks clear the in-flight set and re-request status.
    const unlistenGov = events.onGovernanceResult.listen((e) => {
      if (!alive) return;
      if (e.op === 'status') {
        setGovStatus(e);
        return;
      }
      if (e.op === 'verify') {
        setGovVerify(e);
        return;
      }
      if (e.op === 'approve' || e.op === 'reject') {
        // The ack doesn't echo the policyId, so clear the whole in-flight
        // set — the inbox is small and status refresh follows immediately.
        setGovResolving(new Set());
        setGovNote(e.ok ? null : (e.reason ?? `${e.op} failed`));
        void tauri.rsi.governance('status').catch(() => {});
        void tauri.rsi.governance('verify').catch(() => {});
      }
    });
    // Phase B (L4) — modules_result stream: list snapshots feed the card;
    // resolve acks clear the in-flight set + re-request; an unpaired
    // `quarantined` row surfaces the watchdog rollback as a note.
    const unlistenModules = events.onModulesResult.listen((e) => {
      if (!alive) return;
      if (e.op === 'list') {
        setModulesList(e);
        return;
      }
      if (e.op === 'resolve') {
        setModulesResolving(new Set());
        setModulesNote(e.ok ? null : (e.reason ?? 'action failed'));
        void tauri.rsi.modules('list').catch(() => {});
        return;
      }
      if (e.op === 'quarantined') {
        setModulesNote(
          `A part Cinderpaw built (${e.moduleId ?? 'unknown'}) kept failing, so it was switched off and the original took over.`,
        );
        void tauri.rsi.modules('list').catch(() => {});
      }
    });
    return () => {
      alive = false;
      void unlistenModules.then((u) => u()).catch(() => {});
      void unlistenGov.then((u) => u()).catch(() => {});
      void unlistenMeta.then((u) => u()).catch(() => {});
      void unlistenDream.then((u) => u()).catch(() => {});
      void unlistenPatches.then((u) => u()).catch(() => {});
      void unlistenResolved.then((u) => u()).catch(() => {});
      void unlistenLora.then((u) => u()).catch(() => {});
      void unlistenLoraResolved.then((u) => u()).catch(() => {});
      void unlistenLoraTrain.then((u) => u()).catch(() => {});
    };
  }, []);

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-3 space-y-3">
      <header className="flex items-center gap-2">
        <Moon size={13} className="text-brand" />
        <span className="text-sm font-medium text-text-primary">Cinderpaw&apos;s Dreams</span>
        <span className="text-2xs text-text-muted">self-improvement while you&apos;re idle</span>
        <button
          type="button"
          onClick={dreamNow}
          disabled={requested || dreaming || dreamsAsleep}
          title={
            dreamsAsleep
              ? 'Asleep. Turn on dreaming for cloud models first'
              : 'Run one dream episode now (bypasses the idle wait)'
          }
          className="ml-auto rounded border border-border-subtle px-2 py-0.5 text-2xs text-text-secondary hover:text-text-primary hover:border-brand disabled:opacity-60"
        >
          {dreaming ? 'Dreaming…' : requested ? 'Queued, starts after the current cycle' : 'Dream now'}
        </button>
      </header>

      {dreamsAsleep && (
        <div className="space-y-1.5 rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
          <div className="flex items-start gap-2">
            <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-500" />
            <p className="text-2xs text-text-secondary">
              <span className="font-medium text-text-primary">Cinderpaw isn&apos;t dreaming.</span>{' '}
              Your model runs in the cloud, so every dream costs money. Cinderpaw won&apos;t
              spend it behind your back. Turn this on and it improves itself while
              you&apos;re away, stopping at{' '}
              {budget > 0 ? `$${budget} of spend` : 'the spend cap in Agent settings'}.
            </p>
          </div>
          <button
            type="button"
            disabled={allowBusy}
            onClick={async () => {
              setAllowBusy(true);
              try {
                await setAllowCloudDreams(true);
              } catch { /* the store already rolled the toggle back */ }
              setAllowBusy(false);
            }}
            className="ml-5 rounded border border-amber-500/40 px-2 py-0.5 text-2xs text-text-primary hover:border-amber-500 disabled:opacity-60"
          >
            {allowBusy ? 'Waking Cinderpaw…' : 'Let Cinderpaw dream on this model'}
          </button>
        </div>
      )}

      {dreaming && (
        <div className="flex items-center gap-2 rounded border border-brand/30 bg-brand/5 px-2.5 py-1.5">
          <Moon size={11} className="shrink-0 animate-pulse text-brand" />
          <DreamStageStepper stage={stage} />
        </div>
      )}

      {error ? (
        <p className="text-2xs text-text-muted">Couldn&apos;t read dream history ({error}).</p>
      ) : summary === null ? (
        <p className="text-2xs text-text-muted">Loading…</p>
      ) : summary.episodes === 0 ? (
        <p className="text-2xs text-text-muted">
          {dreamsAsleep
            ? 'No dreams yet. Dreaming is off for cloud models, see above.'
            : 'No dreams yet. Cinderpaw dreams when you step away for a while.'}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-x-4 gap-y-1.5 text-2xs">
            <Stat label="Dreams" value={summary.episodes.toLocaleString()} />
            <Stat
              label="Improvements"
              value={summary.ratchets.toLocaleString()}
              accent={summary.ratchets > 0}
            />
            <Stat label="Iterations" value={summary.iterations.toLocaleString()} />
          </div>

          <RatchetSparkline episodes={summary.last} />

          {summary.last[0] && (
            <p className="flex items-center gap-1.5 text-2xs text-text-secondary">
              <Sparkles size={11} className="text-brand" />
              Last dream: {summary.last[0].trigger}-triggered ·{' '}
              {summary.last[0].ratchets > 0
                ? `${summary.last[0].ratchets} improvement${summary.last[0].ratchets === 1 ? '' : 's'}`
                : 'no improvement'}{' '}
              · {summary.last[0].stopReason}
            </p>
          )}

          <Receipts rows={receipts} />
          <ChampionsByNiche rows={champions} />
          <PendingPatches
            payload={pendingPatches}
            resolving={resolving}
            onResolve={resolvePatch}
          />
        </>
      )}

      <LoraReviews
        payload={loraReviews}
        resolving={loraResolving}
        training={loraTraining}
        note={loraTrainNote}
        onResolve={resolveLoraCard}
        onTrain={loraTrainNow}
      />

      <MetaEvolutionCard
        status={metaStatus}
        busy={metaBusy}
        note={metaNote}
        onAction={runMetaAction}
      />

      <GovernanceCard
        status={govStatus}
        verify={govVerify}
        resolving={govResolving}
        note={govNote}
        onResolve={resolveProposal}
      />

      <ArchitectureCard
        list={modulesList}
        resolving={modulesResolving}
        note={modulesNote}
        onResolve={resolveModule}
      />
    </div>
  );
}

/** Plain-language names for the self-improvement systems governance can
 *  pause. Non-technical users see these, never the layer codes. */
const LAYER_LABELS: Record<string, string> = {
  l1: 'settings tuning',
  l2: 'personal learning',
  l3: 'code changes',
  l4: 'internal re-wiring',
  l6: 'learning strategy',
};

/** Slice A6 (L5 Governance) — the "Safety rules" card + approval inbox.
 *  Copy is deliberately non-technical (Darius: people won't understand
 *  policy/FSM/hash-chain talk): the policy is "the rulebook", frozen layers
 *  are "paused", verify is a "tamper check", and a relaxing proposal "asks
 *  for more freedom". Approving here is the only desktop writer of approval
 *  records (G-INV-6); tightening proposals apply on their own and render
 *  without buttons. */
function GovernanceCard({
  status,
  verify,
  resolving,
  note,
  onResolve,
}: {
  status: GovernanceResultLine | null;
  verify: GovernanceResultLine | null;
  resolving: Set<string>;
  note: string | null;
  onResolve: (policyId: string, action: 'approve' | 'reject') => void;
}) {
  if (!status) return null;
  const paused = Object.entries(status.policy?.frozen ?? {})
    .filter(([, v]) => v)
    .map(([k]) => LAYER_LABELS[k] ?? k);
  const pending = status.pending ?? [];
  return (
    <section className="space-y-1.5 border-t border-border-subtle pt-2">
      <header className="flex items-center gap-1.5">
        <Shield size={11} className="text-brand" />
        <span className="text-2xs font-medium text-text-primary">Safety rules</span>
        <span className="text-micro text-text-muted">
          the guardrails Cinderpaw follows while improving itself
        </span>
        {verify && (
          <span
            className="ml-auto flex items-center gap-1 text-micro"
            title={
              verify.ok
                ? 'Every change to the rules is on record, and nothing has been altered.'
                : 'The record of rule changes looks damaged or altered. Cinderpaw pauses self-improvement until this is resolved.'
            }
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${verify.ok ? 'bg-emerald-500' : 'bg-amber-500'}`}
            />
            <span className={verify.ok ? 'text-text-muted' : 'text-amber-500'}>
              {verify.ok ? 'records intact' : 'records check failed'}
            </span>
          </span>
        )}
      </header>

      {status.failClosed ? (
        <p className="flex items-center gap-1.5 text-micro text-amber-500">
          <AlertTriangle size={10} />
          The rulebook couldn&apos;t be read, so Cinderpaw switched to its strictest built-in
          rules and paused all self-improvement until it&apos;s fixed.
        </p>
      ) : (
        <p className="text-micro text-text-muted">
          {paused.length === 0
            ? 'All self-improvement systems are allowed to run.'
            : `Paused right now: ${paused.join(', ')}.`}
        </p>
      )}

      {pending.length > 0 && (
        <ul className="space-y-1.5">
          {pending.map((p) => {
            const needsOk = p.requiredApproval;
            return (
              <li key={p.policyId} className="space-y-1 text-2xs">
                <div className="flex items-center gap-1.5">
                  {needsOk ? (
                    <AlertTriangle size={10} className="shrink-0 text-amber-500" />
                  ) : (
                    <Check size={10} className="shrink-0 text-brand" />
                  )}
                  <span className="text-text-secondary">
                    {needsOk
                      ? 'Cinderpaw asks to loosen its rules. Nothing changes without your OK.'
                      : 'Cinderpaw is making its own rules stricter, and this applies on its own.'}
                  </span>
                  <span className="ml-auto font-mono text-micro text-text-muted">{p.policyId}</span>
                </div>
                {needsOk && (
                  <div className="flex items-center gap-1.5 pl-4">
                    <button
                      type="button"
                      disabled={resolving.has(p.policyId)}
                      onClick={() => onResolve(p.policyId, 'approve')}
                      className="rounded border border-brand/40 bg-brand/10 px-2 py-0.5 text-micro text-brand hover:border-brand disabled:opacity-50"
                    >
                      <Check size={10} className="inline -mt-px mr-0.5" />
                      Allow it
                    </button>
                    <button
                      type="button"
                      disabled={resolving.has(p.policyId)}
                      onClick={() => onResolve(p.policyId, 'reject')}
                      className="rounded border border-border-subtle px-2 py-0.5 text-micro text-text-secondary hover:text-text-primary disabled:opacity-50"
                    >
                      <X size={10} className="inline -mt-px mr-0.5" />
                      Keep things as they are
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {note && (
        <p className="flex items-center gap-1 text-micro text-text-muted">
          <AlertTriangle size={10} className="text-brand" />
          {note}
        </p>
      )}
    </section>
  );
}

/** Plain-language names for the seams (the swappable parts). Mirrors the
 *  LAYER_LABELS discipline: users see these, never the seam keys. */
const SEAM_LABELS: Record<string, string> = {
  retrieval_strategy: 'memory search',
  planner: 'task planning',
};

/** Phase B (L4 Architecture Evolution) — the "Architecture" card: which
 *  swappable parts run a Cinderpaw-built module vs the original, plus the
 *  approval inbox for candidates that passed their exam. Copy is
 *  non-technical (same rule as GovernanceCard): a seam is a "part",
 *  promotion is "take over", demote is "switch back to the original".
 *  Approving here is the ONLY desktop writer of module promotions (AC6). */
function ArchitectureCard({
  list,
  resolving,
  note,
  onResolve,
}: {
  list: ModulesResultLine | null;
  resolving: Set<string>;
  note: string | null;
  onResolve: (
    action: 'approve' | 'reject' | 'demote',
    args: { moduleId?: string; seam?: string },
  ) => void;
}) {
  if (!list) return null;
  const seams = Object.entries(list.seams ?? {});
  const rows = list.modules ?? [];
  const pending = rows.filter((m) => m.state === 'awaiting_approval');
  const active = rows.filter((m) => m.active);
  // Nothing brewing and everything on the original → one quiet line.
  const allBuiltin = active.length === 0 && pending.length === 0;
  return (
    <section className="space-y-1.5 border-t border-border-subtle pt-2">
      <header className="flex items-center gap-1.5">
        <GitMerge size={11} className="text-brand" />
        <span className="text-2xs font-medium text-text-primary">Architecture</span>
        <span className="text-micro text-text-muted">
          replacement parts Cinderpaw built for itself
        </span>
      </header>

      {allBuiltin ? (
        <p className="text-micro text-text-muted">
          Every part runs the original. No replacements active or waiting.
        </p>
      ) : (
        <>
          {active.map((m) => {
            const chip = SEAM_LABELS[m.seam] ?? m.seam;
            return (
              <div key={m.id} className="flex items-center gap-1.5 text-2xs">
                <Check size={10} className="shrink-0 text-brand" />
                <span className="text-text-secondary">
                  {chip} runs a part Cinderpaw built: {m.displayName}
                </span>
                <button
                  type="button"
                  disabled={resolving.has(m.seam)}
                  onClick={() => onResolve('demote', { seam: m.seam })}
                  title="Instantly switch this part back to the original"
                  className="ml-auto rounded border border-border-subtle px-2 py-0.5 text-micro text-text-secondary hover:text-text-primary disabled:opacity-50"
                >
                  <Undo2 size={10} className="inline -mt-px mr-0.5" />
                  Use the original
                </button>
              </div>
            );
          })}
          {pending.map((m) => {
            const chip = SEAM_LABELS[m.seam] ?? m.seam;
            return (
              <div key={m.id} className="space-y-1 text-2xs">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle size={10} className="shrink-0 text-amber-500" />
                  <span className="text-text-secondary">
                    Cinderpaw built a new {chip} part ({m.displayName}) and it passed its exam
                    {m.eval?.reason ? '' : ''} Nothing changes without your OK.
                  </span>
                </div>
                {m.eval && (
                  <p className="pl-4 text-micro text-text-muted">{m.eval.reason}</p>
                )}
                <div className="flex items-center gap-1.5 pl-4">
                  <button
                    type="button"
                    disabled={resolving.has(m.id)}
                    onClick={() => onResolve('approve', { moduleId: m.id })}
                    className="rounded border border-brand/40 bg-brand/10 px-2 py-0.5 text-micro text-brand hover:border-brand disabled:opacity-50"
                  >
                    <Check size={10} className="inline -mt-px mr-0.5" />
                    Let it take over
                  </button>
                  <button
                    type="button"
                    disabled={resolving.has(m.id)}
                    onClick={() => onResolve('reject', { moduleId: m.id })}
                    className="rounded border border-border-subtle px-2 py-0.5 text-micro text-text-secondary hover:text-text-primary disabled:opacity-50"
                  >
                    <X size={10} className="inline -mt-px mr-0.5" />
                    Keep the original
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}

      {seams.length > 0 && !allBuiltin && (
        <p className="text-micro text-text-muted">
          {seams
            .map(([seam, e]) => `${SEAM_LABELS[seam] ?? seam}: ${e.active === 'builtin' ? 'original' : 'Cinderpaw-built'}`)
            .join(' · ')}
        </p>
      )}

      {note && (
        <p className="flex items-center gap-1 text-micro text-text-muted">
          <AlertTriangle size={10} className="text-brand" />
          {note}
        </p>
      )}
    </section>
  );
}

/** Faza 6 (L6) — Meta Evolution: the MetaGenome that steers HOW the RSI
 *  searches. Read-mostly: shows generation / live fitness / metaparameters,
 *  with Evolve (settle + propose the next candidate) and Rollback (drop the
 *  pending candidate). Rendered outside the telemetry guard, mirroring
 *  LoraReviews — meta state exists even before the first dream. */
function MetaEvolutionCard({
  status,
  busy,
  note,
  onAction,
}: {
  status: MetaResultLine | null;
  busy: boolean;
  note: string | null;
  onAction: (op: 'evolve' | 'rollback') => void;
}) {
  if (!status) return null;
  const fitness = status.fitness ?? null;
  return (
    <section className="space-y-1.5 border-t border-border-subtle pt-2">
      <header className="flex items-center gap-1.5">
        <Brain size={11} className="text-brand" />
        <span className="text-2xs font-medium text-text-primary">Meta Evolution</span>
        <span className="text-micro text-text-muted">
          generation {status.generation ?? 0}
          {status.pendingCandidate ? ' · candidate pending' : ''}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {status.pendingCandidate && (
            <button
              type="button"
              onClick={() => onAction('rollback')}
              disabled={busy}
              title="Drop the pending candidate and return to its baseline"
              className="rounded border border-border-subtle px-2 py-0.5 text-micro text-text-secondary hover:text-text-primary hover:border-brand disabled:opacity-60"
            >
              <Undo2 size={10} className="mr-1 inline" />
              Rollback
            </button>
          )}
          <button
            type="button"
            onClick={() => onAction('evolve')}
            disabled={busy}
            title="Settle the pending candidate against its baseline, then propose the next one"
            className="rounded border border-border-subtle px-2 py-0.5 text-micro text-text-secondary hover:text-text-primary hover:border-brand disabled:opacity-60"
          >
            {busy ? 'Working…' : 'Evolve'}
          </button>
        </span>
      </header>
      <p className="text-micro text-text-muted">
        {fitness
          ? `fitness ${fitness.score.toFixed(4)} over ${fitness.cycles} cycles`
          : 'fitness: needs more dream cycles under this genome'}
      </p>
      {status.genome && (
        <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-micro">
          {Object.entries(status.genome).map(([k, v]) => (
            <span key={k} className="flex justify-between gap-2">
              <span className="text-text-muted">{k}</span>
              <span className="text-text-secondary tabular-nums">{v}</span>
            </span>
          ))}
        </div>
      )}
      {note && (
        <p className="flex items-center gap-1 text-micro text-text-muted">
          <AlertTriangle size={10} className="text-brand" />
          {note}
        </p>
      )}
    </section>
  );
}

/** Faza 4 (L2 LoRA) — the personal-adaptation card: per-domain champion
 *  adapters, the review inbox (approve = promote + apply live), and the
 *  "Train now" trigger. Mirrors the PendingPatches pattern. Rendered outside
 *  the dream-history guard — training is user-triggered and must be reachable
 *  before the first dream. */
function LoraReviews({
  payload,
  resolving,
  training,
  note,
  onResolve,
  onTrain,
}: {
  payload: LoraReviewsLine | null;
  resolving: Set<string>;
  training: boolean;
  note: string | null;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
  onTrain: () => void;
}) {
  const reviews = payload?.reviews ?? [];
  const champions = payload?.champions ?? [];
  return (
    <div className="space-y-1.5 border-t border-border-subtle pt-2.5">
      <div className="flex items-center gap-2">
        <Brain size={11} className="text-brand" />
        <span className="text-2xs font-medium text-text-secondary">Personal adaptation</span>
        <span className="text-text-muted text-2xs">LoRA · learns how you work</span>
        <button
          type="button"
          onClick={onTrain}
          disabled={training}
          title="Mine your conversations into a dataset, train a candidate adapter, and evaluate it against the champion"
          className="ml-auto rounded border border-border-subtle px-2 py-0.5 text-2xs text-text-secondary hover:text-text-primary hover:border-brand disabled:opacity-60"
        >
          {training ? 'Training…' : 'Train now'}
        </button>
      </div>
      {note && <p className="text-2xs text-amber-500">{note}</p>}
      {payload && payload.stats.adapters > 0 && (
        <div className="grid grid-cols-4 gap-x-4 gap-y-1.5 text-2xs">
          <Stat label="Adapters" value={String(payload.stats.adapters)} />
          <Stat
            label="Accepted"
            value={
              payload.stats.acceptanceRate === null
                ? '-'
                : `${Math.round(payload.stats.acceptanceRate * 100)}%`
            }
            accent={(payload.stats.acceptanceRate ?? 0) > 0}
          />
          <Stat
            label="Avg gain"
            value={
              payload.stats.averageGain === null
                ? '-'
                : `${payload.stats.averageGain >= 0 ? '+' : ''}${(payload.stats.averageGain * 100).toFixed(0)}%`
            }
            accent={(payload.stats.averageGain ?? 0) > 0}
          />
          <Stat
            label="Train time"
            value={
              payload.stats.trainingMsTotal > 0
                ? `${(payload.stats.trainingMsTotal / 60_000).toFixed(1)}m`
                : '-'
            }
          />
        </div>
      )}
      {champions.length > 0 && (
        <ul className="space-y-0.5">
          {champions.map((c) => (
            <li key={c.domain} className="flex items-center gap-2 text-2xs">
              <Check size={10} className="text-brand" />
              <span className="text-text-secondary">{c.domain}</span>
              <span className="ml-auto font-mono text-micro text-text-muted">{c.id}</span>
            </li>
          ))}
        </ul>
      )}
      {reviews.length === 0 ? (
        <p className="text-2xs text-text-muted">
          No adapters under review. Train one and Cinderpaw starts adapting to you. Every
          promotion needs your explicit approval.
        </p>
      ) : (
        <ul className="space-y-2">
          {reviews.map((r) => (
            <li key={r.id} className="text-2xs space-y-1">
              <div className="flex items-center gap-1.5">
                <LoraVerdictBadge status={r.status} verdict={r.verdict} />
                <span className="text-text-secondary">{r.domain}</span>
                <span className="font-mono text-text-muted">{r.id.slice(0, 24)}</span>
                <span className="ml-auto text-text-muted tabular-nums">
                  {formatRelativeTime(r.createdAt)}
                </span>
              </div>
              <p className="text-text-secondary">{r.reason}</p>
              {r.status === 'pending' && (
                <div className="flex items-center gap-1.5 pt-0.5">
                  {r.verdict === 'recommend_promote' && (
                    <button
                      type="button"
                      disabled={resolving.has(r.id)}
                      onClick={() => onResolve(r.id, 'approve')}
                      className="rounded border border-brand/40 bg-brand/10 px-2 py-0.5 text-brand hover:border-brand disabled:opacity-50"
                    >
                      <Check size={10} className="inline -mt-px mr-0.5" />
                      Approve &amp; use
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={resolving.has(r.id)}
                    onClick={() => onResolve(r.id, 'reject')}
                    className="rounded border border-border-subtle px-2 py-0.5 text-text-secondary hover:text-text-primary disabled:opacity-50"
                  >
                    <X size={10} className="inline -mt-px mr-0.5" />
                    Reject
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Badge for a review card: resolved status wins, otherwise the gate verdict. */
function LoraVerdictBadge({ status, verdict }: { status: string; verdict: string }) {
  const map: Record<string, { icon: typeof Check; cls: string; label: string }> = {
    approved: { icon: Check, cls: 'text-brand', label: 'champion' },
    rejected: { icon: X, cls: 'text-text-muted', label: 'rejected' },
    recommend_promote: { icon: Sparkles, cls: 'text-brand', label: 'recommended' },
    reject: { icon: X, cls: 'text-text-muted', label: 'not better' },
    insufficient_evidence: { icon: AlertTriangle, cls: 'text-amber-500', label: 'needs more evals' },
  };
  const entry = (status !== 'pending' ? map[status] : map[verdict])
    ?? { icon: AlertTriangle, cls: 'text-text-muted', label: verdict };
  const { icon: Icon, cls, label } = entry;
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${cls}`}>
      <Icon size={11} />
      {label}
    </span>
  );
}

/** Tree of Champions (§7.4) — the best config per behavioural niche. Shows that
 *  Cinderpaw keeps DIVERSITY, not just the single global best: each row is a
 *  distinct region (`t:c:r:d` — temperature / context / retrieval / depth) that
 *  won on its own terms. Empty until the engine has ratcheted a niche. */
function ChampionsByNiche({ rows }: { rows: ChampionTreeRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5 border-t border-border-subtle pt-2.5">
      <span className="text-2xs font-medium text-text-secondary">
        Champions by niche <span className="text-text-muted">({rows.length})</span>
      </span>
      <ul className="space-y-1">
        {rows.map((c) => (
          <li key={c.niche} className="flex items-center gap-2 text-2xs">
            <span className="font-mono text-text-muted">{c.niche}</span>
            <span className="ml-auto tabular-nums text-text-secondary">{c.score.toFixed(1)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Recent Evolution Journal rows (BRSI §2.9) — the auditable "receipts" of
 *  what each dream episode decided and why. Read-only, honest: shows the
 *  promotion decision, why candidates were blocked (confidence / Tier 0
 *  floor), and how much budget was left. Empty until the journal has rows. */
function Receipts({ rows }: { rows: JournalRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5 border-t border-border-subtle pt-2.5">
      <span className="text-2xs font-medium text-text-secondary">Receipts</span>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          // Per-candidate Contract rows share the episode's cycleId, so the
          // key needs the index to stay unique.
          <li key={`${r.cycleId}:${i}`} className="text-2xs">
            <div className="flex items-center gap-1.5">
              <DecisionBadge action={r.decided.action} />
              <span className="text-text-muted tabular-nums">
                {new Date(r.timestamp).toLocaleString([], {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </span>
            </div>
            <p className="mt-0.5 text-text-secondary">{r.decided.reason}</p>
            {r.result && (
              // Per-candidate fitness receipt (Contract FSM rows only).
              <p className="mt-0.5 text-text-muted tabular-nums">
                fitness {r.result.aggregate.toFixed(2)}
                {' · '}satisfaction {r.result.fitnessVector.userSatisfaction.toFixed(2)}
                {' · '}tier0 {r.result.tier0}
              </p>
            )}
            {r.observed.length > 0 && (
              <ul className="mt-0.5 space-y-0.5 pl-3 text-text-muted">
                {r.observed.map((line, i) => (
                  <li key={i} className="list-disc marker:text-border-subtle">{line}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DecisionBadge({ action }: { action: string }) {
  const map: Record<string, { icon: typeof Check; cls: string; label: string }> = {
    accept: { icon: Check, cls: 'text-brand', label: 'promoted' },
    reject: { icon: X, cls: 'text-text-muted', label: 'no change' },
    halt: { icon: AlertTriangle, cls: 'text-amber-500', label: 'halted' },
  };
  const { icon: Icon, cls, label } = map[action] ?? map.reject;
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${cls}`}>
      <Icon size={11} />
      {label}
    </span>
  );
}

/** Faza 2 Slice 5 — the code-patch approval gate (Dreams-panel "Pending patches"
 *  card). Mirrors the Receipts pattern: fetch on mount, refresh on `dream_cycle
 *  ended`, render the queue with one row per patch. The first 10 applys need
 *  explicit human approval (spec §2.5); after the window closes, approvals
 *  auto-apply and the `applied`/`apply_failed` ack comes back async. */
function PendingPatches({
  payload,
  resolving,
  onResolve,
}: {
  payload: CodePatchesPayload | null;
  resolving: Set<string>;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
}) {
  const patches = payload?.patches ?? [];
  // No state until the sidecar has answered once — avoid a flash of "no
  // pending patches" during the cold-start fetch.
  if (payload === null) return null;
  const showWindow = payload.manualWindowOpen;
  return (
    <div className="space-y-1.5 border-t border-border-subtle pt-2.5">
      <div className="flex items-center gap-2">
        <Code2 size={11} className="text-brand" />
        <span className="text-2xs font-medium text-text-secondary">
          Pending patches
        </span>
        <span className="text-text-muted text-2xs">({patches.length})</span>
        {showWindow && (
          <span className="ml-auto text-2xs text-text-muted tabular-nums">
            {payload.appliedCount}/10 manual approvals until auto-apply unlocks
          </span>
        )}
      </div>
      {patches.length === 0 ? (
        <p className="text-2xs text-text-muted">No pending code patches.</p>
      ) : (
        <ul className="space-y-2">
          {patches.map((p) => (
            <PatchRow
              key={p.id}
              patch={p}
              busy={resolving.has(p.id)}
              onResolve={onResolve}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One pending code patch — the row, the diff, and the resolve controls. */
function PatchRow({
  patch,
  busy,
  onResolve,
}: {
  patch: CodePatch;
  busy: boolean;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
}) {
  return (
    <li className="text-2xs space-y-1">
      <div className="flex items-center gap-1.5">
        <PatchStatusBadge status={patch.status} />
        <span className="font-mono text-text-muted">{patch.id.slice(0, 8)}</span>
        <span className="ml-auto flex items-center gap-2 text-text-muted tabular-nums">
          <span>score {patch.score.toFixed(2)}</span>
          <span>·</span>
          <span>{formatRelativeTime(patch.createdAt)}</span>
        </span>
      </div>
      <p className="text-text-secondary">{patch.rationale}</p>
      {patch.affectedFiles.length > 0 && (
        <ul className="flex flex-wrap gap-1 text-text-muted">
          {patch.affectedFiles.map((f) => (
            <li
              key={f}
              className="font-mono text-micro rounded border border-border-subtle px-1 py-px"
            >
              {f}
            </li>
          ))}
        </ul>
      )}
      {patch.note && (
        <p className="text-text-muted">{patch.note}</p>
      )}
      {patch.error && (
        <p className="text-amber-500">{patch.error}</p>
      )}
      <details className="rounded border border-border-subtle">
        <summary className="cursor-pointer select-none px-2 py-1 text-text-muted hover:text-text-secondary">
          <FileText size={10} className="inline -mt-px mr-1" />
          Show diff
        </summary>
        <pre className="overflow-x-auto whitespace-pre bg-bg-base/40 px-2 py-1.5 font-mono text-micro text-text-secondary border-t border-border-subtle">
          {patch.patch}
        </pre>
      </details>
      {patch.status === 'pending' && (
        <div className="flex items-center gap-1.5 pt-0.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => onResolve(patch.id, 'approve')}
            className="rounded border border-brand/40 bg-brand/10 px-2 py-0.5 text-brand hover:border-brand disabled:opacity-50"
          >
            <Check size={10} className="inline -mt-px mr-0.5" />
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onResolve(patch.id, 'reject')}
            className="rounded border border-border-subtle px-2 py-0.5 text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            <X size={10} className="inline -mt-px mr-0.5" />
            Reject
          </button>
        </div>
      )}
    </li>
  );
}

/** Color-coded badge for the six lifecycle states (spec §2.5). */
function PatchStatusBadge({ status }: { status: CodePatchStatus | string }) {
  const map: Record<string, { icon: typeof Check; cls: string; label: string }> = {
    pending:      { icon: Code2,        cls: 'text-text-muted',          label: 'pending' },
    approved:     { icon: GitMerge,     cls: 'text-text-muted',          label: 'approved' },
    rejected:     { icon: X,            cls: 'text-text-muted',          label: 'rejected' },
    applied:      { icon: Check,        cls: 'text-brand',               label: 'applied' },
    apply_failed: { icon: AlertTriangle, cls: 'text-amber-500',          label: 'apply failed' },
    reverted:     { icon: Undo2,        cls: 'text-text-muted',          label: 'reverted' },
  };
  const entry = map[status] ?? { icon: AlertTriangle, cls: 'text-text-muted', label: status };
  const { icon: Icon, cls, label } = entry;
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${cls}`}>
      <Icon size={11} />
      {label}
    </span>
  );
}

/** Compact "x ago" — never trust the host clock to match the sidecar's; this
 *  is a display helper only, the sidecar's `createdAt` is the source of truth. */
function formatRelativeTime(ts: number): string {
  const deltaMs = Date.now() - ts;
  if (deltaMs < 0) return 'just now';
  const m = Math.floor(deltaMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-text-muted">{label}</span>
      <span className={accent ? 'font-medium text-brand' : 'font-medium text-text-primary'}>{value}</span>
    </div>
  );
}

/** Tiny bar chart of ratchets per recent episode (oldest → newest). Bars are
 *  scaled to the busiest episode; a flat row of zero-height stubs means "tried
 *  but didn't improve", which is itself useful signal. */
function RatchetSparkline({ episodes }: { episodes: DreamTelemetrySummary['last'] }) {
  if (episodes.length === 0) return null;
  // `last` is newest-first; show oldest-first so it reads left→right in time.
  const ordered = [...episodes].reverse();
  const max = Math.max(1, ...ordered.map((e) => e.ratchets));
  return (
    <div
      className="flex items-end gap-0.5 h-8"
      role="img"
      aria-label={`Ratchets per recent dream: ${ordered.map((e) => e.ratchets).join(', ')}`}
    >
      {ordered.map((e, i) => (
        <div
          key={i}
          className="flex-1 rounded-sm bg-brand/70 min-h-[2px]"
          style={{ height: `${(e.ratchets / max) * 100}%` }}
          title={`${e.trigger}: ${e.ratchets} improvement${e.ratchets === 1 ? '' : 's'}`}
        />
      ))}
    </div>
  );
}
