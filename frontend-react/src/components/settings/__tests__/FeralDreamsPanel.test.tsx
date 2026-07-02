import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FeralDreamsPanel } from '@/components/settings/FeralDreamsPanel';
import { tauri, type DreamTelemetrySummary } from '@/lib/tauri';
import { events, type CodePatchesLine, type LoraReviewsLine } from '@/lib/tauri/events';
import { useDream } from '@/stores/dream';

afterEach(() => {
  vi.restoreAllMocks();
  useDream.setState({ dreaming: false, stage: null }); // don't leak dream state across tests
});

function stubListener() {
  // onDreamCycle.listen returns Promise<UnlistenFn>; the panel only needs it
  // to resolve to a no-op unlisten. Slice 5 adds two more sidecar-filtered
  // listeners — same shape, same fake. Faza 4 adds the three LoRA ones.
  vi.spyOn(events.onDreamCycle, 'listen').mockResolvedValue(() => {});
  vi.spyOn(events.onCodePatches, 'listen').mockResolvedValue(() => {});
  vi.spyOn(events.onCodePatchResolved, 'listen').mockResolvedValue(() => {});
  vi.spyOn(events.onLoraReviews, 'listen').mockResolvedValue(() => {});
  vi.spyOn(events.onLoraReviewResolved, 'listen').mockResolvedValue(() => {});
  vi.spyOn(events.onLoraTrainResult, 'listen').mockResolvedValue(() => {});
  vi.spyOn(tauri.rsi, 'loraReviewsList').mockResolvedValue();
}

const SUMMARY: DreamTelemetrySummary = {
  episodes: 12,
  ratchets: 4,
  tokens: 9800,
  iterations: 37,
  last: [
    { startedAt: 5000, endedAt: 6000, trigger: 'idle', iterations: 4, tokens: 200, ratchets: 2, stopReason: 'Converged' },
    { startedAt: 3000, endedAt: 4000, trigger: 'error', iterations: 2, tokens: 50, ratchets: 0, stopReason: 'BudgetExhausted' },
  ],
};

