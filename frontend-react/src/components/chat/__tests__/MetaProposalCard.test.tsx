import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MetaProposalCard, changeWords } from '@/components/chat/MetaProposalCard';
import { tauri } from '@/lib/tauri';
import { events, type MetaProposal, type MetaProposalLine, type MetaResultLine } from '@/lib/tauri/events';

afterEach(() => vi.restoreAllMocks());

const CHANGE: MetaProposal = {
  id: 'gen-3-42', kind: 'change', field: 'dream_batch', from: 40, to: 48, settled: 'bootstrap',
  score: 0.62, baselineScore: null, cycles: 6, generation: 3, seed: 42, createdAt: 1,
};

/** Capture the card's two listeners so a test can play the sidecar. */
function wire() {
  let proposal: ((e: MetaProposalLine) => void) | undefined;
  let result: ((e: MetaResultLine) => void) | undefined;
  vi.spyOn(events.onMetaProposal, 'listen').mockImplementation(async (cb) => { proposal = cb; return () => {}; });
  vi.spyOn(events.onMetaResult, 'listen').mockImplementation(async (cb) => { result = cb; return () => {}; });
  const meta = vi.spyOn(tauri.rsi, 'meta').mockResolvedValue();
  return {
    meta,
    send: (p: MetaProposal | null) => act(() => proposal!({ type: 'meta_proposal', proposal: p })),
    reply: (e: Partial<MetaResultLine>) => act(() => result!({ type: 'meta_result', id: CHANGE.id, op: 'approve', ok: true, ...e })),
  };
}

describe('MetaProposalCard: L6 asks in chat before it changes how Cinderpaw practices', () => {
  it('asks for the waiting card on mount and shows nothing without one', async () => {
    const w = wire();
    const { container } = render(<MetaProposalCard />);
    await waitFor(() => expect(w.meta).toHaveBeenCalledWith('proposal'));
    expect(container).toBeEmptyDOMElement();
  });

  it('says what changes in plain words, and approving names exactly that card', async () => {
    const w = wire();
    render(<MetaProposalCard />);
    await waitFor(() => expect(events.onMetaProposal.listen).toHaveBeenCalled());
    w.send(CHANGE);

    expect(screen.getByText(/wants to change how it practices/i)).toBeInTheDocument();
    expect(screen.getByText(/try 48 ideas in each dream instead of 40/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing changes unless you say yes/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(w.meta).toHaveBeenCalledWith('approve', 'gen-3-42'));

    w.send(null);
    w.reply({ ok: true });
    expect(screen.getByText(/tell you here whether it helped/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('deny answers the card and says nothing changed', async () => {
    const w = wire();
    render(<MetaProposalCard />);
    await waitFor(() => expect(events.onMetaProposal.listen).toHaveBeenCalled());
    w.send(CHANGE);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(w.meta).toHaveBeenCalledWith('deny', 'gen-3-42'));
    w.send(null);
    w.reply({ op: 'deny', ok: true });
    expect(screen.getByText(/nothing changed/i)).toBeInTheDocument();
  });

  it('an undo card says the last change did not help, with the scores', async () => {
    const w = wire();
    render(<MetaProposalCard />);
    await waitFor(() => expect(events.onMetaProposal.listen).toHaveBeenCalled());
    w.send({ ...CHANGE, kind: 'undo', settled: 'rejected', from: 48, to: 40, score: 0.31, baselineScore: 0.62 });
    expect(screen.getByText(/wants to undo a change/i)).toBeInTheDocument();
    expect(screen.getByText(/It did not help\. Its practice score went from 62 to 31 out of 100/)).toBeInTheDocument();
    // The change it undoes is told the way it was first asked: 40 → 48.
    expect(screen.getByText(/try 48 ideas in each dream instead of 40/i)).toBeInTheDocument();
  });

  it('every L6 knob has words both ways', () => {
    for (const f of ['mutation_rate', 'exploration', 'confidence_gate', 'dream_batch', 'selection_pressure'] as const) {
      expect(changeWords(f, 0.5, 0.6)).not.toBe(changeWords(f, 0.6, 0.5));
    }
    expect(changeWords('confidence_gate', 0.95, 0.97)).toMatch(/97% sure .* instead of 95%/);
  });
});
