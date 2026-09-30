import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoworkerStrip } from '../CoworkerStrip';
import { useCoworkTranscript, type CoworkExchange } from '@/stores/coworkTranscript';
import { useUI } from '@/stores/ui';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const answered: CoworkExchange = {
  id: 'msg:1', threadId: 't', kind: 'message', fromAgentId: 'human', toAgentId: 'atlas', toName: 'Atlas',
  requestText: 'Find flights', responseText: 'Three options under 200 EUR.', status: 'done', at: 1, startedAt: 1,
};

beforeEach(() => {
  useUI.setState({ mascotEnabled: false });
  useCoworkTranscript.setState({ exchanges: [], activeThreadId: 't', seenAnswers: {} });
});

describe('CoworkerStrip', () => {
  it('is not shown when no teammate is working or waiting to be read', () => {
    const { container } = render(<CoworkerStrip />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens an answer from the card, and the card goes once it is read', async () => {
    useCoworkTranscript.setState({ exchanges: [answered] });
    render(<CoworkerStrip />);
    await userEvent.click(screen.getByRole('button', { name: 'Atlas, has an answer' }));
    await userEvent.click(screen.getByRole('button', { name: 'View answer' }));
    expect(screen.getByText('Three options under 200 EUR.')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(useCoworkTranscript.getState().seenAnswers['msg:1']).toBe(true);
    expect(screen.queryByRole('button', { name: /Atlas/ })).toBeNull();
  });
});