describe('FeralDreamsPanel', () => {
  it('renders lifetime totals and the last dream summary', async () => {
    stubListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);

    render(<FeralDreamsPanel />);

    expect(await screen.findByText('12')).toBeInTheDocument(); // dreams
    expect(screen.getByText('4')).toBeInTheDocument(); // improvements
    expect(screen.getByText('37')).toBeInTheDocument(); // iterations
    // Last dream line uses the newest (idle, 2 improvements).
    expect(screen.getByText(/idle-triggered/)).toBeInTheDocument();
    expect(screen.getByText(/2 improvements/)).toBeInTheDocument();
    expect(screen.getByText(/Converged/)).toBeInTheDocument();
  });

  it('renders journal receipts with the decision and observed lines', async () => {
    stubListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([
      {
        cycleId: 'c-2026-07-01T12:00:00.000Z',
        timestamp: Date.UTC(2026, 6, 1, 12, 0, 0),
        durationMin: 1.5,
        observed: [
          '12 evaluation(s), 2 promoted to main',
          '3 candidate(s) beat the score but were blocked by a promotion gate (confidence / Tier 0 floor)',
          'budget left: 18000 tokens, 6.0 min',
        ],
        decided: { action: 'accept', reason: '2 candidate(s) cleared the confidence gate and ratcheted main' },
      },
      // A per-candidate Contract FSM row: same cycleId (key must tolerate the
      // collision), non-null result → renders the fitness receipt line.
      {
        cycleId: 'c-2026-07-01T12:00:00.000Z',
        timestamp: Date.UTC(2026, 6, 1, 12, 1, 0),
        durationMin: 0.1,
        observed: [],
        decided: { action: 'accept', reason: 'all contract stages passed' },
        result: {
          aggregate: 0.73,
          tier0: 'passed',
          fitnessVector: { accuracy: 0.73, userSatisfaction: 0.62 },
        },
      },
    ]);

    render(<FeralDreamsPanel />);

    expect(await screen.findByText('Receipts')).toBeInTheDocument();
    expect(screen.getAllByText('promoted').length).toBe(2);
    expect(screen.getByText(/cleared the confidence gate/)).toBeInTheDocument();
    expect(screen.getByText(/blocked by a promotion gate/)).toBeInTheDocument();
    expect(screen.getByText(/budget left: 18000 tokens/)).toBeInTheDocument();
    // The per-candidate fitness receipt.
    expect(screen.getByText(/fitness 0\.73/)).toBeInTheDocument();
    expect(screen.getByText(/satisfaction 0\.62/)).toBeInTheDocument();
    expect(screen.getByText(/tier0 passed/)).toBeInTheDocument();
  });

  it('shows a clean empty state when no dreams have run', async () => {
    stubListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue({
      episodes: 0, ratchets: 0, tokens: 0, iterations: 0, last: [],
    });
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);

    render(<FeralDreamsPanel />);

    expect(await screen.findByText(/No dreams yet/)).toBeInTheDocument();
  });

  it('renders the Tree of Champions niche rows, highest score first', async () => {
    stubListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'championTree').mockResolvedValue([
      { niche: 't2:c2:rgraph:d2', genomeId: 'g2', score: 80 },
      { niche: 't1:c1:rsemantic:d1', genomeId: 'g1', score: 50 },
    ]);

    render(<FeralDreamsPanel />);

    expect(await screen.findByText('Champions by niche')).toBeInTheDocument();
    expect(screen.getByText('t2:c2:rgraph:d2')).toBeInTheDocument();
    expect(screen.getByText('t1:c1:rsemantic:d1')).toBeInTheDocument();
    expect(screen.getByText('80.0')).toBeInTheDocument();
  });

  it('shows the live §2.8 stage indicator while a cycle is dreaming', async () => {
    stubListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    useDream.setState({ dreaming: true, stage: 'evaluate' });

    render(<FeralDreamsPanel />);

    // The stepper renders all five emitted stages; Evaluate is the active one.
    expect(await screen.findByText('Evaluate')).toBeInTheDocument();
    expect(screen.getByText('Observe')).toBeInTheDocument();
    expect(screen.getByText('Remember')).toBeInTheDocument();
    expect(screen.getByText('Sleep')).toBeInTheDocument();
  });

  it('hides the stage indicator when not dreaming', async () => {
    stubListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    useDream.setState({ dreaming: false, stage: null });

    render(<FeralDreamsPanel />);

    await screen.findByText('12'); // panel loaded
    expect(screen.queryByText('Evaluate')).not.toBeInTheDocument();
  });

  it('surfaces a read error without crashing', async () => {
    stubListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockRejectedValue('disk gone');
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);

    render(<FeralDreamsPanel />);

    expect(await screen.findByText(/Couldn't read dream history/)).toBeInTheDocument();
  });
});

// ─── Faza 2 Slice 5 — code-patch approval gate (Dreams-panel card) ────────────
// The IPC shapes are FROZEN (`code_patches` / `code_patch_resolved`); these
// tests pin the React side of the trust boundary.

/** Capture the callback `onCodePatches.listen` was given and let the test
 *  fire it with a synthetic payload. Returns the captured callback (or null
 *  if the panel never subscribed, which is a test bug). */
function capturePatchesListener(): (e: CodePatchesLine) => void {
  let cb: ((e: CodePatchesLine) => void) | null = null;
  vi.spyOn(events.onCodePatches, 'listen').mockImplementation((c) => {
    cb = c as (e: CodePatchesLine) => void;
    return Promise.resolve(() => {});
  });
  // Return a callable that also asserts the subscription happened.
  return (e) => {
    if (!cb) throw new Error('panel never subscribed to onCodePatches');
    cb(e);
  };
}

const SAMPLE_PATCH = (over: Partial<{
  id: string; status: string; score: number; rationale: string;
  affectedFiles: string[]; patch: string; commitHash: string;
  createdAt: number; note?: string; error?: string;
}> = {}) => ({
  id: 'p-abc12345',
  status: 'pending',
  score: 0.78,
  rationale: 'fix: handle empty input in mutation.ts',
  affectedFiles: ['src/rsi/mutation.ts'],
  patch: '--- a/src/rsi/mutation.ts\n+++ b/src/rsi/mutation.ts\n@@ -1,1 +1,2 @@\n+const guard = "";\n',
  commitHash: 'deadbeef',
  createdAt: Date.now() - 60_000,
  ...over,
});

const PATCHES_PAYLOAD = (over: Partial<CodePatchesLine> = {}) => ({
  type: 'code_patches' as const,
  patches: [SAMPLE_PATCH()],
  manualWindowOpen: true,
  appliedCount: 3,
  ...over,
});

