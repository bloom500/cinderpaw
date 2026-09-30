import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalCard } from '../ApprovalCard';
import type { CoworkExchange } from '@/stores/coworkTranscript';
import { applyCoworkEvent } from '@/stores/coworkTranscript';
import { tauri } from '@/lib/tauri';

vi.mock('@/lib/tauri', () => ({
  tauri: { cinderpawAgent: { coworkApprovalResolve: vi.fn().mockResolvedValue(undefined) } },
}));

const ask = (over: Partial<CoworkExchange> = {}): CoworkExchange => ({
  id: 'approval:r1', threadId: 't1', kind: 'approval',
  fromAgentId: 'demo-agent-bolt', fromName: 'Bolt', toAgentId: 'human',
  requestText: 'rm -rf dist/', responseText: null, approvalClass: 'delete',
  status: 'running', at: 0, startedAt: Date.now(), ...over,
});

beforeEach(() => vi.mocked(tauri.cinderpawAgent.coworkApprovalResolve).mockClear());

describe('ApprovalCard', () => {
  it('says who asks, what exactly, and the real class as a badge', () => {
    render(<ApprovalCard e={ask()} />);
    expect(screen.getByText('Bolt wants your OK')).toBeTruthy();
    expect(screen.getByText('Delete').className).toContain('text-error');
    expect(screen.getByText('rm -rf dist/')).toBeTruthy();
  });

  it('a request with no class shows no badge', () => {
    render(<ApprovalCard e={ask({ approvalClass: undefined })} />);
    expect(screen.queryByText(/^(Send|Publish|Delete|Purchase|Production change)$/)).toBeNull();
  });

  it('Send is amber, not red', () => {
    render(<ApprovalCard e={ask({ approvalClass: 'send' })} />);
    expect(screen.getByText('Send').className).toContain('text-warning');
  });

  it('is answered from the card, and the buttons go so it cannot be sent twice', async () => {
    render(<ApprovalCard e={ask({ id: 'approval:r7' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(tauri.cinderpawAgent.coworkApprovalResolve).toHaveBeenCalledWith('r7', false);
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('a verdict that never reached the sidecar can be given again', async () => {
    vi.mocked(tauri.cinderpawAgent.coworkApprovalResolve).mockRejectedValueOnce(new Error('sidecar is not running'));
    render(<ApprovalCard e={ask()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/sidecar is not running/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('an expired request says nothing was done', () => {
    render(<ApprovalCard e={ask({ status: 'error', outcome: 'expired' })} />);
    expect(screen.getByText('Timed out, so nothing was done')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('the store keeps whether an answer was a no or a timeout', () => {
    const base = { agentId: 'bolt', title: 'x', threadId: 't1', data: { requestId: 'r1', approvalClass: 'delete' } };
    const asked = applyCoworkEvent([], { ...base, eventType: 'approval_requested' } as never);
    const expired = applyCoworkEvent(asked, { ...base, eventType: 'approval_expired' } as never);
    expect(expired.find((e) => e.kind === 'approval')?.outcome).toBe('expired');
  });
});
