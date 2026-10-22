import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportCard } from '../ImportCard';
import { tauri, type MigrateFound } from '@/lib/tauri';

const openclaw: MigrateFound = {
  source: 'OpenClaw',
  root: 'C:\\Users\\u\\.openclaw',
  version: '2026.6.11',
  plan: {
    willImport: [
      { what: 'SOUL.md', target: 'x', note: null },
      { what: 'skill: summarize', target: 'y', note: null },
      { what: 'skill: trello', target: 'z', note: null },
    ],
    notImported: ["workspace/AGENTS.md — OpenClaw's working manual; Cinderpaw keeps its own"],
    conflicts: [],
    backupDir: 'b',
  },
};

beforeEach(() => vi.restoreAllMocks());

describe('ImportCard', () => {
  it('draws nothing on a machine with no other agent installed', async () => {
    const preview = vi.spyOn(tauri.raw, 'migratePreview').mockResolvedValue([]);
    const { container } = render(<ImportCard />);
    await vi.waitFor(() => expect(preview).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('says what it brings, imports on click, and lists what it leaves when asked', async () => {
    vi.spyOn(tauri.raw, 'migratePreview').mockResolvedValue([openclaw]);
    const apply = vi.spyOn(tauri.raw, 'migrateApply').mockResolvedValue(['SOUL.md', 'skill: summarize', 'skill: trello']);
    render(<ImportCard />);

    expect(await screen.findByText('Coming from OpenClaw?')).toBeTruthy();
    expect(screen.getByText(/its personality and 2 skills/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /What exactly/ }));
    expect(screen.getByText(/OpenClaw's working manual/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Bring it over/ }));
    expect(apply).toHaveBeenCalledWith(openclaw.root);
    expect(await screen.findByText(/Brought over 3 items/)).toBeTruthy();
  });
});