describe('FeralDreamsPanel — Pending patches (Slice 5)', () => {
  it('fires feral_code_patches_list on mount', async () => {
    stubListener();
    capturePatchesListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    const listSpy = vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();

    render(<FeralDreamsPanel />);

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalled();
    });
  });

  it('renders pending patches with approve/reject buttons', async () => {
    stubListener();
    const fire = capturePatchesListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();

    render(<FeralDreamsPanel />);
    fire(PATCHES_PAYLOAD());

    expect(await screen.findByText('Pending patches')).toBeInTheDocument();
    expect(screen.getByText('fix: handle empty input in mutation.ts')).toBeInTheDocument();
    expect(screen.getByText('src/rsi/mutation.ts')).toBeInTheDocument();
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Reject')).toBeInTheDocument();
    // Score + relative time both rendered (toFixed(2) → "0.78").
    expect(screen.getByText(/score 0\.78/)).toBeInTheDocument();
  });

  it('clicking Approve invokes codePatchResolve with the right args', async () => {
    stubListener();
    const fire = capturePatchesListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();
    const resolveSpy = vi.spyOn(tauri.rsi, 'codePatchResolve').mockResolvedValue();

    render(<FeralDreamsPanel />);
    fire(PATCHES_PAYLOAD());

    const approveBtn = await screen.findByText('Approve');
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(resolveSpy).toHaveBeenCalledWith('p-abc12345', 'approve');
    });
  });

  it('clicking Reject invokes codePatchResolve with "reject"', async () => {
    stubListener();
    const fire = capturePatchesListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();
    const resolveSpy = vi.spyOn(tauri.rsi, 'codePatchResolve').mockResolvedValue();

    render(<FeralDreamsPanel />);
    fire(PATCHES_PAYLOAD());

    fireEvent.click(await screen.findByText('Reject'));

    await waitFor(() => {
      expect(resolveSpy).toHaveBeenCalledWith('p-abc12345', 'reject');
    });
  });

  it('does not show Approve/Reject for an already-applied patch', async () => {
    stubListener();
    const fire = capturePatchesListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();

    render(<FeralDreamsPanel />);
    fire(PATCHES_PAYLOAD({
      patches: [SAMPLE_PATCH({ status: 'applied', note: 'live apply OK' })],
    }));

    await screen.findByText('applied');
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
    expect(screen.queryByText('Reject')).not.toBeInTheDocument();
    expect(screen.getByText('live apply OK')).toBeInTheDocument();
  });

  it('renders the manual window header while the first-10 window is open', async () => {
    stubListener();
    const fire = capturePatchesListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();

    render(<FeralDreamsPanel />);
    fire(PATCHES_PAYLOAD({ manualWindowOpen: true, appliedCount: 3 }));

    expect(await screen.findByText(/3\/10 manual approvals until auto-apply unlocks/)).toBeInTheDocument();
  });

  it('hides the manual window header after auto-apply unlocks', async () => {
    stubListener();
    const fire = capturePatchesListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();

    render(<FeralDreamsPanel />);
    fire(PATCHES_PAYLOAD({ manualWindowOpen: false, appliedCount: 12 }));

    await screen.findByText('Pending patches');
    expect(screen.queryByText(/manual approvals until auto-apply/)).not.toBeInTheDocument();
  });

  it('renders the empty state when the sidecar sends zero patches', async () => {
    stubListener();
    const fire = capturePatchesListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();

    render(<FeralDreamsPanel />);
    fire(PATCHES_PAYLOAD({ patches: [] }));

    expect(await screen.findByText(/No pending code patches/)).toBeInTheDocument();
  });

  it('stays hidden until the sidecar has answered once (no flash of empty state)', async () => {
    stubListener();
    capturePatchesListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();

    render(<FeralDreamsPanel />);

    // Panel must render the dream summary…
    expect(await screen.findByText('12')).toBeInTheDocument();
    // …but the Pending patches card must NOT appear before the listener fires.
    expect(screen.queryByText('Pending patches')).not.toBeInTheDocument();
    expect(screen.queryByText(/No pending code patches/)).not.toBeInTheDocument();
  });
});

// ── Faza 4 (L2 LoRA) — the Personal adaptation card ─────────────────────────

function captureLoraListener(): (e: LoraReviewsLine) => void {
  let cb: ((e: LoraReviewsLine) => void) | null = null;
  vi.spyOn(events.onLoraReviews, 'listen').mockImplementation((c) => {
    cb = c as (e: LoraReviewsLine) => void;
    return Promise.resolve(() => {});
  });
  return (e) => {
    if (!cb) throw new Error('panel never subscribed to onLoraReviews');
    cb(e);
  };
}

