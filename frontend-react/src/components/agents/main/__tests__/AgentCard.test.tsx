import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentCard } from '../AgentCard';
import type { AgentConfig } from '@/lib/tauri';

const agent: AgentConfig = {
  id: 'test-id-1',
  name: 'Test Agent',
  system_prompt: 'You are helpful.',
  model_id: '',
  tools: [],
};

// AgentCard does not call tauri directly — onDelete is a prop — so no module mock needed.

describe('AgentCard', () => {
  it('keeps dialog open and shows error when delete prop rejects', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('disk is full'));
    render(<AgentCard agent={agent} onDelete={onDelete} />);

    await userEvent.click(screen.getByRole('button', { name: /delete test agent/i }));
    expect(screen.getByText(/delete "test agent"/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(screen.getByText(/disk is full/i)).toBeInTheDocument();
    });
    // Dialog must still be open
    expect(screen.getByText(/delete "test agent"/i)).toBeInTheDocument();
  });

  it('closes dialog on successful delete', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<AgentCard agent={agent} onDelete={onDelete} />);

    await userEvent.click(screen.getByRole('button', { name: /delete test agent/i }));
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/delete "test agent"/i)).not.toBeInTheDocument();
    });
  });
});
