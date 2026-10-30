import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  convertFileSrc: (p: string) => `http://asset.localhost/${p}`,
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(async () => {}) }));

beforeEach(() => { invoke.mockReset(); vi.resetModules(); });

describe('a video link card', () => {
  it('on a fresh install shows the YouTube picture and offers the download, which the click starts', async () => {
    let installed = false;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'video_tools_ready') return installed;
      if (cmd === 'install_video_tools') { installed = true; return null; }
      if (cmd === 'video_link_info') return { title: 'Never Gonna', duration: 213 };
      return null;
    });
    const { VideoLinkCard } = await import('../VideoLinkCard');
    const { container } = render(<VideoLinkCard href="https://youtu.be/dQw4w9WgXcQ" />);
    const offer = await screen.findByRole('button', { name: /downloads yt-dlp \+ ffmpeg/ });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    fireEvent.click(offer);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('install_video_tools'));
    expect(await screen.findByText('Never Gonna')).toBeInTheDocument();
    expect(screen.getByText('3:33')).toBeInTheDocument();
  }, 20_000);

  it('downloads nothing until the person clicks', async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === 'video_tools_ready' ? false : null));
    const { VideoLinkCard } = await import('../VideoLinkCard');
    render(<VideoLinkCard href="https://x.com/a/status/1" onRemove={() => {}} />);
    await screen.findByRole('button', { name: /downloads yt-dlp/ });
    expect(invoke).not.toHaveBeenCalledWith('install_video_tools');
    expect(invoke).not.toHaveBeenCalledWith('video_link_info', expect.anything());
  });
});
