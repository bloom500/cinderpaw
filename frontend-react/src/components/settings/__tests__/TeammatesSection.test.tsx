import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TeammatesSection } from '../TeammatesSection';
import { useCoworkTeam } from '@/stores/coworkTeam';
import { tauri, type CoworkTeammate } from '@/lib/tauri';

vi.mock('@/lib/tauri', () => ({
  tauri: { cinderpawAgent: { coworkTeam: vi.fn().mockResolvedValue(undefined) } },
}));

const atlas: CoworkTeammate = {
  id: 'atlas', name: 'Atlas', role: 'research', instructions: '',
  tools: ['read_file', 'web_search'], model: null, createdAt: 1,
};

describe('TeammatesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCoworkTeam.setState({ roster: [], loaded: false, busy: false, error: null, removed: null });
  });

  test('asks for the roster when it opens', () => {
    render(<TeammatesSection />);
    expect(tauri.cinderpawAgent.coworkTeam).toHaveBeenCalledWith('list', undefined);
  });

  test('an empty roster says how to make a teammate', async () => {
    render(<TeammatesSection />);
    useCoworkTeam.getState().receive({ roster: [] });
    expect(await screen.findByText('No teammates yet')).toBeInTheDocument();
  });

  test('shows each teammate with what they may use', async () => {
    render(<TeammatesSection />);
    useCoworkTeam.getState().receive({ roster: [atlas, { ...atlas, id: 'old', name: 'Old', tools: null }] });
    expect(await screen.findByText('Atlas')).toBeInTheDocument();
    expect(screen.getByText('read_file, web_search')).toBeInTheDocument();
    // A teammate from before tools were scoped is flagged, not hidden.
    expect(screen.getByText(/Every tool/)).toBeInTheDocument();
  });

  test('removing asks first, then sends the remove', async () => {
    render(<TeammatesSection />);
    useCoworkTeam.getState().receive({ roster: [atlas] });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Atlas' }));
    expect(tauri.cinderpawAgent.coworkTeam).not.toHaveBeenCalledWith('remove', 'atlas');
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(tauri.cinderpawAgent.coworkTeam).toHaveBeenCalledWith('remove', 'atlas');
  });

  test('says so when the engine cannot be reached', async () => {
    vi.mocked(tauri.cinderpawAgent.coworkTeam).mockRejectedValueOnce(new Error('cinderpaw-agent is not running'));
    render(<TeammatesSection />);
    expect(await screen.findByText('cinderpaw-agent is not running')).toBeInTheDocument();
  });
});
