/**
 * ArtifactCard — what a reply made is a card that opens it, and only once it
 * is finished; while it is being made it stays a tool row with its progress.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArtifactCard, artifactLine } from '../ArtifactCard';
import { MessageToolWidgets } from '../MessageToolWidgets';
import { useArtifacts } from '@/stores/artifacts';
import { startActivity, finishActivity } from '@/hooks/useLiveToolActivity';

// The download store subscribes to host events when it is imported; there is no host here.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const PLAN = { id: 'a1', title: 'Launch week', kind: 'document', version: 1, path: null };

beforeEach(() => {
  useArtifacts.setState({ panelOpen: false, openArtifact: vi.fn(async () => {}) });
});

describe('artifactLine', () => {
  it('names the kind, and the version once there is more than one', () => {
    expect(artifactLine({ kind: 'document', version: 1 })).toBe('Document');
    expect(artifactLine({ kind: 'app', version: 3 })).toBe('Interactive, v3');
    expect(artifactLine({ kind: 'something-new', version: 1 })).toBe('File');
  });
});

describe('ArtifactCard', () => {
  it('opens the artifact in the side panel', async () => {
    render(<ArtifactCard f={PLAN} />);
    expect(screen.getByText('Launch week')).toBeTruthy();
    expect(screen.getByText('Document')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Open Launch week' }));
    expect(useArtifacts.getState().panelOpen).toBe(true);
    expect(useArtifacts.getState().openArtifact).toHaveBeenCalledWith('a1');
  });

  it('is drawn for a finished artifact tool, not for one still running', () => {
    const running = startActivity('artifact_create', { title: 'Launch week' });
    const { rerender } = render(<MessageToolWidgets activity={[running]} streaming />);
    expect(screen.queryByRole('button', { name: 'Open Launch week' })).toBeNull();

    const done = finishActivity(running, { ok: true, data: PLAN });
    rerender(<MessageToolWidgets activity={[done]} streaming={false} />);
    expect(screen.getByRole('button', { name: 'Open Launch week' })).toBeTruthy();
  });
});
