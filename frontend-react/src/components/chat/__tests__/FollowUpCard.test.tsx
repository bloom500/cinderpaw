import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { FollowUpCard } from '../FollowUpCard';
import { useFollowUps } from '@/stores/followUps';

const { open, cronOp } = vi.hoisted(() => ({ open: vi.fn(async () => {}), cronOp: vi.fn(async () => {}) }));
vi.mock('@/stores/conversations', () => ({ useConversations: { getState: () => ({ open }) } }));
vi.mock('@/lib/tauri', () => ({ tauri: { raw: { cinderpawCronOp: cronOp } } }));
beforeEach(() => {
  open.mockClear();
  cronOp.mockClear();
  useFollowUps.setState({ enabled: true, card: null, dismissed: [] });
});
function Location() { return <output aria-label="Location">{useLocation().pathname}</output>; }

it('opens the original conversation without sending or scheduling work', () => {
  useFollowUps.getState().receive({ id: 'run-1', sessionId: 'chat-1', mission: 'Finish the launch checklist' });
  render(<MemoryRouter><FollowUpCard /><Location /></MemoryRouter>);
  expect(screen.getByText('Finish the launch checklist')).toBeInTheDocument();
  expect(screen.getByText('Nothing resumes until you ask.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Open conversation/ }));
  expect(screen.getByLabelText('Location')).toHaveTextContent('/chat/chat-1');
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: 'Unfinished work' })).toBeNull();
  // Counted as opened, not as dismissed, even though the card goes away.
  expect(cronOp).toHaveBeenCalledTimes(1);
  expect(cronOp).toHaveBeenCalledWith(expect.any(String), 'nudge_opened', { jobId: 'run-1' });
});

it('dismisses locally and stays quiet when disabled', () => {
  useFollowUps.getState().receive({ id: 'run-1', sessionId: 'chat-1', mission: 'Finish the launch checklist' });
  const { rerender } = render(<MemoryRouter><FollowUpCard /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss follow-up' }));
  expect(open).not.toHaveBeenCalled();
  expect(cronOp).toHaveBeenCalledWith(expect.any(String), 'nudge_dismissed', { jobId: 'run-1' });
  useFollowUps.getState().setEnabled(false);
  rerender(<MemoryRouter><FollowUpCard /></MemoryRouter>);
  expect(screen.queryByRole('region', { name: 'Unfinished work' })).toBeNull();
});
