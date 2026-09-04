/**
 * Phase 4 S3 — the download indicator left the sidebar. What matters is that
 * it appears on its own when something is happening, and stays out of the way
 * when nothing is.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadStatus } from '../DownloadStatus';
import { useDownload } from '@/stores/download';

// The store registers its progress listeners at module load, which needs a
// Tauri IPC bridge that jsdom does not have.
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, tauri: { download: { start: vi.fn(), cancel: vi.fn() } } };
});

beforeEach(() => {
  useDownload.setState({ active: null, done: false, error: null });
});

describe('DownloadStatus', () => {
  it('shows nothing at all while there is no download', () => {
    const { container } = render(<DownloadStatus />);
    expect(container.textContent).toBe('');
  });

  it('appears with the progress in its label while downloading', () => {
    useDownload.setState({
      active: { repoId: 'org/model', filename: 'model.gguf', progress: 0.42, key: 'k' },
    });
    render(<DownloadStatus />);
    expect(screen.getByLabelText('Downloading, 42%')).toBeTruthy();
  });

  it('stays visible after a failure, so the reason is still reachable', () => {
    useDownload.setState({ error: 'no space left on device' });
    render(<DownloadStatus />);
    expect(screen.getByLabelText('Download failed')).toBeTruthy();
  });
});