const LORA_PAYLOAD = (over: Partial<LoraReviewsLine> = {}): LoraReviewsLine => ({
  type: 'lora_reviews',
  reviews: [
    {
      id: 'lora-general-abc123def456',
      domain: 'general',
      status: 'pending',
      verdict: 'recommend_promote',
      reason: 'passes Tier 0 and confidence gate',
      metrics: { loss: 0.42 },
      adapterPath: 'C:/adapters/a.gguf',
      baseModel: 'Qwen3.5-4B.gguf',
      createdAt: Date.now() - 60_000,
    },
  ],
  champions: [],
  stats: {
    adapters: 1,
    datasets: 1,
    pendingReviews: 1,
    champions: 0,
    rollbacks: 0,
    acceptanceRate: null,
    averageGain: 0.31,
    trainingMsTotal: 90_000,
  },
  ...over,
});

describe('FeralDreamsPanel — Personal adaptation (Faza 4)', () => {
  it('fires feral_lora_reviews_list on mount and renders the empty state', async () => {
    stubListener();
    capturePatchesListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();
    const listSpy = vi.spyOn(tauri.rsi, 'loraReviewsList').mockResolvedValue();

    render(<FeralDreamsPanel />);

    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(screen.getByText('Personal adaptation')).toBeInTheDocument();
    expect(screen.getByText(/No adapters under review/)).toBeInTheDocument();
    expect(screen.getByText('Train now')).toBeInTheDocument();
  });

  it('renders a recommended card and approves it', async () => {
    stubListener();
    capturePatchesListener();
    const fire = captureLoraListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();
    vi.spyOn(tauri.rsi, 'loraReviewsList').mockResolvedValue();
    const resolveSpy = vi.spyOn(tauri.rsi, 'loraReviewResolve').mockResolvedValue();

    render(<FeralDreamsPanel />);
    fire(LORA_PAYLOAD());

    expect(await screen.findByText('recommended')).toBeInTheDocument();
    expect(screen.getByText(/passes Tier 0 and confidence gate/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Approve & use/));
    await waitFor(() => {
      expect(resolveSpy).toHaveBeenCalledWith('lora-general-abc123def456', 'approve');
    });
  });

  it('a reject-verdict card offers Reject but no Approve', async () => {
    stubListener();
    capturePatchesListener();
    const fire = captureLoraListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();
    vi.spyOn(tauri.rsi, 'loraReviewsList').mockResolvedValue();

    render(<FeralDreamsPanel />);
    fire(LORA_PAYLOAD({
      reviews: [{ ...LORA_PAYLOAD().reviews[0], verdict: 'reject', reason: 'no significant gain' }],
    }));

    expect(await screen.findByText('not better')).toBeInTheDocument();
    expect(screen.queryByText(/Approve & use/)).not.toBeInTheDocument();
  });

  it('clicking Train now invokes loraTrain and shows the busy state', async () => {
    stubListener();
    capturePatchesListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();
    vi.spyOn(tauri.rsi, 'loraReviewsList').mockResolvedValue();
    const trainSpy = vi.spyOn(tauri.rsi, 'loraTrain').mockResolvedValue();

    render(<FeralDreamsPanel />);
    fireEvent.click(await screen.findByText('Train now'));

    await waitFor(() => expect(trainSpy).toHaveBeenCalled());
    expect(screen.getByText(/Training…/)).toBeInTheDocument();
  });

  it('renders champion adapters per domain', async () => {
    stubListener();
    capturePatchesListener();
    const fire = captureLoraListener();
    vi.spyOn(tauri.rsi, 'dreamTelemetry').mockResolvedValue(SUMMARY);
    vi.spyOn(tauri.rsi, 'journalRecent').mockResolvedValue([]);
    vi.spyOn(tauri.rsi, 'codePatchesList').mockResolvedValue();
    vi.spyOn(tauri.rsi, 'loraReviewsList').mockResolvedValue();

    render(<FeralDreamsPanel />);
    fire(LORA_PAYLOAD({
      reviews: [],
      champions: [{ domain: 'coding', id: 'lora-coding-deadbeef1234', adapterPath: 'C:/a.gguf' }],
    }));

    expect(await screen.findByText('coding')).toBeInTheDocument();
    expect(screen.getByText('lora-coding-deadbeef1234')).toBeInTheDocument();
  });
});
