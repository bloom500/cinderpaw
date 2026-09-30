import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { TeammatesSection } from '../TeammatesSection';
import { useCoworkTeam } from '@/stores/coworkTeam';
import { useCoworkTranscript, type CoworkExchange } from '@/stores/coworkTranscript';
import { tauri, type CoworkTeammate } from '@/lib/tauri';

vi.mock('@/lib/tauri', () => ({
  tauri: { cinderpawAgent: { coworkTeam: vi.fn().mockResolvedValue(undefined) } },
}));

const atlas: CoworkTeammate = {
  id: 'atlas', name: 'Atlas', role: 'research', instructions: '',
  tools: ['read_file', 'web_search'], model: null, createdAt: 1,
};

/** Where Message and Add a teammate lead: the chat, with words for the box. */
function ChatProbe() {
  const state = useLocation().state as { compose?: string } | null;
  return <p>chat opened with "{state?.compose}"</p>;
}

function renderSection() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/settings" element={<TeammatesSection />} />
        <Route path="/chat" element={<ChatProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TeammatesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCoworkTeam.setState({ roster: [], loaded: false, busy: false, error: null, removed: null });
    useCoworkTranscript.setState({ exchanges: [] });
  });

  test('asks for the roster when it opens', () => {
    renderSection();
    expect(tauri.cinderpawAgent.coworkTeam).toHaveBeenCalledWith('list', undefined);
  });

  test('an empty roster shows only the Add a teammate card, saying what a teammate is', async () => {
    renderSection();
    useCoworkTeam.getState().receive({ roster: [] });
    expect(await screen.findByText('Add a teammate')).toBeInTheDocument();
    expect(screen.getByText(/A helper with one job/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
  });

  test('shows each teammate with what they may use', async () => {
    renderSection();
    useCoworkTeam.getState().receive({ roster: [atlas, { ...atlas, id: 'old', name: 'Old', tools: null }] });
    expect(await screen.findByText('Atlas')).toBeInTheDocument();
    expect(screen.getByText('Can use: read_file, web_search')).toBeInTheDocument();
    // A teammate from before tools were scoped is flagged, not hidden.
    expect(screen.getByText(/Every tool/)).toBeInTheDocument();
  });

  test('a teammate is Working on what it was asked, else Idle', async () => {
    useCoworkTranscript.setState({
      exchanges: [
        { id: 'x1', toAgentId: 'atlas', status: 'running', requestText: 'read the reviews' } as CoworkExchange,
      ],
    });
    renderSection();
    useCoworkTeam.getState().receive({ roster: [atlas, { ...atlas, id: 'nova', name: 'Nova' }] });
    expect(await screen.findByText('Working: read the reviews')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  test('Message opens a chat with the words in the box, sending nothing', async () => {
    renderSection();
    useCoworkTeam.getState().receive({ roster: [atlas] });
    await userEvent.click(await screen.findByRole('button', { name: 'Message' }));
    expect(screen.getByText('chat opened with "Ask Atlas to "')).toBeInTheDocument();
  });

  test('removing asks first, then sends the remove', async () => {
    renderSection();
    useCoworkTeam.getState().receive({ roster: [atlas] });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Atlas' }));
    expect(tauri.cinderpawAgent.coworkTeam).not.toHaveBeenCalledWith('remove', 'atlas');
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(tauri.cinderpawAgent.coworkTeam).toHaveBeenCalledWith('remove', 'atlas');
  });

  test('says so when the engine cannot be reached', async () => {
    vi.mocked(tauri.cinderpawAgent.coworkTeam).mockRejectedValueOnce(new Error('cinderpaw-agent is not running'));
    renderSection();
    expect(await screen.findByText('cinderpaw-agent is not running')).toBeInTheDocument();
  });
});
